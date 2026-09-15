//! Session state and the monotonic claim tracker.
//!
//! # This store is not durable, and that is a security property, not a detail
//!
//! The high-water mark (`cumulative_settled` / `last_nonce`) is the only thing
//! stopping an agent from replaying an old claim to obtain a second resource
//! for the same money. The on-chain program cannot help here: it sees exactly
//! one settlement at session close and has no view of individual requests.
//!
//! So an in-memory store means **a gateway restart is a security event** —
//! forgetting the high-water mark reopens claim regression for every live
//! session. `InMemorySessionStore` is therefore development scaffolding only.
//! `SessionStore` exists as a trait so a durable Postgres implementation can
//! replace it without touching the verification path.

use std::collections::HashMap;
use std::sync::{PoisonError, RwLock};

use solana_pubkey::Pubkey;

use crate::claim::Claim;

/// A claim together with the signature that authorised it.
///
/// Settlement replays the *highest* accepted claim on-chain, so the signature
/// must be retained verbatim: the Ed25519 precompile re-verifies these exact
/// bytes, and the gateway cannot reproduce a signature it did not keep.
#[derive(Debug, Clone, Copy)]
pub struct SignedClaim {
    pub claim: Claim,
    pub signature: [u8; 64],
}

/// What the gateway knows about a session it is tracking.
#[derive(Debug, Clone)]
pub struct SessionRecord {
    pub session: Pubkey,
    pub agent: Pubkey,
    pub provider: Pubkey,
    pub mint: Pubkey,
    pub deposited_total: u64,
    pub expires_at: i64,
    /// Highest cumulative amount accepted so far. Never decreases.
    pub cumulative_accepted: u64,
    /// Nonce of the last accepted claim. Never decreases.
    pub last_nonce: Option<u64>,
    /// The highest accepted claim and its signature — what settlement submits.
    pub highest_claim: Option<SignedClaim>,
    pub is_settled: bool,
}

impl SessionRecord {
    pub fn new(
        session: Pubkey,
        agent: Pubkey,
        provider: Pubkey,
        mint: Pubkey,
        deposited_total: u64,
        expires_at: i64,
    ) -> Self {
        Self {
            session,
            agent,
            provider,
            mint,
            deposited_total,
            expires_at,
            cumulative_accepted: 0,
            last_nonce: None,
            highest_claim: None,
            is_settled: false,
        }
    }
}

/// Why a claim was refused by the state tracker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimRejection {
    SessionExpired,
    SessionSettled,
    NotMonotonic,
    NonceNotMonotonic,
    ExceedsDeposit,
}

/// Accepted claim, with the delta it represents over the previous high-water mark.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaimAccepted {
    pub cumulative_amount: u64,
    pub previous_cumulative: u64,
    /// `cumulative_amount - previous_cumulative`, the incremental price.
    pub delta: u64,
    pub nonce: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("session state is unavailable")]
    Unavailable,
    #[error("session is already tracked")]
    AlreadyOpen,
    #[error("session is not tracked")]
    Unknown,
}

pub trait SessionStore: Send + Sync {
    fn open(&self, record: SessionRecord) -> Result<(), StoreError>;
    fn get(&self, session: &Pubkey) -> Result<SessionRecord, StoreError>;
    /// Validates ordering and, on success, advances the high-water mark.
    ///
    /// Must be atomic: two concurrent requests carrying the same claim have to
    /// serialise, or both would observe the same previous value and both be
    /// admitted.
    fn admit_claim(
        &self,
        claim: &Claim,
        signature: &[u8; 64],
        now: i64,
    ) -> Result<Result<ClaimAccepted, ClaimRejection>, StoreError>;
    fn mark_settled(&self, session: &Pubkey) -> Result<(), StoreError>;
}

/// Pure ordering rules, separated from storage so they can be tested directly
/// and reused by a durable implementation.
pub fn evaluate_claim(
    record: &SessionRecord,
    claim: &Claim,
    now: i64,
) -> Result<ClaimAccepted, ClaimRejection> {
    if record.is_settled {
        return Err(ClaimRejection::SessionSettled);
    }

    // Matches the program's permissive-direction skew handling, so the gateway
    // never accepts a claim the chain would reject as expired.
    let limit = record
        .expires_at
        .checked_add(crate::claim::CLOCK_SKEW_TOLERANCE_SECS)
        .unwrap_or(i64::MAX);
    if now > limit {
        return Err(ClaimRejection::SessionExpired);
    }

    // Strictly increasing: equal is a replay, lower is a regression.
    if claim.cumulative_amount <= record.cumulative_accepted {
        return Err(ClaimRejection::NotMonotonic);
    }

    if let Some(last) = record.last_nonce {
        if claim.nonce <= last {
            return Err(ClaimRejection::NonceNotMonotonic);
        }
    }

    if claim.cumulative_amount > record.deposited_total {
        return Err(ClaimRejection::ExceedsDeposit);
    }

    let delta = claim
        .cumulative_amount
        .checked_sub(record.cumulative_accepted)
        .ok_or(ClaimRejection::NotMonotonic)?;

    Ok(ClaimAccepted {
        cumulative_amount: claim.cumulative_amount,
        previous_cumulative: record.cumulative_accepted,
        delta,
        nonce: claim.nonce,
    })
}

