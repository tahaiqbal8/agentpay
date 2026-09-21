//! AgentPay enforcement gateway.
//!
//! Sits between an agent and a provider: verifies each cumulative claim,
//! enforces ordering against session state, and (eventually) submits one
//! aggregated settlement per session.
//!
//! Trust boundary: this process is trusted for availability and policy
//! enforcement, never for custody. It holds no keys that can move funds beyond
//! what the escrow program's on-chain constraints already permit.

mod auth;
mod buy;
mod chain;
mod claim;
mod config;
mod control;
mod control_db;
mod db;
mod error;
mod evidence;
mod policy;
mod ratelimit;
mod registry;
mod routes;
mod settle;
mod state;
mod verify;

use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::Router;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_keypair::Keypair;
use solana_signer::Signer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::routes::{system_clock, AppState};
use crate::chain::{RpcSessionFetcher, SessionAccountFetcher};
use crate::db::Database;
use crate::state::{InMemorySessionStore, SessionStore};

/// Routes the control plane: everything that changes who may spend, or decides
/// a spend on a human's behalf. All of it sits behind the admin token.
///
/// `/v1/catalogue` is deliberately NOT here. A price list is meant to be
/// discoverable, and an agent reading one has learned nothing it could not
/// learn by asking the provider directly.
fn control_plane(state: Arc<AppState>) -> Router {
    Router::new()
        // Enumerating every session exposes each agent's wallet, deposit and
        // spend to anyone who asks. Public verifiability needs the per-session
        // endpoints, not a directory of everybody, so the listings sit here.
        .route("/v1/sessions", get(routes::list_sessions))
        .route("/v1/decisions/recent", get(routes::recent_decisions))
        .route(
            "/v1/agents",
            get(control::list_agents).post(control::create_agent),
        )
        .route("/v1/agents/{agent_id}", get(control::get_agent))
        .route(
            "/v1/agents/{agent_id}/authorize",
            post(control::authorize_agent),
        )
        .route("/v1/agents/{agent_id}/status", post(control::set_agent_status))
        .route(
            "/v1/providers",
            get(control::list_providers).post(control::register_provider),
        )
        .route(
            "/v1/providers/{provider_id}",
            axum::routing::delete(control::delete_provider),
        )
        .route("/v1/agent/plan", post(control::plan))
        .route(
            "/v1/operators",
            get(control::list_operators).post(control::create_operator),
        )
        .route(
            "/v1/operators/{operator_id}/status",
            post(control::set_operator_status),
        )
        // Self-service only, deliberately: see `rotate_own_token` for why
        // there is no path to rotate somebody else's credential.
        .route("/v1/operators/me/rotate", post(control::rotate_own_token))
        .route("/v1/approvals", get(control::list_approvals))
        .route(
            "/v1/approvals/{approval_id}/decide",
            post(control::decide_approval),
        )
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&state),
            auth::require_admin,
        ))
        .with_state(state)
}

