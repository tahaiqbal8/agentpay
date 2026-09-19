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

/// 8-byte discriminator plus the fields below.
pub const SESSION_ACCOUNT_LEN: usize = 187;

// Byte offsets into the account data, including the discriminator.
const OFF_AGENT: usize = 8;
const OFF_PROVIDER: usize = 40;
const OFF_MINT: usize = 72;
const OFF_VAULT: usize = 104;
const OFF_DEPOSITED_TOTAL: usize = 136;
const OFF_CUMULATIVE_SETTLED: usize = 144;
const OFF_REFUNDED_TOTAL: usize = 152;
const OFF_EXPIRES_AT: usize = 160;
const OFF_SESSION_ID: usize = 168;
const OFF_BUMP: usize = 184;
const OFF_VAULT_BUMP: usize = 185;
const OFF_IS_SETTLED: usize = 186;

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
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementRecordAccount {
    pub session: Pubkey,
    pub claim_hash: [u8; 32],
    pub merkle_root: [u8; 32],
    pub settled_at: i64,
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
    #[error("account data is {0} bytes, expected {SESSION_ACCOUNT_LEN}")]
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
        if data.len() != SESSION_ACCOUNT_LEN {
            return Err(SessionVerificationError::InvalidAccountData(data.len()));
        }

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

        let mut session_id = [0u8; 16];
        session_id.copy_from_slice(&data[OFF_SESSION_ID..OFF_SESSION_ID + 16]);

        Ok(Self {
            agent: pubkey_at(OFF_AGENT),
            provider: pubkey_at(OFF_PROVIDER),
            mint: pubkey_at(OFF_MINT),
            vault: pubkey_at(OFF_VAULT),
            deposited_total: u64_at(OFF_DEPOSITED_TOTAL),
            cumulative_settled: u64_at(OFF_CUMULATIVE_SETTLED),
            refunded_total: u64_at(OFF_REFUNDED_TOTAL),
            expires_at: i64_at(OFF_EXPIRES_AT),
            session_id,
            bump: data[OFF_BUMP],
            vault_bump: data[OFF_VAULT_BUMP],
            // Anchor encodes bool as a single 0/1 byte. Anything else means we
            // are not reading the field we think we are.
            is_settled: match data[OFF_IS_SETTLED] {
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
    if owner != *program_id {
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
        d[OFF_MINT..OFF_MINT + 32].copy_from_slice(acct.mint.as_ref());
        d[OFF_VAULT..OFF_VAULT + 32].copy_from_slice(acct.vault.as_ref());
        d[OFF_DEPOSITED_TOTAL..OFF_DEPOSITED_TOTAL + 8]
            .copy_from_slice(&acct.deposited_total.to_le_bytes());
        d[OFF_CUMULATIVE_SETTLED..OFF_CUMULATIVE_SETTLED + 8]
            .copy_from_slice(&acct.cumulative_settled.to_le_bytes());
        d[OFF_REFUNDED_TOTAL..OFF_REFUNDED_TOTAL + 8]
            .copy_from_slice(&acct.refunded_total.to_le_bytes());
        d[OFF_EXPIRES_AT..OFF_EXPIRES_AT + 8].copy_from_slice(&acct.expires_at.to_le_bytes());
        d[OFF_SESSION_ID..OFF_SESSION_ID + 16].copy_from_slice(&acct.session_id);
        d[OFF_BUMP] = acct.bump;
        d[OFF_VAULT_BUMP] = acct.vault_bump;
        d[OFF_IS_SETTLED] = acct.is_settled as u8;
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
        d[OFF_IS_SETTLED] = 7;
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
        d[OFF_REFUNDED_TOTAL..OFF_REFUNDED_TOTAL + 8].copy_from_slice(&u64::MAX.to_le_bytes());
        let acct = SessionAccount::parse(&d).unwrap();
        assert_eq!(acct.remaining(), 0);
    }

    #[test]
    fn rpc_fetcher_constructs() {
        let rpc = Arc::new(RpcClient::new("http://127.0.0.1:8899".to_string()));
        let _ = RpcSessionFetcher::new(rpc);
    }
}
