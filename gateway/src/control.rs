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

use crate::claim::ClaimWire;
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
    /// Who decided, as recorded at the moment of the decision.
    pub decided_by: Option<String>,
    pub decided_by_label: Option<String>,
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
            decided_by: a.decided_by.clone(),
            decided_by_label: a.decided_by_label.clone(),
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
    axum::Extension(operator): axum::Extension<crate::auth::Operator>,
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
        .create_agent(
            &agent_id,
            req.label.trim(),
            &req.agent_pubkey,
            owner,
            mode,
            operator.workspace_id.as_deref(),
        )
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;

    if !created {
        // The pubkey is unique, so this is almost always a second agent for a
        // key that already has one.
        return Err(Denial::new(ReasonCode::ERR_AGENT_EXISTS, &rid));
    }

    info!(request_id = %rid, agent_id = %agent_id, pubkey = %req.agent_pubkey, "agent created");

    let record = db
        .get_agent(&agent_id, operator.workspace_id.as_deref())
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
    axum::Extension(operator): axum::Extension<crate::auth::Operator>,
) -> Result<Json<AgentsResponse>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    let records = db
        .list_agents(operator.workspace_id.as_deref())
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
    axum::Extension(operator): axum::Extension<crate::auth::Operator>,
    Path(agent_id): Path<String>,
) -> Result<Json<AgentView>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    let record = db
        .get_agent(&agent_id, operator.workspace_id.as_deref())
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
    axum::Extension(operator): axum::Extension<crate::auth::Operator>,
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
        .get_agent(&agent_id, operator.workspace_id.as_deref())
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
        .set_policy(&agent_id, mode, &policy, operator.workspace_id.as_deref())
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
        .get_agent(&agent_id, operator.workspace_id.as_deref())
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
    axum::Extension(operator): axum::Extension<crate::auth::Operator>,
    Path(agent_id): Path<String>,
    Json(req): Json<StatusRequest>,
) -> Result<Json<AgentView>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    let ok = db
        .set_agent_status(&agent_id, req.status, operator.workspace_id.as_deref())
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
        .get_agent(&agent_id, operator.workspace_id.as_deref())
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
    axum::Extension(operator): axum::Extension<crate::auth::Operator>,
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

    db.upsert_provider(&record, operator.workspace_id.as_deref())
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
    axum::Extension(operator): axum::Extension<crate::auth::Operator>,
) -> Json<ProvidersResponse> {
    // The in-memory registry is GLOBAL: it is loaded once at boot and backs the
    // public catalogue, so it knows nothing about tenants. Serving it directly
    // to a scoped caller would list every tenant's providers.
    //
    // So a scoped caller is answered from the database, which does know. An
    // unscoped legacy admin keeps the registry view, which additionally
    // includes the boot-time upstream entry that may not have a row.
    if let (Some(ws), Some(db)) = (operator.workspace_id.as_deref(), state.db.as_ref()) {
        let providers = db.list_providers(Some(ws)).await.unwrap_or_default();
        return Json(ProvidersResponse { providers });
    }
    Json(ProvidersResponse {
        providers: state.registry.list().await,
    })
}

/// DELETE /v1/providers/{provider_id}
pub async fn delete_provider(
    State(state): State<Arc<AppState>>,
    axum::Extension(operator): axum::Extension<crate::auth::Operator>,
    Path(provider_id): Path<String>,
) -> Result<Json<ProvidersResponse>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    let removed = db
        .delete_provider(&provider_id, operator.workspace_id.as_deref())
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
/// The planning calculation, shared by both front doors.
///
/// Extracted so the operator planner (`/v1/agent/plan`) and the agent planner
/// (`/v1/session/plan`) cannot drift apart and report different numbers for
/// the same question. The logic is unchanged from when it lived inline in
/// `plan`; only its home moved.
///
/// Reads only. It evaluates `policy::evaluate` against a `Spend` the caller
/// supplies and returns what it found. It writes nothing, reserves nothing,
/// and advances nothing.
async fn plan_options(
    state: &AppState,
    agent: &AgentRecord,
    spend: Spend,
    wanted: &str,
    calls: u32,
) -> (Vec<PlanOption>, Option<String>, Vec<crate::registry::ProviderError>) {
    let aggregate = state.registry.aggregate().await;
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
            // No envelope: the escrow is the only bound, and this function does
            // not see the session, so it reports the request as-is rather than
            // inventing a limit.
            None => (calls, None, false),
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
                        while n < calls {
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
            sufficient: affordable >= calls,
            refused_by,
            needs_approval,
        });
    }

    // Cheapest usable option wins. "Usable" means it can afford at least one
    // call; an option that affords none is still listed, with its reason, so
    // the caller learns why rather than seeing an empty list.
    let recommended = options
        .iter()
        .filter(|o| o.affordable_calls > 0)
        .min_by_key(|o| o.unit_price.parse::<u64>().unwrap_or(u64::MAX))
        .map(|o| o.provider_id.clone());

    (options, recommended, aggregate.unavailable)
}

