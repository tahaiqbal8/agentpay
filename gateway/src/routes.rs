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
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::chain::{verify_on_chain_session, ClaimedSession, SessionAccountFetcher, SessionVerificationError};
use crate::claim::ClaimWire;
use crate::db::Database;
use crate::error::{Denial, ReasonCode};
use crate::evidence::{verify_chain, MerkleTree};
use crate::settle::{submit_settlement, SettleError};
use crate::state::{ClaimRejection, SessionRecord, SessionStore, StoreError};
use crate::verify::{verify_claim_signature, SignatureVerdict};

pub struct AppState {
    pub store: Arc<dyn SessionStore>,
    /// Same object as `store` when Postgres is configured, exposed concretely
    /// because the evidence log is not part of the `SessionStore` abstraction.
    /// `None` on the in-memory store, which keeps no evidence.
    pub db: Option<Arc<Database>>,
    /// False while running on the non-durable in-memory store.
    pub durable_state: bool,
    pub program_id: Pubkey,
    /// Injected so tests can drive expiry deterministically.
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// None when running verify-only with no signing key configured.
    pub rpc: Option<Arc<RpcClient>>,
    pub provider_keypair: Option<Arc<Keypair>>,
    /// Reads `Session` accounts for `/v1/session/open` reconciliation.
    /// `None` only when reconciliation is explicitly disabled.
    pub session_fetcher: Option<Arc<dyn SessionAccountFetcher>>,
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

fn hex32(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn reconciliation_code(e: &SessionVerificationError) -> ReasonCode {
    match e {
        SessionVerificationError::AccountNotFound => ReasonCode::ERR_SESSION_ACCOUNT_NOT_FOUND,
        SessionVerificationError::DepositMismatch { .. } => ReasonCode::ERR_DEPOSIT_MISMATCH,
        SessionVerificationError::FieldMismatch { .. } => ReasonCode::ERR_SESSION_FIELD_MISMATCH,
        SessionVerificationError::AlreadySettled => ReasonCode::ERR_SESSION_SETTLED,
        SessionVerificationError::WrongProgramOwner { .. }
        | SessionVerificationError::InvalidAccountData(_)
        | SessionVerificationError::NotASessionAccount => {
            ReasonCode::ERR_NOT_A_SESSION_ACCOUNT
        }
        // Fail closed: an unreachable node denies rather than trusting input.
        SessionVerificationError::RpcUnavailable => ReasonCode::ERR_CHAIN_UNAVAILABLE,
    }
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
// GET /   — API index
//
// Exists because a bare 404 here is a confusing first impression: the natural
// thing to try after `docker compose up` is the port in the logs, and this is a
// JSON API with no page at `/`. Saying where the UI lives costs one route.
// --------------------------------------------------------------------------

#[derive(Serialize)]
pub struct IndexResponse {
    pub service: &'static str,
    pub description: &'static str,
    pub note: &'static str,
    pub console: &'static str,
    pub program_id: String,
    pub endpoints: Vec<&'static str>,
}

pub async fn index(State(state): State<Arc<AppState>>) -> Json<IndexResponse> {
    Json(IndexResponse {
        service: "agentpay-gateway",
        description: "Enforcement and audit layer for agent payments on Solana.",
        note: "This is a JSON API, not a web page. The operator console is a separate service.",
        console: "http://localhost:3100",
        program_id: state.program_id.to_string(),
        endpoints: vec![
            "GET  /health",
            "GET  /v1/sessions",
            "GET  /v1/decisions/recent",
            "GET  /v1/session/{pubkey}/evidence",
            "POST /v1/session/open",
            "POST /v1/claim/verify",
            "POST /v1/session/settle",
            "POST /v1/evidence/proof",
        ],
    })
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
    /// "POSTGRES" or "EPHEMERAL_IN_MEMORY".
    pub state_backend: &'static str,
}

pub async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        program_id: state.program_id.to_string(),
        ephemeral_state: !state.durable_state,
        state_backend: if state.durable_state {
            "POSTGRES"
        } else {
            "EPHEMERAL_IN_MEMORY"
        },
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

    // Reconcile against the chain before believing any of it (D8). Without
    // this the endpoint mints credit: a caller could assert a deposit that was
    // never escrowed and have claims authorised against it.
    match &state.session_fetcher {
        Some(fetcher) => {
            let claimed = ClaimedSession {
                agent,
                provider,
                mint,
                deposited_total,
                expires_at,
            };
            let account = verify_on_chain_session(
                fetcher.as_ref(),
                &state.program_id,
                &session,
                &claimed,
            )
            .await
            .map_err(|e| {
                warn!(
                    request_id = %rid,
                    session = %session,
                    error = %e,
                    "on-chain reconciliation refused this session"
                );
                Denial::new(reconciliation_code(&e), &rid)
            })?;
            info!(
                request_id = %rid,
                session = %session,
                on_chain_deposit = account.deposited_total,
                "session reconciled against chain"
            );
        }
        None => {
            warn!(
                request_id = %rid,
                session = %session,
                "AGENTPAY_TRUST_OPEN_REQUESTS is set: accepting unverified session claims"
            );
        }
    }

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
        .await
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
        state_durability: if state.durable_state {
            "POSTGRES"
        } else {
            "EPHEMERAL_IN_MEMORY"
        },
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
        .await
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

    // 5. Ordering and bounds, atomically advancing the high-water mark and
    //    retaining this claim + signature as the one settlement will submit.
    let outcome = state
        .store
        .admit_claim(&claim, &signature, now)
        .await
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
    /// Optional 32-byte evidence Merkle root, hex or base58. Defaults to zero
    /// until the evidence log lands — a zero root means "no evidence committed",
    /// which is honest, rather than a fabricated digest.
    #[serde(default)]
    pub merkle_root: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SettleSessionResponse {
    pub decision: &'static str,
    pub session: String,
    /// The evidence root committed on-chain by this settlement, hex-encoded.
    pub merkle_root: String,
    /// How many decisions that root covers.
    pub evidence_entries: usize,
    /// The on-chain transaction signature. Real, confirmed, and verifiable.
    pub signature: String,
    pub cumulative_amount: String,
    pub nonce: String,
    pub provider_token_account: String,
    pub settlement_record: String,
    pub token_program: String,
    pub request_id: String,
}

fn parse_merkle_root(raw: &Option<String>) -> Option<[u8; 32]> {
    let Some(s) = raw else {
        return Some([0u8; 32]);
    };
    let bytes = if let Some(hex) = s.strip_prefix("0x") {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
            .collect::<Option<Vec<u8>>>()?
    } else {
        bs58::decode(s).into_vec().ok()?
    };
    bytes.try_into().ok()
}

/// Assembles and submits the on-chain settlement for a session.
///
/// Submits the *highest* claim the gateway accepted. Because claims are
/// cumulative and monotonic, that single claim settles the whole session — the
/// intermediate ones never need to reach the chain, which is the entire point
/// of the deferred scheme.
pub async fn settle_session(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SettleSessionRequest>,
) -> Result<Json<SettleSessionResponse>, Denial> {
    let rid = request_id();

    let Ok(session) = req.session.parse::<Pubkey>() else {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    };

    // The root is computed from the evidence log, not supplied by the caller.
    // An operator-chosen root would let the committed digest disagree with the
    // decisions actually recorded, which defeats the entire commitment.
    //
    // An explicit `merkle_root` in the request is honoured ONLY when no
    // evidence store exists, so a verify-only deployment can still settle.
    let mut evidence_count = 0usize;
    let merkle_root = match &state.db {
        Some(db) => match db.load_evidence_leaves(&session).await {
            Ok(leaves) => {
                evidence_count = leaves.len();
                MerkleTree::new(leaves).root()
            }
            Err(e) => {
                error!(request_id = %rid, session = %session, error = %e,
                       "could not compute evidence root");
                // Fail closed: settling with a wrong root is worse than not
                // settling, because the wrong root is permanent once on-chain.
                return Err(Denial::new(ReasonCode::ERR_EVIDENCE_UNAVAILABLE, &rid));
            }
        },
        None => {
            let Some(root) = parse_merkle_root(&req.merkle_root) else {
                return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
            };
            warn!(
                request_id = %rid,
                "no evidence store configured; committing the caller-supplied root \
                 (all zeroes unless overridden)"
            );
            root
        }
    };

    // Verify-only deployments have no signing key and cannot settle. Say so
    // explicitly rather than failing somewhere deeper.
    let (Some(rpc), Some(provider_keypair)) = (&state.rpc, &state.provider_keypair) else {
        warn!(request_id = %rid, "settle requested but no provider keypair is configured");
        return Err(Denial::new(ReasonCode::ERR_SETTLEMENT_UNAVAILABLE, &rid));
    };

    let record = state
        .store
        .get(&session)
        .await
        .map_err(|e| store_denial(e, &rid))?;

    if record.is_settled {
        return Err(Denial::new(ReasonCode::ERR_SESSION_SETTLED, &rid));
    }
    let Some(highest) = record.highest_claim else {
        return Err(Denial::new(ReasonCode::ERR_NOTHING_TO_SETTLE, &rid));
    };
    if provider_keypair.pubkey() != record.provider {
        error!(
            request_id = %rid,
            configured = %provider_keypair.pubkey(),
            expected = %record.provider,
            "configured provider key does not match the session's provider"
        );
        return Err(Denial::new(ReasonCode::ERR_WRONG_PROVIDER_KEY, &rid));
    }

    info!(
        request_id = %rid,
        session = %session,
        cumulative = highest.claim.cumulative_amount,
        nonce = highest.claim.nonce,
        "submitting settlement"
    );

    let outcome = submit_settlement(
        rpc,
        &state.program_id,
        provider_keypair,
        &session,
        &record.mint,
        &highest.claim,
        &highest.signature,
        &record.agent,
        &merkle_root,
    )
    .await
    .map_err(|e| {
        error!(request_id = %rid, session = %session, error = %e, "settlement failed");
        let code = match e {
            SettleError::Rpc(_) | SettleError::MintNotFound(_) => {
                ReasonCode::ERR_SETTLEMENT_FAILED
            }
        };
        Denial::new(code, &rid)
    })?;

    // Only after the chain confirms. Marking earlier would strand the session
    // as unsettleable if submission failed.
    if let Err(e) = state.store.mark_settled(&session).await {
        // The money moved; losing the local flag must not report failure.
        error!(
            request_id = %rid,
            session = %session,
            error = %e,
            signature = %outcome.signature,
            "settlement confirmed on chain but marking it locally failed"
        );
    }

    info!(
        request_id = %rid,
        session = %session,
        signature = %outcome.signature,
        cumulative = outcome.cumulative_amount,
        "settlement confirmed"
    );

    Ok(Json(SettleSessionResponse {
        decision: "SETTLED",
        session: session.to_string(),
        merkle_root: hex32(&merkle_root),
        evidence_entries: evidence_count,
        signature: outcome.signature,
        cumulative_amount: outcome.cumulative_amount.to_string(),
        nonce: outcome.nonce.to_string(),
        provider_token_account: outcome.provider_token_account.to_string(),
        settlement_record: outcome.settlement_record.to_string(),
        token_program: outcome.token_program.to_string(),
        request_id: rid,
    }))
}

// --------------------------------------------------------------------------
// GET /v1/session/{session}/evidence
// --------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct EvidenceEntryView {
    pub sequence_id: i64,
    pub decision: String,
    pub cumulative_amount: String,
    pub nonce: String,
    pub prev_hash: String,
    pub entry_hash: String,
}

#[derive(Debug, Serialize)]
pub struct SessionEvidenceResponse {
    pub session: String,
    pub merkle_root: String,
    pub entry_count: usize,
    /// Result of walking the hash chain server-side. An auditor should not
    /// trust this field — it is a convenience. Recompute the chain from
    /// `entries` and compare against the on-chain root instead.
    pub chain_valid: bool,
    pub chain_error: Option<String>,
    pub entries: Vec<EvidenceEntryView>,
    pub request_id: String,
}

pub async fn session_evidence(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(session_str): axum::extract::Path<String>,
) -> Result<Json<SessionEvidenceResponse>, Denial> {
    let rid = request_id();

    let Ok(session) = session_str.parse::<Pubkey>() else {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    };
    let Some(db) = &state.db else {
        return Err(Denial::new(ReasonCode::ERR_EVIDENCE_UNAVAILABLE, &rid));
    };

    let entries = db.load_evidence_chain(&session).await.map_err(|e| {
        error!(request_id = %rid, error = %e, "could not load evidence chain");
        Denial::new(ReasonCode::ERR_EVIDENCE_UNAVAILABLE, &rid)
    })?;

    let root = MerkleTree::new(entries.iter().map(|e| e.entry_hash).collect()).root();
    let chain_error = verify_chain(&session, &entries).err().map(|e| format!("{e:?}"));

    Ok(Json(SessionEvidenceResponse {
        session: session.to_string(),
        merkle_root: hex32(&root),
        entry_count: entries.len(),
        chain_valid: chain_error.is_none(),
        chain_error,
        entries: entries
            .iter()
            .map(|e| EvidenceEntryView {
                sequence_id: e.sequence_id,
                decision: e.decision.clone(),
                cumulative_amount: e.cumulative_amount.to_string(),
                nonce: e.nonce.to_string(),
                prev_hash: hex32(&e.prev_hash),
                entry_hash: hex32(&e.entry_hash),
            })
            .collect(),
        request_id: rid,
    }))
}

// --------------------------------------------------------------------------
// POST /v1/evidence/proof
// --------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct EvidenceProofRequest {
    pub session: String,
    /// Which decision to prove, by its per-session sequence number.
    pub sequence_id: i64,
}

#[derive(Debug, Serialize)]
pub struct ProofNodeView {
    pub hash: String,
    /// "left" or "right" — the side the sibling sits on. A verifier MUST
    /// respect this when concatenating, or the recomputed root will not match.
    pub side: &'static str,
}

#[derive(Debug, Serialize)]
pub struct EvidenceProofResponse {
    pub session: String,
    pub sequence_id: i64,
    pub decision: String,
    pub cumulative_amount: String,
    pub nonce: String,
    /// The leaf being proved: this entry's hash.
    pub leaf_hash: String,
    /// Root the proof reconstructs. Compare against the root committed on-chain
    /// by the settlement transaction — that comparison is the actual audit.
    pub merkle_root: String,
    pub leaf_index: usize,
    pub total_leaves: usize,
    pub proof: Vec<ProofNodeView>,
    /// Self-check that the returned proof reconstructs the returned root.
    /// Guards against this server shipping a malformed proof; it is NOT
    /// evidence of anything on its own, since both values come from here.
    pub verified_locally: bool,
    pub request_id: String,
}

/// Merkle inclusion proof for a single decision.
///
/// Lets a third party confirm that one specific decision — critically, a
/// *denial* — is covered by the root committed on-chain, without being given
/// the whole log. The denial is the product: an agent that was stopped is what
/// a finance team needs proof of.
pub async fn evidence_proof(
    State(state): State<Arc<AppState>>,
    Json(req): Json<EvidenceProofRequest>,
) -> Result<Json<EvidenceProofResponse>, Denial> {
    let rid = request_id();

    let Ok(session) = req.session.parse::<Pubkey>() else {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    };
    let Some(db) = &state.db else {
        return Err(Denial::new(ReasonCode::ERR_EVIDENCE_UNAVAILABLE, &rid));
    };

    let entries = db.load_evidence_chain(&session).await.map_err(|e| {
        error!(request_id = %rid, error = %e, "could not load evidence chain");
        Denial::new(ReasonCode::ERR_EVIDENCE_UNAVAILABLE, &rid)
    })?;

    // sequence_id is 0-based and contiguous, so it is also the leaf index.
    // verify_chain enforces that invariant; this looks the entry up rather than
    // assuming it, so a gap yields a clean 404 instead of an off-by-one proof.
    let Some(leaf_index) = entries.iter().position(|e| e.sequence_id == req.sequence_id) else {
        return Err(Denial::new(ReasonCode::ERR_EVIDENCE_NOT_FOUND, &rid));
    };
    let entry = &entries[leaf_index];

    let tree = MerkleTree::new(entries.iter().map(|e| e.entry_hash).collect());
    let root = tree.root();
    let Some(proof) = tree.proof(leaf_index) else {
        return Err(Denial::new(ReasonCode::ERR_EVIDENCE_NOT_FOUND, &rid));
    };

    let verified_locally =
        crate::evidence::verify_proof(&entry.entry_hash, &proof, &root);
    if !verified_locally {
        error!(
            request_id = %rid,
            session = %session,
            sequence_id = req.sequence_id,
            "generated a proof that does not verify against its own root"
        );
        return Err(Denial::new(ReasonCode::ERR_EVIDENCE_UNAVAILABLE, &rid));
    }

    Ok(Json(EvidenceProofResponse {
        session: session.to_string(),
        sequence_id: entry.sequence_id,
        decision: entry.decision.clone(),
        cumulative_amount: entry.cumulative_amount.to_string(),
        nonce: entry.nonce.to_string(),
        leaf_hash: hex32(&entry.entry_hash),
        merkle_root: hex32(&root),
        leaf_index,
        total_leaves: tree.leaf_count(),
        proof: proof
            .iter()
            .map(|n| ProofNodeView {
                hash: hex32(&n.hash),
                side: match n.side {
                    crate::evidence::Side::Left => "left",
                    crate::evidence::Side::Right => "right",
                },
            })
            .collect(),
        verified_locally,
        request_id: rid,
    }))
}

// --------------------------------------------------------------------------
// GET /v1/sessions   — the monitor's table + high-water-mark bars
// --------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct SessionSummaryView {
    pub session: String,
    pub agent: String,
    pub provider: String,
    pub mint: String,
    /// Micro-USDC as strings; a JS client would round these as JSON numbers.
    pub deposited_total: String,
    pub cumulative_accepted: String,
    pub remaining: String,
    pub last_nonce: Option<String>,
    pub expires_at: i64,
    pub is_settled: bool,
    pub evidence_count: i64,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct SessionListResponse {
    pub sessions: Vec<SessionSummaryView>,
    pub request_id: String,
}

pub async fn list_sessions(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SessionListResponse>, Denial> {
    let rid = request_id();
    let Some(db) = &state.db else {
        return Err(Denial::new(ReasonCode::ERR_EVIDENCE_UNAVAILABLE, &rid));
    };

    let rows = db.list_sessions(200).await.map_err(|e| {
        error!(request_id = %rid, error = %e, "could not list sessions");
        Denial::new(ReasonCode::ERR_STORE_UNAVAILABLE, &rid)
    })?;

    Ok(Json(SessionListResponse {
        sessions: rows
            .into_iter()
            .map(|s| SessionSummaryView {
                session: s.session.to_string(),
                agent: s.agent.to_string(),
                provider: s.provider.to_string(),
                mint: s.mint.to_string(),
                deposited_total: s.deposited_total.to_string(),
                cumulative_accepted: s.cumulative_accepted.to_string(),
                // Saturating: the invariant says this cannot go negative, but a
                // dashboard must not panic if the database ever disagrees.
                remaining: s
                    .deposited_total
                    .saturating_sub(s.cumulative_accepted)
                    .to_string(),
                last_nonce: s.last_nonce.map(|n| n.to_string()),
                expires_at: s.expires_at,
                is_settled: s.is_settled,
                evidence_count: s.evidence_count,
                created_at: s.created_at.to_rfc3339(),
            })
            .collect(),
        request_id: rid,
    }))
}

// --------------------------------------------------------------------------
// GET /v1/decisions/recent   — the live claim feed
// --------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct RecentDecisionView {
    pub session: String,
    pub sequence_id: i64,
    pub decision: String,
    pub allowed: bool,
    pub cumulative_amount: String,
    pub nonce: String,
    pub entry_hash: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct RecentDecisionsResponse {
    pub decisions: Vec<RecentDecisionView>,
    pub request_id: String,
}

pub async fn recent_decisions(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RecentDecisionsResponse>, Denial> {
    let rid = request_id();
    let Some(db) = &state.db else {
        return Err(Denial::new(ReasonCode::ERR_EVIDENCE_UNAVAILABLE, &rid));
    };

    let rows = db.recent_decisions(60).await.map_err(|e| {
        error!(request_id = %rid, error = %e, "could not load recent decisions");
        Denial::new(ReasonCode::ERR_EVIDENCE_UNAVAILABLE, &rid)
    })?;

    Ok(Json(RecentDecisionsResponse {
        decisions: rows
            .into_iter()
            .map(|d| RecentDecisionView {
                session: d.session.to_string(),
                sequence_id: d.sequence_id,
                allowed: d.decision == "ALLOWED",
                decision: d.decision,
                cumulative_amount: d.cumulative_amount.to_string(),
                nonce: d.nonce.to_string(),
                entry_hash: hex32(&d.entry_hash),
                created_at: d.created_at.to_rfc3339(),
            })
            .collect(),
        request_id: rid,
    }))
}
