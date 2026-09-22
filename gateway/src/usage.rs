//! SaaS usage metering.
//!
//! # This is billing, not enforcement
//!
//! Nothing in this module may ever decide whether a purchase succeeds. It is
//! called *after* a decision has already been made, it swallows every error it
//! meets, and it returns nothing the caller can branch on. A gateway that
//! refused a validly signed, correctly funded API call because a billing row
//! failed to insert would be a worse product than one that occasionally
//! under-bills.
//!
//! The failure direction is deliberate: **lose the record, never the call.**
//!
//! # Why this is not the evidence log
//!
//! `evidence_log` is a cryptographic record. Its row shape is frozen by the
//! hash preimage — `SHA256(prev ‖ session ‖ cumulative ‖ nonce ‖ decision)` —
//! and every Merkle root ever published depends on exactly those bytes.
//!
//! If billing read from that table, then one day a billing requirement would
//! argue for adding a column to it, and that argument must be impossible to
//! make. Two tables means a commercial need can never become a reason to
//! invalidate a historical proof.
//!
//! # Why a settlement is not a usage event
//!
//! Seven API calls settle in one Solana transaction. The customer is billed
//! for seven. Settlement is a payment mechanism, not a unit of consumption,
//! and counting settlements would under-count usage by whatever batching
//! factor the agent happened to choose.
//!
//! # Why refusals are billed
//!
//! Refusing a purchase is the work the provider is paying AgentPay to do. A
//! meter that counted only successful calls would charge nothing for the
//! feature that is the entire product.

use tracing::warn;

/// One metered decision.
///
/// Borrowed throughout: this is constructed on the hot path and dropped
/// immediately, and there is no reason to allocate for it.
#[derive(Debug)]
pub struct UsageEvent<'a> {
    /// The paying tenant. `None` on a legacy single-tenant deployment, or when
    /// the agent is not registered in the control plane.
    pub workspace_id: Option<&'a str>,
    /// Which provider served — or would have served — the call.
    pub provider_id: Option<&'a str>,
    pub agent_id: Option<&'a str>,
    pub session_pubkey: Option<&'a str>,
    pub resource: &'a str,
    /// The asking price, in micro-USDC, as quoted by the provider's catalogue.
    ///
    /// Recorded even for a refusal: what the agent *would* have been charged
    /// is the honest measure of the work done, and a refused call has a price
    /// even though no money moved.
    pub price: u64,
    /// `ALLOWED` or an `ERR_*` reason code, mirroring `evidence_log.decision`.
    pub decision: &'a str,
}

/// Records one usage event. Never fails, never blocks a decision.
///
/// Awaited rather than spawned, deliberately. The hot path already awaits
/// several database round trips, so one more adds no failure mode that was not
/// already there — and awaiting makes the record deterministic, which is what
/// lets a test assert on it instead of sleeping and hoping.
///
/// `price` arrives as `u64` and the column is `BIGINT`. A price above
/// `i64::MAX` is not a real price; it is clamped rather than dropped, because
/// losing the row would hide a call that happened.
pub async fn record(db: Option<&crate::db::Database>, event: UsageEvent<'_>) {
    let Some(db) = db else {
        // No control plane configured. Metering is a control-plane concern;
        // the money path runs fine without one.
        return;
    };

    let price = i64::try_from(event.price).unwrap_or(i64::MAX);

    let res = sqlx::query(
        r#"
        INSERT INTO usage_records (
            workspace_id, provider_id, agent_id, session_pubkey,
            resource, price, decision
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(event.workspace_id)
    .bind(event.provider_id)
    .bind(event.agent_id)
    .bind(event.session_pubkey)
    .bind(event.resource)
    .bind(price)
    .bind(event.decision)
    .execute(&db.pool)
    .await;

    if let Err(e) = res {
        // Loud, because silent under-billing is a revenue leak nobody notices
        // until a customer disputes an invoice. But still only a warning: the
        // call it describes has already been served or refused correctly.
        warn!(
            error = %e,
            resource = %event.resource,
            decision = %event.decision,
            "usage not metered — the decision stands, the billing row is lost"
        );
    }
}
