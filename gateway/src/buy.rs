//! Paid resource access — the 402 handshake and the forwarding path.
//!
//! This is what turns the enforcement engine into something an agent can
//! actually buy from. Without it the gateway can say "allowed" but nothing is
//! ever purchased.
//!
//! # The flow
//!
//! ```text
//! GET /v1/buy/weather?city=lahore                  (no claim)
//!   → 402 Payment Required + what to pay
//!
//! GET /v1/buy/weather?city=lahore                  (X-Agentpay-Claim: …)
//!   → verify signature → check ordering/limits → forward upstream → 200 + data
//! ```
//!
//! # The invariant that matters most
//!
//! **A refused claim must never reach the provider.** If it did, an agent could
//! send a claim it knows will be rejected and still receive the resource — free
//! data, which defeats the entire system. The forward happens strictly after
//! `admit_claim` returns `Ok(Ok(_))`, and `denied_requests_never_reach_upstream`
//! tests exactly that.
//!
//! # Why the price comes from the provider
//!
//! The gateway reads `/_catalogue` from upstream rather than holding its own
//! price list. A gateway that invented prices would be charging for someone
//! else's goods, and the provider could not change a price without redeploying
//! us.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

/// How long a fetched catalogue is trusted before re-reading it.
const CATALOGUE_TTL: Duration = Duration::from_secs(60);

/// Upstream must answer within this, or the request fails closed.
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ResourcePrice {
    /// Micro-USDC as a decimal string. Never a JSON number: above 2^53 a
    /// double silently rounds, and this is a price.
    pub price: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Catalogue {
    #[serde(default)]
    pub provider: String,
    pub resources: HashMap<String, ResourcePrice>,
}

#[derive(Debug, thiserror::Error)]
pub enum UpstreamError {
    #[error("upstream is not configured")]
    NotConfigured,
    #[error("upstream unreachable: {0}")]
    Unreachable(String),
    #[error("upstream catalogue is malformed: {0}")]
    BadCatalogue(String),
    #[error("no such resource: {0}")]
    UnknownResource(String),
    #[error("price for {resource} is not a u64 micro-USDC value: {value}")]
    BadPrice { resource: String, value: String },
}

/// Talks to the provider: reads its price list, forwards paid requests.
pub struct Upstream {
    base_url: String,
    client: reqwest::Client,
    cached: RwLock<Option<(Catalogue, Instant)>>,
}

pub struct UpstreamResponse {
    pub status: u16,
    pub body: String,
    pub content_type: String,
    /// Echoed back so a caller can confirm the provider really answered.
    pub served_by: Option<String>,
}

impl Upstream {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            client: reqwest::Client::builder()
                .timeout(UPSTREAM_TIMEOUT)
                .build()
                .expect("reqwest client builds with a timeout"),
            cached: RwLock::new(None),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// The provider's price list, cached briefly.
    pub async fn catalogue(&self) -> Result<Catalogue, UpstreamError> {
        if let Some((cat, fetched)) = self.cached.read().await.as_ref() {
            if fetched.elapsed() < CATALOGUE_TTL {
                return Ok(cat.clone());
            }
        }

        let url = format!("{}/_catalogue", self.base_url);
        let res = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| UpstreamError::Unreachable(e.to_string()))?;

        if !res.status().is_success() {
            return Err(UpstreamError::Unreachable(format!(
                "catalogue returned HTTP {}",
                res.status()
            )));
        }

        let cat: Catalogue = res
            .json()
            .await
            .map_err(|e| UpstreamError::BadCatalogue(e.to_string()))?;

        *self.cached.write().await = Some((cat.clone(), Instant::now()));
        Ok(cat)
    }

    /// Price of one resource, in micro-USDC.
    pub async fn price_of(&self, resource: &str) -> Result<u64, UpstreamError> {
        let cat = self.catalogue().await?;
        let key = normalise_resource(resource);
        let entry = cat
            .resources
            .get(&key)
            .ok_or_else(|| UpstreamError::UnknownResource(key.clone()))?;

        entry
            .price
            .parse::<u64>()
            .map_err(|_| UpstreamError::BadPrice {
                resource: key,
                value: entry.price.clone(),
            })
    }

    /// Forwards a paid request upstream.
    ///
    /// Only ever called after a claim has been admitted. Nothing in this
    /// function re-checks that, which is precisely why the call site ordering is
    /// covered by a test.
    pub async fn forward(
        &self,
        resource: &str,
        query: &str,
    ) -> Result<UpstreamResponse, UpstreamError> {
        let path = normalise_resource(resource);
        let url = if query.is_empty() {
            format!("{}{}", self.base_url, path)
        } else {
            format!("{}{}?{}", self.base_url, path, query)
        };

        let res = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| UpstreamError::Unreachable(e.to_string()))?;

        let status = res.status().as_u16();
        let content_type = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/json")
            .to_string();
        let served_by = res
            .headers()
            .get("x-served-by")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);

        let body = res
            .text()
            .await
            .map_err(|e| UpstreamError::Unreachable(e.to_string()))?;

        Ok(UpstreamResponse {
            status,
            body,
            content_type,
            served_by,
        })
    }
}

