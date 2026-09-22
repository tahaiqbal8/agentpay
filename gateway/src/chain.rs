//! On-chain session reconciliation.
//!
//! Closes D8: `/v1/session/open` used to believe whatever the caller said about
//! a session. Now the gateway reads the actual `Session` account from Solana and
//! refuses to track anything that disagrees with it.
//!
//! # Why this is parsed by hand
//!
//! The obvious approach is `#[derive(AnchorDeserialize)]`, but `anchor-lang`
//! pins the `solana-program` 3.x tree while this crate is built on the 4.x split
//! crates that `solana-client` requires. Pulling Anchor in here would either
//! fail to resolve or silently build a second, incompatible `Pubkey`. The
//! account is a fixed-size struct with no `Vec` or `String`, so explicit offsets
//! are both exact and trivially auditable — and `layout_matches_a_real_devnet_account`
//! pins them against bytes actually read from chain.
//!
//! # What the field names are
//!
//! There is no `owner`, `session_pubkey`, `settled_amount`, `state`, or `nonce`
//! on this account. Those names deserialize cleanly against the real 187-byte
//! layout and yield garbage rather than an error, which is the worst possible
//! failure mode. The real field set is below and matches the IDL exactly.

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_pubkey::Pubkey;

/// Anchor account discriminator: `sha256("account:Session")[..8]`.
///
/// Checked before parsing so a different account type under the same program
/// is rejected rather than misread.
pub const SESSION_DISCRIMINATOR: [u8; 8] = [243, 81, 72, 115, 214, 188, 72, 144];

/// The v1 `Session`: the layout the ORIGINAL program
/// `3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U` writes.
pub const SESSION_ACCOUNT_LEN_V1: usize = 187;

/// The v2 `Session`: v1 plus `settlement_authority`, 32 bytes inserted after
/// `provider`. Written by `ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m`.
pub const SESSION_ACCOUNT_LEN_V2: usize = 219;

/// Kept as an alias so existing callers and tests keep compiling. It names the
/// v1 length because that is what every account on devnet is today.
pub const SESSION_ACCOUNT_LEN: usize = SESSION_ACCOUNT_LEN_V1;

// ---------------------------------------------------------------------------
// Byte offsets, including the discriminator.
//
// BOTH programs write the same 8-byte discriminator, because it is
// `sha256("account:Session")[..8]` and the struct is still called `Session`.
// So the discriminator CANNOT distinguish the versions and the length is what
// does: 187 is v1, 219 is v2, anything else is refused.
//
// Getting this wrong is the failure mode this module's header warns about —
// the wrong offsets do not error, they return plausible garbage. Every offset
// after `provider` shifts by 32 between the versions, so they are spelled out
// separately rather than computed, and `v2_offsets_are_v1_shifted_by_32` pins
// the relationship.
// ---------------------------------------------------------------------------
const OFF_AGENT: usize = 8;
const OFF_PROVIDER: usize = 40;

// v1: no settlement_authority.
const V1_OFF_MINT: usize = 72;
const V1_OFF_VAULT: usize = 104;
const V1_OFF_DEPOSITED_TOTAL: usize = 136;
const V1_OFF_CUMULATIVE_SETTLED: usize = 144;
const V1_OFF_REFUNDED_TOTAL: usize = 152;
const V1_OFF_EXPIRES_AT: usize = 160;
const V1_OFF_SESSION_ID: usize = 168;
const V1_OFF_BUMP: usize = 184;
const V1_OFF_VAULT_BUMP: usize = 185;
const V1_OFF_IS_SETTLED: usize = 186;

// v2: settlement_authority at 72, everything after it shifted by 32.
const V2_OFF_SETTLEMENT_AUTHORITY: usize = 72;
const V2_OFF_MINT: usize = 104;
const V2_OFF_VAULT: usize = 136;
const V2_OFF_DEPOSITED_TOTAL: usize = 168;
const V2_OFF_CUMULATIVE_SETTLED: usize = 176;
const V2_OFF_REFUNDED_TOTAL: usize = 184;
const V2_OFF_EXPIRES_AT: usize = 192;
const V2_OFF_SESSION_ID: usize = 200;
const V2_OFF_BUMP: usize = 216;
const V2_OFF_VAULT_BUMP: usize = 217;
const V2_OFF_IS_SETTLED: usize = 218;

/// `sha256("account:SettlementRecord")[..8]`, checked against the real account
/// `6hs7LfYXeh6TTgVytN4Wyvv71YHyKB1r9oNdX69hYxmU` on devnet.
pub const SETTLEMENT_DISCRIMINATOR: [u8; 8] = [172, 159, 67, 74, 96, 85, 37, 205];

/// 8-byte discriminator + session + claim_hash + merkle_root + i64 + u64 + bump.
pub const SETTLEMENT_RECORD_LEN: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1;

const OFF_SR_SESSION: usize = 8;
const OFF_SR_CLAIM_HASH: usize = 40;
const OFF_SR_MERKLE_ROOT: usize = 72;
const OFF_SR_SETTLED_AT: usize = 104;
const OFF_SR_SETTLED_AMOUNT: usize = 112;

