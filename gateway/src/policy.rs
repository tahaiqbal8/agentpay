//! The permission envelope a human grants an agent, and its evaluation.
//!
//! # What this is, and what it is not
//!
//! The on-chain escrow already bounds an agent absolutely: `deposited_total`
//! is a hard ceiling the program enforces, and no policy here can widen it.
//! This module adds a *narrower* bound that an operator can change without
//! touching the program — per-resource allowlists, a cap on one purchase, a
//! call count, and a threshold above which a human decides.
//!
//! The split is deliberate. Custody rules belong on-chain because they must
//! hold even if this process is compromised. Operational rules belong here
//! because they change often and a redeploy per change is untenable.
//!
//! Losing this table cannot cause overspend. It can only remove restrictions
//! the human layered on top of the deposit.
//!
//! # Ordering
//!
//! `evaluate` is a pure function for the same reason `state::evaluate_claim`
//! is: the ordering of checks is the specification, and it should be testable
//! without a database, a chain or an HTTP request.

use serde::{Deserialize, Serialize};

/// How an agent is permitted to act.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentMode {
    /// Spends at or above the approval threshold wait for a human decision.
    Human,
    /// The agent acts alone inside its envelope.
    Autonomous,
}

impl AgentMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::Autonomous => "autonomous",
        }
    }

    /// Unknown strings become `Human`, the more restrictive of the two.
    ///
    /// A corrupted or future-valued column must not silently grant autonomy.
    pub fn from_str_or_human(s: &str) -> Self {
        match s {
            "autonomous" => Self::Autonomous,
            _ => Self::Human,
        }
    }
}

/// Whether an agent may act at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Active,
    /// Revocation mid-session, which the escrow cannot express: it stops the
    /// agent without settling the session or stopping the gateway.
    Suspended,
}

impl AgentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Suspended => "suspended",
        }
    }

    /// Unknown strings become `Suspended`. Fail closed: an unreadable status
    /// must not read as permission to spend.
    pub fn from_str_or_suspended(s: &str) -> Self {
        match s {
            "active" => Self::Active,
            _ => Self::Suspended,
        }
    }
}

/// The envelope itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentPolicy {
    /// Ceiling across everything this agent spends.
    pub max_total: u64,
    /// Ceiling on one purchase.
    pub max_per_call: u64,
    /// At or above this, a human decides. `None` means never ask.
    pub approval_threshold: Option<u64>,
    /// `None` or empty means every resource the registry offers.
    pub allowed_resources: Option<Vec<String>>,
    /// `None` means unlimited.
    pub max_calls: Option<u32>,
}

/// What the agent has done so far, against which the envelope is measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Spend {
    /// Micro-USDC already committed by accepted claims.
    pub spent: u64,
    /// Purchases already admitted.
    pub calls: u32,
}

/// The outcome of evaluating one proposed purchase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyDecision {
    /// Within the envelope; proceed to the claim checks.
    Allow,
    /// Within the envelope but above the threshold, or the agent is in human
    /// mode: a person must decide before this can proceed.
    NeedsApproval,
    Refuse(PolicyRefusal),
}

/// Why a purchase was refused, one variant per rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyRefusal {
    /// The agent record is suspended.
    Suspended,
    /// This resource is not in the allowlist.
    ResourceNotAllowed,
    /// One purchase exceeds `max_per_call`.
    PriceCap,
    /// This purchase would take total spend past `max_total`.
    Budget,
    /// The call count is exhausted.
    CallLimit,
}

impl PolicyRefusal {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Suspended => "ERR_AGENT_SUSPENDED",
            Self::ResourceNotAllowed => "ERR_POLICY_RESOURCE_NOT_ALLOWED",
            Self::PriceCap => "ERR_POLICY_PRICE_CAP",
            Self::Budget => "ERR_POLICY_BUDGET",
            Self::CallLimit => "ERR_POLICY_CALL_LIMIT",
        }
    }
}

/// Normalises a resource path so an allowlist entry and a request agree.
///
/// The catalogue publishes `/weather`, a request may arrive as `weather`, and
/// a human typing an allowlist will produce either. Comparing the raw strings
/// would refuse a purchase the operator believes they permitted, which is a
/// silent, confusing denial.
pub fn normalise_resource(raw: &str) -> String {
    let trimmed = raw.trim().trim_start_matches('/');
    // Query strings are not part of the resource identity: `/weather?city=X`
    // and `/weather?city=Y` are the same priced resource.
    let without_query = trimmed.split('?').next().unwrap_or("");
    format!("/{}", without_query.trim_end_matches('/'))
}