pub async fn plan(
    State(state): State<Arc<AppState>>,
    axum::Extension(operator): axum::Extension<crate::auth::Operator>,
    Json(req): Json<PlanRequest>,
) -> Result<Json<PlanResponse>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    if req.calls == 0 {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    }

    let agent = db
        .get_agent(&req.agent_id, operator.workspace_id.as_deref())
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?
        .ok_or_else(|| Denial::new(ReasonCode::ERR_AGENT_NOT_FOUND, &rid))?;

    let spend = db
        .agent_spend(&agent.agent_pubkey)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;

    let wanted = crate::policy::normalise_resource(&req.resource);
    let (options, recommended, unavailable) =
        plan_options(&state, &agent, spend, &wanted, req.calls).await;

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
        unavailable,
        request_id: rid,
    }))
}

// ---------------------------------------------------------------------------
// Operators — who holds a control-plane credential
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct OperatorView {
    pub operator_id: String,
    pub label: String,
    pub role: String,
    pub enabled: bool,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateOperatorRequest {
    pub label: String,
}

#[derive(Debug, Serialize)]
pub struct CreatedOperatorView {
    pub operator_id: String,
    pub label: String,
    /// **Shown once.** Only its SHA-256 hash is stored, so this cannot be
    /// recovered later — a lost token is replaced, never retrieved.
    pub token: String,
    pub note: &'static str,
}

/// POST /v1/operators — mint a credential for one person.
///
/// The token is generated HERE, from 32 bytes of randomness, and a
/// caller-supplied one is not accepted. That is what lets the store hold a
/// plain SHA-256 digest rather than a slow password hash: there is no low
/// entropy to defend, because nobody gets to choose a weak token.
pub async fn create_operator(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateOperatorRequest>,
) -> Result<Json<CreatedOperatorView>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    if req.label.trim().is_empty() {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    }

    // Two UUIDs of entropy, hex-encoded: 256 bits from the same CSPRNG the
    // rest of the codebase uses for ids.
    let token = format!(
        "{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let operator_id = format!("op_{}", Uuid::new_v4().simple());
    let hash = crate::auth::token_hash(&token);

    let created = db
        .create_operator(&operator_id, req.label.trim(), &hash)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;
    if !created {
        return Err(Denial::new(ReasonCode::ERR_OPERATOR_EXISTS, &rid));
    }

    // The id is logged; the token never is.
    info!(request_id = %rid, operator_id = %operator_id, "operator created");

    Ok(Json(CreatedOperatorView {
        operator_id,
        label: req.label.trim().to_string(),
        token,
        note: "Store this now. Only its hash is kept, so it cannot be shown again.",
    }))
}

#[derive(Debug, Serialize)]
pub struct OperatorsResponse {
    pub operators: Vec<OperatorView>,
}

/// GET /v1/operators — never returns a token or a hash.
pub async fn list_operators(
    State(state): State<Arc<AppState>>,
) -> Result<Json<OperatorsResponse>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    let rows = db
        .list_operators()
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;

    Ok(Json(OperatorsResponse {
        operators: rows
            .into_iter()
            .map(|o| OperatorView {
                operator_id: o.operator_id,
                label: o.label,
                role: o.role,
                enabled: o.enabled,
                created_at: o.created_at.to_rfc3339(),
                last_used_at: o.last_used_at.map(|t| t.to_rfc3339()),
            })
            .collect(),
    }))
}

/// POST /v1/operators/me/rotate — replace your own token.
///
/// # Why only your own
///
/// An operator rotating somebody else's credential would receive the new token
/// themselves, and every decision they then made would be recorded under the
/// other person's name. That breaks the one thing the trail is for: that
/// `decided_by` means *that person acted*.
///
/// So there is no admin path to rotate another operator. The honest recovery
/// for a lost credential is to **disable it and mint a new operator** — a new
/// id, so history stays truthful about who held what.
///
/// # No grace period
///
/// The old token stops working on the very next request. Two live credentials
/// for one identity would mean a stolen token keeps working for the length of
/// the window, which is the opposite of what rotation is for.
pub async fn rotate_own_token(
    State(state): State<Arc<AppState>>,
    axum::Extension(operator): axum::Extension<crate::auth::Operator>,
) -> Result<Json<CreatedOperatorView>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    // The shared token lives in the environment, not in `operators`. There is
    // no row to rotate, and silently doing nothing would tell the caller their
    // credential had been replaced when it had not.
    if operator.operator_id == crate::auth::SHARED_TOKEN_OPERATOR {
        warn!(
            request_id = %rid,
            "rotation attempted for the shared admin token"
        );
        return Err(Denial::new(ReasonCode::ERR_SHARED_TOKEN_NOT_ROTATABLE, &rid));
    }

    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let hash = crate::auth::token_hash(&token);

    let rotated = db
        .rotate_operator_token(&operator.operator_id, &hash)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;
    if !rotated {
        return Err(Denial::new(ReasonCode::ERR_OPERATOR_NOT_FOUND, &rid));
    }

    // The id is logged; neither the old token nor the new one ever is.
    warn!(
        request_id = %rid,
        operator_id = %operator.operator_id,
        "operator token rotated; the previous one no longer authenticates"
    );

    Ok(Json(CreatedOperatorView {
        operator_id: operator.operator_id,
        label: operator.label,
        token,
        note: "Store this now. The previous token stopped working immediately, \
               and only a hash of this one is kept.",
    }))
}

