//! Machine-readable reason codes.
//!
//! Every allow and every deny carries one of these. They appear in the API
//! response, the logs, and eventually the dashboard and the evidence log, so
//! they are a stable interface — renaming one is a breaking change.
//!
//! Codes mirror the program's `AgentPayError` names where the same rule is
//! enforced in both places, so a denial can be traced across the boundary.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

// The variant names ARE the wire codes; they appear verbatim in API responses,
// logs, and the dashboard. Renaming them to CamelCase would either change the
// contract or force a hand-written mapping that could drift from the enum.
#[allow(non_camel_case_types)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ReasonCode {
    // --- request shape ---
    ERR_MALFORMED_CLAIM,
    ERR_MALFORMED_REQUEST,

    // --- session state ---
    ERR_SESSION_UNKNOWN,
    ERR_SESSION_ALREADY_OPEN,
    ERR_SESSION_EXPIRED,
    ERR_SESSION_SETTLED,

    // --- claim validity ---
    ERR_CLAIM_EXPIRED,
    ERR_CLAIM_NOT_MONOTONIC,
    ERR_NONCE_NOT_MONOTONIC,
    ERR_CLAIM_EXCEEDS_DEPOSIT,
    ERR_INVALID_SIGNATURE,

    // --- settlement ---
    ERR_NOTHING_TO_SETTLE,
    ERR_WRONG_PROVIDER_KEY,
    ERR_SETTLEMENT_UNAVAILABLE,
    ERR_SETTLEMENT_FAILED,

    // --- on-chain reconciliation ---
    ERR_SESSION_ACCOUNT_NOT_FOUND,
    ERR_DEPOSIT_MISMATCH,
    ERR_SESSION_FIELD_MISMATCH,
    ERR_NOT_A_SESSION_ACCOUNT,
    ERR_CHAIN_UNAVAILABLE,

    // --- paid resource access ---
    ERR_UPSTREAM_NOT_CONFIGURED,
    ERR_UPSTREAM_UNAVAILABLE,
    ERR_UNKNOWN_RESOURCE,
    ERR_PRICE_MISMATCH,

    // --- evidence log ---
    ERR_EVIDENCE_UNAVAILABLE,
    ERR_EVIDENCE_NOT_FOUND,

    // --- infrastructure: always deny, never allow ---
    ERR_STORE_UNAVAILABLE,
}

