# AgentPay — SaaS / Commercial Architecture Report

**Status: PARTLY IMPLEMENTED. Phases 1–3 of §P were built — the schema
(workspaces, usage_records, subscriptions), usage metering at decision time,
and workspace-scoped control-plane reads and writes. Phase 8 (settlement
custody) was also built and shipped as program v2; see
[SETTLEMENT_CUSTODY.md](SETTLEMENT_CUSTODY.md) and
[RELEASE_V2.md](RELEASE_V2.md). Phases 4, 5, 6 and 7 — provider-facing
endpoints and console pages, the billing abstraction, tenant-aware rate
limiting, and multi-provider buy routing — are NOT built.**

**Everything in the commercial argument remains unvalidated.** There is still
no design partner, no pilot and no customer conversation; read the status
ledger at the end before quoting any part of this document.

This report is the output of a read-only audit of the repository at commit
`09855df`, and is written in the present tense of that moment. Everything below
is classified:

| Tag | Meaning |
| --- | --- |
| `[EXISTING]` | Already built and working today |
| `[SMALL ADDITION]` | Additive; no existing behaviour changes |
| `[NEW FEATURE]` | New surface area, but isolated from the core |
| `[ARCHITECTURAL CHANGE]` | Touches how the system is shaped. Needs care. |

And every claim is separated into:

- **TECHNICALLY PROVEN** — demonstrated against devnet, with artifacts
- **COMMERCIAL HYPOTHESIS** — a belief we hold, with no evidence yet
- **NOT YET VALIDATED** — a question nobody has answered

---

# A. Current architecture relevant to SaaS

## A.1 The layers that exist

```
  Agent (holds Ed25519 key, signs claims)
    │
    │  x-agentpay-claim header
    ▼
  Gateway  ── Postgres (high-water mark, evidence log)
    │     └── Solana devnet RPC (reconciliation, settlement)
    │
    ▼
  Provider API  (139 lines, zero payment code)
```

## A.2 The invariant that must not move

From `gateway/src/routes.rs`, the `/v1/buy` ordering is:

```
price lookup → 402 → decode claim → expiry → session lookup
  → signature → price match → enforce_agent_policy → admit_claim → forward
```

Policy runs **before** `admit_claim` so a refusal does not consume a nonce.
Nothing in this report reorders this.

## A.3 Database — the complete picture

Seven tables, five migrations. **Every one of them is global.**

| Table | Purpose | Tenant column? |
| --- | --- | --- |
| `sessions` | escrow state, high-water mark source | **none** |
| `claim_tickets` | latest accepted claim per session | **none** |
| `evidence_log` | hash-chained decisions | **none** |
| `providers` | registry: where to ask | **none** (is itself the would-be tenant) |
| `agents` | agent identity | **none** |
| `agent_policies` | the envelope | **none** |
| `approvals` | human-in-the-loop queue | **none** |
| `operators` | per-operator API tokens | **none** |

## A.4 Authentication as it stands today

Three identities already exist and are already correctly separated:

1. **Agent** — Ed25519 keypair. Proves itself by signing a 73-byte canonical
   claim. Never has a password or a token. `[EXISTING]`
2. **Operator** — a bearer token, either the shared `AGENTPAY_ADMIN_TOKEN` or a
   per-operator token hashed into `operators.token_hash`. `[EXISTING]`
3. **Provider** — *does not exist as an authenticated identity.* A provider is
   a **row** in `providers` created by an operator. It cannot log in, holds no
   credential, and can see nothing.

That third gap is the whole commercial problem in one line.

---

# B. What already supports the business model

These are real and load-bearing. **TECHNICALLY PROVEN.**

| Capability | Where | Evidence |
| --- | --- | --- |
| Provider needs zero payment code | `demo-provider/server.js` | 139 lines, no 402, no wallet, no signature check |
| Escrow-backed sessions | Anchor program `open_session` | devnet |
| Policy enforcement, ordered | `gateway/src/policy.rs` | allowlist → per-call → count → budget → approval |
| Replay prevention | high-water mark in Postgres | `ERR_CLAIM_NOT_MONOTONIC` on an equal claim |
| Refusal is recorded, not discarded | `evidence_log` | denials are hash-chained too |
| A refusal is provable to a third party | Merkle inclusion proof | proof verified against on-chain root; wrong leaf and tampered proof both rejected |
| Settlement is per-session, not per-call | `settle_session` | 7 claims → 1 transaction, 0.00001 SOL |
| Agent suspension | `agents.status` | `from_str_or_suspended` fails closed |
| Per-operator credentials + audit trail | `operators`, `approvals.decided_by_label` | snapshot, not a lookup |