/// The on-chain `SettlementRecord`.
///
/// This is what closes the audit: the evidence root the console recomputes in
/// the browser has to equal the one the program stored here, and that equality
/// is the whole claim. Reading it back rather than echoing what the gateway
/// said at settlement time is the point — a gateway that lied about the root
/// it committed would be caught exactly here.
///
/// # The root is the LATEST, not the final
///
/// Under program v2 settlement is repeatable, so this account is created on
/// the first settlement and advanced on every later one. `merkle_root` is
/// therefore the root as of the most recent settlement — the evidence log is
/// append-only, so a later settlement commits a root over more leaves.
///
/// The verifier stays correct because it fetches a fresh proof against the
/// current log and compares it to the current on-chain root; both advance
/// together. But a proof exported and published earlier will not verify
/// against a later root, and nothing here may be described as permanently
/// final. See docs/SETTLEMENT_CUSTODY.md §17.
///
/// The byte LAYOUT is unchanged between v1 and v2 — same fields, same sizes,
/// same offsets — so no version check is needed here. Only the meaning of
/// `settled_amount` changed, and that is documented on the field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementRecordAccount {
    pub session: Pubkey,
    pub claim_hash: [u8; 32],
    pub merkle_root: [u8; 32],
    pub settled_at: i64,
    /// The CUMULATIVE total this session has settled, not the delta of the
    /// most recent transaction.
    ///
    /// Program v1 wrote the delta, which was unambiguous because settlement
    /// happened exactly once. Program v2 makes settlement repeatable, and a
    /// per-transaction delta would then be actively misleading: the last
    /// settlement of a session that paid 750 in two steps would read 650.
    ///
    /// The two programs therefore write different meanings into the same
    /// bytes. A v1 record read today is still correct — a single settlement's
    /// delta IS the cumulative — so no historical record is misinterpreted,
    /// but do not reach for this field expecting "what moved in that one
    /// transaction".
    pub settled_amount: u64,
}

/// Parses a `SettlementRecord`, refusing anything that is not exactly one.
pub fn parse_settlement_record(
    owner: &Pubkey,
    program_id: &Pubkey,
    data: &[u8],
) -> Result<SettlementRecordAccount, SessionVerificationError> {
    if owner != program_id {
        return Err(SessionVerificationError::WrongProgramOwner {
            expected: *program_id,
            actual: *owner,
        });
    }
    if data.len() != SETTLEMENT_RECORD_LEN {
        return Err(SessionVerificationError::InvalidAccountData(data.len()));
    }
    if data[..8] != SETTLEMENT_DISCRIMINATOR {
        return Err(SessionVerificationError::NotASessionAccount);
    }

    let pk = |off: usize| -> Pubkey {
        let mut b = [0u8; 32];
        b.copy_from_slice(&data[off..off + 32]);
        Pubkey::new_from_array(b)
    };
    let arr = |off: usize| -> [u8; 32] {
        let mut b = [0u8; 32];
        b.copy_from_slice(&data[off..off + 32]);
        b
    };
    let u64_at = |off: usize| -> u64 {
        u64::from_le_bytes(data[off..off + 8].try_into().expect("8 bytes"))
    };

    Ok(SettlementRecordAccount {
        session: pk(OFF_SR_SESSION),
        claim_hash: arr(OFF_SR_CLAIM_HASH),
        merkle_root: arr(OFF_SR_MERKLE_ROOT),
        settled_at: i64::from_le_bytes(
            data[OFF_SR_SETTLED_AT..OFF_SR_SETTLED_AT + 8].try_into().expect("8 bytes"),
        ),
        settled_amount: u64_at(OFF_SR_SETTLED_AMOUNT),
    })
}

/// The on-chain `Session`, mirroring `programs/agentpay/src/lib.rs` exactly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionAccount {
    pub agent: Pubkey,
    pub provider: Pubkey,
    /// Who, besides the provider, may trigger settlement.
    ///
    /// `None` means this is a v1 session from the original program, which has
    /// no such field — NOT that the field is set to zero. The distinction
    /// matters: a v1 session can only ever be settled by the provider's own
    /// key, which is why the legacy settlement path has to stay until the last
    /// of them drains.
    pub settlement_authority: Option<Pubkey>,
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

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SessionVerificationError {
    #[error("no account exists at that address")]
    AccountNotFound,
    #[error("account is owned by {actual}, not the AgentPay program {expected}")]
    WrongProgramOwner { expected: Pubkey, actual: Pubkey },
    #[error(
        "account data is {0} bytes, expected {SESSION_ACCOUNT_LEN_V1} (v1) \
         or {SESSION_ACCOUNT_LEN_V2} (v2)"
    )]
    InvalidAccountData(usize),
    #[error("account discriminator is not a Session")]
    NotASessionAccount,
    #[error("session is already settled on chain")]
    AlreadySettled,
    #[error("deposit mismatch: request says {expected}, chain says {on_chain}")]
    DepositMismatch { expected: u64, on_chain: u64 },
    #[error("{field} mismatch: request says {expected}, chain says {on_chain}")]
    FieldMismatch {
        field: &'static str,
        expected: String,
        on_chain: String,
    },
    #[error("rpc unavailable")]
    RpcUnavailable,
}

