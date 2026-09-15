//! HTTP handlers.
//!
//! Verification order is deliberate and is documented per-step in
//! `verify_claim`. Cheap checks run before expensive ones so that a flood of
//! garbage claims cannot force the gateway to spend ~60µs of Ed25519 work per
//! request. The program orders its checks the same way.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use solana_pubkey::Pubkey;
use tracing::{info, warn};
use uuid::Uuid;

use crate::claim::ClaimWire;
use crate::error::{Denial, ReasonCode};
use crate::state::{ClaimRejection, SessionRecord, SessionStore, StoreError};
use crate::verify::{verify_claim_signature, SignatureVerdict};

pub struct AppState {
    pub store: Arc<dyn SessionStore>,
    pub program_id: Pubkey,
    /// Injected so tests can drive expiry deterministically.
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl AppState {
    pub fn now(&self) -> i64 {
        (self.clock)()
    }
}

pub fn system_clock() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn request_id() -> String {
    Uuid::new_v4().to_string()
}

fn store_denial(e: StoreError, rid: &str) -> Denial {
    match e {
        // Fail closed: if state cannot be read, deny.
        StoreError::Unavailable => Denial::new(ReasonCode::ERR_STORE_UNAVAILABLE, rid),
        StoreError::Unknown => Denial::new(ReasonCode::ERR_SESSION_UNKNOWN, rid),
        StoreError::AlreadyOpen => Denial::new(ReasonCode::ERR_SESSION_ALREADY_OPEN, rid),
    }
}

// --------------------------------------------------------------------------
// GET /health
// --------------------------------------------------------------------------

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub program_id: String,
    /// True while the gateway is using the non-durable in-memory store.
    pub ephemeral_state: bool,
}

pub async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        program_id: state.program_id.to_string(),
        ephemeral_state: true,
    })
}

// --------------------------------------------------------------------------
// POST /v1/session/open
// --------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct OpenSessionRequest {
    pub session: String,
    pub agent: String,
    pub provider: String,
    pub mint: String,
    /// Micro-USDC, decimal string. See ClaimWire for why not a JSON number.
    pub deposited_total: String,
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
pub struct OpenSessionResponse {
    pub session: String,
    pub tracking: bool,
    pub request_id: String,
    /// Loud, machine-readable marker that this state does not survive restart.
    pub state_durability: &'static str,
}

pub async fn open_session(
    State(state): State<Arc<AppState>>,
    Json(req): Json<OpenSessionRequest>,
) -> Result<Json<OpenSessionResponse>, Denial> {
    let rid = request_id();

    let parse = |s: &str| s.parse::<Pubkey>().ok();
    let (Some(session), Some(agent), Some(provider), Some(mint)) = (
        parse(&req.session),
        parse(&req.agent),
        parse(&req.provider),
        parse(&req.mint),
    ) else {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    };

    let (Ok(deposited_total), Ok(expires_at)) = (
        req.deposited_total.parse::<u64>(),
        req.expires_at.parse::<i64>(),
    ) else {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    };

    // NOTE: this records what the caller *claims* the session is. It is not yet
    // reconciled against the on-chain Session account, so a caller could
    // overstate deposited_total and get claims admitted that settlement would
    // later reject. Reconciliation lands with the RPC client; until then this
    // endpoint is trusted-input. Tracked in docs/decisions.md D8.
    let record = SessionRecord::new(
        session,
        agent,
        provider,
        mint,
        deposited_total,
        expires_at,
    );

    state
        .store
        .open(record)
        .map_err(|e| store_denial(e, &rid))?;

    info!(
        request_id = %rid,
        session = %session,
        agent = %agent,
        deposited_total,
        "session tracking opened"
    );

    Ok(Json(OpenSessionResponse {
        session: session.to_string(),
        tracking: true,
        request_id: rid,
        state_durability: "EPHEMERAL_IN_MEMORY",
    }))
}

// --------------------------------------------------------------------------
// POST /v1/claim/verify
// --------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct VerifyClaimRequest {
    pub claim: ClaimWire,
}

#[derive(Debug, Serialize)]
pub struct VerifyClaimResponse {
    pub decision: &'static str,
    pub session: String,
    pub cumulative_amount: String,
    pub previous_cumulative: String,
    /// The incremental price this claim authorises, in micro-USDC.
    pub delta: String,
    pub nonce: String,
    pub request_id: String,
}

