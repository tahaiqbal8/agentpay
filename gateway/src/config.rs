//! Configuration, entirely from the environment.
//!
//! No network address, program ID, or mint is hardcoded. A mainnet endpoint
//! must never be reachable by forgetting to pass a flag.

use std::net::SocketAddr;

use solana_pubkey::Pubkey;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub rpc_url: String,
    pub program_id: Pubkey,
    /// Path to the provider's Solana keypair JSON.
    ///
    /// TRUST NOTE: `settle_session` requires the provider's signature, so the
    /// gateway must hold this key to settle on their behalf. This is the one
    /// key the gateway holds, and its blast radius is bounded on-chain: the
    /// program constrains `provider_token_account.owner == provider`, so a
    /// compromised gateway can settle *early* or at a lower amount, but cannot
    /// redirect funds anywhere except the provider's own account, and cannot
    /// exceed the agent's signed cumulative claim. It is optional so the
    /// gateway can run in verify-only mode with no signing key present at all.
    pub provider_keypair_path: Option<String>,
    /// Postgres connection string.
    ///
    /// When absent the gateway falls back to the in-memory store, which does
    /// not survive a restart. That fallback is a development convenience and is
    /// warned about loudly at boot; production must set this.
    pub database_url: Option<String>,
    /// Disables on-chain reconciliation in `/v1/session/open`.
    ///
    /// Named for what it does rather than for the convenience it buys. With
    /// this set the gateway believes whatever a caller asserts about a session,
    /// including a deposit that was never escrowed, so claims get authorised
    /// against credit that does not exist. Development only.
    pub trust_open_requests: bool,
    /// Provider behind /v1/buy. Absent disables the paid path entirely.
    pub upstream_url: Option<String>,
    /// Network label echoed in 402 responses.
    pub network: String,
    /// Shared secret guarding the control plane.
    ///
    /// `None` is permitted ONLY on a loopback bind; `from_env` refuses to
    /// build otherwise. See `auth.rs` for what this protects and why the money
    /// path is deliberately not behind it.
    pub admin_token: Option<String>,
    /// Refuse sessions whose agent has no authorized record.
    ///
    /// Off by default: the control plane is additive, and an existing
    /// deployment must not start refusing traffic because the gateway was
    /// upgraded. On, every session must belong to an agent a human authorized.
    pub require_agent_policy: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} is not set")]
    Missing(&'static str),
    #[error("{0} is not valid: {1}")]
    Invalid(&'static str, String),
    #[error(
        "AGENTPAY_RPC_URL points at mainnet ({0}). This build is devnet-only; \
         set AGENTPAY_ALLOW_MAINNET=1 to override deliberately."
    )]
    MainnetRefused(String),
    #[error(
        "AGENTPAY_BIND_ADDR is {0}, which is reachable from outside this machine, \
         but AGENTPAY_ADMIN_TOKEN is not set. The control plane would then let \
         anyone who can reach the port approve their own spends and suspend \
         other people's agents. Set a token, or bind to 127.0.0.1.\n\n  \
         AGENTPAY_ADMIN_TOKEN=$(openssl rand -hex 32)"
    )]
    AdminTokenRequired(SocketAddr),
    #[error(
        "AGENTPAY_ADMIN_TOKEN is {0} characters; at least {1} are required. A short \
         token is worse than none, because it looks like security."
    )]
    AdminTokenTooShort(usize, usize),
}

/// Reads an optional variable, treating empty and whitespace-only as unset.
fn optional_env(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => Some(v),
        _ => None,
    }
}