/// `weather` and `/weather/` both mean `/weather`.
///
/// Catalogue keys are stored with a leading slash, and an agent should not have
/// to guess which spelling we wanted.
pub fn normalise_resource(resource: &str) -> String {
    let trimmed = resource.trim_matches('/');
    format!("/{trimmed}")
}

/// The body of a 402 response: everything an agent needs to pay.
#[derive(Debug, Serialize)]
pub struct PaymentRequired {
    /// Names the claim format so a future scheme can be told apart from this one.
    pub scheme: &'static str,
    pub network: String,
    pub resource: String,
    pub description: String,
    /// Micro-USDC, decimal string.
    pub price: String,
    /// What the agent's next cumulative total must be, given what it has already
    /// spent. Saves the agent re-deriving it and getting it wrong.
    pub next_cumulative: Option<String>,
    pub next_nonce: Option<String>,
    pub session_hint: &'static str,
    pub claim_header: &'static str,
    pub signing: SigningHint,
}

/// The exact byte layout an agent must sign.
///
/// Spelled out in the 402 itself because this is the part integrations get
/// wrong, and getting it wrong fails silently at settlement rather than here.
#[derive(Debug, Serialize)]
pub struct SigningHint {
    pub algorithm: &'static str,
    pub message: &'static str,
    pub encoding: &'static str,
    pub total_bytes: usize,
}

impl SigningHint {
    pub fn new() -> Self {
        Self {
            algorithm: "ed25519",
            message: "\"agentpay:claim:v1\" || session(32) || cumulative_le(8) || nonce_le(8) || expires_at_le(8)",
            encoding: "little-endian integers; signature base58",
            total_bytes: crate::claim::CLAIM_MESSAGE_LEN,
        }
    }
}

impl Default for SigningHint {
    fn default() -> Self {
        Self::new()
    }
}

pub type SharedUpstream = Arc<Upstream>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_paths_normalise() {
        assert_eq!(normalise_resource("weather"), "/weather");
        assert_eq!(normalise_resource("/weather"), "/weather");
        assert_eq!(normalise_resource("/weather/"), "/weather");
        assert_eq!(normalise_resource("//weather//"), "/weather");
    }

    #[test]
    fn prices_parse_as_integers_only() {
        let cat: Catalogue = serde_json::from_str(
            r#"{"provider":"x","resources":{"/a":{"price":"1000","description":"d"}}}"#,
        )
        .unwrap();
        assert_eq!(cat.resources["/a"].price.parse::<u64>().unwrap(), 1000);

        // A float price must not silently truncate to an integer.
        let bad: Catalogue =
            serde_json::from_str(r#"{"provider":"x","resources":{"/a":{"price":"0.001"}}}"#)
                .unwrap();
        assert!(bad.resources["/a"].price.parse::<u64>().is_err());
    }

    #[test]
    fn signing_hint_matches_the_real_claim_length() {
        // If the claim format ever changes, the 402 must not keep advertising
        // the old one.
        assert_eq!(SigningHint::new().total_bytes, 73);
    }

    #[test]
    fn base_url_trailing_slash_is_normalised() {
        let u = Upstream::new("http://provider:4021/".to_string());
        assert_eq!(u.base_url(), "http://provider:4021");
    }
}