The unit economics argument is the strongest commercial asset here: settlement
cost is amortised across every call in a session, which is what makes sub-cent
API calls servable at all.

---

# C. What is missing

Five findings, ordered by how much they change the plan.

## C.1 There is no tenant boundary anywhere `[ARCHITECTURAL CHANGE]`

No table has a `workspace_id`. Any operator token can read every agent, every
session, every piece of evidence, and every settlement in the database.

This is not a bug — the system was built as a single operator's gateway. But it
means **multi-tenancy is a schema change across seven tables plus every query**,
not a filter added to a handler.

## C.2 The money path is single-provider `[ARCHITECTURAL CHANGE]`

`/v1/buy/{resource}` resolves its upstream from `state.upstream`, which comes
from one environment variable, `AGENTPAY_UPSTREAM_URL`.

The `providers` registry **is not consulted by the buy path at all.** It feeds
`/v1/catalogue` and the planner — discovery and advice — and nothing else.
`main.rs` says so directly: the single-provider deployment keeps working because
the upstream is entered under the reserved id `default`.

So one running gateway serves exactly one provider's API. A hosted control
plane serving many providers requires the buy path to resolve the provider from
the resource, which means routing, per-provider catalogue caching, and a
per-provider failure domain.

## C.3 Settlement requires the provider's own signature `[ARCHITECTURAL CHANGE]`

From the Anchor program:

```rust
pub struct SettleSession<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,
    ...
}
```

`settle_session` **requires the provider to sign the transaction.** The gateway
today satisfies this by holding one key (`AGENTPAY_PROVIDER_KEYPAIR`) and
refusing to settle any session whose provider does not match it.

This collides head-on with the product promise that a provider should not need
wallet management. For a hosted gateway there are only three honest options,
and they are discussed in **M. Security considerations**. This is the hardest
unsolved problem in the entire commercial design, and it is a custody problem,
not an engineering one.

## C.4 No per-decision resource or price `[SMALL ADDITION]`

`evidence_log` records `session_pubkey, sequence_id, cumulative_amount, nonce,
decision, prev_hash, entry_hash, signature`.

It does **not** record which resource was bought, or at what price.

So the question "how many calls to `/weather` did this provider serve last
month" is **unanswerable from the current schema**. SaaS metering needs it.

The constraint that shapes the fix: `decision` is part of the entry hash
preimage, and the table comment is explicit — *"these strings are frozen:
renaming one changes every historical root."* Therefore **resource and price
must be added as non-hashed sidecar columns.** They must never enter the hash
preimage, or every historical Merkle root becomes unverifiable.

## C.5 Rate limiting keys on the TCP peer address `[SMALL ADDITION]`

`ratelimit.rs` keys buckets on `ConnectInfo<SocketAddr>` and deliberately
ignores `X-Forwarded-For`, because a caller can forge that header.

That is the right call for a directly-exposed gateway. Behind a load balancer —
which any hosted deployment has — every tenant collapses into one bucket, and
one noisy agent rate-limits everybody.

---

# D. Minimum viable commercial architecture

The smallest thing that is honestly a SaaS:

```
  workspace  (the paying customer — one provider company)
     │
     ├── members        operators scoped to this workspace
     ├── providers      the APIs this workspace exposes
     ├── agents         agents authorised against those APIs
     │      └── sessions → evidence → settlements
     └── subscription   plan + included usage + usage records
```

**One workspace owns one or more providers.** Agents belong to a workspace
because they were authorised against that workspace's APIs. Sessions and
evidence inherit the workspace from the agent.

Deliberately **not** in the MVP: org hierarchies, RBAC beyond
owner/member, SSO, per-resource pricing tiers, usage-based overage billing.

---

# E. Proposed database changes

## E.1 New tables `[NEW FEATURE]`

```sql
workspaces (
  workspace_id   VARCHAR(64) PRIMARY KEY,
  name           VARCHAR(128) NOT NULL,
  plan           VARCHAR(32)  NOT NULL DEFAULT 'starter',
  status         VARCHAR(16)  NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- SaaS usage. Deliberately separate from evidence_log: evidence is a
-- cryptographic record whose shape is frozen by the hash preimage, and
-- billing must never be a reason to touch it.
usage_records (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces,
  provider_id  VARCHAR(64) NOT NULL,
  agent_id     VARCHAR(64),
  session_pubkey VARCHAR(44),
  resource     TEXT        NOT NULL,
  price        BIGINT      NOT NULL,
  decision     VARCHAR(32) NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

subscriptions (
  workspace_id    VARCHAR(64) PRIMARY KEY REFERENCES workspaces,
  plan            VARCHAR(32) NOT NULL,
  included_calls  BIGINT      NOT NULL,
  period_start    TIMESTAMPTZ NOT NULL,
  period_end      TIMESTAMPTZ NOT NULL,
  external_ref    TEXT,          -- billing provider's id. Nullable on purpose.
  status          VARCHAR(16) NOT NULL DEFAULT 'active'
);
```

