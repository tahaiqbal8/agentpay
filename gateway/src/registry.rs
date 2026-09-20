//! The provider registry: who sells what, and at what price.
//!
//! # Why a registry rather than a price list
//!
//! Before this, the gateway talked to exactly one upstream named by
//! `AGENTPAY_UPSTREAM_URL`. That is enough to enforce payment but not enough
//! for an agent to *choose*: selection between one option is not selection.
//!
//! The registry holds many providers and aggregates their catalogues into one
//! view an agent can plan against.
//!
//! # What has not changed
//!
//! Prices still come from each provider's own `/_catalogue`, never from the
//! gateway and never from the registry table. Registering a provider records
//! *where to ask*, not *what to charge*. A gateway that invented prices would
//! be charging for someone else's goods, and a provider could not change a
//! price without asking us to redeploy.
//!
//! A provider that is unreachable is omitted from the aggregate with its error
//! recorded, rather than failing the whole listing — one dead provider must not
//! make the registry unusable — but its resources are then not purchasable,
//! because pricing one requires reading its catalogue.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::buy::{normalise_resource, ResourcePrice, SharedUpstream, Upstream};

/// The id the bootstrap provider is registered under.
///
/// `AGENTPAY_UPSTREAM_URL` keeps working exactly as before by being entered
/// into the registry under this id at boot, so a single-provider deployment
/// needs no migration and `/v1/buy` behaves identically.
pub const DEFAULT_PROVIDER_ID: &str = "default";

/// A provider as the registry records it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderRecord {
    pub provider_id: String,
    pub label: String,
    pub base_url: String,
    /// The key that settles sessions with this provider. `None` is legal for
    /// browsing a catalogue; settlement needs it.
    pub provider_pubkey: Option<String>,
    pub enabled: bool,
}

/// One purchasable resource, told from the point of view of an agent choosing.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogueEntry {
    pub provider_id: String,
    pub provider_label: String,
    pub resource: String,
    /// Micro-USDC, decimal string. Never a JSON number — above 2^53 a double
    /// silently rounds, and this is a price.
    pub price: String,
    pub description: String,
}

/// A provider the registry could not read, and why.
#[derive(Debug, Clone, Serialize)]
pub struct ProviderError {
    pub provider_id: String,
    pub base_url: String,
    pub error: String,
}

/// The aggregate an agent plans against.
#[derive(Debug, Clone, Serialize)]
pub struct AggregateCatalogue {
    pub entries: Vec<CatalogueEntry>,
    /// Providers that did not answer. Listed rather than hidden: an agent that
    /// cannot see a provider should know it exists and is down, not conclude
    /// the resource does not exist.
    pub unavailable: Vec<ProviderError>,
}

