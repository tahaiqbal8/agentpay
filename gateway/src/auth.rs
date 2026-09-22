//! Authentication for the control plane.
//!
//! # What this closes
//!
//! The control plane added operations that need no signature: creating an
//! agent, setting its envelope, suspending it, registering a provider, and
//! deciding an approval. Before it existed, an unauthenticated caller could do
//! almost nothing — every money-path request needs a valid Ed25519 signature
//! over a claim, and every session is reconciled against the chain.
//!
//! Without this module, anyone who can reach the port can **approve their own
//! pending spend**, which defeats human-controlled mode entirely, and can
//! **suspend somebody else's agent**, which is a denial of service against a
//! running workload.
//!
//! # What it deliberately does NOT cover
//!
//! The money path stays open: `/v1/buy`, `/v1/claim/verify` and the session
//! endpoints are protected by signatures and on-chain reconciliation, and
//! putting a shared secret in front of them would break every agent while
//! adding nothing. The public verification endpoints — evidence, proofs,
//! `/v1/catalogue` — stay open on purpose: a third party being able to check a
//! decision without the operator's permission is the product.
//!
//! # The boot rule
//!
//! A token is optional only while the gateway is bound to a loopback address.
//! Bound anywhere else, an absent or weak token is **fatal at startup**. That
//! ordering matters: the failure happens when the operator is watching a
//! deploy, not silently at the first request from a stranger.

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::error::{Denial, ReasonCode};
use crate::routes::{request_id, AppState};

/// Header an operator may use instead of `Authorization: Bearer`.
pub const ADMIN_HEADER: &str = "x-agentpay-admin-token";

/// Shortest token accepted.
///
/// Not a strength guarantee — it rejects the tokens people type when they mean
/// "turn this off", like `admin` or `1234`, which would be worse than no token
/// because they look like security.
pub const MIN_TOKEN_LEN: usize = 16;