## E.2 Added columns `[SMALL ADDITION]`

```sql
ALTER TABLE providers ADD COLUMN workspace_id VARCHAR(64) REFERENCES workspaces;
ALTER TABLE agents    ADD COLUMN workspace_id VARCHAR(64) REFERENCES workspaces;
ALTER TABLE operators ADD COLUMN workspace_id VARCHAR(64) REFERENCES workspaces;
ALTER TABLE operators ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'member';

-- Sidecar, NOT part of any hash. See C.4.
ALTER TABLE evidence_log ADD COLUMN resource TEXT;
ALTER TABLE evidence_log ADD COLUMN price    BIGINT;
```

`sessions` inherits its workspace through `agents.agent_pubkey`. Denormalising
`workspace_id` onto `sessions` is an optimisation to defer until a query is
actually slow.

**Every added column is nullable.** Existing rows keep working; a NULL
workspace means "belongs to the legacy single-tenant deployment".

---

# F. Proposed API changes

## F.1 New, provider-facing `[NEW FEATURE]`

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/workspaces` | create a workspace (signup) |
| GET | `/v1/workspace` | the caller's own workspace |
| GET | `/v1/workspace/usage` | metered calls for the current period |
| GET | `/v1/workspace/revenue` | settled volume, from real settlements |
| POST | `/v1/workspace/members` | invite an operator |

## F.2 Scoped, not changed `[SMALL ADDITION]`

Every existing control-plane endpoint gains a workspace filter derived from the
caller's token. **No request or response shape changes.** A legacy token with a
NULL workspace sees everything, exactly as today.

## F.3 Untouched `[EXISTING]`

`/v1/buy`, `/v1/session/open`, `/v1/claim/verify`, `/v1/session/settle`,
`/v1/evidence/proof`, `/v1/session/{s}/evidence`, `/v1/catalogue`.

The money path and the public verification path do not learn what a workspace
is. A third party verifying a proof must never need an account.

---

# G. Proposed authentication changes

Keep the three identities separate — they already are, and the separation is
correct:

| Identity | Proves itself with | Scope | Change |
| --- | --- | --- | --- |
| **Agent** | Ed25519 signature over a claim | one session | none `[EXISTING]` |
| **Operator / member** | bearer token, SHA-256 in `operators` | one workspace | add `workspace_id` + `role` `[SMALL ADDITION]` |
| **Provider service credential** | *does not exist* | one workspace | `[NEW FEATURE]` |
| **Shared admin token** | `AGENTPAY_ADMIN_TOKEN` | everything | becomes break-glass only `[SMALL ADDITION]` |

`auth.rs` already resolves a token into an `Operator` struct placed in request
extensions. Adding `workspace_id` to that struct is the single insertion point
for tenant scoping — which is a genuinely fortunate piece of existing design.

**Human login (email/password, sessions, reset) is deliberately out of scope
for the MVP.** Workspace API tokens are enough to prove the model. Adding real
auth before knowing anyone wants the product is effort spent on a guess.

---

# H. Provider onboarding flow

```
1. Create workspace                    POST /v1/workspaces        [NEW]
2. Register API base_url               POST /v1/providers         [EXISTING]
3. Publish /_catalogue on their API    provider's own work        [EXISTING]
4. Receive workspace token             returned once at step 1    [NEW]
5. Point agents at the gateway         config, no code            [EXISTING]
6. Test one payment                    npm run sdk-demo:v1-legacy           [EXISTING]
7. Go live                             —
```

**Steps 2, 3, 5 and 6 already work.** The provider's integration is genuinely
just: serve a `/_catalogue` price list, and let the gateway sit in front.

Step 3 is the only code a provider writes, and it is a static JSON endpoint.

The unsolved step is settlement custody (C.3), which onboarding cannot paper
over.

---

# I. Usage metering design

**Blockchain settlement is not the billing event.** Today's devnet run makes
the distinction concrete:

| Concept | Count | Unit |
| --- | --- | --- |
| API calls the agent made | 7 | SaaS billable |
| Claims admitted | 3 | — |
| Claims refused | 4 | SaaS billable (enforcement is the product) |
| Solana settlements | 1 | not a billing event |

**Refusals must be metered.** Refusing is the work the provider is paying for.
A price list that only counts successful calls would charge nothing for the
feature that is the entire value proposition.

Write path: one `usage_records` insert alongside the existing `evidence_log`
write, in the same transaction. `[SMALL ADDITION]`

Why not derive usage from `evidence_log` instead? Because it lacks resource and
price (C.4), and because coupling billing to the cryptographic record means a
billing requirement could one day argue for changing the hash preimage. Keeping
them apart makes that conversation impossible.

---

# J. Billing abstraction

```
Workspace → Subscription → Plan → UsageRecord → Invoice
```

Define a trait, implement it twice: `[NEW FEATURE]`

```rust
trait BillingProvider {
    async fn create_customer(&self, ws: &Workspace) -> Result<String>;
    async fn report_usage(&self, sub: &Subscription, qty: u64) -> Result<()>;
    async fn subscription_status(&self, external_ref: &str) -> Result<Status>;
}
```

- `ManualBilling` — writes to `subscriptions`, invoices by hand. **This is the
  MVP.** It is sufficient for the first ten customers.
- `StripeBilling` — added only when there is someone to charge.

**No Stripe dependency until a customer exists.** The repository has no payment
processor integration today and should not acquire one on speculation.

Critically: `agentpay-gateway` must not depend on the billing crate. Billing
failure must never be able to refuse a payment claim.

---

# K. Multi-tenancy model

```
workspace ──┬── members (operators, scoped tokens)
            ├── providers ── resources (from their own /_catalogue)
            └── agents ──── sessions ──── evidence ──── settlements
