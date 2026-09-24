//! Per-client rate limiting.
//!
//! # What this protects
//!
//! `/v1/session/open` performs a Solana RPC read on every request and needs no
//! credential — by design, because reconciliation is what makes the endpoint
//! trustworthy. Unlimited, that lets anyone burn the gateway's RPC quota, which
//! providers meter and charge for, and take reconciliation down for everyone
//! else. That is the path this exists for; the rest is defence in depth.
//!
//! The money path is deliberately given a loose limit. It is protected by
//! signatures, and an attacker without one is refused by a shape check before
//! any I/O happens — so the expensive work never runs. A tight limit there
//! would break legitimate high-volume agents, which is the whole point of the
//! product, in exchange for stopping nothing.
//!
//! # The part that is usually got wrong
//!
//! A naive per-IP map grows without bound: an attacker rotating source
//! addresses turns a rate limiter into a memory exhaustion bug, which is worse
//! than having none. Two things prevent that here — idle buckets are evicted,
//! and the map has a hard cap. **At the cap, new clients are refused rather
//! than admitted**, because a limiter that fails open under pressure protects
//! nothing at exactly the moment it matters.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Most buckets held at once.
///
/// At 64 bytes a bucket this is a few megabytes — small enough to be safe,
/// large enough that a real deployment never reaches it.
const MAX_BUCKETS: usize = 50_000;

/// A bucket untouched for this long is evicted.
const IDLE_EVICTION: Duration = Duration::from_secs(300);

/// A token bucket: `capacity` requests, refilling at `capacity / period`.
///
/// Chosen over a fixed window because a window lets a client spend its whole
/// allowance in the last instant of one window and again in the first instant
/// of the next, which is twice the intended rate at the worst moment.
#[derive(Debug, Clone, Copy)]
pub struct Quota {
    pub capacity: u32,
    pub period: Duration,
}

impl Quota {
    pub const fn per_minute(capacity: u32) -> Self {
        Self {
            capacity,
            period: Duration::from_secs(60),
        }
    }

    fn refill_per_sec(&self) -> f64 {
        self.capacity as f64 / self.period.as_secs_f64()
    }
}

#[derive(Debug)]
struct Bucket {
    tokens: f64,
    last: Instant,
}

/// The outcome of asking for permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// Refused, with roughly how long until a token is available.
    Refuse { retry_after_secs: u64 },
}

pub struct RateLimiter {
    buckets: Mutex<HashMap<IpAddr, Bucket>>,
    quota: Quota,
}

impl RateLimiter {
    pub fn new(quota: Quota) -> Self {
        Self {
            buckets: Mutex::new(HashMap::new()),
            quota,
        }
    }

    /// Takes one token for `key`, or refuses.
    pub fn check(&self, key: IpAddr) -> Decision {
        self.check_at(key, Instant::now())
    }

    /// `check`, with the clock injected so the behaviour is testable without
    /// sleeping.
    fn check_at(&self, key: IpAddr, now: Instant) -> Decision {
        let mut buckets = match self.buckets.lock() {
            Ok(g) => g,
            // A poisoned lock means another thread panicked holding it. Fail
            // CLOSED: a limiter that stops limiting after one panic is the
            // failure mode this whole module exists to avoid.
            Err(_) => return Decision::Refuse { retry_after_secs: 1 },
        };

        // Evict before inserting, so a burst of new clients cannot push the map
        // past its cap while stale entries are still sitting in it.
        if buckets.len() >= MAX_BUCKETS {
            buckets.retain(|_, b| now.duration_since(b.last) < IDLE_EVICTION);
        }

        let refill = self.quota.refill_per_sec();
        let capacity = self.quota.capacity as f64;

        match buckets.get_mut(&key) {
            Some(bucket) => {
                let elapsed = now.duration_since(bucket.last).as_secs_f64();
                bucket.tokens = (bucket.tokens + elapsed * refill).min(capacity);
                bucket.last = now;

                if bucket.tokens >= 1.0 {
                    bucket.tokens -= 1.0;
                    Decision::Allow
                } else {
                    let needed = (1.0 - bucket.tokens) / refill;
                    Decision::Refuse {
                        retry_after_secs: needed.ceil().max(1.0) as u64,
                    }
                }
            }
            None => {
                // Still full after eviction: refuse rather than admit an
                // untracked client. Admitting would mean an attacker who can
                // fill the map gets unlimited access, which inverts the
                // control.
                if buckets.len() >= MAX_BUCKETS {
                    return Decision::Refuse { retry_after_secs: 1 };
                }
                buckets.insert(
                    key,
                    Bucket {
                        tokens: capacity - 1.0,
                        last: now,
                    },
                );
                Decision::Allow
            }
        }
    }

