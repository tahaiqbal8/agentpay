use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};
// Solana 3.0 split the monolithic `solana-program` crate; these no longer exist
// behind `anchor_lang::solana_program` and must be depended on directly.
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sdk_ids::{ed25519_program, sysvar::instructions as instructions_sysvar_id};

// A NEW program id, deliberately.
//
// `Session` gained `settlement_authority`, which grows the account by 32
// bytes. Accounts already allocated on devnet were sized without it, so
// deserialising one with this struct fails — the data is simply too short, and
// no upgrade can retroactively enlarge an account somebody else paid rent for.
//
// The old program therefore keeps running for the sessions it already holds.
// New sessions open here. Old sessions drain by settling or, after expiry, by
// the permissionless refund — so nothing can get stuck. See
// docs/SETTLEMENT_CUSTODY.md §16.
declare_id!("ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m");

/// Domain separation prefix for claim signatures.
///
/// Without this, a signature produced for some other protocol that happens to
/// sign a 72-byte blob could be replayed here as a valid claim.
pub const CLAIM_DOMAIN: &[u8] = b"agentpay:claim:v1";

/// Serialized claim length: domain(17) + session(32) + cumulative(8) + nonce(8) + expiry(8).
pub const CLAIM_MESSAGE_LEN: usize = 17 + 32 + 8 + 8 + 8;

/// Upper bound on session lifetime. Bounds how long agent capital can be locked
/// if a provider simply never settles.
pub const MAX_SESSION_DURATION_SECS: i64 = 30 * 24 * 60 * 60;

/// Tolerance for validator clock skew when evaluating expiries.
pub const CLOCK_SKEW_TOLERANCE_SECS: i64 = 30;

pub const SESSION_SEED: &[u8] = b"session";
pub const VAULT_SEED: &[u8] = b"vault";
pub const SETTLEMENT_SEED: &[u8] = b"settlement";

#[program]
pub mod agentpay {
    use super::*;