impl SessionAccount {
    /// Parses account data, discriminator included.
    pub fn parse(data: &[u8]) -> Result<Self, SessionVerificationError> {
        if data.len() < 8 {
            return Err(SessionVerificationError::InvalidAccountData(data.len()));
        }
        if data[..8] != SESSION_DISCRIMINATOR {
            return Err(SessionVerificationError::NotASessionAccount);
        }
        // Exact length, not a minimum: a short account would read past its end
        // and a long one is not the struct we think it is.
        //
        // The length is also the ONLY thing that tells the versions apart. Both
        // programs write the same discriminator, so a v2 account parsed with v1
        // offsets would not error — it would return a plausible-looking session
        // with the mint where the settlement authority is. Refusing anything
        // that is not exactly one of the two known lengths is what prevents
        // that.
        let v2 = match data.len() {
            SESSION_ACCOUNT_LEN_V1 => false,
            SESSION_ACCOUNT_LEN_V2 => true,
            other => return Err(SessionVerificationError::InvalidAccountData(other)),
        };

        let pubkey_at = |off: usize| -> Pubkey {
            let mut b = [0u8; 32];
            b.copy_from_slice(&data[off..off + 32]);
            Pubkey::new_from_array(b)
        };
        let u64_at = |off: usize| -> u64 {
            let mut b = [0u8; 8];
            b.copy_from_slice(&data[off..off + 8]);
            u64::from_le_bytes(b)
        };
        let i64_at = |off: usize| -> i64 {
            let mut b = [0u8; 8];
            b.copy_from_slice(&data[off..off + 8]);
            i64::from_le_bytes(b)
        };

        // One table per version. Picked once, here, so no field below can be
        // read with the wrong version's offset by accident.
        let (
            off_mint,
            off_vault,
            off_deposited,
            off_cumulative,
            off_refunded,
            off_expires,
            off_session_id,
            off_bump,
            off_vault_bump,
            off_is_settled,
        ) = if v2 {
            (
                V2_OFF_MINT,
                V2_OFF_VAULT,
                V2_OFF_DEPOSITED_TOTAL,
                V2_OFF_CUMULATIVE_SETTLED,
                V2_OFF_REFUNDED_TOTAL,
                V2_OFF_EXPIRES_AT,
                V2_OFF_SESSION_ID,
                V2_OFF_BUMP,
                V2_OFF_VAULT_BUMP,
                V2_OFF_IS_SETTLED,
            )
        } else {
            (
                V1_OFF_MINT,
                V1_OFF_VAULT,
                V1_OFF_DEPOSITED_TOTAL,
                V1_OFF_CUMULATIVE_SETTLED,
                V1_OFF_REFUNDED_TOTAL,
                V1_OFF_EXPIRES_AT,
                V1_OFF_SESSION_ID,
                V1_OFF_BUMP,
                V1_OFF_VAULT_BUMP,
                V1_OFF_IS_SETTLED,
            )
        };

        let mut session_id = [0u8; 16];
        session_id.copy_from_slice(&data[off_session_id..off_session_id + 16]);

        Ok(Self {
            agent: pubkey_at(OFF_AGENT),
            provider: pubkey_at(OFF_PROVIDER),
            // `None` for v1: the field does not exist there. Reading zeros and
            // calling it "no authority" would be the same value with a
            // different meaning, and the settlement path needs to tell a v1
            // session from a v2 one that happens to have none.
            settlement_authority: v2.then(|| pubkey_at(V2_OFF_SETTLEMENT_AUTHORITY)),
            mint: pubkey_at(off_mint),
            vault: pubkey_at(off_vault),
            deposited_total: u64_at(off_deposited),
            cumulative_settled: u64_at(off_cumulative),
            refunded_total: u64_at(off_refunded),
            expires_at: i64_at(off_expires),
            session_id,
            bump: data[off_bump],
            vault_bump: data[off_vault_bump],
            // Anchor encodes bool as a single 0/1 byte. Anything else means we
            // are not reading the field we think we are.
            is_settled: match data[off_is_settled] {
                0 => false,
                1 => true,
                _ => return Err(SessionVerificationError::NotASessionAccount),
            },
        })
    }

    /// Unspent balance still held by the vault.
    #[allow(dead_code)] // surfaced for operators and asserted in tests
    pub fn remaining(&self) -> u64 {
        self.deposited_total
            .saturating_sub(self.cumulative_settled)
            .saturating_sub(self.refunded_total)
    }
}

/// What the caller asserted in the open request.
#[derive(Debug, Clone)]
pub struct ClaimedSession {
    pub agent: Pubkey,
    pub provider: Pubkey,
    pub mint: Pubkey,
    pub deposited_total: u64,
    pub expires_at: i64,
}

/// One account read, behind a trait so tests need no cluster.
#[async_trait]
pub trait SessionAccountFetcher: Send + Sync {
    /// Returns `(owner_program, data)`, or `None` when no account exists.
    async fn fetch(&self, pubkey: &Pubkey) -> Result<Option<(Pubkey, Vec<u8>)>, ()>;
}

pub struct RpcSessionFetcher {
    rpc: std::sync::Arc<RpcClient>,
}

impl RpcSessionFetcher {
    pub fn new(rpc: std::sync::Arc<RpcClient>) -> Self {
        Self { rpc }
    }
}

#[async_trait]
impl SessionAccountFetcher for RpcSessionFetcher {
    async fn fetch(&self, pubkey: &Pubkey) -> Result<Option<(Pubkey, Vec<u8>)>, ()> {
        match self.rpc.get_account(pubkey).await {
            Ok(acct) => Ok(Some((acct.owner, acct.data))),
            Err(e) => {
                // A missing account and a dead RPC must not be conflated: the
                // first is a client error, the second must fail closed.
                let msg = e.to_string();
                if msg.contains("AccountNotFound") || msg.contains("could not find account") {
                    Ok(None)
                } else {
                    tracing::warn!(error = %e, "rpc account fetch failed");
                    Err(())
                }
            }
        }
    }
}

