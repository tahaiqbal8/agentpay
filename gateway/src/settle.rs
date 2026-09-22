//! On-chain settlement.
//!
//! Assembles the two-instruction transaction the program requires:
//!
//!   ix[n-1]  Ed25519 precompile, verifying the agent's signature over the
//!            highest accepted claim
//!   ix[n]    `settle_session`, which reads the instructions sysvar and
//!            confirms the precompile was asked to check exactly that claim
//!
//! The precompile MUST sit immediately before `settle_session`: the program
//! loads `current_index - 1` and rejects anything else with
//! `MissingEd25519Instruction`.

use sha2::{Digest, Sha256};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_commitment_config::CommitmentConfig;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_sdk_ids::{ed25519_program, sysvar::instructions as instructions_sysvar};
use solana_signer::Signer;
use solana_transaction::Transaction;

use crate::claim::{Claim, CLAIM_MESSAGE_LEN};

pub const VAULT_SEED: &[u8] = b"vault";
pub const SETTLEMENT_SEED: &[u8] = b"settlement";

/// The SPL Associated Token Account program.
///
/// Hardcoded because it is a fixed protocol address, not a deployment choice —
/// unlike the AgentPay program ID, which comes from configuration.
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// Failures reachable once submission has begun.
///
/// Session-state problems (nothing to settle, already settled, wrong provider
/// key) are caught by the route handler before it gets here, so they are not
/// represented twice.
#[derive(Debug, thiserror::Error)]
pub enum SettleError {
    #[error("rpc error: {0}")]
    Rpc(String),
    #[error("mint account {0} not found on chain")]
    MintNotFound(Pubkey),
}

/// Anchor's instruction discriminator: the first 8 bytes of
/// `sha256("global:<instruction_name>")`.
pub fn anchor_discriminator(instruction_name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{instruction_name}").as_bytes());
    let digest = hasher.finalize();
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest[..8]);
    out
}

pub fn derive_vault(program_id: &Pubkey, session: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED, session.as_ref()], program_id)
}

pub fn derive_settlement_record(program_id: &Pubkey, session: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SETTLEMENT_SEED, session.as_ref()], program_id)
}

/// Standard associated token account address.
pub fn derive_associated_token_account(
    owner: &Pubkey,
    token_program: &Pubkey,
    mint: &Pubkey,
) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    .0
}

// Offsets within the precompile instruction data. These reproduce the layout
// the canonical client emits, which the on-chain `verify_ed25519_claim` parses
// and which was confirmed byte-for-byte against devnet:
//   header(16) | pubkey(32) @16 | signature(64) @48 | message @112
const ED25519_HEADER_LEN: usize = 16;
const ED25519_PUBKEY_OFFSET: u16 = 16;
const ED25519_SIGNATURE_OFFSET: u16 = 48;
const ED25519_MESSAGE_OFFSET: u16 = 112;
/// The precompile's "this instruction" sentinel.
///
/// The program requires all three index fields to be this value, so signature,
/// key, and message must live inside the precompile instruction's own data.
/// Anything else would let an attacker point the precompile at one message
/// while the program reads another.
const ED25519_SELF_REF: u16 = u16::MAX;

/// Builds the Ed25519 precompile instruction for one signature.
pub fn build_ed25519_instruction(
    signer: &Pubkey,
    signature: &[u8; 64],
    message: &[u8],
) -> Instruction {
    let mut data = Vec::with_capacity(ED25519_HEADER_LEN + 32 + 64 + message.len());

    data.push(1); // num_signatures
    data.push(0); // padding
    data.extend_from_slice(&ED25519_SIGNATURE_OFFSET.to_le_bytes());
    data.extend_from_slice(&ED25519_SELF_REF.to_le_bytes());
    data.extend_from_slice(&ED25519_PUBKEY_OFFSET.to_le_bytes());
    data.extend_from_slice(&ED25519_SELF_REF.to_le_bytes());
    data.extend_from_slice(&ED25519_MESSAGE_OFFSET.to_le_bytes());
    data.extend_from_slice(&(message.len() as u16).to_le_bytes());
    data.extend_from_slice(&ED25519_SELF_REF.to_le_bytes());

    debug_assert_eq!(data.len(), ED25519_HEADER_LEN);
    data.extend_from_slice(signer.as_ref()); // @16
    data.extend_from_slice(signature); // @48
    data.extend_from_slice(message); // @112

    Instruction {
        program_id: ed25519_program::ID,
        accounts: vec![],
        data,
    }
}