/// Development-only store. See the module docs: a restart loses the high-water
/// mark and reopens claim replay.
pub struct InMemorySessionStore {
    inner: RwLock<HashMap<Pubkey, SessionRecord>>,
}

impl InMemorySessionStore {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
        }
    }

    /// Number of tracked sessions. Used by the health endpoint and tests.
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.inner.read().map(|g| g.len()).unwrap_or(0)
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for InMemorySessionStore {
    fn default() -> Self {
        Self::new()
    }
}

// A poisoned lock means another thread panicked mid-update, so the map may be
// torn. Fail closed rather than reading possibly-inconsistent state.
fn poisoned<T>(_: PoisonError<T>) -> StoreError {
    StoreError::Unavailable
}

impl SessionStore for InMemorySessionStore {
    fn open(&self, record: SessionRecord) -> Result<(), StoreError> {
        let mut guard = self.inner.write().map_err(poisoned)?;
        if guard.contains_key(&record.session) {
            return Err(StoreError::AlreadyOpen);
        }
        guard.insert(record.session, record);
        Ok(())
    }

    fn get(&self, session: &Pubkey) -> Result<SessionRecord, StoreError> {
        let guard = self.inner.read().map_err(poisoned)?;
        guard.get(session).cloned().ok_or(StoreError::Unknown)
    }

    fn admit_claim(
        &self,
        claim: &Claim,
        signature: &[u8; 64],
        now: i64,
    ) -> Result<Result<ClaimAccepted, ClaimRejection>, StoreError> {
        // Write lock for the whole read-decide-write cycle: concurrent
        // duplicates must serialise so only one can advance the mark.
        let mut guard = self.inner.write().map_err(poisoned)?;
        let record = guard.get_mut(&claim.session).ok_or(StoreError::Unknown)?;

        match evaluate_claim(record, claim, now) {
            Ok(accepted) => {
                record.cumulative_accepted = accepted.cumulative_amount;
                record.last_nonce = Some(accepted.nonce);
                // Monotonicity guarantees this claim is the new highest, so it
                // is always the one settlement should submit.
                record.highest_claim = Some(SignedClaim {
                    claim: *claim,
                    signature: *signature,
                });
                Ok(Ok(accepted))
            }
            Err(rejection) => Ok(Err(rejection)),
        }
    }