/// Compares two secrets without leaking which byte differed, or how long the
/// presented value was.
///
/// Digesting both sides first means the comparison is always over 32 bytes, so
/// neither the content nor the length of the guess is observable in timing. A
/// plain `==` on the raw strings would short-circuit at the first differing
/// byte and let an attacker recover the token one character at a time.
fn secret_eq(presented: &str, expected: &str) -> bool {
    let a = Sha256::digest(presented.as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Extracts a bearer token from an `Authorization` header.
fn bearer(raw: &str) -> Option<&str> {
    let rest = raw.strip_prefix("Bearer ").or_else(|| raw.strip_prefix("bearer "))?;
    let t = rest.trim();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// SHA-256 hex of a token, as stored in `operators.token_hash`.
pub fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Who is making a control-plane request.
///
/// Flows into handlers through request extensions so an approval can record
/// its approver. Carries no secret.
#[derive(Debug, Clone)]
pub struct Operator {
    pub operator_id: String,
    pub label: String,
    /// The tenant this caller may act within.
    ///
    /// `None` means **unscoped legacy admin** — the shared `AGENTPAY_ADMIN_TOKEN`,
    /// or a per-operator credential created before workspaces existed. Such a
    /// caller sees every tenant.
    ///
    /// That is a migration affordance with a real cost, and it is stated here
    /// rather than buried: while any unscoped credential exists, the tenant
    /// boundary is only as strong as the handling of that credential. It is
    /// break-glass, and it should be retired once every operator has been
    /// assigned to a workspace.
    pub workspace_id: Option<String>,
    /// `owner` may invite members and change the plan. `member` does everything
    /// else. Legacy rows carry `operator`, which is treated as `owner`.
    ///
    /// Stored and resolved in Phase 3; enforced in Phase 4, when the endpoints
    /// that distinguish the two roles exist.
    #[allow(dead_code)]
    pub role: String,
}

// `role`, `is_scoped` and `is_owner` are resolved and carried now but not yet
// enforced anywhere: the endpoints that need them — inviting a member, changing
// a plan — are Phase 4, which is deliberately not built yet. Kept rather than
// deleted so that the credential a Phase 3 deployment mints already carries the
// right role, and Phase 4 does not need a second migration to backfill one.
#[allow(dead_code)]
impl Operator {
    /// True when this caller is confined to one tenant.
    ///
    /// The inverse — an unscoped caller — is what legacy deployments rely on,
    /// so it is named rather than implied by a bare `is_none()` at each call
    /// site.
    pub fn is_scoped(&self) -> bool {
        self.workspace_id.is_some()
    }

    /// True when the caller may manage members and the subscription.
    pub fn is_owner(&self) -> bool {
        self.role == "owner" || self.role == "operator"
    }
}

/// The id used when the shared `AGENTPAY_ADMIN_TOKEN` authenticated a request.
///
/// A real id rather than `None`, because the trail should say *something*
/// truthful: "whoever held the shared token". Recording that is more useful
/// than a blank, and it makes deployments that have not yet moved to
/// per-operator credentials visible in the audit rather than silent.
pub const SHARED_TOKEN_OPERATOR: &str = "op_shared_token";

/// Guards the control-plane routes and resolves the caller to an `Operator`.
///
/// Two credentials are accepted, in this order:
///
/// 1. `AGENTPAY_ADMIN_TOKEN`, the shared secret. Kept working so no existing
///    deployment breaks, and so there is a way to bootstrap the first
///    per-operator credential. Resolves to `SHARED_TOKEN_OPERATOR`.
/// 2. A per-operator token, looked up by SHA-256 hash in `operators`.
///
/// The shared token is checked FIRST and needs no database. That ordering
/// matters during an incident: if Postgres is unreachable, an operator holding
/// the shared token can still act, while an unknown token is refused rather
/// than admitted. Fails closed in every direction.
pub async fn require_admin(
    State(state): State<Arc<AppState>>,
    mut req: Request,
    next: Next,
) -> Result<Response, Denial> {
    let headers = req.headers();
    let presented = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(bearer)
        .or_else(|| headers.get(ADMIN_HEADER).and_then(|v| v.to_str().ok()))
        .map(str::to_string);

    // No token configured at all: reachable only on a loopback bind, because
    // `Config` refuses to start otherwise. The warning was emitted once at
    // boot rather than per request, which would drown the log.
    if state.admin_token.is_none() {
        req.extensions_mut().insert(Operator {
            operator_id: SHARED_TOKEN_OPERATOR.to_string(),
            label: "Unauthenticated (loopback)".to_string(),
            workspace_id: None,
            role: "owner".to_string(),
        });
        return Ok(next.run(req).await);
    }

    let rid = request_id();
    let Some(token) = presented else {
        return Err(reject(&rid, req.uri().path(), "no token presented"));
    };

    // 1. The shared token. No database needed, so it keeps working when
    //    Postgres does not.
    if let Some(expected) = state.admin_token.as_deref() {
        if secret_eq(&token, expected) {
            req.extensions_mut().insert(Operator {
                operator_id: SHARED_TOKEN_OPERATOR.to_string(),
                label: "Shared admin token".to_string(),
                // The shared token is deliberately unscoped: it is the
                // break-glass credential, and an incident is the worst moment
                // to discover it cannot see the tenant that is on fire.
                workspace_id: None,
                role: "owner".to_string(),
            });
            return Ok(next.run(req).await);
        }
    }

    // 2. A per-operator token. An unreadable database refuses rather than
    //    guessing — the same rule the money path applies.
    let Some(db) = state.db.as_ref() else {
        return Err(reject(&rid, req.uri().path(), "no per-operator store"));
    };

    match db.operator_by_token_hash(&token_hash(&token)).await {
        Ok(Some(op)) => {
            // Best effort: a failed timestamp update must not refuse a
            // legitimate request. It is informational, not a control.
            let _ = db.touch_operator(&op.operator_id).await;
            tracing::info!(
                request_id = %rid,
                operator_id = %op.operator_id,
                path = %req.uri().path(),
                "control-plane request authenticated"
            );
            req.extensions_mut().insert(Operator {
                operator_id: op.operator_id,
                label: op.label,
                workspace_id: op.workspace_id,
                role: op.role,
            });
            Ok(next.run(req).await)
        }
        Ok(None) => Err(reject(&rid, req.uri().path(), "unknown or disabled token")),
        Err(e) => {
            tracing::warn!(request_id = %rid, error = %e, "operator lookup failed");
            Err(reject(&rid, req.uri().path(), "operator lookup failed"))
        }
    }
}

/// One rejection path, so every refusal logs the same way and none of them
/// ever logs the token — not even a prefix. A rejected guess in a log file is
/// still a guess somebody can read.
fn reject(rid: &str, path: &str, why: &str) -> Denial {
    tracing::warn!(
        request_id = %rid,
        %path,
        reason = %why,
        "control-plane request rejected"
    );
    Denial::new(ReasonCode::ERR_UNAUTHORIZED, rid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_correct_token_matches_and_a_wrong_one_does_not() {
        assert!(secret_eq("correct-horse-battery", "correct-horse-battery"));
        assert!(!secret_eq("correct-horse-batterx", "correct-horse-battery"));
        assert!(!secret_eq("", "correct-horse-battery"));
    }

    #[test]
    fn a_prefix_of_the_token_does_not_match() {
        // The case a short-circuiting comparison would leak: an attacker
        // lengthening a guess and timing the response.
        assert!(!secret_eq("correct-horse", "correct-horse-battery"));
        assert!(!secret_eq("correct-horse-battery-and-more", "correct-horse-battery"));
    }

    #[test]
    fn bearer_is_parsed_but_a_bare_header_is_not_mistaken_for_one() {
        assert_eq!(bearer("Bearer abc123"), Some("abc123"));
        assert_eq!(bearer("bearer abc123"), Some("abc123"));
        assert_eq!(bearer("Bearer  padded  "), Some("padded"));
        // Anything that is not a bearer scheme is rejected rather than being
        // read as a raw token, which would accept `Basic <base64>` as if the
        // base64 were the secret.
        assert_eq!(bearer("abc123"), None);
        assert_eq!(bearer("Basic abc123"), None);
        assert_eq!(bearer("Bearer "), None);
        assert_eq!(bearer(""), None);
    }
}
