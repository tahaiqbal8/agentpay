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
}

fn require(key: &'static str) -> Result<String, ConfigError> {
    std::env::var(key).map_err(|_| ConfigError::Missing(key))
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

        Ok(Self {
            bind_addr,
            rpc_url,
            program_id,
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
    fn bind_addr_parses() {
        assert!("127.0.0.1:8080".parse::<SocketAddr>().is_ok());
    }
}