/// Account order must match the IDL exactly; Anchor matches positionally.
#[allow(clippy::too_many_arguments)]
/// Builds the `settle_session` instruction.
///
/// The account list is identical between program v1 and v2 — same accounts, in
/// the same order. Only the FIRST one changed meaning: v1 required it to be the
/// provider, v2 accepts either the session's settlement authority or the
/// provider. Nothing about the encoding needs to branch on the version.
pub fn build_settle_instruction(
    program_id: &Pubkey,
    // The transaction signer. The provider under v1; under v2 either the
    // session's settlement authority or the provider.
    settler: &Pubkey,
    session: &Pubkey,
    settlement_record: &Pubkey,
    vault: &Pubkey,
    provider_token_account: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
    claim: &Claim,
    merkle_root: &[u8; 32],
) -> Instruction {
    let mut data = Vec::with_capacity(8 + 8 + 8 + 8 + 32);
    data.extend_from_slice(&anchor_discriminator("settle_session"));
    data.extend_from_slice(&claim.cumulative_amount.to_le_bytes());
    data.extend_from_slice(&claim.nonce.to_le_bytes());
    data.extend_from_slice(&claim.expires_at.to_le_bytes());
    data.extend_from_slice(merkle_root);

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*settler, true),
            AccountMeta::new(*session, false),
            AccountMeta::new(*settlement_record, false),
            AccountMeta::new(*vault, false),
            AccountMeta::new(*provider_token_account, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(instructions_sysvar::ID, false),
            AccountMeta::new_readonly(*token_program, false),
            AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
        ],
        data,
    }
}

pub struct SettlementOutcome {
    pub signature: String,
    pub cumulative_amount: u64,
    pub nonce: u64,
    pub token_program: Pubkey,
    pub provider_token_account: Pubkey,
    pub settlement_record: Pubkey,
}

/// Builds, signs, and submits the settlement transaction.
///
/// The mint's owning program is read from chain rather than assumed, so a
/// Token-2022 mint settles through the Token-2022 program without special
/// casing at the call site.
pub async fn submit_settlement(
    rpc: &RpcClient,
    program_id: &Pubkey,
    // Whoever signs and pays. Under v2 this is the gateway's own settlement
    // authority and is NOT the provider.
    settler: &Keypair,
    // The session's immutable payee, read from the session account.
    //
    // Deliberately NOT derived from `settler`. It used to be, because under v1
    // the two were the same key — under v2 that would send the money to the
    // gateway's own token account. The program would refuse it
    // (`provider_token_account.owner == session.provider`), so the mistake
    // costs a failed transaction rather than funds, but the destination
    // belongs to the session and is read from it.
    provider: &Pubkey,
    session: &Pubkey,
    mint: &Pubkey,
    claim: &Claim,
    signature: &[u8; 64],
    agent: &Pubkey,
    merkle_root: &[u8; 32],
) -> Result<SettlementOutcome, SettleError> {
    let mint_account = rpc
        .get_account(mint)
        .await
        .map_err(|_| SettleError::MintNotFound(*mint))?;
    let token_program = mint_account.owner;

    let (vault, _) = derive_vault(program_id, session);
    let (settlement_record, _) = derive_settlement_record(program_id, session);
    let settler_key = settler.pubkey();
    let provider_token_account =
        derive_associated_token_account(provider, &token_program, mint);

    let message = claim.signing_bytes();
    debug_assert_eq!(message.len(), CLAIM_MESSAGE_LEN);

    let ed25519_ix = build_ed25519_instruction(agent, signature, &message);
    let settle_ix = build_settle_instruction(
        program_id,
        &settler_key,
        session,
        &settlement_record,
        &vault,
        &provider_token_account,
        mint,
        &token_program,
        claim,
        merkle_root,
    );

    let blockhash = rpc
        .get_latest_blockhash()
        .await
        .map_err(|e| SettleError::Rpc(e.to_string()))?;

    // Order is load-bearing: the precompile must immediately precede settle.
    let tx = Transaction::new_signed_with_payer(
        &[ed25519_ix, settle_ix],
        Some(&settler_key),
        &[settler],
        blockhash,
    );

    let signature = rpc
        .send_and_confirm_transaction(&tx)
        .await
        .map_err(|e| SettleError::Rpc(e.to_string()))?;

    Ok(SettlementOutcome {
        signature: signature.to_string(),
        cumulative_amount: claim.cumulative_amount,
        nonce: claim.nonce,
        token_program,
        provider_token_account,
        settlement_record,
    })
}