    /// Opens an escrow session.
    ///
    /// `settlement_authority` names who, besides the provider, may later
    /// trigger settlement. It is recorded immutably and confers no power over
    /// the amount or the destination. Pass `Pubkey::default()` for
    /// provider-only settlement, which is the behaviour this program had
    /// before the field existed.
    pub fn open_session(
        ctx: Context<OpenSession>,
        session_id: [u8; 16],
        deposit_amount: u64,
        expires_at: i64,
        settlement_authority: Pubkey,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;

        require!(deposit_amount > 0, AgentPayError::ZeroDeposit);
        require!(expires_at > now, AgentPayError::ExpiryInPast);
        require!(
            expires_at
                .checked_sub(now)
                .ok_or(AgentPayError::ArithmeticOverflow)?
                <= MAX_SESSION_DURATION_SECS,
            AgentPayError::ExpiryTooDistant
        );

        let session = &mut ctx.accounts.session;
        session.agent = ctx.accounts.agent.key();
        session.provider = ctx.accounts.provider.key();
        // Written once, here, and never assigned again anywhere in this
        // program. Grep for `settlement_authority =` to confirm.
        session.settlement_authority = settlement_authority;
        session.mint = ctx.accounts.mint.key();
        session.vault = ctx.accounts.vault.key();
        session.deposited_total = deposit_amount;
        session.cumulative_settled = 0;
        session.refunded_total = 0;
        session.expires_at = expires_at;
        session.session_id = session_id;
        session.bump = ctx.bumps.session;
        session.vault_bump = ctx.bumps.vault;
        session.is_settled = false;

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.agent_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.agent.to_account_info(),
                },
            ),
            deposit_amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(SessionOpened {
            session: session.key(),
            agent: session.agent,
            provider: session.provider,
            settlement_authority,
            mint: session.mint,
            deposited_total: deposit_amount,
            expires_at,
        });

        Ok(())
    }

    pub fn settle_session(
        ctx: Context<SettleSession>,
        cumulative_amount: u64,
        nonce: u64,
        claim_expires_at: i64,
        merkle_root: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let session_key = ctx.accounts.session.key();

        // ---- who may trigger this -----------------------------------------
        //
        // Either the session's designated settlement authority — a hosted
        // gateway's OWN key, never the provider's — or the provider itself.
        //
        // The provider branch is the fallback that makes the hosted model
        // safe to depend on: if the gateway is compromised, unavailable, or
        // simply fired, the provider can still collect what it is owed using
        // the wallet it already controls, with no service to run.
        //
        // A default (all-zero) authority matches no keypair, so a session
        // opened without one is provider-only — exactly the old behaviour.
        let settler = ctx.accounts.settler.key();
        require!(
            settler == ctx.accounts.session.settlement_authority
                || settler == ctx.accounts.session.provider,
            AgentPayError::UnauthorizedSettler
        );

        // Cheap checks first: a forged claim should be rejected before we pay the
        // compute cost of sysvar introspection and byte comparison.
        require!(
            now <= ctx
                .accounts
                .session
                .expires_at
                .checked_add(CLOCK_SKEW_TOLERANCE_SECS)
                .ok_or(AgentPayError::ArithmeticOverflow)?,
            AgentPayError::SessionExpired
        );
        require!(
            now <= claim_expires_at
                .checked_add(CLOCK_SKEW_TOLERANCE_SECS)
                .ok_or(AgentPayError::ArithmeticOverflow)?,
            AgentPayError::ClaimExpired
        );
        require!(
            cumulative_amount > ctx.accounts.session.cumulative_settled,
            AgentPayError::ClaimNotMonotonic
        );
        require!(
            cumulative_amount <= ctx.accounts.session.deposited_total,
            AgentPayError::ClaimExceedsDeposit
        );

        let expected = build_claim_message(&session_key, cumulative_amount, nonce, claim_expires_at);
        verify_ed25519_claim(
            &ctx.accounts.instructions_sysvar,
            &ctx.accounts.session.agent,
            &expected,
        )?;

        let delta = cumulative_amount
            .checked_sub(ctx.accounts.session.cumulative_settled)
            .ok_or(AgentPayError::ArithmeticOverflow)?;

        let settled_plus_refunded = cumulative_amount
            .checked_add(ctx.accounts.session.refunded_total)
            .ok_or(AgentPayError::ArithmeticOverflow)?;
        require!(
            settled_plus_refunded <= ctx.accounts.session.deposited_total,
            AgentPayError::PayoutExceedsDeposit
        );

        let agent_key = ctx.accounts.session.agent;
        let provider_key = ctx.accounts.session.provider;
        let session_id = ctx.accounts.session.session_id;
        let session_bump = ctx.accounts.session.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            SESSION_SEED,
            agent_key.as_ref(),
            provider_key.as_ref(),
            session_id.as_ref(),
            &[session_bump],
        ]];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.provider_token_account.to_account_info(),
                    authority: ctx.accounts.session.to_account_info(),
                },
                signer_seeds,
            ),
            delta,
            ctx.accounts.mint.decimals,
        )?;

        let session = &mut ctx.accounts.session;
        session.cumulative_settled = cumulative_amount;
        session.is_settled = true;

        // ---- the receipt: create on the first settlement, advance after ----
        //
        // Done by hand rather than with `init_if_needed`, which would re-run
        // the initializer over an existing account. Everything protective here
        // is a check that could be skipped by accident with that macro:
        //
        //   * the address is the right PDA           — seeds on the account
        //   * a fresh account is owned by the system program, and empty
        //   * an existing account is owned by THIS program
        //   * an existing account carries the SettlementRecord discriminator
        //     (`try_deserialize` refuses anything else)
        //   * an existing account belongs to THIS session
        //
        // Note that nothing below decides whether money moves. The transfer
        // has already happened, gated by checks that do not involve this
        // account at all. This is bookkeeping, and it is written last.
        let record_info = ctx.accounts.settlement_record.to_account_info();
        let record_is_new = record_info.owner == &anchor_lang::system_program::ID;

        if record_is_new {
            let space = 8 + SettlementRecord::INIT_SPACE;
            let lamports = Rent::get()?.minimum_balance(space);
            let bump = [ctx.bumps.settlement_record];
            let seeds: &[&[u8]] = &[SETTLEMENT_SEED, session_key.as_ref(), &bump];
            anchor_lang::system_program::create_account(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::CreateAccount {
                        from: ctx.accounts.settler.to_account_info(),
                        to: record_info.clone(),
                    },
                    &[seeds],
                ),
                lamports,
                space as u64,
                &crate::ID,
            )?;
        } else {
            // Not ours, not empty: refuse rather than write through it.
            require_keys_eq!(
                *record_info.owner,
                crate::ID,
                AgentPayError::SettlementRecordInvalid
            );
        }

        let mut record = if record_is_new {
            SettlementRecord {
                session: session_key,
                claim_hash: [0u8; 32],
                merkle_root: [0u8; 32],
                settled_at: 0,
                settled_amount: 0,
                bump: ctx.bumps.settlement_record,
            }
        } else {
            // Checks the Anchor discriminator. An account of some other type
            // at this address cannot be mistaken for a receipt.
            let data = record_info.try_borrow_data()?;
            let existing = SettlementRecord::try_deserialize(&mut &data[..])
                .map_err(|_| error!(AgentPayError::SettlementRecordInvalid))?;
            require_keys_eq!(
                existing.session,
                session_key,
                AgentPayError::SettlementRecordInvalid
            );
            existing
        };

        record.claim_hash = solana_sha256_hasher::hash(&expected).to_bytes();
        record.merkle_root = merkle_root;
        record.settled_at = now;
        // CUMULATIVE, not the delta of this transaction.
        //
        // Under repeatable settlement a per-transaction delta would be
        // meaningless to a reader: the last one would say 650 for a session
        // that paid out 750. This field answers "how much has this session
        // paid in total", which is the question anybody asking has.
        record.settled_amount = cumulative_amount;
        record.bump = ctx.bumps.settlement_record;

        let mut out = record_info.try_borrow_mut_data()?;
        record.try_serialize(&mut &mut out[..])?;
        drop(out);

        emit!(SessionSettled {
            session: session_key,
            provider: provider_key,
            cumulative_amount,
            transferred: delta,
            merkle_root,
            settled_at: now,
        });

        Ok(())
    }

    pub fn refund_session(ctx: Context<RefundSession>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let session_key = ctx.accounts.session.key();

        let expired = now
            > ctx
                .accounts
                .session
                .expires_at
                .checked_add(CLOCK_SKEW_TOLERANCE_SECS)
                .ok_or(AgentPayError::ArithmeticOverflow)?;

        // Post-expiry the refund is permissionless: funds can only ever move to the
        // agent's token account, so a third party triggering it cannot redirect them.
        // This is what makes recovery possible with no gateway and no provider.
        if !expired {
            require!(
                ctx.accounts.caller.key() == ctx.accounts.session.agent,
                AgentPayError::UnauthorizedRefund
            );
            require!(
                ctx.accounts.session.is_settled,
                AgentPayError::SessionStillActive
            );
        }

        let remaining = ctx
            .accounts
            .session
            .deposited_total
            .checked_sub(ctx.accounts.session.cumulative_settled)
            .ok_or(AgentPayError::ArithmeticOverflow)?
            .checked_sub(ctx.accounts.session.refunded_total)
            .ok_or(AgentPayError::ArithmeticOverflow)?;

        require!(remaining > 0, AgentPayError::NothingToRefund);

        let agent_key = ctx.accounts.session.agent;
        let provider_key = ctx.accounts.session.provider;
        let session_id = ctx.accounts.session.session_id;
        let session_bump = ctx.accounts.session.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            SESSION_SEED,
            agent_key.as_ref(),
            provider_key.as_ref(),
            session_id.as_ref(),
            &[session_bump],
        ]];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.agent_token_account.to_account_info(),
                    authority: ctx.accounts.session.to_account_info(),
                },
                signer_seeds,
            ),
            remaining,
            ctx.accounts.mint.decimals,
        )?;

        let session = &mut ctx.accounts.session;
        session.refunded_total = session
            .refunded_total
            .checked_add(remaining)
            .ok_or(AgentPayError::ArithmeticOverflow)?;

        emit!(SessionRefunded {
            session: session_key,
            agent: agent_key,
            amount: remaining,
            permissionless: expired,
            refunded_at: now,
        });

        Ok(())
    }
}