#[derive(Debug, Deserialize)]
pub struct OperatorStatusRequest {
    pub enabled: bool,
}

/// POST /v1/operators/{id}/status — revoke one credential.
///
/// The thing a shared secret cannot do: remove one person's access without
/// changing it for everybody, which is why in practice nobody ever did.
pub async fn set_operator_status(
    State(state): State<Arc<AppState>>,
    Path(operator_id): Path<String>,
    Json(req): Json<OperatorStatusRequest>,
) -> Result<Json<OperatorsResponse>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    let done = db
        .set_operator_enabled(&operator_id, req.enabled)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;
    if !done {
        return Err(Denial::new(ReasonCode::ERR_OPERATOR_NOT_FOUND, &rid));
    }

    warn!(
        request_id = %rid,
        operator_id = %operator_id,
        enabled = req.enabled,
        "operator credential status changed"
    );

    list_operators(State(state)).await
}

// ---------------------------------------------------------------------------
// Session-scoped planning — the agent's own front door
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct SessionPlanRequest {
    /// The session the caller holds, base58.
    pub session: String,
    pub resource: String,
    pub calls: u32,
    /// A claim over this session at its CURRENT state, proving key possession.
    /// See `plan_for_session` for why it cannot be spent.
    pub claim: ClaimWire,
}

#[derive(Debug, Serialize)]
pub struct SessionPlanResponse {
    pub session: String,
    pub resource: String,
    pub requested_calls: u32,
    pub options: Vec<PlanOption>,
    pub recommended: Option<String>,
    pub spent: String,
    pub remaining: Option<String>,
    /// Escrow left on chain. The absolute bound; the envelope only narrows it.
    pub escrow_remaining: String,
    pub unavailable: Vec<crate::registry::ProviderError>,
    pub request_id: String,
}

