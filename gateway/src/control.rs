//! Control plane: agent onboarding, authorization, the registry, selection and
//! approvals.
//!
//! These are the stages that sit *above* the money path — deciding who may
//! spend, on what, and how much — as opposed to `routes.rs`, which enforces a
//! claim once the decision has been made.
//!
//! # The line between the two
//!
//! Nothing here can widen what the chain permits. An agent's escrow deposit
//! remains its absolute ceiling; a policy can only narrow it. That is why this
//! layer is allowed to be flexible and mutable while `routes.rs` and the
//! program are not.
//!
//! # Why a policy is optional
//!
//! A session whose agent has no record here is bound by its escrow and nothing
//! else — which is exactly the behaviour before this module existed, so adding
//! it breaks no deployment. Operators who want every session to belong to an
//! authorized agent set `AGENTPAY_REQUIRE_AGENT_POLICY=1`, and an unregistered
//! agent is then refused. Both readings are defensible; neither is silent.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};
use uuid::Uuid;

use crate::control_db::{AgentRecord, ApprovalRecord};
use crate::error::{Denial, ReasonCode};
use crate::policy::{AgentMode, AgentPolicy, AgentStatus, Spend};
use crate::registry::{AggregateCatalogue, CatalogueEntry, ProviderRecord};
use crate::routes::{request_id, AppState};

/// The control plane needs a database; there is nowhere else to keep an agent.
fn db(state: &AppState, rid: &str) -> Result<Arc<crate::db::Database>, Denial> {
    state
        .db
        .clone()
        .ok_or_else(|| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, rid))
}

// ---------------------------------------------------------------------------
// Serialisation
//
// Every amount crosses the wire as a decimal string, never a JSON number.
// Above 2^53 a double silently rounds, and these are budgets.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct PolicyView {
    pub max_total: String,
    pub max_per_call: String,
    pub approval_threshold: Option<String>,
    pub allowed_resources: Option<Vec<String>>,
    pub max_calls: Option<u32>,
}