fn build_claim_message(
    session: &Pubkey,
    cumulative_amount: u64,
    nonce: u64,
    claim_expires_at: i64,
) -> Vec<u8> {
    // Every field is fixed-width, so concatenation is unambiguous without length
    // prefixes: no two distinct claims can produce the same byte string.
    let mut msg = Vec::with_capacity(CLAIM_MESSAGE_LEN);
    msg.extend_from_slice(CLAIM_DOMAIN);
    msg.extend_from_slice(session.as_ref());
    msg.extend_from_slice(&cumulative_amount.to_le_bytes());
    msg.extend_from_slice(&nonce.to_le_bytes());
    msg.extend_from_slice(&claim_expires_at.to_le_bytes());
    msg
}

/// Confirms the transaction contains an Ed25519 precompile instruction that
/// verified exactly this message under exactly the session's agent key.
///
/// Solana has no ed25519 verify syscall. The native Ed25519 precompile does the
/// verification, but it runs as a *separate instruction* and cannot report back,
/// so the only way to consume its result is to introspect the instruction list
/// and confirm the precompile was asked to check the tuple we care about.
fn verify_ed25519_claim(
    instructions_sysvar: &AccountInfo,
    expected_signer: &Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)? as usize;
    require!(current_index > 0, AgentPayError::MissingEd25519Instruction);

    let ix = load_instruction_at_checked(current_index - 1, instructions_sysvar)
        .map_err(|_| error!(AgentPayError::MissingEd25519Instruction))?;

    require_keys_eq!(
        ix.program_id,
        ed25519_program::ID,
        AgentPayError::MissingEd25519Instruction
    );

    let data = &ix.data;
    require!(data.len() >= 16, AgentPayError::MalformedEd25519Instruction);
    require!(data[0] == 1, AgentPayError::MalformedEd25519Instruction);
    require!(data[1] == 0, AgentPayError::MalformedEd25519Instruction);

    let read_u16 = |at: usize| -> u16 { u16::from_le_bytes([data[at], data[at + 1]]) };

    let signature_offset = read_u16(2) as usize;
    let signature_ix_index = read_u16(4);
    let public_key_offset = read_u16(6) as usize;
    let public_key_ix_index = read_u16(8);
    let message_offset = read_u16(10) as usize;
    let message_size = read_u16(12) as usize;
    let message_ix_index = read_u16(14);

    // Require all three regions to live inside the precompile instruction itself
    // (u16::MAX is the precompile's "current instruction" sentinel). Otherwise an
    // attacker could point the precompile at bytes in an unrelated instruction and
    // have it verify something other than what we are about to read.
    require!(
        signature_ix_index == u16::MAX
            && public_key_ix_index == u16::MAX
            && message_ix_index == u16::MAX,
        AgentPayError::Ed25519IndirectReference
    );

    require!(
        message_size == expected_message.len(),
        AgentPayError::ClaimMessageMismatch
    );

    let sig_end = signature_offset
        .checked_add(64)
        .ok_or(AgentPayError::MalformedEd25519Instruction)?;
    let key_end = public_key_offset
        .checked_add(32)
        .ok_or(AgentPayError::MalformedEd25519Instruction)?;
    let msg_end = message_offset
        .checked_add(message_size)
        .ok_or(AgentPayError::MalformedEd25519Instruction)?;
    require!(
        sig_end <= data.len() && key_end <= data.len() && msg_end <= data.len(),
        AgentPayError::MalformedEd25519Instruction
    );

    require!(
        &data[public_key_offset..key_end] == expected_signer.as_ref(),
        AgentPayError::ClaimSignerMismatch
    );
    require!(
        &data[message_offset..msg_end] == expected_message,
        AgentPayError::ClaimMessageMismatch
    );

    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct Session {
    pub agent: Pubkey,
    /// The payee, and the ONLY destination this session's funds can reach.
    ///
    /// Part of the session PDA seeds, so it cannot be changed after the session
    /// is opened — not by the provider, not by the gateway, not by this
    /// program. A provider rotating its wallet affects future sessions only.
    pub provider: Pubkey,
    /// Who else, besides the provider, may TRIGGER settlement.
    ///
    /// This is a permission to submit, not a permission to receive. It cannot
    /// change the amount — that is fixed by the agent's Ed25519 signature over
    /// the claim — and it cannot change the destination, which is bound to
    /// `provider` above. A hosted gateway holds its OWN key here and therefore
    /// never holds the provider's.
    ///
    /// `Pubkey::default()` (all zeros) disables the second settler: no keypair
    /// corresponds to it, so only the provider can settle. That is the exact
    /// behaviour of the program before this field existed, which makes it the
    /// correct value for a caller that does not know what to pass.
    ///
    /// Immutable for the life of the session, like everything else here.
    pub settlement_authority: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub deposited_total: u64,
    pub cumulative_settled: u64,
    pub refunded_total: u64,
    pub expires_at: i64,
    pub session_id: [u8; 16],
    pub bump: u8,
    pub vault_bump: u8,
    pub is_settled: bool,
}