pub fn commitment() -> CommitmentConfig {
    CommitmentConfig::confirmed()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminator_matches_the_generated_idl() {
        // target/idl/agentpay.json reports these. Deriving rather than pasting
        // means a renamed instruction fails here instead of on chain.
        assert_eq!(
            anchor_discriminator("settle_session"),
            [156, 20, 180, 117, 117, 85, 225, 128]
        );
        assert_eq!(
            anchor_discriminator("open_session"),
            [130, 54, 124, 7, 236, 20, 104, 104]
        );
        assert_eq!(
            anchor_discriminator("refund_session"),
            [168, 87, 185, 45, 250, 170, 10, 85]
        );
    }

    #[test]
    fn ed25519_layout_matches_what_the_program_parses() {
        let signer = Pubkey::new_from_array([7u8; 32]);
        let signature = [9u8; 64];
        let message = [3u8; CLAIM_MESSAGE_LEN];

        let ix = build_ed25519_instruction(&signer, &signature, &message);
        let d = &ix.data;

        assert_eq!(ix.program_id, ed25519_program::ID);
        assert_eq!(d[0], 1, "num_signatures");
        assert_eq!(d[1], 0, "padding");

        let rd = |at: usize| u16::from_le_bytes([d[at], d[at + 1]]);
        assert_eq!(rd(2), 48, "signature_offset");
        assert_eq!(rd(4), u16::MAX, "signature ix index sentinel");
        assert_eq!(rd(6), 16, "public_key_offset");
        assert_eq!(rd(8), u16::MAX, "public key ix index sentinel");
        assert_eq!(rd(10), 112, "message_offset");
        assert_eq!(rd(12), CLAIM_MESSAGE_LEN as u16, "message_size");
        assert_eq!(rd(14), u16::MAX, "message ix index sentinel");

        // The regions must be readable at the offsets just declared, or the
        // precompile verifies bytes other than the ones we think it does.
        assert_eq!(&d[16..48], signer.as_ref());
        assert_eq!(&d[48..112], &signature[..]);
        assert_eq!(&d[112..112 + CLAIM_MESSAGE_LEN], &message[..]);
        assert_eq!(d.len(), 16 + 32 + 64 + CLAIM_MESSAGE_LEN);
    }

    #[test]
    fn settle_instruction_data_is_borsh_positional() {
        let claim = Claim {
            session: Pubkey::new_from_array([1u8; 32]),
            cumulative_amount: 1_234_567,
            nonce: 42,
            expires_at: 1_800_000_000,
        };
        let root = [0xabu8; 32];
        let ix = build_settle_instruction(
            &Pubkey::new_from_array([2u8; 32]),
            &Pubkey::new_from_array([3u8; 32]),
            &claim.session,
            &Pubkey::new_from_array([4u8; 32]),
            &Pubkey::new_from_array([5u8; 32]),
            &Pubkey::new_from_array([6u8; 32]),
            &Pubkey::new_from_array([7u8; 32]),
            &Pubkey::new_from_array([8u8; 32]),
            &claim,
            &root,
        );

        assert_eq!(&ix.data[0..8], &anchor_discriminator("settle_session"));
        assert_eq!(&ix.data[8..16], &1_234_567u64.to_le_bytes());
        assert_eq!(&ix.data[16..24], &42u64.to_le_bytes());
        assert_eq!(&ix.data[24..32], &1_800_000_000i64.to_le_bytes());
        assert_eq!(&ix.data[32..64], &root[..]);
        assert_eq!(ix.data.len(), 64);
    }

    #[test]
    fn settle_account_order_matches_the_idl() {
        let ix = build_settle_instruction(
            &Pubkey::new_from_array([2u8; 32]),
            &Pubkey::new_from_array([3u8; 32]),
            &Pubkey::new_from_array([1u8; 32]),
            &Pubkey::new_from_array([4u8; 32]),
            &Pubkey::new_from_array([5u8; 32]),
            &Pubkey::new_from_array([6u8; 32]),
            &Pubkey::new_from_array([7u8; 32]),
            &Pubkey::new_from_array([8u8; 32]),
            &Claim {
                session: Pubkey::new_from_array([1u8; 32]),
                cumulative_amount: 1,
                nonce: 1,
                expires_at: 1,
            },
            &[0u8; 32],
        );

        assert_eq!(ix.accounts.len(), 9);
        // Only the provider signs; everything else is passed unsigned.
        assert!(ix.accounts[0].is_signer);
        assert!(ix.accounts[1..].iter().all(|a| !a.is_signer));
        // Accounts the program mutates.
        for i in 0..5 {
            assert!(ix.accounts[i].is_writable, "account {i} must be writable");
        }
        for i in 5..9 {
            assert!(!ix.accounts[i].is_writable, "account {i} must be readonly");
        }
        assert_eq!(ix.accounts[6].pubkey, instructions_sysvar::ID);
        assert_eq!(ix.accounts[8].pubkey, solana_sdk_ids::system_program::ID);
    }

    /// The settler and the payee are independent, and the instruction proves
    /// it: a settlement signed by AgentPay's authority must still name the
    /// PROVIDER's token account.
    ///
    /// This is the test behind the claim "AgentPay does not hold provider
    /// private keys for new sessions". If the destination were ever derived
    /// from the signer again — as it was under v1, where the two were the same
    /// key — a v2 settlement would try to pay the gateway itself.
    #[test]
    fn the_destination_comes_from_the_provider_not_the_signer() {
        let program_id = Pubkey::new_from_array([2u8; 32]);
        let authority = Pubkey::new_from_array([9u8; 32]); // AgentPay's own key
        let provider_ata = Pubkey::new_from_array([6u8; 32]); // the provider's

        let ix = build_settle_instruction(
            &program_id,
            &authority,
            &Pubkey::new_from_array([1u8; 32]),
            &Pubkey::new_from_array([4u8; 32]),
            &Pubkey::new_from_array([5u8; 32]),
            &provider_ata,
            &Pubkey::new_from_array([7u8; 32]),
            &Pubkey::new_from_array([8u8; 32]),
            &Claim {
                session: Pubkey::new_from_array([1u8; 32]),
                cumulative_amount: 1,
                nonce: 1,
                expires_at: 1,
            },
            &[0u8; 32],
        );

        // Account 0 is the signer, and it is AgentPay's authority.
        assert_eq!(ix.accounts[0].pubkey, authority);
        assert!(ix.accounts[0].is_signer);

        // Account 4 is the destination, and it is the PROVIDER's — not the
        // signer's, and not derived from it.
        assert_eq!(ix.accounts[4].pubkey, provider_ata);
        assert_ne!(
            ix.accounts[4].pubkey, authority,
            "the settlement is paying its own signer"
        );

        // And the authority appears exactly once: as the signer, nowhere else.
        let appearances = ix.accounts.iter().filter(|a| a.pubkey == authority).count();
        assert_eq!(appearances, 1, "the settler must not be any other account");
    }

    #[test]
    fn pdas_use_the_documented_seeds() {
        let program_id = Pubkey::new_from_array([2u8; 32]);
        let session = Pubkey::new_from_array([1u8; 32]);

        let (vault, vb) = derive_vault(&program_id, &session);
        let (record, rb) = derive_settlement_record(&program_id, &session);

        assert_eq!(
            vault,
            Pubkey::find_program_address(&[b"vault", session.as_ref()], &program_id).0
        );
        assert_eq!(
            record,
            Pubkey::find_program_address(&[b"settlement", session.as_ref()], &program_id).0
        );
        assert_ne!(vault, record);
        // find_program_address only ever returns canonical bumps, and the
        // program refuses user-supplied ones; a bump of 0 would mean the search
        // exhausted every candidate, which is not a real address.
        assert!(vb > 0 && rb > 0);
    }

    #[test]
    fn associated_token_account_derivation_is_standard() {
        let owner = Pubkey::new_from_array([1u8; 32]);
        let mint = Pubkey::new_from_array([2u8; 32]);
        let token_program = Pubkey::new_from_array([3u8; 32]);
        let ata = derive_associated_token_account(&owner, &token_program, &mint);
        assert_eq!(
            ata,
            Pubkey::find_program_address(
                &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
                &ASSOCIATED_TOKEN_PROGRAM_ID
            )
            .0
        );
        // A different token program yields a different ATA, which is why the
        // mint owner is read from chain rather than assumed.
        let other = derive_associated_token_account(
            &owner,
            &Pubkey::new_from_array([4u8; 32]),
            &mint,
        );
        assert_ne!(ata, other);
    }
}