impl From<&AgentPolicy> for PolicyView {
    fn from(p: &AgentPolicy) -> Self {
        Self {
            max_total: p.max_total.to_string(),
            max_per_call: p.max_per_call.to_string(),
            approval_threshold: p.approval_threshold.map(|t| t.to_string()),
            allowed_resources: p.allowed_resources.clone(),
            max_calls: p.max_calls,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AgentView {
    pub agent_id: String,
    pub label: String,
    pub agent_pubkey: String,
    pub owner_pubkey: Option<String>,
    pub mode: AgentMode,
    pub status: AgentStatus,
    pub created_at: String,
    /// `None` means the agent has not been authorized: only its escrow bounds
    /// it. The console must say so rather than implying a policy exists.
    pub policy: Option<PolicyView>,
    /// Derived from the money path, not from a counter kept here.
    pub spent: String,
    pub calls: u32,
    /// What remains of `max_total`, or `None` when there is no policy.
    pub remaining: Option<String>,
}

fn view(a: &AgentRecord, spend: Spend) -> AgentView {
    let remaining = a
        .policy
        .as_ref()
        .map(|p| p.max_total.saturating_sub(spend.spent).to_string());
    AgentView {
        agent_id: a.agent_id.clone(),
        label: a.label.clone(),
        agent_pubkey: a.agent_pubkey.clone(),
        owner_pubkey: a.owner_pubkey.clone(),
        mode: a.mode,
        status: a.status,
        created_at: a.created_at.to_rfc3339(),
        policy: a.policy.as_ref().map(PolicyView::from),
        spent: spend.spent.to_string(),
        calls: spend.calls,
        remaining,
    }
}

#[derive(Debug, Serialize)]
pub struct ApprovalView {
    pub approval_id: String,
    pub agent_id: String,
    pub session: Option<String>,
    pub resource: String,
    pub price: String,
    pub calls: i32,
    pub state: String,
    pub reason: Option<String>,
    pub created_at: String,
    pub decided_at: Option<String>,
}

impl From<&ApprovalRecord> for ApprovalView {
    fn from(a: &ApprovalRecord) -> Self {
        Self {
            approval_id: a.approval_id.clone(),
            agent_id: a.agent_id.clone(),
            session: a.session.clone(),
            resource: a.resource.clone(),
            price: a.price.to_string(),
            calls: a.calls,
            state: a.state.clone(),
            reason: a.reason.clone(),
            created_at: a.created_at.to_rfc3339(),
            decided_at: a.decided_at.map(|d| d.to_rfc3339()),
        }
    }
}

/// Parses a decimal micro-USDC string.
///
/// Rejects anything that is not a plain u64: a budget expressed as "1e6" or
/// "1.5" is a mistake that must surface here, not be rounded into an amount.
fn parse_amount(s: &str) -> Option<u64> {
    s.trim().parse::<u64>().ok()
}

// ---------------------------------------------------------------------------
// Agents — stages 1 to 4
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CreateAgentRequest {
    pub label: String,
    /// The agent's wallet. Base58 Ed25519 public key.
    pub agent_pubkey: String,
    /// The human who owns it. Informational — authority comes from the escrow.
    #[serde(default)]
    pub owner_pubkey: Option<String>,
    /// Defaults to `human`, the more restrictive mode. An agent should not
    /// become autonomous because a field was omitted.
    #[serde(default)]
    pub mode: Option<AgentMode>,
}

/// POST /v1/agents — stages 1 and 2: create an agent and bind it to a wallet.
pub async fn create_agent(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateAgentRequest>,
) -> Result<Json<AgentView>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    if req.label.trim().is_empty() {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    }
    // The wallet must be a real Ed25519 key. Storing an unparseable string
    // would produce an agent whose claims can never be matched to it.
    if req.agent_pubkey.parse::<solana_pubkey::Pubkey>().is_err() {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    }
    if let Some(owner) = req.owner_pubkey.as_deref() {
        if !owner.trim().is_empty() && owner.parse::<solana_pubkey::Pubkey>().is_err() {
            return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
        }
    }

    let agent_id = format!("agt_{}", Uuid::new_v4().simple());
    let mode = req.mode.unwrap_or(AgentMode::Human);
    let owner = req
        .owner_pubkey
        .as_deref()
        .filter(|o| !o.trim().is_empty());

    let created = db
        .create_agent(&agent_id, req.label.trim(), &req.agent_pubkey, owner, mode)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;

    if !created {
        // The pubkey is unique, so this is almost always a second agent for a
        // key that already has one.
        return Err(Denial::new(ReasonCode::ERR_AGENT_EXISTS, &rid));
    }

    info!(request_id = %rid, agent_id = %agent_id, pubkey = %req.agent_pubkey, "agent created");

    let record = db
        .get_agent(&agent_id)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?
        .ok_or_else(|| Denial::new(ReasonCode::ERR_AGENT_NOT_FOUND, &rid))?;

    Ok(Json(view(&record, Spend { spent: 0, calls: 0 })))
}

#[derive(Debug, Serialize)]
pub struct AgentsResponse {
    pub agents: Vec<AgentView>,
}

/// GET /v1/agents
pub async fn list_agents(
    State(state): State<Arc<AppState>>,
) -> Result<Json<AgentsResponse>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    let records = db
        .list_agents()
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;

    let mut agents = Vec::with_capacity(records.len());
    for r in &records {
        let spend = db.agent_spend(&r.agent_pubkey).await.unwrap_or(Spend {
            spent: 0,
            calls: 0,
        });
        agents.push(view(r, spend));
    }
    Ok(Json(AgentsResponse { agents }))
}

/// GET /v1/agents/{agent_id}
pub async fn get_agent(
    State(state): State<Arc<AppState>>,
    Path(agent_id): Path<String>,
) -> Result<Json<AgentView>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    let record = db
        .get_agent(&agent_id)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?
        .ok_or_else(|| Denial::new(ReasonCode::ERR_AGENT_NOT_FOUND, &rid))?;

    let spend = db
        .agent_spend(&record.agent_pubkey)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;

    Ok(Json(view(&record, spend)))
}

#[derive(Debug, Deserialize)]
pub struct AuthorizeRequest {
    /// Micro-USDC, decimal strings.
    pub max_total: String,
    pub max_per_call: String,
    #[serde(default)]
    pub approval_threshold: Option<String>,
    #[serde(default)]
    pub allowed_resources: Option<Vec<String>>,
    #[serde(default)]
    pub max_calls: Option<u32>,
    #[serde(default)]
    pub mode: Option<AgentMode>,
}