pub fn build_router(state: Arc<AppState>) -> Router {
    // The money path and the public verification endpoints. Protected by
    // signatures and on-chain reconciliation, not by a shared secret — putting
    // a token here would break every agent and add nothing.
    let open = Router::new()
        .route("/", get(routes::index))
        .route("/health", get(routes::health))
        .route(
            "/v1/session/open",
            post(routes::open_session).layer(axum::middleware::from_fn_with_state(
                Arc::clone(&state),
                ratelimit::limit_open,
            )),
        )
        .route("/v1/claim/verify", post(routes::verify_claim))
        .route("/v1/session/settle", post(routes::settle_session))
        .route("/v1/session/reconcile", post(routes::reconcile_session))
        .route("/v1/buy/{*resource}", get(routes::buy))
        // One session, by its own address. An agent needs this to resume and
        // to read its remaining escrow; knowing the address is not a secret,
        // and the evidence for it is already public by design.
        .route("/v1/session/{session}", get(routes::get_session))
        .route("/v1/session/{session}/evidence", get(routes::session_evidence))
        .route(
            "/v1/session/{session}/settlement",
            get(routes::on_chain_settlement),
        )
        .route("/v1/evidence/proof", post(routes::evidence_proof))
        .route("/v1/catalogue", get(control::catalogue))
        // The agent's own planner. In the OPEN router deliberately: identity
        // comes from a signature over the session, not from the operator
        // token, and placement here means `limit_general` already covers it.
        .route("/v1/session/plan", post(control::plan_for_session))
        .with_state(Arc::clone(&state));

    let open = open.layer(axum::middleware::from_fn_with_state(
        Arc::clone(&state),
        ratelimit::limit_general,
    ));

    open.merge(control_plane(state))
        .layer(TraceLayer::new_for_http())
        // A hung upstream must not pin a connection indefinitely.
        .layer(TimeoutLayer::with_status_code(
            StatusCode::GATEWAY_TIMEOUT,
            Duration::from_secs(15),
        ))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("AGENTPAY_LOG")
                .unwrap_or_else(|_| EnvFilter::new("info,tower_http=debug")),
        )
        .with_target(true)
        .init();

    // Printed via Display, not Debug. A misconfiguration should tell the
    // operator what to do about it — `AdminTokenRequired(0.0.0.0:8080)` does
    // not, and this is the message someone reads at 2am during a deploy.
    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("\nagentpay-gateway cannot start:\n\n  {e}\n");
            std::process::exit(1);
        }
    };

    info!(
        bind = %config.bind_addr,
        rpc = %config.rpc_url,
        program_id = %config.program_id,
        "starting agentpay-gateway"
    );

    // Durable store when DATABASE_URL is set; otherwise the ephemeral one, with
    // the security consequence stated loudly rather than buried.
    let (db_handle, durable): (Option<Arc<Database>>, bool) = match &config.database_url {
        Some(url) => {
            let db = Database::connect(url).await?;

            // Cold-start hydration. This is what makes a restart survivable:
            // without it the high-water marks are gone and every live session
            // is open to claim replay.
            let active = db.load_active_sessions().await?;
            info!(
                sessions = active.len(),
                "rehydrated active sessions from postgres"
            );
            for s in &active {
                info!(
                    session = %s.session,
                    cumulative = s.cumulative_accepted,
                    nonce = ?s.last_nonce,
                    "restored high-water mark"
                );
            }
            let db = Arc::new(db);
            (Some(db), true)
        }
        None => {
            warn!(
                "DATABASE_URL is not set; session state is IN-MEMORY and does not \
                 survive restart. A restart reopens claim replay for every live \
                 session, and NO evidence is recorded, so settlement commits an \
                 all-zero Merkle root. Do not run this way in production."
            );
            (None, false)
        }
    };

    let store: Arc<dyn SessionStore> = match &db_handle {
        Some(db) => Arc::clone(db) as Arc<dyn SessionStore>,
        None => Arc::new(InMemorySessionStore::new()),
    };

    // Settlement needs the provider's signing key. Without one the gateway
    // still verifies claims; it just cannot submit. See Config for the trust
    // note on what holding this key does and does not permit.
    let provider_keypair = match &config.provider_keypair_path {
        Some(path) => {
            let kp = load_keypair(path)?;
            info!(provider = %kp.pubkey(), "settlement enabled");
            Some(Arc::new(kp))
        }
        None => {
            warn!(
                "AGENTPAY_PROVIDER_KEYPAIR is not set; running VERIFY-ONLY. \
                 /v1/session/settle will return ERR_SETTLEMENT_UNAVAILABLE"
            );
            None
        }
    };

    // One RPC client, shared. Previously this was created only when a provider
    // keypair existed, which tied reading the chain to being able to settle;
    // reconciliation needs to read regardless.
    let rpc = Arc::new(RpcClient::new_with_commitment(
        config.rpc_url.clone(),
        settle::commitment(),
    ));

    let session_fetcher: Option<Arc<dyn SessionAccountFetcher>> = if config.trust_open_requests {
        warn!(
            "AGENTPAY_TRUST_OPEN_REQUESTS=1: /v1/session/open will NOT be reconciled \
             against the chain. A caller can assert a deposit that was never escrowed \
             and have claims authorised against credit that does not exist. \
             Development only."
        );
        None
    } else {
        info!("on-chain session reconciliation enabled");
        Some(Arc::new(RpcSessionFetcher::new(Arc::clone(&rpc))))
    };

    let upstream = match &config.upstream_url {
        Some(url) => {
            info!(upstream = %url, "paid resource path enabled at /v1/buy");
            Some(Arc::new(buy::Upstream::new(url.clone())))
        }
        None => {
            warn!("AGENTPAY_UPSTREAM_URL is not set; /v1/buy will return ERR_UPSTREAM_NOT_CONFIGURED");
            None
        }
    };

    // The registry. A single-provider deployment keeps working unchanged
    // because AGENTPAY_UPSTREAM_URL is entered under the reserved id
    // `default`, so /v1/buy resolves to exactly the upstream it always did.
    let registry = Arc::new(registry::Registry::new());
    if let Some(db) = &db_handle {
        match db.list_providers().await {
            Ok(rows) => {
                for r in rows {
                    registry.upsert(r).await;
                }
                info!(
                    providers = registry.list().await.len(),
                    "provider registry loaded"
                );
            }
            // A registry that cannot be read is empty, not fatal: the money
            // path does not depend on it, and the bootstrap provider below
            // still lets /v1/buy work.
            Err(e) => warn!(error = %e, "could not load the provider registry"),
        }
    }
    if let Some(url) = &config.upstream_url {
        // Registered even when the table already holds `default`, because the
        // environment is the more authoritative statement of where this
        // gateway's own upstream lives.
        registry
            .upsert(registry::ProviderRecord {
                provider_id: registry::DEFAULT_PROVIDER_ID.to_string(),
                label: "Configured upstream".to_string(),
                base_url: url.clone(),
                provider_pubkey: provider_keypair.as_ref().map(|k| k.pubkey().to_string()),
                enabled: true,
            })
            .await;
        if let Some(db) = &db_handle {
            let _ = db
                .upsert_provider(&registry::ProviderRecord {
                    provider_id: registry::DEFAULT_PROVIDER_ID.to_string(),
                    label: "Configured upstream".to_string(),
                    base_url: url.clone(),
                    provider_pubkey: provider_keypair.as_ref().map(|k| k.pubkey().to_string()),
                    enabled: true,
                })
                .await;
        }
    }

    match &config.admin_token {
        Some(_) => info!("control plane requires an admin token"),
        None => warn!(
            "AGENTPAY_ADMIN_TOKEN is not set. The control plane is UNAUTHENTICATED: \
             anyone who can reach {} can approve spends and suspend agents. This is \
             permitted only because the bind address is loopback — binding anywhere \
             else without a token is refused at startup.",
            config.bind_addr
        ),
    }

    if config.require_agent_policy {
        info!(
            "AGENTPAY_REQUIRE_AGENT_POLICY=1: sessions whose agent has no authorized \
             record will be refused at /v1/buy"
        );
    } else if db_handle.is_some() {
        info!(
            "agent policies are optional; a session whose agent has no record is \
             bounded by its on-chain escrow alone. Set AGENTPAY_REQUIRE_AGENT_POLICY=1 \
             to require one."
        );
    }

    let state = Arc::new(AppState {
        store,
        db: db_handle,
        durable_state: durable,
        program_id: config.program_id,
        clock: Arc::new(system_clock),
        // Settlement additionally needs a signing key; without one it stays
        // verify-only even though the RPC client exists.
        rpc: provider_keypair.as_ref().map(|_| Arc::clone(&rpc)),
        provider_keypair,
        session_fetcher,
        upstream,
        network: config.network.clone(),
        admin_token: config.admin_token.clone(),
        // Strict on the path that costs an RPC read per request; loose
        // elsewhere, where a signature is already the gate.
        open_limiter: Arc::new(ratelimit::RateLimiter::new(ratelimit::Quota::per_minute(
            config.open_rate_limit,
        ))),
        general_limiter: Arc::new(ratelimit::RateLimiter::new(
            ratelimit::Quota::per_minute(config.general_rate_limit),
        )),
        registry,
        require_agent_policy: config.require_agent_policy,
    });

    let listener = tokio::net::TcpListener::bind(config.bind_addr).await?;
    info!(addr = %listener.local_addr()?, "listening");

    // into_make_service_with_connect_info is what puts the peer address in the
    // request extensions. Without it every client shares one rate-limit bucket.
    axum::serve(
        listener,
        build_router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

/// Reads a Solana CLI keypair file: a JSON array of 64 bytes.
fn load_keypair(path: &str) -> Result<Keypair, Box<dyn std::error::Error>> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read provider keypair at {path}: {e}"))?;
    let bytes: Vec<u8> = serde_json::from_str(&raw)
        .map_err(|e| format!("provider keypair at {path} is not a JSON byte array: {e}"))?;
    let bytes: [u8; 64] = bytes
        .try_into()
        .map_err(|_| format!("provider keypair at {path} is not 64 bytes"))?;
    Keypair::try_from(&bytes[..]).map_err(|e| format!("invalid provider keypair: {e}").into())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    info!("shutdown signal received");
}
