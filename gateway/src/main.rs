//! AgentPay enforcement gateway.
//!
//! Sits between an agent and a provider: verifies each cumulative claim,
//! enforces ordering against session state, and (eventually) submits one
//! aggregated settlement per session.
//!
//! Trust boundary: this process is trusted for availability and policy
//! enforcement, never for custody. It holds no keys that can move funds beyond
//! what the escrow program's on-chain constraints already permit.

mod claim;
mod config;
mod db;
mod error;
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
use crate::db::Database;
use crate::state::{InMemorySessionStore, SessionStore};

pub fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(routes::health))
        .route("/v1/session/open", post(routes::open_session))
        .route("/v1/claim/verify", post(routes::verify_claim))
        .route("/v1/session/settle", post(routes::settle_session))
        .layer(TraceLayer::new_for_http())
        // A hung upstream must not pin a connection indefinitely.
        .layer(TimeoutLayer::with_status_code(
            StatusCode::GATEWAY_TIMEOUT,
            Duration::from_secs(15),
        ))
        .with_state(state)
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

    let config = Config::from_env()?;

    info!(
        bind = %config.bind_addr,
        rpc = %config.rpc_url,
        program_id = %config.program_id,
        "starting agentpay-gateway"
    );

    // Durable store when DATABASE_URL is set; otherwise the ephemeral one, with
    // the security consequence stated loudly rather than buried.
    let (store, durable): (Arc<dyn SessionStore>, bool) = match &config.database_url {
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
            (Arc::new(db), true)
        }
        None => {
            warn!(
                "DATABASE_URL is not set; session state is IN-MEMORY and does not \
                 survive restart. A restart reopens claim replay for every live \
                 session. Do not run this way in production."
            );
            (Arc::new(InMemorySessionStore::new()), false)
        }
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

    let rpc = provider_keypair.as_ref().map(|_| {
        Arc::new(RpcClient::new_with_commitment(
            config.rpc_url.clone(),
            settle::commitment(),
        ))
    });

    let state = Arc::new(AppState {
        store,
        durable_state: durable,
        program_id: config.program_id,
        clock: Arc::new(system_clock),
        rpc,
        provider_keypair,
    });

    let listener = tokio::net::TcpListener::bind(config.bind_addr).await?;
    info!(addr = %listener.local_addr()?, "listening");

    axum::serve(listener, build_router(state))
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