/// Applies the envelope to one proposed purchase.
///
/// Order matters and is the specification:
///
/// 1. Status, because a suspended agent is refused whatever it asks for.
/// 2. Allowlist, because a forbidden resource is refused at any price.
/// 3. Per-call cap, which needs no history.
/// 4. Call count, then budget — both need history, and the budget is the
///    expensive one conceptually, so it goes last.
/// 5. Approval, evaluated only once the spend is known to be *permitted*.
///    Asking a human to approve something the policy would refuse anyway
///    wastes their attention and teaches them to approve reflexively.
pub fn evaluate(
    status: AgentStatus,
    mode: AgentMode,
    policy: &AgentPolicy,
    resource: &str,
    price: u64,
    so_far: Spend,
) -> PolicyDecision {
    if status != AgentStatus::Active {
        return PolicyDecision::Refuse(PolicyRefusal::Suspended);
    }

    if let Some(allowed) = policy.allowed_resources.as_ref() {
        // An empty list means "unrestricted", not "nothing allowed". A list
        // that is present but empty is what a form submits when the operator
        // left the field alone, and refusing everything there would be a
        // surprising reading of an unfilled field.
        if !allowed.is_empty() {
            let wanted = normalise_resource(resource);
            let permitted = allowed
                .iter()
                .any(|a| normalise_resource(a) == wanted);
            if !permitted {
                return PolicyDecision::Refuse(PolicyRefusal::ResourceNotAllowed);
            }
        }
    }

    if price > policy.max_per_call {
        return PolicyDecision::Refuse(PolicyRefusal::PriceCap);
    }

    if let Some(limit) = policy.max_calls {
        if so_far.calls >= limit {
            return PolicyDecision::Refuse(PolicyRefusal::CallLimit);
        }
    }

    // Checked: a policy written with a huge max_total and a huge price must
    // refuse, never wrap into a small number that passes.
    let projected = match so_far.spent.checked_add(price) {
        Some(v) => v,
        None => return PolicyDecision::Refuse(PolicyRefusal::Budget),
    };
    if projected > policy.max_total {
        return PolicyDecision::Refuse(PolicyRefusal::Budget);
    }

    // Human mode asks for everything; autonomous mode asks only above the
    // threshold. A threshold of None in autonomous mode never asks.
    let needs_approval = match mode {
        AgentMode::Human => true,
        AgentMode::Autonomous => policy
            .approval_threshold
            .is_some_and(|t| price >= t),
    };

    if needs_approval {
        PolicyDecision::NeedsApproval
    } else {
        PolicyDecision::Allow
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> AgentPolicy {
        AgentPolicy {
            max_total: 1_000_000,
            max_per_call: 25_000,
            approval_threshold: None,
            allowed_resources: None,
            max_calls: None,
        }
    }

    fn fresh() -> Spend {
        Spend { spent: 0, calls: 0 }
    }

    fn autonomous(p: &AgentPolicy, resource: &str, price: u64, so_far: Spend) -> PolicyDecision {
        evaluate(
            AgentStatus::Active,
            AgentMode::Autonomous,
            p,
            resource,
            price,
            so_far,
        )
    }

    #[test]
    fn an_ordinary_purchase_inside_the_envelope_is_allowed() {
        assert_eq!(
            autonomous(&policy(), "/weather", 1_000, fresh()),
            PolicyDecision::Allow
        );
    }

    #[test]
    fn a_suspended_agent_is_refused_whatever_it_asks_for() {
        // Suspension outranks everything, including a purchase that would
        // otherwise be trivially fine. This is the revocation path.
        let d = evaluate(
            AgentStatus::Suspended,
            AgentMode::Autonomous,
            &policy(),
            "/weather",
            1,
            fresh(),
        );
        assert_eq!(d, PolicyDecision::Refuse(PolicyRefusal::Suspended));
    }

    #[test]
    fn an_unreadable_status_reads_as_suspended() {
        // Fail closed: a corrupted column must not grant spending.
        assert_eq!(
            AgentStatus::from_str_or_suspended("actve"),
            AgentStatus::Suspended
        );
        assert_eq!(AgentStatus::from_str_or_suspended(""), AgentStatus::Suspended);
        assert_eq!(
            AgentStatus::from_str_or_suspended("active"),
            AgentStatus::Active
        );
    }

    #[test]
    fn an_unreadable_mode_reads_as_human() {
        // Also fail closed: the unknown value must not grant autonomy.
        assert_eq!(AgentMode::from_str_or_human("autonomus"), AgentMode::Human);
        assert_eq!(AgentMode::from_str_or_human(""), AgentMode::Human);
        assert_eq!(
            AgentMode::from_str_or_human("autonomous"),
            AgentMode::Autonomous
        );
    }

    #[test]
    fn a_resource_outside_the_allowlist_is_refused_at_any_price() {
        let mut p = policy();
        p.allowed_resources = Some(vec!["/weather".into(), "/quote".into()]);
        assert_eq!(
            autonomous(&p, "/analyse", 1, fresh()),
            PolicyDecision::Refuse(PolicyRefusal::ResourceNotAllowed)
        );
        assert_eq!(autonomous(&p, "/weather", 1, fresh()), PolicyDecision::Allow);
    }

    #[test]
    fn allowlist_matching_survives_slashes_and_query_strings() {
        // The catalogue says "/weather", a request may say "weather?city=X",
        // and an operator may type either. Refusing on that difference would
        // deny a purchase the human believes they permitted.
        let mut p = policy();
        p.allowed_resources = Some(vec!["weather".into()]);
        for form in ["/weather", "weather", "/weather/", "weather?city=Lahore"] {
            assert_eq!(
                autonomous(&p, form, 1, fresh()),
                PolicyDecision::Allow,
                "form {form:?} should match the allowlist entry"
            );
        }
    }

    #[test]
    fn an_empty_allowlist_means_unrestricted_not_nothing() {
        // A form field left alone submits []. Reading that as "refuse
        // everything" would be a surprising interpretation of an unfilled box.
        let mut p = policy();
        p.allowed_resources = Some(vec![]);
        assert_eq!(autonomous(&p, "/anything", 1, fresh()), PolicyDecision::Allow);
    }

    #[test]
    fn one_purchase_above_the_per_call_cap_is_refused() {
        // Even with the whole budget free: the cap is about a single purchase.
        assert_eq!(
            autonomous(&policy(), "/analyse", 25_001, fresh()),
            PolicyDecision::Refuse(PolicyRefusal::PriceCap)
        );
        assert_eq!(
            autonomous(&policy(), "/analyse", 25_000, fresh()),
            PolicyDecision::Allow,
            "exactly at the cap is permitted"
        );
    }

    #[test]
    fn the_budget_counts_what_was_already_spent() {
        let p = policy(); // max_total 1_000_000
        let nearly_done = Spend {
            spent: 990_000,
            calls: 10,
        };
        assert_eq!(
            autonomous(&p, "/weather", 10_000, nearly_done),
            PolicyDecision::Allow,
            "exactly reaching max_total is permitted"
        );
        assert_eq!(
            autonomous(&p, "/weather", 10_001, nearly_done),
            PolicyDecision::Refuse(PolicyRefusal::Budget)
        );
    }

    #[test]
    fn a_budget_that_would_overflow_refuses_rather_than_wrapping() {
        // The case that matters: u64 addition wrapping to a small number would
        // turn a refusal into an approval.
        let p = AgentPolicy {
            max_total: u64::MAX,
            max_per_call: u64::MAX,
            approval_threshold: None,
            allowed_resources: None,
            max_calls: None,
        };
        let almost_max = Spend {
            spent: u64::MAX - 1,
            calls: 0,
        };
        assert_eq!(
            autonomous(&p, "/weather", 5, almost_max),
            PolicyDecision::Refuse(PolicyRefusal::Budget)
        );
    }

    #[test]
    fn the_call_limit_is_exhausted_at_the_limit_not_after_it() {
        let mut p = policy();
        p.max_calls = Some(3);
        let three_done = Spend { spent: 10, calls: 3 };
        assert_eq!(
            autonomous(&p, "/weather", 1, three_done),
            PolicyDecision::Refuse(PolicyRefusal::CallLimit)
        );
        let two_done = Spend { spent: 10, calls: 2 };
        assert_eq!(autonomous(&p, "/weather", 1, two_done), PolicyDecision::Allow);
    }

    #[test]
    fn human_mode_asks_for_every_purchase() {
        let d = evaluate(
            AgentStatus::Active,
            AgentMode::Human,
            &policy(),
            "/weather",
            1,
            fresh(),
        );
        assert_eq!(d, PolicyDecision::NeedsApproval);
    }

    #[test]
    fn autonomous_mode_asks_only_at_or_above_the_threshold() {
        let mut p = policy();
        p.approval_threshold = Some(10_000);
        assert_eq!(autonomous(&p, "/weather", 9_999, fresh()), PolicyDecision::Allow);
        assert_eq!(
            autonomous(&p, "/analyse", 10_000, fresh()),
            PolicyDecision::NeedsApproval,
            "at the threshold asks, so a threshold of 0 asks for everything"
        );
    }

    #[test]
    fn a_refusal_is_never_dressed_up_as_an_approval_request() {
        // Ordering check with teeth. This purchase is both over the per-call
        // cap AND over the approval threshold. Asking a human to approve
        // something the policy forbids would train them to click through, and
        // an approval could not make it admissible anyway.
        let mut p = policy();
        p.max_per_call = 5_000;
        p.approval_threshold = Some(1_000);
        assert_eq!(
            autonomous(&p, "/analyse", 25_000, fresh()),
            PolicyDecision::Refuse(PolicyRefusal::PriceCap)
        );
    }

    #[test]
    fn a_suspended_agent_in_human_mode_is_refused_not_queued() {
        // The same ordering point at the other end: suspension must not become
        // an approval prompt, or revocation would be defeated by one click.
        let d = evaluate(
            AgentStatus::Suspended,
            AgentMode::Human,
            &policy(),
            "/weather",
            1,
            fresh(),
        );
        assert_eq!(d, PolicyDecision::Refuse(PolicyRefusal::Suspended));
    }
}