#[account]
#[derive(InitSpace)]
pub struct SettlementRecord {
    pub session: Pubkey,
    pub claim_hash: [u8; 32],
    pub merkle_root: [u8; 32],
    pub settled_at: i64,
    pub settled_amount: u64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(session_id: [u8; 16])]
pub struct OpenSession<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,

    /// CHECK: Recorded as the only key permitted to settle this session. Never
    /// signs here and is never read from, so no further validation is meaningful.
    pub provider: UncheckedAccount<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = agent,
        space = 8 + Session::INIT_SPACE,
        seeds = [SESSION_SEED, agent.key().as_ref(), provider.key().as_ref(), session_id.as_ref()],
        bump,
    )]
    pub session: Account<'info, Session>,

    #[account(
        init,
        payer = agent,
        seeds = [VAULT_SEED, session.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = session,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = agent_token_account.mint == mint.key() @ AgentPayError::MintMismatch,
        constraint = agent_token_account.owner == agent.key() @ AgentPayError::TokenAccountOwnerMismatch,
    )]
    pub agent_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleSession<'info> {
    /// Whoever is submitting this settlement, and the rent payer.
    ///
    /// Formerly `provider: Signer`. The handler checks this key against the
    /// session's `settlement_authority` OR its `provider`; being a signer here
    /// grants nothing on its own.
    ///
    /// Note what this signature does NOT control: not the amount, which the
    /// agent's Ed25519 signature fixes, and not the destination, which is
    /// bound to `session.provider` below. A settler can only choose *when*,
    /// and *which already-signed claim*.
    #[account(mut)]
    pub settler: Signer<'info>,

    #[account(
        mut,
        seeds = [
            SESSION_SEED,
            session.agent.as_ref(),
            session.provider.as_ref(),
            session.session_id.as_ref(),
        ],
        bump = session.bump,
        has_one = mint @ AgentPayError::MintMismatch,
        has_one = vault @ AgentPayError::VaultMismatch,
    )]
    pub session: Account<'info, Session>,

    /// The settlement receipt. Created on the first settlement, advanced on
    /// every later one.
    ///
    /// `UncheckedAccount` rather than `Account` or `init_if_needed`, and this
    /// is deliberate. `init_if_needed` re-runs the initializer against an
    /// account that already exists, and repeatable settlement depends on NOT
    /// resetting the state we are about to compare against. The handler does
    /// the create-or-advance explicitly and checks the owner and the
    /// discriminator itself.
    ///
    /// CHECK: constrained to the correct PDA by the seeds below; ownership and
    /// the Anchor discriminator are validated in the handler before any read
    /// or write.
    #[account(
        mut,
        seeds = [SETTLEMENT_SEED, session.key().as_ref()],
        bump,
    )]
    pub settlement_record: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, session.key().as_ref()],
        bump = session.vault_bump,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// The ONLY account this session's funds can reach.
    ///
    /// Constrained against `session.provider` — the field baked into the
    /// session PDA's own seeds — rather than against any account the caller
    /// supplies. There is no input to this instruction that can redirect a
    /// payment, which is the property the whole custody design rests on.
    #[account(
        mut,
        constraint = provider_token_account.mint == mint.key() @ AgentPayError::MintMismatch,
        constraint = provider_token_account.owner == session.provider @ AgentPayError::TokenAccountOwnerMismatch,
    )]
    pub provider_token_account: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Address-constrained to the instructions sysvar; read only via the
    /// checked `load_*` helpers.
    #[account(address = instructions_sysvar_id::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefundSession<'info> {
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [
            SESSION_SEED,
            session.agent.as_ref(),
            session.provider.as_ref(),
            session.session_id.as_ref(),
        ],
        bump = session.bump,
        has_one = mint @ AgentPayError::MintMismatch,
        has_one = vault @ AgentPayError::VaultMismatch,
    )]
    pub session: Account<'info, Session>,

    #[account(
        mut,
        seeds = [VAULT_SEED, session.key().as_ref()],
        bump = session.vault_bump,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = agent_token_account.mint == mint.key() @ AgentPayError::MintMismatch,
        constraint = agent_token_account.owner == session.agent @ AgentPayError::TokenAccountOwnerMismatch,
    )]
    pub agent_token_account: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct SessionOpened {
    pub session: Pubkey,
    pub agent: Pubkey,
    pub provider: Pubkey,
    pub settlement_authority: Pubkey,
    pub mint: Pubkey,
    pub deposited_total: u64,
    pub expires_at: i64,
}