    fn mark_settled(&self, session: &Pubkey) -> Result<(), StoreError> {
        let mut guard = self.inner.write().map_err(poisoned)?;
        let record = guard.get_mut(session).ok_or(StoreError::Unknown)?;
        record.is_settled = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000_000;
    /// Ordering rules are what these tests exercise; signature validity is
    /// verify.rs's job, so a fixed placeholder is correct here.
    const SIG: [u8; 64] = [0u8; 64];

    fn session_key() -> Pubkey {
        Pubkey::new_from_array([1u8; 32])
    }

    fn record() -> SessionRecord {
        SessionRecord::new(
            session_key(),
            Pubkey::new_from_array([2u8; 32]),
            Pubkey::new_from_array([3u8; 32]),
            Pubkey::new_from_array([4u8; 32]),
            5_000_000,
            NOW + 3600,
        )
    }

    fn claim(cumulative: u64, nonce: u64) -> Claim {
        Claim {
            session: session_key(),
            cumulative_amount: cumulative,
            nonce,
            expires_at: NOW + 600,
        }
    }

    fn store_with_session() -> InMemorySessionStore {
        let store = InMemorySessionStore::new();
        store.open(record()).expect("opens");
        store
    }

    #[test]
    fn accepts_an_increasing_ladder_and_reports_deltas() {
        let store = store_with_session();
        for (i, (cum, expected_delta)) in
            [(100u64, 100u64), (250, 150), (251, 1)].into_iter().enumerate()
        {
            let accepted = store
                .admit_claim(&claim(cum, i as u64 + 1), &SIG, NOW)
                .expect("store ok")
                .expect("claim accepted");
            assert_eq!(accepted.delta, expected_delta);
            assert_eq!(accepted.cumulative_amount, cum);
        }
    }

    #[test]
    fn rejects_an_exact_replay() {
        let store = store_with_session();
        store.admit_claim(&claim(100, 1), &SIG, NOW).unwrap().unwrap();
        assert_eq!(
            store.admit_claim(&claim(100, 2), &SIG, NOW).unwrap(),
            Err(ClaimRejection::NotMonotonic)
        );
    }

    #[test]
    fn rejects_a_regression_to_a_lower_cumulative() {
        let store = store_with_session();
        store.admit_claim(&claim(500, 1), &SIG, NOW).unwrap().unwrap();
        assert_eq!(
            store.admit_claim(&claim(499, 2), &SIG, NOW).unwrap(),
            Err(ClaimRejection::NotMonotonic)
        );
    }

    #[test]
    fn rejects_a_reused_or_lowered_nonce() {
        let store = store_with_session();
        store.admit_claim(&claim(100, 5), &SIG, NOW).unwrap().unwrap();
        // Cumulative rises, but the sequence number does not.
        assert_eq!(
            store.admit_claim(&claim(200, 5), &SIG, NOW).unwrap(),
            Err(ClaimRejection::NonceNotMonotonic)
        );
        assert_eq!(
            store.admit_claim(&claim(200, 4), &SIG, NOW).unwrap(),
            Err(ClaimRejection::NonceNotMonotonic)
        );
    }

    #[test]
    fn a_rejected_claim_does_not_advance_the_mark() {
        let store = store_with_session();
        store.admit_claim(&claim(100, 1), &SIG, NOW).unwrap().unwrap();
        let _ = store.admit_claim(&claim(99, 2), &SIG, NOW).unwrap();
        // The next legitimate claim must still be measured against 100.
        let accepted = store
            .admit_claim(&claim(150, 2), &SIG, NOW)
            .unwrap()
            .expect("accepted");
        assert_eq!(accepted.previous_cumulative, 100);
        assert_eq!(accepted.delta, 50);
    }

    #[test]
    fn rejects_a_claim_above_the_deposit() {
        let store = store_with_session();
        assert_eq!(
            store.admit_claim(&claim(5_000_001, 1), &SIG, NOW).unwrap(),
            Err(ClaimRejection::ExceedsDeposit)
        );
        // Exactly the deposit is allowed.
        assert!(store.admit_claim(&claim(5_000_000, 1), &SIG, NOW).unwrap().is_ok());
    }

    #[test]
    fn rejects_claims_once_the_session_expires() {
        let store = store_with_session();
        let past = NOW + 3600 + crate::claim::CLOCK_SKEW_TOLERANCE_SECS + 1;
        assert_eq!(
            store.admit_claim(&claim(100, 1), &SIG, past).unwrap(),
            Err(ClaimRejection::SessionExpired)
        );
    }

    #[test]
    fn honours_skew_tolerance_at_the_boundary() {
        let store = store_with_session();
        let edge = NOW + 3600 + crate::claim::CLOCK_SKEW_TOLERANCE_SECS;
        assert!(store.admit_claim(&claim(100, 1), &SIG, edge).unwrap().is_ok());
    }

    #[test]
    fn rejects_claims_after_settlement() {
        let store = store_with_session();
        store.mark_settled(&session_key()).unwrap();
        assert_eq!(
            store.admit_claim(&claim(100, 1), &SIG, NOW).unwrap(),
            Err(ClaimRejection::SessionSettled)
        );
    }

    #[test]
    fn unknown_session_is_an_error_not_a_rejection() {
        let store = InMemorySessionStore::new();
        assert!(matches!(
            store.admit_claim(&claim(100, 1), &SIG, NOW),
            Err(StoreError::Unknown)
        ));
    }

    #[test]
    fn duplicate_open_is_refused() {
        let store = store_with_session();
        assert!(matches!(store.open(record()), Err(StoreError::AlreadyOpen)));
    }

    #[test]
    fn concurrent_duplicate_claims_admit_exactly_one() {
        use std::sync::Arc;
        use std::thread;

        let store = Arc::new(store_with_session());
        let barrier = Arc::new(std::sync::Barrier::new(16));
        let admitted = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let mut handles = Vec::new();
        for _ in 0..16 {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            let admitted = Arc::clone(&admitted);
            handles.push(thread::spawn(move || {
                barrier.wait();
                if let Ok(Ok(_)) = store.admit_claim(&claim(1_000, 1), &SIG, NOW) {
                    admitted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        // The whole point of holding the write lock across read-decide-write.
        assert_eq!(
            admitted.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the same claim was admitted more than once"
        );
    }
}