/// Reads the session from chain and reconciles it against what was claimed.
///
/// Reconciles **every** field the gateway will later rely on, not only the
/// deposit. `agent` matters most: claim signatures are verified against the key
/// recorded here, so accepting a caller-supplied agent would let anyone open
/// tracking under a key they control and have the gateway authorise claims the
/// chain will never settle. The provider would deliver the resource for nothing.
pub async fn verify_on_chain_session(
    fetcher: &dyn SessionAccountFetcher,
    program_id: &Pubkey,
    // The previous program, during a migration. A session it owns is a real
    // session and must reconcile — refusing them would strand every escrow
    // opened before the cutover.
    //
    // Passed explicitly rather than read from a global so that a caller cannot
    // widen what counts as "our program" by accident. Only these two are ever
    // accepted.
    legacy_program_id: Option<&Pubkey>,
    session: &Pubkey,
    claimed: &ClaimedSession,
) -> Result<SessionAccount, SessionVerificationError> {
    let Ok(fetched) = fetcher.fetch(session).await else {
        // Fail closed: an unreachable RPC denies the open rather than falling
        // back to trusting the request.
        return Err(SessionVerificationError::RpcUnavailable);
    };
    let Some((owner, data)) = fetched else {
        return Err(SessionVerificationError::AccountNotFound);
    };

    // Without this, an attacker could deploy their own program, create an
    // account with a matching discriminator and any values they like, and have
    // the gateway treat it as a funded session.
    //
    // Exactly two programs are acceptable, and a migration does not relax that
    // — it widens the set by one known id, not to "anything plausible".
    let recognised = owner == *program_id || legacy_program_id == Some(&owner);
    if !recognised {
        return Err(SessionVerificationError::WrongProgramOwner {
            expected: *program_id,
            actual: owner,
        });
    }

    let account = SessionAccount::parse(&data)?;

    if account.is_settled {
        return Err(SessionVerificationError::AlreadySettled);
    }

    // Deposit first: it is the field the spec calls out and the one that bounds
    // credit creation.
    if account.deposited_total != claimed.deposited_total {
        return Err(SessionVerificationError::DepositMismatch {
            expected: claimed.deposited_total,
            on_chain: account.deposited_total,
        });
    }

    let mismatch = |field, expected: String, on_chain: String| {
        SessionVerificationError::FieldMismatch {
            field,
            expected,
            on_chain,
        }
    };
    if account.agent != claimed.agent {
        return Err(mismatch(
            "agent",
            claimed.agent.to_string(),
            account.agent.to_string(),
        ));
    }
    if account.provider != claimed.provider {
        return Err(mismatch(
            "provider",
            claimed.provider.to_string(),
            account.provider.to_string(),
        ));
    }
    if account.mint != claimed.mint {
        return Err(mismatch(
            "mint",
            claimed.mint.to_string(),
            account.mint.to_string(),
        ));
    }
    if account.expires_at != claimed.expires_at {
        return Err(mismatch(
            "expires_at",
            claimed.expires_at.to_string(),
            account.expires_at.to_string(),
        ));
    }

    Ok(account)
}