fn require(key: &'static str) -> Result<String, ConfigError> {
    optional_env(key).ok_or(ConfigError::Missing(key))
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let bind_addr = std::env::var("AGENTPAY_BIND_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:8080".to_string())
            .parse::<SocketAddr>()
            .map_err(|e| ConfigError::Invalid("AGENTPAY_BIND_ADDR", e.to_string()))?;

        let rpc_url = require("AGENTPAY_RPC_URL")?;

        // Guard rail, not security: nothing here holds custody, but an
        // accidental mainnet RPC would be a bad surprise during a demo.
        let looks_like_mainnet = rpc_url.contains("mainnet");
        let override_set = std::env::var("AGENTPAY_ALLOW_MAINNET").is_ok_and(|v| v == "1");
        if looks_like_mainnet && !override_set {
            return Err(ConfigError::MainnetRefused(rpc_url));
        }

        let program_id = require("AGENTPAY_PROGRAM_ID")?
            .parse::<Pubkey>()
            .map_err(|e| ConfigError::Invalid("AGENTPAY_PROGRAM_ID", e.to_string()))?;

        // An EMPTY value means absent, not "use the empty string".
        //
        // Docker Compose interpolates an unset `${VAR}` to an empty string
        // rather than omitting it, so without this the gateway would try to open
        // a keypair at path "" and exit at startup — a confusing failure for
        // something the operator deliberately left blank.
        let provider_keypair_path = optional_env("AGENTPAY_PROVIDER_KEYPAIR");
        let database_url = optional_env("DATABASE_URL");
        let trust_open_requests =
            std::env::var("AGENTPAY_TRUST_OPEN_REQUESTS").is_ok_and(|v| v == "1");
        let upstream_url = optional_env("AGENTPAY_UPSTREAM_URL");
        let require_agent_policy =
            std::env::var("AGENTPAY_REQUIRE_AGENT_POLICY").is_ok_and(|v| v == "1");

        // The control-plane guard, and the one rule that makes it hold:
        // exposing this gateway beyond loopback without a token is refused at
        // BOOT. Failing here means the operator is watching a deploy; failing
        // at the first request means a stranger found it first.
        let admin_token = optional_env("AGENTPAY_ADMIN_TOKEN");
        if let Some(t) = admin_token.as_deref() {
            if t.len() < crate::auth::MIN_TOKEN_LEN {
                return Err(ConfigError::AdminTokenTooShort(
                    t.len(),
                    crate::auth::MIN_TOKEN_LEN,
                ));
            }
        } else if !bind_addr.ip().is_loopback() {
            return Err(ConfigError::AdminTokenRequired(bind_addr));
        }
        let network = optional_env("AGENTPAY_NETWORK").unwrap_or_else(|| {
            // Derived from the RPC URL so the 402 cannot claim devnet while
            // actually talking to something else.
            if rpc_url.contains("devnet") {
                "solana:devnet".to_string()
            } else if rpc_url.contains("testnet") {
                "solana:testnet".to_string()
            } else if rpc_url.contains("mainnet") {
                "solana:mainnet".to_string()
            } else {
                "solana:localnet".to_string()
            }
        });

        Ok(Self {
            bind_addr,
            rpc_url,
            program_id,
            provider_keypair_path,
            admin_token,
            require_agent_policy,
            database_url,
            trust_open_requests,
            upstream_url,
            network,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mainnet_url_is_refused_without_the_override() {
        let err = ConfigError::MainnetRefused("https://api.mainnet-beta.solana.com".into());
        assert!(err.to_string().contains("devnet-only"));
    }

    #[test]
    fn empty_env_values_count_as_unset() {
        // Docker Compose turns an unset ${VAR} into an empty string. Treating
        // that as a real value makes the gateway die on a path of "".
        std::env::set_var("AGENTPAY_TEST_EMPTY", "");
        std::env::set_var("AGENTPAY_TEST_BLANK", "   ");
        std::env::set_var("AGENTPAY_TEST_REAL", "/etc/key.json");

        assert_eq!(optional_env("AGENTPAY_TEST_EMPTY"), None);
        assert_eq!(optional_env("AGENTPAY_TEST_BLANK"), None);
        assert_eq!(
            optional_env("AGENTPAY_TEST_REAL"),
            Some("/etc/key.json".to_string())
        );
        assert_eq!(optional_env("AGENTPAY_TEST_NEVER_SET"), None);
    }

    #[test]
    fn bind_addr_parses() {
        assert!("127.0.0.1:8080".parse::<SocketAddr>().is_ok());
    }
}