```

**Isolation rules for the MVP:**

1. Every control-plane query filters on the caller's `workspace_id`.
2. A NULL `workspace_id` on a token means legacy admin — sees everything.
   Keeps existing deployments working through the migration.
3. Public verification endpoints are **not** scoped. Anyone with a session
   address can fetch its evidence and prove a decision. This is intentional and
   must survive: verifiability that requires an account is not verifiability.
4. Two roles only: `owner` (can invite, can change the plan) and `member`.

**The isolation test that must exist before this ships:** create two
workspaces, and assert that workspace A's token receives 404 — not 403 — for
every one of B's agents, sessions, approvals, and usage records. A 403 confirms
the resource exists, which is itself a leak.

---

# L. Console changes

The console was redesigned recently. **Do not redesign it.** Reuse `Stat`,
`Table`, `Badge`, `Card`, the type scale and the colour semantics.

Minimum commercial pages for an MVP:

| Page | Status | Data source |
| --- | --- | --- |
| Provider Overview | `[NEW FEATURE]` | `usage_records` + `sessions` |
| APIs / Resources | `[EXISTING]` — Registry page, needs scoping | `providers` + `/v1/catalogue` |
| Agents | `[EXISTING]` — needs scoping | `agents` |
| Sessions | `[EXISTING]` — Monitor, needs scoping | `sessions` |
| Usage | `[NEW FEATURE]` | `usage_records` |
| Revenue | `[NEW FEATURE]` | settled sessions — **real settlements only** |
| Evidence | `[EXISTING]` — Verifier | unchanged, stays public |
| Billing | `[NEW FEATURE]` | `subscriptions` |
| Team | `[NEW FEATURE]` | `operators` scoped |

Defer: Settings, notifications, anything with a chart that has no time-series
endpoint behind it. The existing `Stat` primitive carries a comment explaining
why it has no sparkline — that reasoning still holds.

**No fake metrics.** If Revenue has no settled sessions, it shows zero and says
why, the way the Monitor now says "none live right now".

---

# M. Security considerations

## M.1 Settlement custody — the unsolved problem

`settle_session` requires `provider: Signer`. Three options, none free:

| Option | Cost |
| --- | --- |
| Gateway holds each provider's key | AgentPay becomes a custodian of N signing keys. Needs HSM/KMS, an audit, and probably a licence conversation. Contradicts "no wallet management". |
| Provider runs a thin signing worker | Provider manages a key after all — weakens the pitch, but honest and cheap |
| Provider signs from the console with a browser wallet | No custody, but settlement is manual and needs a human |

**Recommendation: option 2 for the MVP, and say so plainly.** The pitch becomes
"you write no payment code" rather than "you touch no key", which is still a
large and true claim. Option 1 is the right long-term answer and must not be
attempted without an external security review.

## M.2 Other items

- **Tenant isolation is a security boundary, not a UX filter.** Every scoped
  query needs a test, not a code review.
- **Rate limiting** (C.5) must become tenant-aware before a shared deployment,
  or one tenant can deny service to all.
- **Workspace tokens** should reuse the existing `operators` mechanism: 32
  CSPRNG bytes, SHA-256 at rest, shown once. That design is already correct and
  documented in `0005_operators.sql`.
- **The admin token** must be demoted to break-glass and logged loudly when used.

---

# N. Migration strategy

Every step is reversible and additive. No existing deployment breaks.

1. Add tables and nullable columns. Nothing reads them. Zero behaviour change.
2. Backfill: create one workspace, assign existing rows to it.
3. Start writing `usage_records` alongside evidence. Still nothing reads them.
4. Add workspace resolution to `auth.rs`. NULL workspace = see everything.
5. Add scoping to control-plane queries, one endpoint at a time, each with an
   isolation test.
6. Add the provider-facing endpoints and console pages.
7. Only then: multi-provider buy routing (C.2), which is the genuinely risky
   change and deserves its own plan.

---

# O. What must NOT be changed

Non-negotiable. Changing any of these invalidates every existing Merkle root,
every published proof, or the custody guarantee:

- claim message format (73 bytes, `"agentpay:claim:v1"` domain)
- claim signature verification, including the Ed25519 precompile introspection
- cumulative claim semantics and the high-water mark
- nonce monotonicity
- expiry validation and clock-skew tolerance
- the escrow ceiling
- policy enforcement ordering
- the `/v1/buy` ordering: verify → policy → admit → forward → evidence
- the evidence hash chain and its preimage, **including the `decision` strings**
- Merkle construction, including odd-node duplication handling
- settlement and refund semantics
- all Solana program instructions
- verifier logic

**And per the brief: no protocol fee, and no treasury split in
`settle_session`.** AgentPay revenue stays entirely outside the chain:

```
Agent escrow:     Agent → vault → Provider     (on chain, no fee)
AgentPay revenue: Provider → AgentPay          (off chain, SaaS)
```

---

# P. Recommended implementation phases

| Phase | Work | Risk | Demoable? |
| --- | --- | --- | --- |
| 1 | Schema: workspaces, usage_records, subscriptions, nullable columns | **Lowest** | No |
| 2 | Write `usage_records` at decision time; add `resource`/`price` sidecars | Low | Yes — real metering |
| 3 | `workspace_id` on the `Operator` struct; scope control-plane reads | Medium | Yes — two isolated tenants |
| 4 | Provider-facing endpoints + Usage/Revenue/Billing console pages | Medium | **Yes — this is the SaaS demo** |
| 5 | `ManualBilling` and the `BillingProvider` trait | Low | Partly |
| 6 | Tenant-aware rate limiting | Medium | No |
| 7 | Multi-provider buy routing | **Highest** | Yes, but needs real customers first |
| 8 | Settlement custody | **Highest** | Needs external security review |

**Lowest-risk path:** phases 1 → 2 → 3. Purely additive, testable, and the
core money path is never touched.

**Highest-risk path:** phases 7 and 8. Both change how money moves. Neither
should start before a real design partner exists, because both are expensive
answers to questions no customer has yet asked.

**Demoable immediately after phase 4:** two isolated workspaces, each seeing
only its own agents, sessions, usage and evidence, with real numbers from real
devnet activity.

**Requires real customers:** pricing tiers, overage policy, enterprise
features, multi-provider routing.

**Requires external review:** settlement key custody (M.1), and mainnet.

---

# Honest status ledger

## TECHNICALLY PROVEN

Escrow-backed agent payment · policy enforcement with ordered refusal reasons ·
replay and regression prevention via the high-water mark · nonce monotonicity ·
refusal recorded as evidence · Merkle inclusion proof of a refusal verified
against an on-chain root, with negative controls · per-session settlement on
devnet at 0.00001 SOL · agent suspension · per-operator credentials with a
decided-by audit snapshot · a provider integrating with zero payment code.

## COMMERCIAL HYPOTHESIS

That API providers will pay monthly for a hosted control plane. That the ICP is
a provider **already** receiving agent traffic it cannot price. That a tier
priced below current market entry points is the right wedge. That metering
refusals as billable is acceptable to customers. That providers will accept
running a thin signing worker (M.1, option 2).

## NOT YET VALIDATED

No design partner. No pilot. No customer conversation. No evidence anyone will
pay anything. No pricing research. No measurement of how much unpriced agent
traffic a real provider sees. No demand signal for enterprise features.

**The single highest-value next action is not in this document.** It is one
conversation with one API provider who is already seeing agent traffic. Every
phase above is cheaper and more likely to be correct after that conversation
than before it.