impl ReasonCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ERR_MALFORMED_CLAIM => "ERR_MALFORMED_CLAIM",
            Self::ERR_MALFORMED_REQUEST => "ERR_MALFORMED_REQUEST",
            Self::ERR_SESSION_UNKNOWN => "ERR_SESSION_UNKNOWN",
            Self::ERR_SESSION_ALREADY_OPEN => "ERR_SESSION_ALREADY_OPEN",
            Self::ERR_SESSION_EXPIRED => "ERR_SESSION_EXPIRED",
            Self::ERR_SESSION_SETTLED => "ERR_SESSION_SETTLED",
            Self::ERR_CLAIM_EXPIRED => "ERR_CLAIM_EXPIRED",
            Self::ERR_CLAIM_NOT_MONOTONIC => "ERR_CLAIM_NOT_MONOTONIC",
            Self::ERR_NONCE_NOT_MONOTONIC => "ERR_NONCE_NOT_MONOTONIC",
            Self::ERR_CLAIM_EXCEEDS_DEPOSIT => "ERR_CLAIM_EXCEEDS_DEPOSIT",
            Self::ERR_INVALID_SIGNATURE => "ERR_INVALID_SIGNATURE",
            Self::ERR_NOTHING_TO_SETTLE => "ERR_NOTHING_TO_SETTLE",
            Self::ERR_WRONG_PROVIDER_KEY => "ERR_WRONG_PROVIDER_KEY",
            Self::ERR_SETTLEMENT_UNAVAILABLE => "ERR_SETTLEMENT_UNAVAILABLE",
            Self::ERR_SETTLEMENT_FAILED => "ERR_SETTLEMENT_FAILED",
            Self::ERR_SESSION_ACCOUNT_NOT_FOUND => "ERR_SESSION_ACCOUNT_NOT_FOUND",
            Self::ERR_DEPOSIT_MISMATCH => "ERR_DEPOSIT_MISMATCH",
            Self::ERR_SESSION_FIELD_MISMATCH => "ERR_SESSION_FIELD_MISMATCH",
            Self::ERR_NOT_A_SESSION_ACCOUNT => "ERR_NOT_A_SESSION_ACCOUNT",
            Self::ERR_CHAIN_UNAVAILABLE => "ERR_CHAIN_UNAVAILABLE",
            Self::ERR_UPSTREAM_NOT_CONFIGURED => "ERR_UPSTREAM_NOT_CONFIGURED",
            Self::ERR_UPSTREAM_UNAVAILABLE => "ERR_UPSTREAM_UNAVAILABLE",
            Self::ERR_UNKNOWN_RESOURCE => "ERR_UNKNOWN_RESOURCE",
            Self::ERR_PRICE_MISMATCH => "ERR_PRICE_MISMATCH",
            Self::ERR_EVIDENCE_UNAVAILABLE => "ERR_EVIDENCE_UNAVAILABLE",
            Self::ERR_EVIDENCE_NOT_FOUND => "ERR_EVIDENCE_NOT_FOUND",
            Self::ERR_STORE_UNAVAILABLE => "ERR_STORE_UNAVAILABLE",
        }
    }

    /// Plain-language text intended for a human reading the dashboard.
    pub fn message(&self) -> &'static str {
        match self {
            Self::ERR_MALFORMED_CLAIM => "The claim could not be decoded.",
            Self::ERR_MALFORMED_REQUEST => "The request body was not valid.",
            Self::ERR_SESSION_UNKNOWN => "No such session is being tracked.",
            Self::ERR_SESSION_ALREADY_OPEN => "That session is already being tracked.",
            Self::ERR_SESSION_EXPIRED => "The session has expired and can no longer be used.",
            Self::ERR_SESSION_SETTLED => "The session has already settled.",
            Self::ERR_CLAIM_EXPIRED => "The claim's own expiry has passed.",
            Self::ERR_CLAIM_NOT_MONOTONIC => {
                "The cumulative amount did not increase over the last accepted claim."
            }
            Self::ERR_NONCE_NOT_MONOTONIC => {
                "The claim sequence number did not increase over the last accepted claim."
            }
            Self::ERR_CLAIM_EXCEEDS_DEPOSIT => {
                "The cumulative amount is larger than the session deposit."
            }
            Self::ERR_INVALID_SIGNATURE => "The claim signature is not valid for this session.",
            Self::ERR_NOTHING_TO_SETTLE => {
                "No claims were accepted for this session, so there is nothing to settle."
            }
            Self::ERR_WRONG_PROVIDER_KEY => {
                "The configured provider key does not match this session's provider."
            }
            Self::ERR_SETTLEMENT_UNAVAILABLE => {
                "This gateway runs in verify-only mode and cannot submit settlements."
            }
            Self::ERR_SETTLEMENT_FAILED => {
                "The settlement transaction could not be submitted or confirmed."
            }
            Self::ERR_SESSION_ACCOUNT_NOT_FOUND => {
                "No escrow session exists on chain at that address."
            }
            Self::ERR_DEPOSIT_MISMATCH => {
                "The deposit in the request does not match the escrowed amount on chain."
            }
            Self::ERR_SESSION_FIELD_MISMATCH => {
                "A session field in the request does not match the on-chain account."
            }
            Self::ERR_NOT_A_SESSION_ACCOUNT => {
                "That address does not hold an AgentPay session account."
            }
            Self::ERR_CHAIN_UNAVAILABLE => {
                "The session could not be verified against the chain, so it was refused."
            }
            Self::ERR_UPSTREAM_NOT_CONFIGURED => {
                "This gateway has no provider configured, so nothing can be bought."
            }
            Self::ERR_UPSTREAM_UNAVAILABLE => {
                "The provider could not be reached or priced, so the request was refused."
            }
            Self::ERR_UNKNOWN_RESOURCE => "The provider does not sell that resource.",
            Self::ERR_PRICE_MISMATCH => {
                "The claim does not cover this resource's price exactly."
            }
            Self::ERR_EVIDENCE_UNAVAILABLE => {
                "The evidence log could not be read, so no root could be produced."
            }
            Self::ERR_EVIDENCE_NOT_FOUND => {
                "No evidence entry exists at that sequence number."
            }
            Self::ERR_STORE_UNAVAILABLE => {
                "Session state could not be read, so the request was denied."
            }
        }
    }

    pub fn status(&self) -> StatusCode {
        match self {
            Self::ERR_MALFORMED_CLAIM | Self::ERR_MALFORMED_REQUEST => StatusCode::BAD_REQUEST,
            Self::ERR_SESSION_UNKNOWN | Self::ERR_SESSION_ACCOUNT_NOT_FOUND => {
                StatusCode::NOT_FOUND
            }
            Self::ERR_DEPOSIT_MISMATCH
            | Self::ERR_SESSION_FIELD_MISMATCH
            | Self::ERR_NOT_A_SESSION_ACCOUNT => StatusCode::BAD_REQUEST,
            Self::ERR_CHAIN_UNAVAILABLE => StatusCode::SERVICE_UNAVAILABLE,
            Self::ERR_SESSION_ALREADY_OPEN => StatusCode::CONFLICT,
            Self::ERR_INVALID_SIGNATURE => StatusCode::UNAUTHORIZED,
            // Every other denial is a policy/state decision, not a client error.
            Self::ERR_SESSION_EXPIRED
            | Self::ERR_SESSION_SETTLED
            | Self::ERR_CLAIM_EXPIRED
            | Self::ERR_CLAIM_NOT_MONOTONIC
            | Self::ERR_NONCE_NOT_MONOTONIC
            | Self::ERR_CLAIM_EXCEEDS_DEPOSIT
            | Self::ERR_NOTHING_TO_SETTLE
            | Self::ERR_WRONG_PROVIDER_KEY => StatusCode::FORBIDDEN,
            // Configuration and chain trouble: the caller did nothing wrong.
            Self::ERR_SETTLEMENT_UNAVAILABLE
            | Self::ERR_SETTLEMENT_FAILED
            | Self::ERR_EVIDENCE_UNAVAILABLE => StatusCode::SERVICE_UNAVAILABLE,
            Self::ERR_EVIDENCE_NOT_FOUND | Self::ERR_UNKNOWN_RESOURCE => StatusCode::NOT_FOUND,
            Self::ERR_PRICE_MISMATCH => StatusCode::PAYMENT_REQUIRED,
            Self::ERR_UPSTREAM_NOT_CONFIGURED | Self::ERR_UPSTREAM_UNAVAILABLE => {
                StatusCode::SERVICE_UNAVAILABLE
            }
            // Fail closed: an unreadable store is a denial, and 503 tells the
            // caller it may be worth retrying later.
            Self::ERR_STORE_UNAVAILABLE => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}

/// Error body returned to the agent.
///
/// Deliberately carries no internal detail: no RPC endpoints, no provider
/// credentials, no Rust error strings. The reason code is the contract.
#[derive(Debug, Serialize)]
pub struct ApiError {
    pub reason_code: &'static str,
    pub message: &'static str,
    pub request_id: String,
}

impl ApiError {
    pub fn new(code: ReasonCode, request_id: impl Into<String>) -> (StatusCode, Self) {
        (
            code.status(),
            Self {
                reason_code: code.as_str(),
                message: code.message(),
                request_id: request_id.into(),
            },
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        // Callers use `ApiError::new` to get an explicit status; this fallback
        // only fires if one is constructed directly.
        (StatusCode::INTERNAL_SERVER_ERROR, Json(self)).into_response()
    }
}

/// A denial carrying its status, for use as a handler `Err` type.
pub struct Denial(pub StatusCode, pub ApiError);

impl Denial {
    pub fn new(code: ReasonCode, request_id: &str) -> Self {
        let (status, body) = ApiError::new(code, request_id);
        Self(status, body)
    }
}

impl IntoResponse for Denial {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_unavailable_is_a_denial_not_a_pass() {
        // Fail-closed, stated as a test: infrastructure trouble must never
        // produce a 2xx.
        assert!(ReasonCode::ERR_STORE_UNAVAILABLE.status().is_server_error());
        assert!(!ReasonCode::ERR_STORE_UNAVAILABLE.status().is_success());
    }

    #[test]
    fn no_reason_code_maps_to_success() {
        let all = [
            ReasonCode::ERR_MALFORMED_CLAIM,
            ReasonCode::ERR_MALFORMED_REQUEST,
            ReasonCode::ERR_SESSION_UNKNOWN,
            ReasonCode::ERR_SESSION_ALREADY_OPEN,
            ReasonCode::ERR_SESSION_EXPIRED,
            ReasonCode::ERR_SESSION_SETTLED,
            ReasonCode::ERR_CLAIM_EXPIRED,
            ReasonCode::ERR_CLAIM_NOT_MONOTONIC,
            ReasonCode::ERR_NONCE_NOT_MONOTONIC,
            ReasonCode::ERR_CLAIM_EXCEEDS_DEPOSIT,
            ReasonCode::ERR_INVALID_SIGNATURE,
            ReasonCode::ERR_NOTHING_TO_SETTLE,
            ReasonCode::ERR_WRONG_PROVIDER_KEY,
            ReasonCode::ERR_SETTLEMENT_UNAVAILABLE,
            ReasonCode::ERR_SETTLEMENT_FAILED,
            ReasonCode::ERR_SESSION_ACCOUNT_NOT_FOUND,
            ReasonCode::ERR_DEPOSIT_MISMATCH,
            ReasonCode::ERR_SESSION_FIELD_MISMATCH,
            ReasonCode::ERR_NOT_A_SESSION_ACCOUNT,
            ReasonCode::ERR_CHAIN_UNAVAILABLE,
            ReasonCode::ERR_UPSTREAM_NOT_CONFIGURED,
            ReasonCode::ERR_UPSTREAM_UNAVAILABLE,
            ReasonCode::ERR_UNKNOWN_RESOURCE,
            ReasonCode::ERR_PRICE_MISMATCH,
            ReasonCode::ERR_EVIDENCE_UNAVAILABLE,
            ReasonCode::ERR_EVIDENCE_NOT_FOUND,
            ReasonCode::ERR_STORE_UNAVAILABLE,
        ];
        for c in all {
            assert!(!c.status().is_success(), "{} maps to 2xx", c.as_str());
            assert_eq!(c.as_str(), format!("{:?}", c));
        }
    }
}