/// POST /v1/agents/{agent_id}/authorize — stage 4: the permission envelope.
///
/// This is the off-chain half of authorization. The on-chain half is
/// `open_session`, and it is the one that actually holds the money: this
/// endpoint can only narrow what the escrow already permits.
pub async fn authorize_agent(
    State(state): State<Arc<AppState>>,
    Path(agent_id): Path<String>,
    Json(req): Json<AuthorizeRequest>,
) -> Result<Json<AgentView>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    let (Some(max_total), Some(max_per_call)) = (
        parse_amount(&req.max_total),
        parse_amount(&req.max_per_call),
    ) else {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    };
    if max_total == 0 || max_per_call == 0 {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    }
    // A per-call cap above the total is not wrong so much as meaningless, and
    // letting it through would display a policy that reads as more permissive
    // than it is.
    if max_per_call > max_total {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    }

    let approval_threshold = match req.approval_threshold.as_deref() {
        None => None,
        Some(s) if s.trim().is_empty() => None,
        Some(s) => match parse_amount(s) {
            Some(v) => Some(v),
            None => return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid)),
        },
    };

    let existing = db
        .get_agent(&agent_id)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?
        .ok_or_else(|| Denial::new(ReasonCode::ERR_AGENT_NOT_FOUND, &rid))?;

    let policy = AgentPolicy {
        max_total,
        max_per_call,
        approval_threshold,
        allowed_resources: req.allowed_resources,
        max_calls: req.max_calls,
    };
    let mode = req.mode.unwrap_or(existing.mode);

    let ok = db
        .set_policy(&agent_id, mode, &policy)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;
    if !ok {
        return Err(Denial::new(ReasonCode::ERR_AGENT_NOT_FOUND, &rid));
    }

    info!(
        request_id = %rid,
        agent_id = %agent_id,
        mode = mode.as_str(),
        max_total,
        max_per_call,
        "agent authorized"
    );

    let record = db
        .get_agent(&agent_id)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?
        .ok_or_else(|| Denial::new(ReasonCode::ERR_AGENT_NOT_FOUND, &rid))?;
    let spend = db
        .agent_spend(&record.agent_pubkey)
        .await
        .unwrap_or(Spend { spent: 0, calls: 0 });

    Ok(Json(view(&record, spend)))
}

#[derive(Debug, Deserialize)]
pub struct StatusRequest {
    pub status: AgentStatus,
}

/// POST /v1/agents/{agent_id}/status — suspend or reinstate.
///
/// Suspension is the revocation the escrow cannot express. `open_session`
/// commits funds until expiry and the program has no pause; this stops the
/// agent at the gateway immediately, without settling the session or taking the
/// whole gateway down.
///
/// Its limit is worth stating: it binds only what passes through *this*
/// gateway. It does not claw back the escrow, and a settlement already in
/// flight is not recalled.
pub async fn set_agent_status(
    State(state): State<Arc<AppState>>,
    Path(agent_id): Path<String>,
    Json(req): Json<StatusRequest>,
) -> Result<Json<AgentView>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    let ok = db
        .set_agent_status(&agent_id, req.status)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;
    if !ok {
        return Err(Denial::new(ReasonCode::ERR_AGENT_NOT_FOUND, &rid));
    }

    warn!(
        request_id = %rid,
        agent_id = %agent_id,
        status = req.status.as_str(),
        "agent status changed"
    );

    let record = db
        .get_agent(&agent_id)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?
        .ok_or_else(|| Denial::new(ReasonCode::ERR_AGENT_NOT_FOUND, &rid))?;
    let spend = db
        .agent_spend(&record.agent_pubkey)
        .await
        .unwrap_or(Spend { spent: 0, calls: 0 });

    Ok(Json(view(&record, spend)))
}

// ---------------------------------------------------------------------------
// Registry — stage 5
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct RegisterProviderRequest {
    pub provider_id: String,
    pub label: String,
    pub base_url: String,
    #[serde(default)]
    pub provider_pubkey: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
pub struct ProvidersResponse {
    pub providers: Vec<ProviderRecord>,
}

/// POST /v1/providers — register where to ask, never what to charge.
///
/// Prices are read from the provider's own `/_catalogue` at purchase time. A
/// registry that stored prices would let the gateway charge for someone else's
/// goods, and a provider could not change a price without asking us.
pub async fn register_provider(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterProviderRequest>,
) -> Result<Json<ProvidersResponse>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    let id = req.provider_id.trim();
    if id.is_empty() || req.label.trim().is_empty() || req.base_url.trim().is_empty() {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    }
    // Refuse anything that is not http(s): a `file://` or bare host would be a
    // confusing failure much later, inside the HTTP client.
    if !(req.base_url.starts_with("http://") || req.base_url.starts_with("https://")) {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    }
    if let Some(pk) = req.provider_pubkey.as_deref() {
        if !pk.trim().is_empty() && pk.parse::<solana_pubkey::Pubkey>().is_err() {
            return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
        }
    }

    let record = ProviderRecord {
        provider_id: id.to_string(),
        label: req.label.trim().to_string(),
        base_url: req.base_url.trim().to_string(),
        provider_pubkey: req
            .provider_pubkey
            .filter(|p| !p.trim().is_empty()),
        enabled: req.enabled,
    };

    db.upsert_provider(&record)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;
    state.registry.upsert(record).await;

    info!(request_id = %rid, provider_id = %id, "provider registered");
    Ok(Json(ProvidersResponse {
        providers: state.registry.list().await,
    }))
}