/// Holds one `Upstream` client per provider, created on demand.
///
/// The clients are kept rather than rebuilt per request because each carries a
/// catalogue cache; rebuilding would defeat it and hammer providers.
pub struct Registry {
    providers: RwLock<HashMap<String, (ProviderRecord, SharedUpstream)>>,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            providers: RwLock::new(HashMap::new()),
        }
    }

    /// Adds or replaces a provider.
    ///
    /// Replacing rebuilds the client, which drops the cached catalogue — right,
    /// because a changed `base_url` means the old cache describes a different
    /// server.
    pub async fn upsert(&self, record: ProviderRecord) {
        let upstream: SharedUpstream = Arc::new(Upstream::new(record.base_url.clone()));
        self.providers
            .write()
            .await
            .insert(record.provider_id.clone(), (record, upstream));
    }

    pub async fn remove(&self, provider_id: &str) -> bool {
        self.providers.write().await.remove(provider_id).is_some()
    }

    pub async fn list(&self) -> Vec<ProviderRecord> {
        let mut out: Vec<ProviderRecord> = self
            .providers
            .read()
            .await
            .values()
            .map(|(r, _)| r.clone())
            .collect();
        // Stable order so the console does not reshuffle between polls.
        out.sort_by(|a, b| a.provider_id.cmp(&b.provider_id));
        out
    }

    pub async fn get(&self, provider_id: &str) -> Option<ProviderRecord> {
        self.providers
            .read()
            .await
            .get(provider_id)
            .map(|(r, _)| r.clone())
    }

    /// The client for one provider, if it is registered and enabled.
    ///
    /// A disabled provider resolves to `None` rather than to its client, so
    /// disabling is enforced at the point of use and not merely in the listing.
    pub async fn upstream_for(&self, provider_id: &str) -> Option<SharedUpstream> {
        self.providers
            .read()
            .await
            .get(provider_id)
            .filter(|(r, _)| r.enabled)
            .map(|(_, u)| Arc::clone(u))
    }

    pub async fn is_empty(&self) -> bool {
        self.providers.read().await.is_empty()
    }

    /// Every resource every enabled provider currently offers.
    async fn snapshot(&self) -> Vec<(ProviderRecord, SharedUpstream)> {
        self.providers
            .read()
            .await
            .values()
            .filter(|(r, _)| r.enabled)
            .map(|(r, u)| (r.clone(), Arc::clone(u)))
            .collect()
    }

    /// Reads every enabled provider's catalogue and merges them.
    pub async fn aggregate(&self) -> AggregateCatalogue {
        let providers = self.snapshot().await;
        let mut entries = Vec::new();
        let mut unavailable = Vec::new();

        for (record, upstream) in providers {
            match upstream.catalogue().await {
                Ok(cat) => {
                    for (resource, ResourcePrice { price, description }) in cat.resources {
                        entries.push(CatalogueEntry {
                            provider_id: record.provider_id.clone(),
                            provider_label: record.label.clone(),
                            resource: normalise_resource(&resource),
                            price,
                            description,
                        });
                    }
                }
                Err(e) => unavailable.push(ProviderError {
                    provider_id: record.provider_id.clone(),
                    base_url: record.base_url.clone(),
                    error: e.to_string(),
                }),
            }
        }

        // Cheapest first, then by provider so equal prices are deterministic.
        // A non-numeric price sorts last rather than panicking: the catalogue
        // is someone else's data and must not be able to crash the listing.
        entries.sort_by(|a, b| {
            let pa = a.price.parse::<u64>().unwrap_or(u64::MAX);
            let pb = b.price.parse::<u64>().unwrap_or(u64::MAX);
            pa.cmp(&pb).then_with(|| a.provider_id.cmp(&b.provider_id))
        });

        AggregateCatalogue {
            entries,
            unavailable,
        }
    }

    /// Every provider offering `resource`, cheapest first.
    ///
    /// This is the selection primitive: an agent asks who sells a thing and
    /// gets the options ordered by price, rather than being told one answer.
    pub async fn offers_of(&self, resource: &str) -> Vec<CatalogueEntry> {
        let wanted = normalise_resource(resource);
        self.aggregate()
            .await
            .entries
            .into_iter()
            .filter(|e| e.resource == wanted)
            .collect()
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

pub type SharedRegistry = Arc<Registry>;

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, url: &str, enabled: bool) -> ProviderRecord {
        ProviderRecord {
            provider_id: id.to_string(),
            label: format!("{id} label"),
            base_url: url.to_string(),
            provider_pubkey: None,
            enabled,
        }
    }

    #[tokio::test]
    async fn a_disabled_provider_is_listed_but_cannot_be_bought_from() {
        // Disabling must bite at the point of use. Enforcing it only in the
        // listing would leave a direct request working against a provider the
        // operator believes they turned off.
        let reg = Registry::new();
        reg.upsert(record("off", "http://127.0.0.1:1/", false)).await;

        assert_eq!(reg.list().await.len(), 1, "still visible to an operator");
        assert!(
            reg.upstream_for("off").await.is_none(),
            "a disabled provider must not resolve to a client"
        );
    }

    #[tokio::test]
    async fn an_unknown_provider_resolves_to_nothing() {
        let reg = Registry::new();
        assert!(reg.upstream_for("nope").await.is_none());
        assert!(reg.get("nope").await.is_none());
    }

    #[tokio::test]
    async fn an_unreachable_provider_is_reported_not_silently_dropped() {
        // Port 1 is not listening. The aggregate must still return, with the
        // failure named: an agent that cannot see a provider should learn it is
        // down, not conclude its resources do not exist.
        let reg = Registry::new();
        reg.upsert(record("dead", "http://127.0.0.1:1/", true)).await;

        let agg = reg.aggregate().await;
        assert!(agg.entries.is_empty());
        assert_eq!(agg.unavailable.len(), 1);
        assert_eq!(agg.unavailable[0].provider_id, "dead");
        assert!(
            !agg.unavailable[0].error.is_empty(),
            "the reason must be carried, not just the fact"
        );
    }

    #[tokio::test]
    async fn upsert_replaces_rather_than_duplicating() {
        let reg = Registry::new();
        reg.upsert(record("p", "http://a/", true)).await;
        reg.upsert(record("p", "http://b/", true)).await;

        let all = reg.list().await;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].base_url, "http://b/");
    }

    #[tokio::test]
    async fn listing_order_is_stable() {
        // The console polls this; an unstable order would make rows jump.
        let reg = Registry::new();
        for id in ["zeta", "alpha", "mid"] {
            reg.upsert(record(id, "http://x/", true)).await;
        }
        let ids: Vec<String> = reg.list().await.into_iter().map(|r| r.provider_id).collect();
        assert_eq!(ids, vec!["alpha", "mid", "zeta"]);
    }
}