/// Derives the discriminator the same way Anchor does, so the constant above is
/// checked rather than trusted.
#[allow(dead_code)] // the constant above is checked against this in tests
pub fn account_discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("account:{name}").as_bytes());
    let digest = hasher.finalize();
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest[..8]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Real bytes, base64, read from devnet account
    /// 3ue4wzF3L35uXekV65o6rnd9t3tu13GhPkEYHLeY4sg1 under program
    /// 3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U.
    ///
    /// This is the ground truth for the offsets above. If the program's account
    /// layout ever changes, this test fails instead of the gateway silently
    /// reading the wrong fields in production.
    const REAL_ACCOUNT_B64: &str = concat!(
        "81FIc9a8SJDyTp7Oy9BN1xgM0OL+Vw/vtiPVxrdIiRVG8coMSY3SqZ9hlM1yvksiNI2h",
        "2D33HwwhJ2XNvtm0pLG9F4TMdaR7a3UPE4eplgtEHWccift1F3UikarX2oGYwkKgMhIw",
        "+I+5YmgU3lLba8hwzhmyjczkN9CqzosQryivQ4SqAVS9QYCEHgAAAAAAsHELAAAAAAAA",
        "AAAAAAAAALx1qWoAAAAA712iepcu0VBwmcRcB0Gc5f36AQ=="
    );

    fn real_account_bytes() -> Vec<u8> {
        use base64_decode::decode;
        decode(REAL_ACCOUNT_B64)
    }

    // Tiny local base64 decoder so the test needs no extra dependency.
    mod base64_decode {
        pub fn decode(s: &str) -> Vec<u8> {
            const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let idx = |c: u8| T.iter().position(|&t| t == c).unwrap() as u32;
            let clean: Vec<u8> = s.bytes().filter(|c| *c != b'=' && !c.is_ascii_whitespace()).collect();
            let mut out = Vec::new();
            for chunk in clean.chunks(4) {
                let mut buf = 0u32;
                for (i, &c) in chunk.iter().enumerate() {
                    buf |= idx(c) << (18 - 6 * i);
                }
                let n = chunk.len();
                out.push((buf >> 16) as u8);
                if n > 2 {
                    out.push((buf >> 8) as u8);
                }
                if n > 3 {
                    out.push(buf as u8);
                }
            }
            out
        }
    }

    struct MockFetcher {
        result: Result<Option<(Pubkey, Vec<u8>)>, ()>,
    }

    #[async_trait]
    impl SessionAccountFetcher for MockFetcher {
        async fn fetch(&self, _: &Pubkey) -> Result<Option<(Pubkey, Vec<u8>)>, ()> {
            self.result.clone()
        }
    }

    /// Real bytes, base64, read from devnet settlement record
    /// 6hs7LfYXeh6TTgVytN4Wyvv71YHyKB1r9oNdX69hYxmU — the settlement the
    /// operator console performed for session ArqVZrM9pZ…nqusq.
    ///
    /// Ground truth for the offsets above, exactly as REAL_ACCOUNT_B64 is for
    /// `Session`. The merkle_root asserted below is the one the browser
    /// recomputed from the evidence log, so this test pins the equality the
    /// whole audit rests on.
    const REAL_SETTLEMENT_B64: &str = concat!(
        "rJ9DSmBVJc2SfXj/0vePknVOX4FpfnYnAboNfmgb3Kf/Ssv4/vLhRK53zfPCQ/3MJRGMvP",
        "5vm0hbJ7/TZduMTgQqVzXm4HI3uTn8p0UWwnH7wHX3Uj8k/dpreuAzj8r/uZbEBkaF6Zmu",
        "mq5qAAAAAODIEAAAAAAA/Q=="
    );

    #[test]
    fn the_real_settlement_record_parses_to_the_root_the_browser_recomputed() {
        let data = base64_decode::decode(REAL_SETTLEMENT_B64);
        assert_eq!(data.len(), SETTLEMENT_RECORD_LEN);

        let rec = parse_settlement_record(&program_id(), &program_id(), &data).unwrap();

        assert_eq!(
            hex(&rec.merkle_root),
            "b939fca74516c271fbc075f7523f24fdda6b7ae0338fcaffb996c4064685e999",
            "the on-chain root must equal the one recomputed from the evidence log"
        );
        assert_eq!(rec.settled_amount, 1_100_000);
        assert_eq!(rec.settled_at, 1_789_827_758);
        assert_eq!(
            rec.session.to_string(),
            "ArqVZrM9pZGpT9bR6e3CU2HdS2wXF9ATDUvDfL8nqusq"
        );
    }

    #[test]
    fn a_settlement_record_from_another_program_is_refused() {
        let data = base64_decode::decode(REAL_SETTLEMENT_B64);
        let impostor = Pubkey::new_from_array([9u8; 32]);
        // Fail closed: same bytes, wrong owner. Anyone can create an account
        // with these contents under a program they control.
        let err = parse_settlement_record(&impostor, &program_id(), &data).unwrap_err();
        assert!(matches!(
            err,
            SessionVerificationError::WrongProgramOwner { .. }
        ));
    }

    #[test]
    fn a_session_account_is_not_mistaken_for_a_settlement_record() {
        // Both are owned by the program. Only the discriminator and length
        // separate them, so this is the check that must not be skipped.
        let session_data = real_account_bytes();
        let err = parse_settlement_record(&program_id(), &program_id(), &session_data).unwrap_err();
        assert!(matches!(
            err,
            SessionVerificationError::InvalidAccountData(_)
        ));
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn program_id() -> Pubkey {
        "3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U"
            .parse()
            .unwrap()
    }

    /// Builds a synthetic but structurally valid account.
    fn account_bytes(f: impl FnOnce(&mut SessionAccount)) -> Vec<u8> {
        let mut acct = SessionAccount {
            settlement_authority: None,
            agent: Pubkey::new_from_array([1u8; 32]),
            provider: Pubkey::new_from_array([2u8; 32]),
            mint: Pubkey::new_from_array([3u8; 32]),
            vault: Pubkey::new_from_array([4u8; 32]),
            deposited_total: 5_000_000,
            cumulative_settled: 0,
            refunded_total: 0,
            expires_at: 1_800_000_000,
            session_id: [9u8; 16],
            bump: 254,
            vault_bump: 253,
            is_settled: false,
        };
        f(&mut acct);

        let mut d = vec![0u8; SESSION_ACCOUNT_LEN];
        d[..8].copy_from_slice(&SESSION_DISCRIMINATOR);
        d[OFF_AGENT..OFF_AGENT + 32].copy_from_slice(acct.agent.as_ref());
        d[OFF_PROVIDER..OFF_PROVIDER + 32].copy_from_slice(acct.provider.as_ref());
        d[V1_OFF_MINT..V1_OFF_MINT + 32].copy_from_slice(acct.mint.as_ref());
        d[V1_OFF_VAULT..V1_OFF_VAULT + 32].copy_from_slice(acct.vault.as_ref());
        d[V1_OFF_DEPOSITED_TOTAL..V1_OFF_DEPOSITED_TOTAL + 8]
            .copy_from_slice(&acct.deposited_total.to_le_bytes());
        d[V1_OFF_CUMULATIVE_SETTLED..V1_OFF_CUMULATIVE_SETTLED + 8]
            .copy_from_slice(&acct.cumulative_settled.to_le_bytes());
        d[V1_OFF_REFUNDED_TOTAL..V1_OFF_REFUNDED_TOTAL + 8]
            .copy_from_slice(&acct.refunded_total.to_le_bytes());
        d[V1_OFF_EXPIRES_AT..V1_OFF_EXPIRES_AT + 8].copy_from_slice(&acct.expires_at.to_le_bytes());
        d[V1_OFF_SESSION_ID..V1_OFF_SESSION_ID + 16].copy_from_slice(&acct.session_id);
        d[V1_OFF_BUMP] = acct.bump;
        d[V1_OFF_VAULT_BUMP] = acct.vault_bump;
        d[V1_OFF_IS_SETTLED] = acct.is_settled as u8;
        d
    }

    fn claimed_matching() -> ClaimedSession {
        ClaimedSession {
            agent: Pubkey::new_from_array([1u8; 32]),
            provider: Pubkey::new_from_array([2u8; 32]),
            mint: Pubkey::new_from_array([3u8; 32]),
            deposited_total: 5_000_000,
            expires_at: 1_800_000_000,
        }
    }

    async fn verify_with(
        data: Result<Option<(Pubkey, Vec<u8>)>, ()>,
        claimed: ClaimedSession,
    ) -> Result<SessionAccount, SessionVerificationError> {
        let fetcher = MockFetcher { result: data };
        verify_on_chain_session(
            &fetcher,
            &program_id(),
            None,
            &Pubkey::new_from_array([7u8; 32]),
            &claimed,
        )
        .await
    }

    /// Same, but with a legacy program configured. Used to prove a migration
    /// widens the accepted set by exactly one id and no further.
    async fn verify_with_legacy(
        data: Result<Option<(Pubkey, Vec<u8>)>, ()>,
        legacy: &Pubkey,
        claimed: ClaimedSession,
    ) -> Result<SessionAccount, SessionVerificationError> {
        let fetcher = MockFetcher { result: data };
        verify_on_chain_session(
            &fetcher,
            &program_id(),
            Some(legacy),
            &Pubkey::new_from_array([7u8; 32]),
            &claimed,
        )
        .await
    }

    // ---- layout ------------------------------------------------------------

    #[test]
    fn discriminator_matches_anchors_derivation() {
        assert_eq!(account_discriminator("Session"), SESSION_DISCRIMINATOR);
    }

    /// The v2 offsets must be the v1 offsets shifted by exactly 32 after
    /// `provider`, because that is the one field that was inserted.
    ///
    /// Arithmetic rather than eyeballing: a typo in a single constant would
    /// read a neighbouring field, and no test that only checks "it parses"
    /// would notice.
    // ---- dual-program routing ---------------------------------------------

    /// A session owned by the LEGACY program reconciles when a migration is
    /// configured. Refusing it would strand every escrow opened before the
    /// cutover — the sessions this whole migration exists to drain safely.
    #[tokio::test]
    async fn a_legacy_program_session_is_accepted_during_migration() {
        let legacy = Pubkey::new_from_array([42u8; 32]);
        // The captured account is a settled session; reconciliation refuses
        // those on their own merits. Clear the flag so this test exercises the
        // program-owner check and nothing else.
        let mut data = real_account_bytes();
        data[V1_OFF_IS_SETTLED] = 0;
        let acct = SessionAccount::parse(&data).unwrap();

        let ok = verify_with_legacy(
            Ok(Some((legacy, data.clone()))),
            &legacy,
            ClaimedSession {
                agent: acct.agent,
                provider: acct.provider,
                mint: acct.mint,
                deposited_total: acct.deposited_total,
                expires_at: acct.expires_at,
            },
        )
        .await;
        assert!(ok.is_ok(), "a legacy session was refused: {ok:?}");
    }

    /// The same session is REFUSED when no migration is configured.
    ///
    /// The pair with the test above is the point: accepting the legacy program
    /// must be a deliberate configuration, not something the gateway does
    /// because an account looked convincing.
    #[tokio::test]
    async fn the_same_session_is_refused_without_a_configured_legacy_program() {
        let legacy = Pubkey::new_from_array([42u8; 32]);
        let mut data = real_account_bytes();
        data[V1_OFF_IS_SETTLED] = 0;
        let acct = SessionAccount::parse(&data).unwrap();

        let refused = verify_with(
            Ok(Some((legacy, data))),
            ClaimedSession {
                agent: acct.agent,
                provider: acct.provider,
                mint: acct.mint,
                deposited_total: acct.deposited_total,
                expires_at: acct.expires_at,
            },
        )
        .await;
        assert!(matches!(
            refused,
            Err(SessionVerificationError::WrongProgramOwner { .. })
        ));
    }

    /// A migration widens the accepted set by exactly ONE id.
    ///
    /// The failure this guards against is a check written as "is it one of the
    /// programs we know about" drifting into "is it plausible". A third
    /// program — an attacker's, with a matching discriminator and any values
    /// it likes — must still be refused while a migration is in progress.
    #[tokio::test]
    async fn a_third_program_is_still_refused_during_a_migration() {
        let legacy = Pubkey::new_from_array([42u8; 32]);
        let attacker = Pubkey::new_from_array([99u8; 32]);
        let mut data = real_account_bytes();
        data[V1_OFF_IS_SETTLED] = 0;
        let acct = SessionAccount::parse(&data).unwrap();

        let refused = verify_with_legacy(
            Ok(Some((attacker, data))),
            &legacy,
            ClaimedSession {
                agent: acct.agent,
                provider: acct.provider,
                mint: acct.mint,
                deposited_total: acct.deposited_total,
                expires_at: acct.expires_at,
            },
        )
        .await;
        assert!(
            matches!(refused, Err(SessionVerificationError::WrongProgramOwner { .. })),
            "an attacker's program was accepted during a migration"
        );
    }

    #[test]
    fn v2_offsets_are_v1_shifted_by_32() {
        assert_eq!(V2_OFF_SETTLEMENT_AUTHORITY, OFF_PROVIDER + 32);
        for (v1, v2) in [
            (V1_OFF_MINT, V2_OFF_MINT),
            (V1_OFF_VAULT, V2_OFF_VAULT),
            (V1_OFF_DEPOSITED_TOTAL, V2_OFF_DEPOSITED_TOTAL),
            (V1_OFF_CUMULATIVE_SETTLED, V2_OFF_CUMULATIVE_SETTLED),
            (V1_OFF_REFUNDED_TOTAL, V2_OFF_REFUNDED_TOTAL),
            (V1_OFF_EXPIRES_AT, V2_OFF_EXPIRES_AT),
            (V1_OFF_SESSION_ID, V2_OFF_SESSION_ID),
            (V1_OFF_BUMP, V2_OFF_BUMP),
            (V1_OFF_VAULT_BUMP, V2_OFF_VAULT_BUMP),
            (V1_OFF_IS_SETTLED, V2_OFF_IS_SETTLED),
        ] {
            assert_eq!(v2, v1 + 32, "v2 offset is not v1 + 32");
        }
        assert_eq!(SESSION_ACCOUNT_LEN_V2, SESSION_ACCOUNT_LEN_V1 + 32);
        assert_eq!(V2_OFF_IS_SETTLED + 1, SESSION_ACCOUNT_LEN_V2, "v2 length");
        assert_eq!(V1_OFF_IS_SETTLED + 1, SESSION_ACCOUNT_LEN_V1, "v1 length");
    }

    /// Builds a v2 account by splicing an authority into real v1 bytes, then
    /// checks every field still reads correctly.
    ///
    /// This is the test that would have caught the whole class of bug: the
    /// same bytes, read with the wrong table, return a session that looks fine.
    #[test]
    fn a_v2_account_parses_with_every_field_in_the_right_place() {
        let v1 = real_account_bytes();
        let authority = Pubkey::new_from_array([7u8; 32]);

        let mut v2 = Vec::with_capacity(SESSION_ACCOUNT_LEN_V2);
        v2.extend_from_slice(&v1[..OFF_PROVIDER + 32]); // through `provider`
        v2.extend_from_slice(authority.as_ref()); // the new field
        v2.extend_from_slice(&v1[OFF_PROVIDER + 32..]); // the rest, shifted
        assert_eq!(v2.len(), SESSION_ACCOUNT_LEN_V2);

        let a = SessionAccount::parse(&v2).expect("v2 account parses");
        let b = SessionAccount::parse(&v1).expect("v1 account parses");

        assert_eq!(a.settlement_authority, Some(authority));
        assert_eq!(b.settlement_authority, None, "v1 has no authority field");

        // Every other field must be identical across the two encodings.
        assert_eq!(a.agent, b.agent);
        assert_eq!(a.provider, b.provider);
        assert_eq!(a.mint, b.mint);
        assert_eq!(a.vault, b.vault);
        assert_eq!(a.deposited_total, b.deposited_total);
        assert_eq!(a.cumulative_settled, b.cumulative_settled);
        assert_eq!(a.refunded_total, b.refunded_total);
        assert_eq!(a.expires_at, b.expires_at);
        assert_eq!(a.session_id, b.session_id);
        assert_eq!(a.bump, b.bump);
        assert_eq!(a.vault_bump, b.vault_bump);
        assert_eq!(a.is_settled, b.is_settled);
    }

    /// A length that is neither version is refused rather than guessed at.
    #[test]
    fn an_unknown_session_length_is_refused() {
        let v1 = real_account_bytes();
        for len in [SESSION_ACCOUNT_LEN_V1 - 1, SESSION_ACCOUNT_LEN_V1 + 1, 218, 220] {
            let mut data = v1.clone();
            data.resize(len, 0);
            assert!(
                matches!(
                    SessionAccount::parse(&data),
                    Err(SessionVerificationError::InvalidAccountData(_))
                ),
                "a {len}-byte account was accepted"
            );
        }
    }

    #[test]
    fn layout_matches_a_real_devnet_account() {
        let data = real_account_bytes();
        assert_eq!(data.len(), SESSION_ACCOUNT_LEN, "real account length");

        let acct = SessionAccount::parse(&data).expect("real account parses");
        assert_eq!(
            acct.provider.to_string(),
            "BjA8GXW7E8eCbEmjzL56rzZBFoyJq28fWR5izUQRBkWn"
        );
        assert_eq!(
            acct.mint.to_string(),
            "8EU9mRnavSgFDPPNtres9p9MKqrZRJ1AgseBryk6ZpnJ"
        );
        assert_eq!(acct.deposited_total, 2_000_000);
        assert_eq!(acct.cumulative_settled, 750_000);
        assert_eq!(acct.refunded_total, 0);
        assert_eq!(acct.expires_at, 1_789_490_620);
        assert_eq!(acct.bump, 253);
        assert_eq!(acct.vault_bump, 250);
        assert!(acct.is_settled);
        assert_eq!(acct.remaining(), 1_250_000);
    }

    /// The layout in the original spec (owner/session_pubkey/deposited_total/…)
    /// would read `deposited_total` from offset 72, which is inside `mint`.
    /// It deserializes without error and returns garbage — the reason the real
    /// layout is pinned by test rather than trusted.
    #[test]
    fn the_naive_layout_would_have_read_garbage() {
        let data = real_account_bytes();
        let mut b = [0u8; 8];
        b.copy_from_slice(&data[72..80]);
        let would_have_read = u64::from_le_bytes(b);
        assert_ne!(would_have_read, 2_000_000);
        assert_eq!(would_have_read, 835_041_178_529_265_003);
    }

    #[test]
    fn rejects_wrong_discriminator() {
        let mut d = account_bytes(|_| {});
        d[0] ^= 0xff;
        assert_eq!(
            SessionAccount::parse(&d),
            Err(SessionVerificationError::NotASessionAccount)
        );
    }

    #[test]
    fn rejects_wrong_length() {
        assert!(matches!(
            SessionAccount::parse(&[0u8; 4]),
            Err(SessionVerificationError::InvalidAccountData(4))
        ));
        let mut short = account_bytes(|_| {});
        short.truncate(100);
        assert!(matches!(
            SessionAccount::parse(&short),
            Err(SessionVerificationError::InvalidAccountData(100))
        ));
        let mut long = account_bytes(|_| {});
        long.push(0);
        assert!(matches!(
            SessionAccount::parse(&long),
            Err(SessionVerificationError::InvalidAccountData(188))
        ));
    }

    #[test]
    fn rejects_a_non_boolean_is_settled_byte() {
        let mut d = account_bytes(|_| {});
        d[V1_OFF_IS_SETTLED] = 7;
        assert_eq!(
            SessionAccount::parse(&d),
            Err(SessionVerificationError::NotASessionAccount)
        );
    }

    // ---- reconciliation ----------------------------------------------------

    #[tokio::test]
    async fn accepts_a_session_that_matches() {
        let d = account_bytes(|_| {});
        let acct = verify_with(Ok(Some((program_id(), d))), claimed_matching())
            .await
            .expect("matching session accepted");
        assert_eq!(acct.deposited_total, 5_000_000);
    }

    #[tokio::test]
    async fn missing_account_is_not_found() {
        assert_eq!(
            verify_with(Ok(None), claimed_matching()).await,
            Err(SessionVerificationError::AccountNotFound)
        );
    }

    #[tokio::test]
    async fn dead_rpc_fails_closed() {
        // Distinct from AccountNotFound: an unreachable node must never be
        // treated as "no such session", and must never fall through to trust.
        assert_eq!(
            verify_with(Err(()), claimed_matching()).await,
            Err(SessionVerificationError::RpcUnavailable)
        );
    }

    #[tokio::test]
    async fn rejects_an_account_owned_by_another_program() {
        let d = account_bytes(|_| {});
        let impostor = Pubkey::new_from_array([42u8; 32]);
        assert!(matches!(
            verify_with(Ok(Some((impostor, d))), claimed_matching()).await,
            Err(SessionVerificationError::WrongProgramOwner { .. })
        ));
    }

    #[tokio::test]
    async fn rejects_an_overstated_deposit() {
        // The credit-creation attack: claim a bigger deposit than was escrowed.
        let d = account_bytes(|_| {});
        let mut claimed = claimed_matching();
        claimed.deposited_total = 500_000_000;
        assert_eq!(
            verify_with(Ok(Some((program_id(), d))), claimed).await,
            Err(SessionVerificationError::DepositMismatch {
                expected: 500_000_000,
                on_chain: 5_000_000,
            })
        );
    }

    #[tokio::test]
    async fn rejects_an_understated_deposit_too() {
        let d = account_bytes(|_| {});
        let mut claimed = claimed_matching();
        claimed.deposited_total = 1;
        assert!(matches!(
            verify_with(Ok(Some((program_id(), d))), claimed).await,
            Err(SessionVerificationError::DepositMismatch { .. })
        ));
    }

    #[tokio::test]
    async fn rejects_a_substituted_agent_key() {
        // The sharpest one. Claim signatures are verified against the recorded
        // agent, so a caller-chosen agent would let an attacker authorise
        // claims the chain can never settle.
        let d = account_bytes(|_| {});
        let mut claimed = claimed_matching();
        claimed.agent = Pubkey::new_from_array([99u8; 32]);
        assert!(matches!(
            verify_with(Ok(Some((program_id(), d))), claimed).await,
            Err(SessionVerificationError::FieldMismatch { field: "agent", .. })
        ));
    }

    #[tokio::test]
    async fn rejects_substituted_provider_mint_or_expiry() {
        let cases: Vec<(&str, fn(&mut ClaimedSession))> = vec![
            ("provider", |c| c.provider = Pubkey::new_from_array([98u8; 32])),
            ("mint", |c| c.mint = Pubkey::new_from_array([97u8; 32])),
            ("expires_at", |c| c.expires_at += 86_400),
        ];
        for (label, mutate) in cases {
            let d = account_bytes(|_| {});
            let mut claimed = claimed_matching();
            mutate(&mut claimed);
            match verify_with(Ok(Some((program_id(), d))), claimed).await {
                Err(SessionVerificationError::FieldMismatch { field, .. }) => {
                    assert_eq!(field, label)
                }
                other => panic!("{label}: expected FieldMismatch, got {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn rejects_an_already_settled_session() {
        let d = account_bytes(|a| a.is_settled = true);
        assert_eq!(
            verify_with(Ok(Some((program_id(), d))), claimed_matching()).await,
            Err(SessionVerificationError::AlreadySettled)
        );
    }

    #[tokio::test]
    async fn rejects_a_lookalike_account_of_the_wrong_type() {
        let mut d = account_bytes(|_| {});
        d[..8].copy_from_slice(&account_discriminator("SettlementRecord"));
        assert_eq!(
            verify_with(Ok(Some((program_id(), d))), claimed_matching()).await,
            Err(SessionVerificationError::NotASessionAccount)
        );
    }

    #[test]
    fn remaining_saturates_rather_than_underflowing() {
        let mut d = account_bytes(|a| {
            a.cumulative_settled = u64::MAX;
        });
        d[V1_OFF_REFUNDED_TOTAL..V1_OFF_REFUNDED_TOTAL + 8].copy_from_slice(&u64::MAX.to_le_bytes());
        let acct = SessionAccount::parse(&d).unwrap();
        assert_eq!(acct.remaining(), 0);
    }

    #[test]
    fn rpc_fetcher_constructs() {
        let rpc = Arc::new(RpcClient::new("http://127.0.0.1:8899".to_string()));
        let _ = RpcSessionFetcher::new(rpc);
    }
}