/// GET /v1/providers
pub async fn list_providers(
    State(state): State<Arc<AppState>>,
) -> Json<ProvidersResponse> {
    Json(ProvidersResponse {
        providers: state.registry.list().await,
    })
}

/// DELETE /v1/providers/{provider_id}
pub async fn delete_provider(
    State(state): State<Arc<AppState>>,
    Path(provider_id): Path<String>,
) -> Result<Json<ProvidersResponse>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    let removed = db
        .delete_provider(&provider_id)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;
    state.registry.remove(&provider_id).await;

    if !removed {
        return Err(Denial::new(ReasonCode::ERR_PROVIDER_NOT_FOUND, &rid));
    }
    Ok(Json(ProvidersResponse {
        providers: state.registry.list().await,
    }))
}

/// GET /v1/catalogue — every resource every registered provider offers.
pub async fn catalogue(State(state): State<Arc<AppState>>) -> Json<AggregateCatalogue> {
    Json(state.registry.aggregate().await)
}

// ---------------------------------------------------------------------------
// Selection and decision — stages 6 and 7
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct PlanRequest {
    /// Which agent is asking. Its envelope bounds the plan.
    pub agent_id: String,
    /// What it wants to buy, e.g. `/weather`.
    pub resource: String,
    /// How many calls the task is expected to need.
    pub calls: u32,
}

#[derive(Debug, Serialize)]
pub struct PlanOption {
    pub provider_id: String,
    pub provider_label: String,
    pub resource: String,
    pub unit_price: String,
    /// Calls this option can actually afford under the envelope — which may be
    /// fewer than requested, and may be zero.
    pub affordable_calls: u32,
    pub total_cost: String,
    /// True when this option satisfies the whole request.
    pub sufficient: bool,
    /// Present when the option is unusable, naming the rule that stops it.
    pub refused_by: Option<String>,
    /// True when each call would wait for a human decision.
    pub needs_approval: bool,
}

#[derive(Debug, Serialize)]
pub struct PlanResponse {
    pub agent_id: String,
    pub resource: String,
    pub requested_calls: u32,
    /// Cheapest first. Empty means nobody sells this, or the registry could not
    /// reach anyone who does.
    pub options: Vec<PlanOption>,
    /// The option the planner would take, if any is usable.
    pub recommended: Option<String>,
    /// What the agent has already committed, for context.
    pub spent: String,
    pub remaining: Option<String>,
    /// Providers that did not answer, so a missing option can be told apart
    /// from a provider that is merely down.
    pub unavailable: Vec<crate::registry::ProviderError>,
    pub request_id: String,
}