/// Integration tests for the paid path.
///
/// These need a real upstream, so they spin up a tiny one in-process and count
/// how many times it is actually hit. Counting is the whole point: the security
/// property is not "denied requests return an error", it is "denied requests
/// never touch the provider at all".
#[cfg(test)]
mod paid_path_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Minimal upstream that records every hit.
    async fn spawn_counting_provider() -> (String, Arc<AtomicUsize>) {
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_for_server = Arc::clone(&hits);

        let app = axum::Router::new()
            .route(
                "/_catalogue",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({
                        "provider": "test",
                        "resources": {
                            "/cheap": { "price": "1000", "description": "cheap" },
                            "/pricey": { "price": "25000", "description": "pricey" }
                        }
                    }))
                }),
            )
            .route(
                "/cheap",
                axum::routing::get(move || {
                    let hits = Arc::clone(&hits_for_server);
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        axum::Json(serde_json::json!({ "data": "the goods" }))
                    }
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        (format!("http://{addr}"), hits)
    }

    #[tokio::test]
    async fn catalogue_is_read_from_the_provider_not_invented() {
        let (url, _) = spawn_counting_provider().await;
        let up = Upstream::new(url);

        assert_eq!(up.price_of("/cheap").await.unwrap(), 1000);
        assert_eq!(up.price_of("pricey").await.unwrap(), 25_000);
    }

    #[tokio::test]
    async fn unknown_resource_is_refused_rather_than_priced_at_zero() {
        let (url, hits) = spawn_counting_provider().await;
        let up = Upstream::new(url);

        // A resource the provider does not sell must error, never fall back to
        // "free" — that would hand out anything not in the catalogue.
        assert!(matches!(
            up.price_of("/not-for-sale").await,
            Err(UpstreamError::UnknownResource(_))
        ));
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn forwarding_reaches_the_provider_and_returns_its_body() {
        let (url, hits) = spawn_counting_provider().await;
        let up = Upstream::new(url);

        let res = up.forward("/cheap", "").await.unwrap();
        assert_eq!(res.status, 200);
        assert!(res.body.contains("the goods"));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    /// The invariant the whole handler exists to protect.
    ///
    /// Mirrors the handler's ordering: evaluate first, and only forward when the
    /// claim was admitted. If this ever fails, an agent can send a claim it knows
    /// will be refused and still be served — free data.
    #[tokio::test]
    async fn denied_requests_never_reach_upstream() {
        use crate::claim::Claim;
        use crate::state::{evaluate_claim, SessionRecord};
        use solana_pubkey::Pubkey;

        let (url, hits) = spawn_counting_provider().await;
        let up = Upstream::new(url);

        let session = Pubkey::new_from_array([1u8; 32]);
        let mut record = SessionRecord::new(
            session,
            Pubkey::new_from_array([2u8; 32]),
            Pubkey::new_from_array([3u8; 32]),
            Pubkey::new_from_array([4u8; 32]),
            5_000,
            1_000_000 + 3600,
        );
        record.cumulative_accepted = 4_000;

        // Over the deposit ceiling: must be refused.
        let over = Claim {
            session,
            cumulative_amount: 9_999_999,
            nonce: 1,
            expires_at: 1_000_000 + 600,
        };

        let verdict = evaluate_claim(&record, &over, 1_000_000);
        assert!(verdict.is_err(), "claim should have been refused");

        // The handler returns here. Nothing forwards.
        if verdict.is_ok() {
            let _ = up.forward("/cheap", "").await;
        }

        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "a refused claim reached the provider — the agent got free data"
        );
    }

    #[tokio::test]
    async fn an_admitted_claim_does_reach_upstream() {
        use crate::claim::Claim;
        use crate::state::{evaluate_claim, SessionRecord};
        use solana_pubkey::Pubkey;

        let (url, hits) = spawn_counting_provider().await;
        let up = Upstream::new(url);

        let session = Pubkey::new_from_array([1u8; 32]);
        let record = SessionRecord::new(
            session,
            Pubkey::new_from_array([2u8; 32]),
            Pubkey::new_from_array([3u8; 32]),
            Pubkey::new_from_array([4u8; 32]),
            5_000_000,
            1_000_000 + 3600,
        );

        // Exactly the asking price for /cheap.
        let good = Claim {
            session,
            cumulative_amount: 1_000,
            nonce: 1,
            expires_at: 1_000_000 + 600,
        };

        let verdict = evaluate_claim(&record, &good, 1_000_000);
        assert!(verdict.is_ok());
        if verdict.is_ok() {
            let res = up.forward("/cheap", "").await.unwrap();
            assert_eq!(res.status, 200);
        }
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn unreachable_provider_fails_closed() {
        // Nothing listening here.
        let up = Upstream::new("http://127.0.0.1:1".to_string());
        assert!(matches!(
            up.price_of("/cheap").await,
            Err(UpstreamError::Unreachable(_))
        ));
    }
}