/// POST /v1/session/plan — the planner an AGENT can reach.
///
/// # Why this exists beside `/v1/agent/plan`
///
/// That endpoint takes an `agent_id` and lives behind the operator's admin
/// token. An agent holds a session and a signing key, never that token, so it
/// could not ask the one question the lifecycle says it asks: *who sells this,
/// and how many can I afford?*
///
/// Opening the operator endpoint was not an option: an `agent_id` parameter on
/// an unauthenticated route is an enumeration oracle for every agent's
/// finances. **This request has no such field.** The agent is derived —
/// session -> `record.agent` -> `get_agent_by_pubkey` — so there is nothing to
/// enumerate.
///
/// # Why the signed claim cannot be spent
///
/// The claim must carry `cumulative_amount == record.cumulative_accepted`.
/// `state::evaluate_claim` admits a claim only when the cumulative is
/// **strictly** greater than the mark, and the on-chain program applies the
/// same rule. A claim at exactly the mark is therefore refused
/// `ERR_CLAIM_NOT_MONOTONIC` by `/v1/buy`, by `/v1/claim/verify` and by the
/// program.
///
/// That is the whole security argument, and it is worth being precise about:
/// a planning claim buys nothing not because this handler declines to spend
/// it, but because **no code path in the system accepts it as payment**.
///
/// A claim carrying a *higher* cumulative is refused rather than ignored, so
/// this endpoint never handles a spendable claim at all.
///
/// # What this handler does not do
///
/// It writes nothing. No store mutation, no evidence entry, no high-water mark
/// advance, no reservation. A plan is advice that can go stale the moment
/// another purchase lands — and that is correct. `/v1/buy` is the authority,
/// and a planner that reserved budget would become a second enforcement path
/// to keep in step with the first.
pub async fn plan_for_session(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SessionPlanRequest>,
) -> Result<Json<SessionPlanResponse>, Denial> {
    let rid = request_id();
    let now = state.now();

    if req.calls == 0 {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    }

    // Order mirrors the money path: cheap checks before the ~60us signature
    // verification, so a flood of garbage cannot force that work.
    let Ok(session) = req.session.parse::<solana_pubkey::Pubkey>() else {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    };

    let Ok((claim, signature)) = req.claim.decode() else {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_CLAIM, &rid));
    };

    // The claim must be about the session being planned for, or a valid claim
    // over session A would authenticate a plan for session B.
    if claim.session != session {
        return Err(Denial::new(ReasonCode::ERR_MALFORMED_REQUEST, &rid));
    }

    if claim.is_expired(now) {
        return Err(Denial::new(ReasonCode::ERR_CLAIM_EXPIRED, &rid));
    }

    let record = state
        .store
        .get(&session)
        .await
        .map_err(|e| crate::routes::store_denial(e, &rid))?;

    // Same order as `evaluate_claim`: settled, then expired.
    if record.is_settled {
        return Err(Denial::new(ReasonCode::ERR_SESSION_SETTLED, &rid));
    }
    let limit = record
        .expires_at
        .checked_add(crate::claim::CLOCK_SKEW_TOLERANCE_SECS)
        .unwrap_or(i64::MAX);
    if now > limit {
        return Err(Denial::new(ReasonCode::ERR_SESSION_EXPIRED, &rid));
    }

    // The binding rule. Exact equality, not "at most": a higher cumulative
    // would be a spendable claim, and this endpoint must never receive one.
    if claim.cumulative_amount != record.cumulative_accepted
        || claim.nonce != record.last_nonce.unwrap_or(0)
    {
        warn!(
            request_id = %rid,
            session = %session,
            presented_cumulative = claim.cumulative_amount,
            expected_cumulative = record.cumulative_accepted,
            presented_nonce = claim.nonce,
            expected_nonce = record.last_nonce.unwrap_or(0),
            "plan: claim does not describe the session's current state"
        );
        return Err(Denial::new(ReasonCode::ERR_PLAN_CLAIM_MISMATCH, &rid));
    }

    // The agent key comes from STORED STATE, never from the request. Accepting
    // a caller-supplied key would let anyone plan for any session using their
    // own keypair. Same rule, same reason, as `routes::verify_claim` step 3.
    if crate::verify::verify_claim_signature(&record.agent, &claim, &signature)
        != crate::verify::SignatureVerdict::Valid
    {
        warn!(request_id = %rid, session = %session, "plan: invalid signature");
        return Err(Denial::new(ReasonCode::ERR_INVALID_SIGNATURE, &rid));
    }

    let db = db(&state, &rid)?;
    let agent = db
        .get_agent_by_pubkey(&record.agent.to_string())
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?
        .ok_or_else(|| Denial::new(ReasonCode::ERR_AGENT_NOT_FOUND, &rid))?;

    let spend = db
        .agent_spend(&agent.agent_pubkey)
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;

    let wanted = crate::policy::normalise_resource(&req.resource);
    let (options, recommended, unavailable) =
        plan_options(&state, &agent, spend, &wanted, req.calls).await;

    let remaining = agent
        .policy
        .as_ref()
        .map(|p| p.max_total.saturating_sub(spend.spent).to_string());

    Ok(Json(SessionPlanResponse {
        session: session.to_string(),
        resource: wanted,
        requested_calls: req.calls,
        options,
        recommended,
        spent: spend.spent.to_string(),
        remaining,
        escrow_remaining: record
            .deposited_total
            .saturating_sub(record.cumulative_accepted)
            .to_string(),
        unavailable,
        // Deliberately NOT `agent_id`: an operator's identifier, of no use to
        // the agent and one more thing to leak.
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
    axum::Extension(operator): axum::Extension<crate::auth::Operator>,
) -> Result<Json<ApprovalsResponse>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    let records = db
        .list_approvals(200, operator.workspace_id.as_deref())
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
    axum::Extension(operator): axum::Extension<crate::auth::Operator>,
    Path(approval_id): Path<String>,
    // Inserted by `auth::require_admin`, which resolved the token to whoever
    // presented it. A decision that cannot name its decider is a workflow, not
    // an audit trail.
    Json(req): Json<DecideRequest>,
) -> Result<Json<ApprovalsResponse>, Denial> {
    let rid = request_id();
    let db = db(&state, &rid)?;

    let decided = db
        .decide_approval(
            &approval_id,
            req.approved,
            req.reason.as_deref(),
            &operator.operator_id,
            &operator.label,
        )
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
        operator_id = %operator.operator_id,
        "approval decided"
    );

    let records = db
        .list_approvals(200, operator.workspace_id.as_deref())
        .await
        .map_err(|_| Denial::new(ReasonCode::ERR_CONTROL_PLANE_UNAVAILABLE, &rid))?;
    Ok(Json(ApprovalsResponse {
        approvals: records.iter().map(ApprovalView::from).collect(),
    }))
}
