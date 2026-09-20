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

/// Guards the control-plane routes.
///
/// Fails closed in every direction: no token configured and a non-loopback
/// bind is refused at boot, so by the time a request arrives the only two
/// states are "no token required, loopback only" and "token required".
pub async fn require_admin(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Result<Response, Denial> {
    let Some(expected) = state.admin_token.as_deref() else {
        // Reachable only on a loopback bind; `Config` refuses to start
        // otherwise. The warning was already emitted once at boot rather than
        // per request, which would drown the log.
        return Ok(next.run(req).await);
    };

    let headers = req.headers();
    let presented = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(bearer)
        .or_else(|| headers.get(ADMIN_HEADER).and_then(|v| v.to_str().ok()));

    match presented {
        Some(token) if secret_eq(token, expected) => Ok(next.run(req).await),
        _ => {
            let rid = request_id();
            // The path is logged, the token never is — not even a prefix.
            // A rejected guess in a log file is still a guess someone can read.
            tracing::warn!(
                request_id = %rid,
                path = %req.uri().path(),
                "control-plane request rejected: missing or invalid admin token"
            );
            Err(Denial::new(ReasonCode::ERR_UNAUTHORIZED, &rid))
        }
    }
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
