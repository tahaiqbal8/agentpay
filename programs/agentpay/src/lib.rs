use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};
// Solana 3.0 split the monolithic `solana-program` crate; these no longer exist
// behind `anchor_lang::solana_program` and must be depended on directly.
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sdk_ids::{ed25519_program, sysvar::instructions as instructions_sysvar_id};

declare_id!("3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U");

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

    pub fn open_session(
        ctx: Context<OpenSession>,
        session_id: [u8; 16],
        deposit_amount: u64,
        expires_at: i64,
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

        let record = &mut ctx.accounts.settlement_record;
        record.session = session_key;
        record.claim_hash = solana_sha256_hasher::hash(&expected).to_bytes();
        record.merkle_root = merkle_root;
        record.settled_at = now;
        record.settled_amount = delta;
        record.bump = ctx.bumps.settlement_record;

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
    pub provider: Pubkey,
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
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(
        mut,
        seeds = [
            SESSION_SEED,
            session.agent.as_ref(),
            session.provider.as_ref(),
            session.session_id.as_ref(),
        ],
        bump = session.bump,
        has_one = provider @ AgentPayError::UnauthorizedSettler,
        has_one = mint @ AgentPayError::MintMismatch,
        has_one = vault @ AgentPayError::VaultMismatch,
    )]
    pub session: Account<'info, Session>,

    // `init` is the double-settle defence: the second attempt fails at account
    // creation because this PDA already exists.
    #[account(
        init,
        payer = provider,
        space = 8 + SettlementRecord::INIT_SPACE,
        seeds = [SETTLEMENT_SEED, session.key().as_ref()],
        bump,
    )]
    pub settlement_record: Account<'info, SettlementRecord>,

    #[account(
        mut,
        seeds = [VAULT_SEED, session.key().as_ref()],
        bump = session.vault_bump,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = provider_token_account.mint == mint.key() @ AgentPayError::MintMismatch,
        constraint = provider_token_account.owner == provider.key() @ AgentPayError::TokenAccountOwnerMismatch,
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
    #[msg("ERR_UNAUTHORIZED_SETTLER: signer is not the designated provider")]
    UnauthorizedSettler,
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