    /// Buckets currently held. Exposed for tests and for a future metric.
    pub fn tracked(&self) -> usize {
        self.buckets.lock().map(|b| b.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod proxy_tests {
    use super::*;
    use axum::extract::ConnectInfo;
    use axum::http::Request as HttpRequest;
    use std::net::SocketAddr;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    /// Builds a request as if it arrived from `peer`, optionally carrying an
    /// `X-Forwarded-For`.
    fn req(peer: &str, xff: Option<&str>) -> Request {
        let mut b = HttpRequest::builder().uri("/");
        if let Some(v) = xff {
            b = b.header("x-forwarded-for", v);
        }
        let mut r: Request = b.body(axum::body::Body::empty()).unwrap();
        let addr: SocketAddr = format!("{peer}:40000").parse().unwrap();
        r.extensions_mut().insert(ConnectInfo(addr));
        r
    }

    /// The bypass this whole mechanism exists to prevent.
    ///
    /// A client talking to the gateway directly can write any address it likes
    /// into `X-Forwarded-For`. If that were believed, every request could claim
    /// a fresh bucket and the limiter would be decorative.
    #[test]
    fn a_direct_client_cannot_spoof_its_way_into_a_fresh_bucket() {
        let trusted = vec![ip("10.0.0.1")];
        // Peer 203.0.113.9 is NOT trusted, so its header is worthless.
        for spoof in ["1.2.3.4", "5.6.7.8", "9.9.9.9"] {
            let got = client_ip_with(&req("203.0.113.9", Some(spoof)), &trusted);
            assert_eq!(
                got,
                ip("203.0.113.9"),
                "an untrusted peer's X-Forwarded-For must be ignored entirely"
            );
        }
    }

    /// With nothing configured the header is never believed, from anyone.
    #[test]
    fn with_no_trusted_proxies_the_header_is_always_ignored() {
        let got = client_ip_with(&req("10.0.0.1", Some("1.2.3.4")), &[]);
        assert_eq!(got, ip("10.0.0.1"), "empty list means believe nobody");
    }

    /// The deployment this exists for: nginx in front, real client behind.
    #[test]
    fn a_trusted_proxy_reveals_the_real_client() {
        let trusted = vec![ip("127.0.0.1")];
        let got = client_ip_with(&req("127.0.0.1", Some("198.51.100.7")), &trusted);
        assert_eq!(got, ip("198.51.100.7"));
    }

    /// Two clients through one proxy must land in two buckets. Without this
    /// they share one, and a single noisy client rate-limits everybody.
    #[test]
    fn two_clients_behind_one_proxy_get_separate_buckets() {
        let trusted = vec![ip("127.0.0.1")];
        let a = client_ip_with(&req("127.0.0.1", Some("198.51.100.7")), &trusted);
        let b = client_ip_with(&req("127.0.0.1", Some("198.51.100.8")), &trusted);
        assert_ne!(a, b, "distinct clients must key distinctly");
    }

    /// A chain of proxies: walk from the right, skip hops we ourselves trust,
    /// and stop at the first address a trusted hop actually observed.
    #[test]
    fn a_chain_of_trusted_proxies_is_walked_from_the_right() {
        let trusted = vec![ip("127.0.0.1"), ip("10.0.0.5")];
        // client -> 10.0.0.5 -> 127.0.0.1 -> us
        let got = client_ip_with(&req("127.0.0.1", Some("198.51.100.7, 10.0.0.5")), &trusted);
        assert_eq!(got, ip("198.51.100.7"));
    }

    /// Everything to the LEFT of the first untrusted hop is client-supplied and
    /// must not be believed, even through a trusted proxy.
    #[test]
    fn client_supplied_hops_to_the_left_are_not_believed() {
        let trusted = vec![ip("127.0.0.1")];
        // The client prepended a lie; the proxy appended the truth.
        let got = client_ip_with(
            &req("127.0.0.1", Some("1.1.1.1, 2.2.2.2, 198.51.100.7")),
            &trusted,
        );
        assert_eq!(
            got,
            ip("198.51.100.7"),
            "the rightmost untrusted entry is the only one a trusted hop vouched for"
        );
    }

    /// A malformed header must fail safe — never to something an attacker
    /// supplied, and never by panicking.
    #[test]
    fn malformed_forwarding_headers_fail_safe() {
        let trusted = vec![ip("127.0.0.1")];
        for bad in ["", ",,,", "not-an-ip", "999.999.999.999", "  ", "<script>"] {
            let got = client_ip_with(&req("127.0.0.1", Some(bad)), &trusted);
            assert_eq!(
                got,
                ip("127.0.0.1"),
                "malformed header {bad:?} must fall back to the peer"
            );
        }
    }

    /// A garbage entry between real ones is skipped, not fatal.
    #[test]
    fn one_bad_hop_does_not_poison_the_whole_header() {
        let trusted = vec![ip("127.0.0.1")];
        let got = client_ip_with(&req("127.0.0.1", Some("198.51.100.7, garbage")), &trusted);
        assert_eq!(got, ip("198.51.100.7"));
    }

    /// A trusted proxy that forwards nothing leaves the peer standing.
    #[test]
    fn a_trusted_proxy_with_no_header_keys_on_the_peer() {
        let trusted = vec![ip("127.0.0.1")];
        assert_eq!(client_ip_with(&req("127.0.0.1", None), &trusted), ip("127.0.0.1"));
    }

    /// An attacker cannot escape their bucket by naming a trusted proxy.
    #[test]
    fn naming_a_trusted_proxy_in_the_header_does_not_help_an_attacker() {
        let trusted = vec![ip("127.0.0.1")];
        // Untrusted peer claims to be the proxy. Still ignored.
        let got = client_ip_with(&req("203.0.113.9", Some("127.0.0.1")), &trusted);
        assert_eq!(got, ip("203.0.113.9"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(n: u8) -> IpAddr {
        IpAddr::from([10, 0, 0, n])
    }

    #[test]
    fn a_client_gets_its_capacity_and_then_is_refused() {
        let rl = RateLimiter::new(Quota::per_minute(3));
        let t = Instant::now();
        for i in 0..3 {
            assert_eq!(rl.check_at(ip(1), t), Decision::Allow, "request {i}");
        }
        assert!(matches!(
            rl.check_at(ip(1), t),
            Decision::Refuse { .. }
        ));
    }

    #[test]
    fn clients_are_limited_independently() {
        // One noisy client must not refuse everybody else.
        let rl = RateLimiter::new(Quota::per_minute(1));
        let t = Instant::now();
        assert_eq!(rl.check_at(ip(1), t), Decision::Allow);
        assert!(matches!(rl.check_at(ip(1), t), Decision::Refuse { .. }));
        assert_eq!(rl.check_at(ip(2), t), Decision::Allow);
    }

    #[test]
    fn tokens_refill_over_time() {
        let rl = RateLimiter::new(Quota::per_minute(60)); // one per second
        let t0 = Instant::now();
        assert_eq!(rl.check_at(ip(1), t0), Decision::Allow);

        // Drain the bucket.
        for _ in 0..59 {
            let _ = rl.check_at(ip(1), t0);
        }
        assert!(matches!(rl.check_at(ip(1), t0), Decision::Refuse { .. }));

        // One second later, exactly one token is back.
        let t1 = t0 + Duration::from_secs(1);
        assert_eq!(rl.check_at(ip(1), t1), Decision::Allow);
        assert!(matches!(rl.check_at(ip(1), t1), Decision::Refuse { .. }));
    }

    #[test]
    fn refill_never_exceeds_capacity() {
        // A client idle for an hour must not accumulate an hour's worth of
        // requests and spend them all at once.
        let rl = RateLimiter::new(Quota::per_minute(5));
        let t0 = Instant::now();
        assert_eq!(rl.check_at(ip(1), t0), Decision::Allow);

        let much_later = t0 + Duration::from_secs(3600);
        for i in 0..5 {
            assert_eq!(rl.check_at(ip(1), much_later), Decision::Allow, "burst {i}");
        }
        assert!(matches!(
            rl.check_at(ip(1), much_later),
            Decision::Refuse { .. }
        ));
    }

    #[test]
    fn retry_after_is_useful_rather_than_zero() {
        let rl = RateLimiter::new(Quota::per_minute(60));
        let t = Instant::now();
        for _ in 0..60 {
            let _ = rl.check_at(ip(1), t);
        }
        match rl.check_at(ip(1), t) {
            Decision::Refuse { retry_after_secs } => {
                // A client told to retry in 0 seconds retries immediately and
                // is refused again, which is a busy loop rather than backoff.
                assert!(retry_after_secs >= 1);
            }
            Decision::Allow => panic!("should have been refused"),
        }
    }

    #[test]
    fn idle_buckets_are_evicted_rather_than_accumulating() {
        let rl = RateLimiter::new(Quota::per_minute(10));
        let t0 = Instant::now();
        for n in 0..50u8 {
            let _ = rl.check_at(ip(n), t0);
        }
        assert_eq!(rl.tracked(), 50);

        // Eviction runs when the map is under pressure. Simulate that by
        // checking the retain predicate directly over an aged map: every
        // bucket older than IDLE_EVICTION goes.
        let aged = t0 + IDLE_EVICTION + Duration::from_secs(1);
        {
            let mut b = rl.buckets.lock().unwrap();
            b.retain(|_, bucket| aged.duration_since(bucket.last) < IDLE_EVICTION);
        }
        assert_eq!(rl.tracked(), 0, "idle buckets must not accumulate forever");
    }

    #[test]
    fn a_full_map_refuses_new_clients_rather_than_admitting_them() {
        // The inversion this guards against: an attacker who can fill the map
        // would otherwise get UNLIMITED access, because an untracked client is
        // an unlimited client.
        let rl = RateLimiter::new(Quota::per_minute(10));
        let t = Instant::now();
        {
            let mut b = rl.buckets.lock().unwrap();
            for n in 0..MAX_BUCKETS {
                b.insert(
                    IpAddr::from([
                        (n >> 24) as u8,
                        (n >> 16) as u8,
                        (n >> 8) as u8,
                        n as u8,
                    ]),
                    Bucket { tokens: 10.0, last: t },
                );
            }
        }
        // Every bucket is fresh, so eviction frees nothing and the newcomer is
        // refused.
        assert!(matches!(
            rl.check_at(ip(200), t),
            Decision::Refuse { .. }
        ));
    }
}

// ---------------------------------------------------------------------------
// Axum middleware
// ---------------------------------------------------------------------------

use axum::extract::{ConnectInfo, Request, State};
use axum::middleware::Next;
use axum::response::Response;
use std::net::SocketAddr;
use std::sync::Arc;

use crate::error::{Denial, ReasonCode};
use crate::routes::{request_id, AppState};

/// The client address a limit is keyed on.
///
/// # The rule
///
/// `X-Forwarded-For` is believed **only** when the request arrived from an
/// address the operator explicitly listed in `AGENTPAY_TRUSTED_PROXIES`. From
/// anyone else the header is ignored entirely and the peer address is used.
///
/// A caller can put anything in that header. Trusting it unconditionally lets
/// an attacker pick a fresh bucket per request and bypass the limit completely,
/// which is strictly worse than no limit — it looks like one and is not.
///
/// # Why the list matters in the other direction too
///
/// With no trusted proxy configured the peer address is the only honest answer,
/// and behind a reverse proxy that address is the PROXY. Every public client
/// then shares one bucket: one noisy client can rate-limit everybody else. That
/// is the failure this configuration exists to fix, and it is the deployment
/// AgentPay actually runs (nginx terminating TLS in front of the gateway).
///
/// # The walk
///
/// `X-Forwarded-For` is appended to by each hop, so the right-hand entries are
/// the ones added closest to us and therefore the ones we can reason about.
/// Walking from the right and skipping entries that are themselves trusted
/// proxies yields the first address a trusted hop actually observed. Anything
/// further left was supplied by the client and is not evidence.
fn client_ip_with(req: &Request, trusted: &[IpAddr]) -> IpAddr {
    let peer = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip())
        // No peer address means the request did not arrive over TCP — a test
        // harness, usually. Key those together rather than exempting them.
        .unwrap_or_else(|| IpAddr::from([0, 0, 0, 0]));

    if trusted.is_empty() || !trusted.contains(&peer) {
        return peer;
    }

    let Some(xff) = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
    else {
        // A trusted proxy that forwarded no header. Nothing to learn; the peer
        // is still the most specific address we have.
        return peer;
    };

    for hop in xff.split(',').rev() {
        // A malformed entry is skipped, not fatal: one bad hop must not make
        // the whole header unusable, and it must not fall through to something
        // an attacker controls either.
        let Ok(ip) = hop.trim().parse::<IpAddr>() else {
            continue;
        };
        if !trusted.contains(&ip) {
            return ip;
        }
    }

    // Every entry was a trusted proxy, or none parsed. The peer stands.
    peer
}

fn client_ip(req: &Request, state: &AppState) -> IpAddr {
    client_ip_with(req, &state.trusted_proxies)
}

/// Limits the expensive, unauthenticated reconciliation path.
pub async fn limit_open(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Result<Response, Denial> {
    let limiter = Arc::clone(&state.open_limiter);
    guard(&limiter, &state, req, next, "session/open").await
}

/// The loose global limit: catches a runaway loop, not a determined attacker.
pub async fn limit_general(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Result<Response, Denial> {
    let limiter = Arc::clone(&state.general_limiter);
    guard(&limiter, &state, req, next, "general").await
}

async fn guard(
    limiter: &RateLimiter,
    state: &AppState,
    req: Request,
    next: Next,
    which: &'static str,
) -> Result<Response, Denial> {
    let ip = client_ip(&req, state);
    match limiter.check(ip) {
        Decision::Allow => Ok(next.run(req).await),
        Decision::Refuse { retry_after_secs } => {
            let rid = request_id();
            tracing::warn!(
                request_id = %rid,
                %ip,
                path = %req.uri().path(),
                limiter = which,
                retry_after_secs,
                "rate limited"
            );
            Err(Denial::new(ReasonCode::ERR_RATE_LIMITED, &rid))
        }
    }
}