pub async fn verify_claim(
    State(state): State<Arc<AppState>>,
    Json(req): Json<VerifyClaimRequest>,
) -> Result<Json<VerifyClaimResponse>, Denial> {
    let rid = request_id();
    let now = state.now();

    // 1. Shape. Pure parsing, no I/O.
    let Ok((claim, signature)) = req.claim.decode() else {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_CLAIM, &rid));
    };

    // 2. Claim's own expiry. A single comparison, and it needs no session.
    if claim.is_expired(now) {
        warn!(request_id = %rid, session = %claim.session, "claim expired");
        return Err(Denial::new(ReasonCode::ERR_CLAIM_EXPIRED, &rid));
    }

    // 3. Session lookup, to obtain the agent key. The key MUST come from here
    //    and never from the request, or anyone could sign their own claims.
    let record = state
        .store
        .get(&claim.session)
        .map_err(|e| store_denial(e, &rid))?;

    // 4. Signature. The expensive step, so it runs after the cheap filters.
    //
    //    Ordering caveat, stated deliberately: because ordering and bounds are
    //    checked in step 5 *after* this, an unauthenticated caller cannot probe
    //    session state — they must hold the agent key to get past here. That is
    //    the reason signature verification precedes the state checks rather
    //    than following them, even though the state checks are cheaper.
    if verify_claim_signature(&record.agent, &claim, &signature) != SignatureVerdict::Valid {
        warn!(
            request_id = %rid,
            session = %claim.session,
            "claim signature invalid"
        );
        return Err(Denial::new(ReasonCode::ERR_INVALID_SIGNATURE, &rid));
    }

    // 5. Ordering and bounds, atomically advancing the high-water mark.
    let outcome = state
        .store
        .admit_claim(&claim, now)
        .map_err(|e| store_denial(e, &rid))?;

    let accepted = match outcome {
        Ok(accepted) => accepted,
        Err(rejection) => {
            let code = match rejection {
                ClaimRejection::SessionExpired => ReasonCode::ERR_SESSION_EXPIRED,
                ClaimRejection::SessionSettled => ReasonCode::ERR_SESSION_SETTLED,
                ClaimRejection::NotMonotonic => ReasonCode::ERR_CLAIM_NOT_MONOTONIC,
                ClaimRejection::NonceNotMonotonic => ReasonCode::ERR_NONCE_NOT_MONOTONIC,
                ClaimRejection::ExceedsDeposit => ReasonCode::ERR_CLAIM_EXCEEDS_DEPOSIT,
            };
            warn!(
                request_id = %rid,
                session = %claim.session,
                reason_code = code.as_str(),
                "claim denied"
            );
            return Err(Denial::new(code, &rid));
        }
    };

    info!(
        request_id = %rid,
        session = %claim.session,
        cumulative = accepted.cumulative_amount,
        delta = accepted.delta,
        nonce = accepted.nonce,
        "claim accepted"
    );

    Ok(Json(VerifyClaimResponse {
        decision: "ALLOW",
        session: claim.session.to_string(),
        cumulative_amount: accepted.cumulative_amount.to_string(),
        previous_cumulative: accepted.previous_cumulative.to_string(),
        delta: accepted.delta.to_string(),
        nonce: accepted.nonce.to_string(),
        request_id: rid,
    }))
}

// --------------------------------------------------------------------------
// POST /v1/session/settle
// --------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct SettleSessionRequest {
    pub session: String,
}

/// NOT IMPLEMENTED.
///
/// Submitting the settlement means building a transaction with the Ed25519
/// precompile instruction plus `settle_session`, signing as the provider, and
/// confirming it — which needs the Solana RPC client that is not wired up yet.
///
/// This returns 501 with `ERR_NOT_IMPLEMENTED` rather than a fabricated
/// signature. Per operating rule 0.2, a stub must be visibly a stub.
pub async fn settle_session(
    State(_state): State<Arc<AppState>>,
    Json(req): Json<SettleSessionRequest>,
) -> Result<Json<serde_json::Value>, Denial> {
    let rid = request_id();
    warn!(
        request_id = %rid,
        session = %req.session,
        "settle_session called but is not implemented"
    );
    Err(Denial::new(ReasonCode::ERR_NOT_IMPLEMENTED, &rid))
}