#[event]
pub struct SessionSettled {
    pub session: Pubkey,
    pub provider: Pubkey,
    pub cumulative_amount: u64,
    pub transferred: u64,
    pub merkle_root: [u8; 32],
    pub settled_at: i64,
}

#[event]
pub struct SessionRefunded {
    pub session: Pubkey,
    pub agent: Pubkey,
    pub amount: u64,
    pub permissionless: bool,
    pub refunded_at: i64,
}

#[error_code]
pub enum AgentPayError {
    #[msg("ERR_ZERO_DEPOSIT: deposit must be greater than zero")]
    ZeroDeposit,
    #[msg("ERR_EXPIRY_IN_PAST: session expiry must be in the future")]
    ExpiryInPast,
    #[msg("ERR_EXPIRY_TOO_DISTANT: session expiry exceeds maximum session duration")]
    ExpiryTooDistant,
    #[msg("ERR_SESSION_EXPIRED: session expired and can no longer settle")]
    SessionExpired,
    #[msg("ERR_CLAIM_EXPIRED: claim expiry has passed")]
    ClaimExpired,
    #[msg("ERR_CLAIM_NOT_MONOTONIC: cumulative amount must exceed the settled amount")]
    ClaimNotMonotonic,
    #[msg("ERR_CLAIM_EXCEEDS_DEPOSIT: cumulative amount exceeds session deposit")]
    ClaimExceedsDeposit,
    #[msg("ERR_PAYOUT_EXCEEDS_DEPOSIT: settled plus refunded would exceed deposit")]
    PayoutExceedsDeposit,
    #[msg("ERR_UNAUTHORIZED_SETTLER: signer is neither the settlement authority nor the provider")]
    UnauthorizedSettler,
    #[msg("ERR_SETTLEMENT_RECORD_INVALID: settlement record is not a receipt for this session")]
    SettlementRecordInvalid,
    #[msg("ERR_UNAUTHORIZED_REFUND: only the agent may refund before expiry")]
    UnauthorizedRefund,
    #[msg("ERR_SESSION_STILL_ACTIVE: session is unsettled and not yet expired")]
    SessionStillActive,
    #[msg("ERR_NOTHING_TO_REFUND: no unspent balance remains")]
    NothingToRefund,
    #[msg("ERR_MINT_MISMATCH: token mint does not match the session mint")]
    MintMismatch,
    #[msg("ERR_VAULT_MISMATCH: vault does not match the session vault")]
    VaultMismatch,
    #[msg("ERR_TOKEN_ACCOUNT_OWNER_MISMATCH: token account owner is not the expected party")]
    TokenAccountOwnerMismatch,
    #[msg("ERR_MISSING_ED25519_INSTRUCTION: no preceding Ed25519 verify instruction found")]
    MissingEd25519Instruction,
    #[msg("ERR_MALFORMED_ED25519_INSTRUCTION: Ed25519 instruction data failed structural validation")]
    MalformedEd25519Instruction,
    #[msg("ERR_ED25519_INDIRECT_REFERENCE: Ed25519 instruction references data outside itself")]
    Ed25519IndirectReference,
    #[msg("ERR_CLAIM_SIGNER_MISMATCH: claim was not signed by the session agent")]
    ClaimSignerMismatch,
    #[msg("ERR_CLAIM_MESSAGE_MISMATCH: verified message does not match the claim")]
    ClaimMessageMismatch,
    #[msg("ERR_ARITHMETIC_OVERFLOW: checked arithmetic overflowed")]
    ArithmeticOverflow,
}