/// POST /v1/agent/plan — stages 6 and 7 in one call.
///
/// Answers "who sells this, and how many can I afford?" by evaluating the
/// agent's own envelope against each provider's live price. It is a *planning*
/// endpoint: it authorises nothing, moves nothing, and buying still goes
/// through `/v1/buy`, where every rule is applied again for real.
///
/// The separation matters. A planner that also authorised would be a second
/// enforcement path to keep in step with the first.
pub async fn plan(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PlanRequest>,
) -> Result<Json<PlanResponse>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    if req.calls == 0 {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    }

    let agent = db
        .get_agent(&req.agent_id)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?
        .ok_or_else(|| Denial::new(ReasonCode::ERR_AGENT_NOT_FOUND, &rid))?;

    let spend = db
        .agent_spend(&agent.agent_pubkey)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;

    let aggregate = state.registry.aggregate().await;
    let wanted = crate::policy::normalise_resource(&req.resource);
    let offers: Vec<CatalogueEntry> = aggregate
        .entries
        .iter()
        .filter(|e| e.resource == wanted)
        .cloned()
        .collect();

    let mut options = Vec::new();
    for offer in offers {
        let Some(unit) = parse_amount(&offer.price) else {
            // A provider whose price is not a u64 is skipped rather than
            // crashing the plan; it is someone else's data.
            continue;
        };

        let (affordable, refused_by, needs_approval) = match agent.policy.as_ref() {
            // No envelope: the escrow is the only bound, and the planner does
            // not know the session yet, so it reports the request as-is rather
            // than inventing a limit.
            None => (req.calls, None, false),
            Some(policy) => {
                let first = crate::policy::evaluate(
                    agent.status,
                    agent.mode,
                    policy,
                    &offer.resource,
                    unit,
                    spend,
                );
                match first {
                    crate::policy::PolicyDecision::Refuse(r) => {
                        (0, Some(r.as_str().to_string()), false)
                    }
                    other => {
                        let needs = matches!(other, crate::policy::PolicyDecision::NeedsApproval);
                        // Walk forward one call at a time against the same rules
                        // the buy path applies, so the count cannot disagree
                        // with what will actually be admitted.
                        let mut n = 0u32;
                        let mut running = spend;
                        while n < req.calls {
                            let d = crate::policy::evaluate(
                                agent.status,
                                agent.mode,
                                policy,
                                &offer.resource,
                                unit,
                                running,
                            );
                            if matches!(d, crate::policy::PolicyDecision::Refuse(_)) {
                                break;
                            }
                            running = Spend {
                                spent: running.spent.saturating_add(unit),
                                calls: running.calls.saturating_add(1),
                            };
                            n += 1;
                        }
                        (n, None, needs)
                    }
                }
            }
        };

        let total = (affordable as u64).saturating_mul(unit);
        options.push(PlanOption {
            provider_id: offer.provider_id.clone(),
            provider_label: offer.provider_label.clone(),
            resource: offer.resource.clone(),
            unit_price: unit.to_string(),
            affordable_calls: affordable,
            total_cost: total.to_string(),
            sufficient: affordable >= req.calls,
            refused_by,
            needs_approval,
        });
    }

    // Cheapest usable option wins. "Usable" means it can afford at least one
    // call; an option that affords none is still listed, with its reason, so
    // the agent learns why rather than seeing an empty list.
    let recommended = options
        .iter()
        .filter(|o| o.affordable_calls > 0)
        .min_by_key(|o| o.unit_price.parse::<u64>().unwrap_or(u64::MAX))
        .map(|o| o.provider_id.clone());

    let remaining = agent
        .policy
        .as_ref()
        .map(|p| p.max_total.saturating_sub(spend.spent).to_string());

    Ok(Json(PlanResponse {
        agent_id: agent.agent_id,
        resource: wanted,
        requested_calls: req.calls,
        options,
        recommended,
        spent: spend.spent.to_string(),
        remaining,
        unavailable: aggregate.unavailable,
        request_id: rid,
    }))
}

// ---------------------------------------------------------------------------
// Approvals — human-controlled mode
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct ApprovalsResponse {
    pub approvals: Vec<ApprovalView>,
}

/// GET /v1/approvals
pub async fn list_approvals(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ApprovalsResponse>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    let records = db
        .list_approvals(200)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;

    Ok(Json(ApprovalsResponse {
        approvals: records.iter().map(ApprovalView::from).collect(),
    }))
}

#[derive(Debug, Deserialize)]
pub struct DecideRequest {
    pub approved: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

/// POST /v1/approvals/{approval_id}/decide
///
/// Only a pending approval can be decided, so a second click cannot flip a
/// rejection into an approval, and an approval already spent stays spent.
pub async fn decide_approval(
    State(state): State<Arc<AppState>>,
    Path(approval_id): Path<String>,
    Json(req): Json<DecideRequest>,
) -> Result<Json<ApprovalsResponse>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    let decided = db
        .decide_approval(&approval_id, req.approved, req.reason.as_deref())
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;

    if !decided {
        // Either it does not exist or it is no longer pending. Both are "there
        // is nothing here to decide".
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    }

    info!(
        request_id = %rid,
        approval_id = %approval_id,
        approved = req.approved,
        "approval decided"
    );

    let records = db
        .list_approvals(200)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;
    Ok(Json(ApprovalsResponse {
        approvals: records.iter().map(ApprovalView::from).collect(),
    }))
}
