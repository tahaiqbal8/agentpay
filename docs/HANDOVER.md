# AgentPay Engineering Handover

2026-09-19

A Solana enforcement and audit layer for autonomous agent payments.

> **Updated for the v2 release.** Two devnet programs are live at once:
> **v2** `ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m` opens all new sessions,
> and **v1** `3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U` keeps settling and
> refunding the sessions it already holds. Where this document says "the
> program" without qualification and describes provider-signed, one-shot
> settlement, it is describing **v1**. The current custody model, the
> settlement authority and the migration state are in
> [RELEASE_V2.md](RELEASE_V2.md) and
> [MIGRATION_V1_V2.md](MIGRATION_V1_V2.md), which take precedence over this
> document wherever they disagree.

---

## 1. What this is

An AI agent that buys things — API calls, inference, data — makes hundreds of
tiny purchases. Settling each one on-chain is absurd: the fee exceeds the
purchase, and confirmation latency exceeds the work.

AgentPay is a **unidirectional payment channel with an enforcement gateway in
front of it**. The agent escrows once. Every purchase after that is an
off-chain signed claim. One transaction at the end settles the whole session.

### The one idea to understand first

Claims are **cumulative, not incremental**. Claim #40 does not say "pay me
0.001 more" — it says "the total you owe me is now 0.043". Consequences:

- Only the **highest** claim ever needs to reach the chain. The other 39 are
  discarded.
- A lost claim is harmless. The next one supersedes it.
- The chain sees exactly one settlement per session, so **the chain cannot
  detect replay of an old claim**. That defence lives entirely in the
  gateway's high-water mark. This is the single most important thing to
  understand about the system's trust model.

### What makes it more than a channel

Every decision the gateway makes — allow *and* refuse — is written to a
hash-chained evidence log. At settlement the Merkle root of that log is
committed on-chain inside the settlement transaction.

So the product claim is not "the agent paid". Anyone can show that. It is:

> **The agent was stopped, and here is a cryptographic proof of it, anchored
> on a public chain.**

That is what an operator needs when an agent overspends and somebody asks what
happened.

### What this document covers, and what it does not

AgentPay covers the flow from creating an agent through to on-chain
settlement. §2 maps it stage by stage with a status for each — most stages are
built; two remain partial and are named there rather than glossed.

The division that runs through the whole system: **the chain enforces custody,
the gateway enforces policy.** An escrow deposit is an absolute ceiling no
software here can widen. Everything above it — which resources an agent may
buy, how much per call, how many calls, when a human must decide — is
off-chain policy that an operator can change without touching the program.

Read §2's table before treating any part of this document as a product
description.

---

## 2. Architecture

Four processes. Docker Compose runs all of them.

| Component | Language | Port | Lines | Owns |
| --- | --- | --- | --- | --- |
| Anchor program | Rust | — (devnet) | 617 | Escrow custody, signature verification, settlement finality |
| Gateway | Rust / Axum 0.8 | 8080 | 6,677 | Claim verification, high-water mark, evidence log, on-chain submission |
| Console | Next.js 16 / React 19 | 3100 | 3,261 | Operator UI, browser-side proof verification |
| Demo provider | Node (zero deps) | 4021 | ~200 | A resource seller that knows nothing about payments |

Postgres 16 sits behind the gateway on 5434.

### The flow of one purchase

```
agent                gateway              provider           chain
  |                     |                    |                 |
  |-- open escrow ------|--------------------|---------------->|  1 tx
  |-- register session->|--- reconcile ------|---------------->|  read
  |                     |                    |                 |
  |-- GET /v1/buy ----->|                    |                 |
  |<-- 402 + price -----|                    |                 |
  |-- GET + claim ----->| verify, admit      |                 |
  |                     |--- forward ------->|                 |
  |<-- 200 + data ------|<-- data -----------|                 |
  |          (repeat N times, no chain traffic)                |
  |                     |                    |                 |
  |-- settle ---------->|--------------------|---------------->|  1 tx
```

### The separation that matters

**The provider has no payment code.** `demo-provider/server.js` has no 402
handling, no signature checks, no wallet, no Solana dependency. It publishes
prices at `/_catalogue` and serves data. Everything about money happens in the
gateway.

That is the integration story: a provider adds AgentPay by putting the gateway
in front of itself and publishing a price list. It does not learn cryptography.

### The trust boundary

The gateway holds the **provider's** signing key so it can submit settlements.
It never holds the agent's key. An agent signs its own claims; the gateway only
verifies them. There is no custody of user keys anywhere in the gateway or the
frontend — this was a hard design constraint, not an accident.

### The end-to-end agent flow, and where AgentPay sits in it

```
Human
  → Create Agent
  → Bind Wallet
  → Fund Escrow
  → Authorize Policy
  → Discover API
  → Agent Plans Calls
  → Human Approval OR Autonomous Mode
  → Buy / API Calls
  → AgentPay Enforcement
  → Provider
  → Final Settlement
  → Evidence / Merkle Verification
```

Every stage is now implemented except the two marked **Partial**, which are
partial in specific, named ways rather than vaguely. Read the Status column
before planning work against it.

| # | Stage | Who performs it | Status | Where it lives |
| --- | --- | --- | --- | --- |
| 1 | Agent creation | Human / application | **Built** | `POST /v1/agents`, `control.rs` |
| 2 | Agent connection | Human / application | **Built** — an application addresses an agent by its `agent_id` | `agents` table, `GET /v1/agents/{id}` |
| 3 | Wallet connection | Human | **Partial** — an agent binds to a real Ed25519 pubkey, uniquely, and claims are verified against it. What is missing is a *browser wallet adapter*: keys are still files the scripts read. | `agents.agent_pubkey`; §11 |
| 4 | Human authorization + funding | Human | **Built** — `open_session` on-chain, plus an off-chain envelope: per-resource allowlist, per-call cap, total budget, call count, approval threshold, suspension | `open_session` + `POST /v1/agents/{id}/authorize`, `policy.rs` |
| 5 | API / AI registry | Platform | **Built** — many providers, catalogues aggregated live | `registry.rs`, `GET /v1/catalogue` |
| 6 | API selection | Agent | **Built** — offers for a resource, cheapest first, with a recommendation | `POST /v1/agent/plan` |
| 7 | Agent decision (how many calls) | Agent | **Built** — `POST /v1/session/plan` answers for the agent that holds the session, authenticated by a signature rather than the operator token. Choosing a task's real call count is still the application's job; there is no task planner. | `control.rs::plan_for_session`, SDK `plan()`; §11 |
| 8 | API calls | Agent | **Built** — 402 handshake, signed cumulative claims, and `@agentpay/client` so an integrator writes three lines rather than 194 | `/v1/buy/{resource}`, `sdk/`, §4 |
| 9 | Gateway enforcement | Gateway | **Built** — policy, signature, ordering, high-water mark, price match | `verify_claim`, `evaluate_claim`, `policy.rs`, §4 |
| 10 | Provider delivery | Provider | **Built** — forwarded only after admission | `buy.rs`, §4 |
| 11 | Final settlement + anchoring | Gateway → chain | **Built** — one transaction, Merkle root committed | `settle_session`, §3 and §5 |

### Planning has two front doors

| Endpoint | For | Authenticated by |
| --- | --- | --- |
| `POST /v1/agent/plan` | The **operator**. Takes an `agent_id` and can plan for any agent. | `AGENTPAY_ADMIN_TOKEN` |
| `POST /v1/session/plan` | The **agent**. Plans only for the session it holds. No `agent_id` field exists. | A signed claim over that session |

Agent identity is established by the signature, not by a credential: the caller
signs a claim over its session, the gateway verifies it with the same
`verify_claim_signature` the buy path uses, against `record.agent` taken from
**stored state**. The agent is then resolved session → `record.agent` →
`get_agent_by_pubkey`.

Both call the same `plan_options()`, so the two doors cannot drift apart and
report different numbers for the same question.

**The planner is informational only.** It writes nothing, reserves nothing, and
advances nothing. A plan can go stale the moment another purchase lands, and
that is correct: **`/v1/buy` remains the final spending authority**, and
re-checks the signature, the price and the whole envelope from scratch.

#### The planning claim is deliberately non-spendable

It must carry `cumulative_amount == record.cumulative_accepted` and
`nonce == record.last_nonce`. A claim carrying a *higher* cumulative is refused
`ERR_PLAN_CLAIM_MISMATCH`, so the endpoint never handles a spendable claim.

Where such a claim is refused depends on which validation gate receives it
first:

| Gate | Reason code | Why |
| --- | --- | --- |
| `/v1/buy` | `ERR_PRICE_MISMATCH` | The price gate runs **before** `admit_claim` and requires `accepted + price`; a planning claim carries `accepted`. |
| `/v1/claim/verify` | `ERR_CLAIM_NOT_MONOTONIC` | No price gate, so it reaches `evaluate_claim` — the same rule the on-chain program applies. |

**The invariant is: a planning claim can never be used as a payment claim.** The
exact rejection reason depends on which gate receives it first. `/v1/buy`'s
ordering is **not** to be changed to make a code match a test's wording — the
price gate running first is what stops a cheap claim buying an expensive
resource.

### The control plane

Stages 1 to 7 live in four modules kept deliberately apart from the money path:

| Module | Holds |
| --- | --- |
| `policy.rs` | The permission envelope and its evaluation — pure functions, no I/O |
| `registry.rs` | Providers and their aggregated catalogues |
| `control.rs` | Agent, provider, approval and planner handlers |
| `control_db.rs` | Control-plane persistence, out of `db.rs` |

They hold no custody and cannot affect settlement, which is why they are
allowed to be mutable and flexible while the program and `routes.rs` are not.

### The task boundary

A distinction to preserve. These are different jobs, and mixing them would cost
the property that makes the second one trustworthy.

| The agent / application / LLM | AgentPay |
| --- | --- |
| Understands the programmer's task | Checks whether those calls are allowed |
| Discovers suitable APIs | Enforces spending limits |
| Decides what resources are needed | Enforces allowed resources |
| Decides an initial number of calls | Enforces approval requirements |
| | Prevents unauthorized provider access |
| | Records refusals |
| | Settles the final cumulative claim |
| | Provides cryptographic evidence |

**Do not introduce an LLM or task planner into the gateway.** The gateway's
value is that it is deterministic and testable; a model inside it makes its
behaviour probabilistic and its test suite a matter of chance. And a defective
planner is already harmless — the escrow caps it, the envelope caps it, and
every refusal is recorded and provable. That property exists *because* the
planner is outside, and it disappears the moment the planner becomes a trusted
component.

> **AgentPay does not decide what an agent should buy. The agent decides what it
> needs; AgentPay determines what the agent is permitted to buy, enforces those
> boundaries, and produces verifiable evidence when a purchase is refused.**

**A policy can only narrow, never widen.** The escrow deposit remains the
absolute ceiling. This is why the envelope is off-chain: allowlists and call
counts change often, and a redeploy per policy change would be untenable —
whereas custody rules must hold even if this process is compromised, so they
stay in the program.

### How stages 8–11 chain together

This is the part that exists, described as one continuous story so the mapping
above has something concrete to point at.

1. The human opens an escrow: `open_session` locks `deposited_total` in a vault
   PDA until `expires_at`. That deposit is the agent's entire spending power —
   the chain will not release more, whatever the agent or the gateway claims.
2. The session is registered with the gateway, which **reconciles every field
   against the chain** before believing it (§10). An asserted deposit that was
   never escrowed is refused.
3. The agent requests a resource with no claim and receives **402 Payment
   Required** carrying the price, `next_cumulative`, `next_nonce`, and the exact
   73-byte layout to sign.
4. The agent signs a **cumulative** claim — "the total you owe is now X" — and
   retries with the `x-agentpay-claim` header.
5. The gateway verifies the signature against the agent key **taken from stored
   session state, never from the request**, checks that `X − previous` equals
   the catalogue price for that exact resource (`ERR_PRICE_MISMATCH`), and
   advances the high-water mark atomically.
6. Only then is the request forwarded upstream. A refused claim never reaches
   the provider.
7. Steps 3–6 repeat for every purchase, with **no chain traffic at all**.
8. At the end, one `settle_session` transaction moves the highest claim's
   amount to the provider and commits the Merkle root of every decision — the
   refusals included — into the `SettlementRecord` PDA.

Stages 1–7 sit *above* this pipeline and decide **which** resource is bought
and **how many times**. Nothing in stages 8–11 depends on how that decision was
reached, which is why the enforcement layer is already mode-agnostic.

### Two operating modes

Both are implemented. `agents.mode` selects between them, and the enforcement
layer below is identical either way: the gateway sees a signed claim and
applies the same rules regardless of how the decision to send it was reached.

**Human-controlled** (`mode = "human"`). Every spend needs a decision. The
agent's purchase is refused with `ERR_APPROVAL_REQUIRED` and a proposal appears
in the approval queue; once a person approves it, the agent's retry succeeds.

The approval is **single-use and bound to a resource and a price**. One click
authorises one purchase — a standing permission would turn a moment's
inattention into an unbounded budget. A retry does not queue a duplicate: one
pending proposal exists per agent, resource and price.

The agent is *refused*, not held, while it waits. A queued HTTP request would
occupy a connection until somebody happened to look at the queue.

**Autonomous** (`mode = "autonomous"`). The human authorizes once, and the
agent thereafter selects providers and executes calls alone, bounded by its
envelope. A spend at or above `approval_threshold` still asks; with no
threshold set, it never does.

What holds in both cases: the escrow deposit is a hard ceiling the chain
enforces, so even a fully autonomous agent with a defective decision layer
cannot spend beyond what the human escrowed. **Autonomy is bounded by custody,
not by the agent's own correctness.** That is the reason for the escrow-first
design.

### Why the provider implements nothing

Worth restating in the context of this flow, because it is the main adoption
argument: at no point in stages 8–11 does the provider handle a signature, a
claim, a balance or a chain interaction. It answers `/_catalogue` with a price
list and serves ordinary HTTP. The 402 handshake, Ed25519 verification,
high-water mark, price matching and settlement all happen in the gateway.

`demo-provider/server.js` is the proof: zero dependencies, no Solana import, no
payment code of any kind.

---

## 3. The on-chain program

`programs/agentpay/src/lib.rs` — Anchor 1.2.0. The source in the tree today is
**v2**, deployed at `ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m`. The
description in this section was written against **v1**, still deployed at
`3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U` and still serving the sessions
it holds. What v2 changed — `settlement_authority`, a 219-byte `Session`, and
repeatable monotonic settlement — is in
[MIGRATION_V1_V2.md](MIGRATION_V1_V2.md).

### Three instructions

**`open_session(session_id, deposited_total, expires_at)`** — agent signs.
Creates the `Session` PDA and a vault token account owned by it, and moves the
deposit in. Rejects a zero deposit, an expiry in the past, or an expiry beyond
30 days.

**`settle_session(cumulative_amount, nonce, claim_expiry, merkle_root)`** —
provider signs. Verifies the agent's claim, transfers `cumulative_amount` from
the vault to the provider, writes a `SettlementRecord` PDA holding the claim
hash, the Merkle root and the amount, and marks the session settled.

**`refund_session()`** — returns the unspent balance to the agent. Before
expiry only the agent may call it, and only on a settled session. **After
expiry it is permissionless**: funds can only ever move to the agent's token
account, so a third party triggering it cannot redirect them. This is what
makes recovery possible with no gateway and no provider alive.

### Account layout — `Session`, 187 bytes

The gateway parses this by hand with explicit offsets rather than
`AnchorDeserialize`, because `anchor-lang` pins `solana-program` 3.x which
conflicts with the 4.x split crates the RPC client needs. The offsets are
pinned by a test against real devnet bytes.

```
  0  discriminator      [243,81,72,115,214,188,72,144]   8
  8  agent              Pubkey                          32
 40  provider           Pubkey                          32
 72  mint               Pubkey                          32
104  vault              Pubkey                          32
136  deposited_total    u64                              8
144  cumulative_settled u64                              8
152  refunded_total     u64                              8
160  expires_at         i64                              8
168  session_id         [u8;16]                         16
184  bump               u8                               1
185  vault_bump         u8                               1
186  is_settled         bool                             1
```

`SettlementRecord` is 121 bytes: discriminator, `session`, `claim_hash`,
`merkle_root`, `settled_at` (i64), `settled_amount` (u64), `bump`.

### PDA seeds

```
session    = [b"session", agent, provider, session_id]
vault      = [b"vault", session]
settlement = [b"settlement", session]
```

The `settlement` PDA is what makes double settlement structurally impossible —
a second `settle_session` cannot create an account that already exists.

### The Ed25519 part, which is the subtle bit

Solana verifies Ed25519 signatures in a **separate precompile instruction**,
not inside your program. So `settle_session` introspects the instructions
sysvar to confirm what the precompile actually verified.

The canonical claim message is 73 bytes:

```
"agentpay:claim:v1"  17 bytes   domain separator
session              32 bytes
cumulative_amount     8 bytes   u64 little-endian
nonce                 8 bytes   u64 little-endian
expires_at            8 bytes   i64 little-endian
```

The program checks that the precompile instruction's signer equals
`session.agent`, and that the verified message equals the message it
reconstructs from the instruction arguments. **All three instruction-index
fields in the precompile header must be `u16::MAX` (65535)**, the
self-reference sentinel — otherwise an attacker could point the precompile at a
message in a different instruction and have the program verify the wrong thing.

This was checked empirically: the precompile *accepts* a tampered instruction,
which is exactly why the program's own check is load-bearing rather than
redundant.

### Error codes

18 codes, all prefixed `ERR_`, e.g. `ERR_CLAIM_NOT_MONOTONIC`,
`ERR_CLAIM_EXCEEDS_DEPOSIT`, `ERR_UNAUTHORIZED_SETTLER`,
`ERR_MISSING_ED25519_INSTRUCTION`, `ERR_ED25519_INDIRECT_REFERENCE`,
`ERR_CLAIM_SIGNER_MISMATCH`. Every arithmetic operation is checked;
`ERR_ARITHMETIC_OVERFLOW` is reachable by design rather than by panic.

---

## 4. The gateway — backend

Rust, Axum 0.8, sqlx 0.8, Postgres. `gateway/src/`, 6,677 lines across 11
modules.

| Module | Responsibility |
| --- | --- |
| `routes.rs` | All HTTP handlers |
| `claim.rs` | The canonical 73-byte encoding, byte-identical to the program |
| `verify.rs` | Ed25519 signature verification |
| `state.rs` | `SessionStore` trait + `evaluate_claim`, the single source of ordering rules |
| `db.rs` | Postgres implementation of that trait |
| `evidence.rs` | Hash chain and Merkle tree, pure functions |
| `chain.rs` | Reading and reconciling on-chain accounts |
| `settle.rs` | Building the Ed25519 + settle instruction pair |
| `buy.rs` | The 402 handshake and upstream forwarding |
| `config.rs` | Environment parsing |
| `error.rs` | 27 reason codes |

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Status, program id, state backend |
| POST | `/v1/session/open` | Register a session, reconciled against the chain |
| POST | `/v1/claim/verify` | The enforcement path — allow or refuse a claim |
| POST | `/v1/session/settle` | Build, sign and submit the settlement transaction |
| POST | `/v1/session/reconcile` | Re-check a session's escrow against the chain |
| GET | `/v1/buy/{resource}` | Paid resource access; 402 without a valid claim |
| GET | `/v1/session/{pubkey}` | One session — what an agent reads to resume |
| GET | `/v1/session/{pubkey}/evidence` | Full evidence log plus Merkle root |
| GET | `/v1/session/{pubkey}/settlement` | The root the program actually stored |
| POST | `/v1/evidence/proof` | Merkle inclusion proof for one decision |
| POST | `/v1/session/plan` | The agent's own planner — authenticated by a signature over its session |

Control plane:

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/v1/agents` | List agents, or create one bound to a wallet |
| GET | `/v1/agents/{id}` | One agent with its envelope and derived spend |
| POST | `/v1/agents/{id}/authorize` | Set the permission envelope and mode |
| POST | `/v1/agents/{id}/status` | Suspend or reinstate — revocation mid-session |
| GET/POST | `/v1/providers` | List or register providers |
| DELETE | `/v1/providers/{id}` | Remove one |
| GET | `/v1/catalogue` | Every resource every provider offers, cheapest first |
| POST | `/v1/operators*` — credentials and revocation | |
| `/v1/agent/plan` | Selection and affordability against the envelope |
| GET | `/v1/sessions` | All sessions — enumeration, so operator-only |
| GET | `/v1/decisions/recent` | The claim feed |
| GET | `/v1/approvals` | The human-decision queue |
| POST | `/v1/approvals/{id}/decide` | Approve or reject one spend |

### The verification ordering in `/v1/claim/verify`

This order is deliberate and must not be rearranged. Cheap checks run before
expensive ones so a flood of garbage claims cannot force ~60µs of Ed25519 work
each.

1. **Shape.** Pure parsing, no I/O. → `ERR_MALFORMED_CLAIM`
2. **Claim expiry.** One comparison, needs no session. → `ERR_CLAIM_EXPIRED`
3. **Session lookup**, to obtain the agent key. The key **must** come from
   stored state, never from the request — accepting a caller-supplied agent
   would let anyone open tracking under a key they control.
4. **Signature.** The expensive step, so it runs after the cheap filters. →
   `ERR_INVALID_SIGNATURE`
5. **Ordering and bounds**, atomically advancing the high-water mark.

Step 5 delegates to `evaluate_claim` in `state.rs`, which is the only place
ordering rules live. Its order: settled → expired → cumulative monotonic →
nonce monotonic → deposit ceiling.

### Atomicity

`admit_claim` must be atomic or two concurrent identical claims would both
observe the same previous value and both be admitted. The Postgres
implementation opens a transaction, takes `SELECT … FOR UPDATE` on the session
row, evaluates, then does a conditional upsert as defence in depth. The
in-memory store holds a write lock for the whole cycle.

### The buy path ordering

`/v1/buy/{resource}` has its own ordering, and it is load-bearing in a
different way: **nothing reaches the provider until the claim is admitted.**

price lookup → 402 if no claim → decode → expiry → session lookup →
**signature** → price match (`ERR_PRICE_MISMATCH`) → **agent policy** →
`admit_claim` → *only then* forward upstream.

The policy step sits where it does for two reasons, and both are load-bearing:

- **After the price**, because the envelope is about amounts and cannot be
  evaluated without one.
- **Before `admit_claim`**, because a policy refusal must not advance the
  high-water mark. Advancing it would consume a nonce and a cumulative step for
  a purchase that never happened, and the agent's next honest claim would then
  be refused as non-monotonic — the session would be bricked by its own policy.

`tests/policy-devnet.ts` asserts exactly that: the mark is unchanged across a
refusal, and the next purchase still succeeds.

The price-match step exists because `admit_claim` checks ordering and the
deposit ceiling but not *what is being bought*. Without it an agent could
present a 0.0005 claim and take the 0.025 resource.

This is verified by a test that counts hits on a throwaway upstream rather than
checking a status code — a refused request that still reached the provider
means the agent got free data, and a status code would not reveal it.

### The SDK — what an integrator actually writes

`sdk/`, published as `@agentpay/client`. No runtime dependencies.

```ts
const pay = new AgentPayClient({ gateway, session, expiresAt, signer });
const weather = await pay.buy("/weather?city=Lahore");
```

The client quotes the resource, signs a cumulative claim for the new total,
retries with it attached, and advances its counters **only on success** — the
same discipline the gateway keeps, for the same reason: a refusal that moved
the client's counter would put it one step ahead of the high-water mark and
every later claim would be refused as non-monotonic.

| Method | Purpose |
| --- | --- |
| `quote(resource)` | The 402 handshake, without paying |
| `buy(resource)` | One purchase |
| `buyMany(resource, n, query?)` | A run, stopping at the first refusal |
| `buyWhenApproved(resource)` | Polls through `ERR_APPROVAL_REQUIRED` in human mode |
| `affordableCalls(resource)` | How many the remaining escrow covers |
| `sessionState()` | Deposit, spend, remaining, evidence count |
| `settle()` | One transaction for the whole session |
| `AgentPayClient.resume()` | Rebuilds counters from the gateway after a restart |

**Two classes, and the split is the security boundary.** `AgentPayClient`
carries a session and a signing key. `AgentPayControl` carries the admin token
and can widen an envelope, suspend an agent, approve spends. An agent process
that never constructs the second cannot do those things — the capability is
absent, not merely unused.

Errors are classified by what the caller should *do*, because a bare 403 cannot
distinguish a budget from a waiting human: `needsApproval` (wait and retry),
`outOfAuthority` (retrying will not help), `transient` (back off). `retry` is
off by default and retries transient failures only — retrying a decision is a
busy loop, and anything already charged costs again.

`sdk/src/claim.ts` is pinned against the same hex vector `gateway/src/claim.rs`
asserts, **copied rather than derived**: deriving it would only prove the SDK
agrees with itself. That test matters more than the rest of the package
together — every other mistake surfaces as a readable HTTP error, but a wrong
claim encoding produces a signature that verifies nowhere and fails at
settlement, after the agent was told its purchases succeeded.

`affordableCalls()` reports the **escrow** ceiling, not permission. The policy
envelope may be narrower and the agent is not told it: reading another party's
spending rules is an operator's business. The definitive answer comes from
buying, and a refusal names the exact rule.

### A charge is per call, not per success

`admit_claim` runs **before** the request is forwarded — that ordering is what
stops a refused claim from ever reaching the provider. The consequence is that
a provider answering `404` or `500` has still cost the agent money.

The gateway used to log that status and return a bare `200`, so an agent paid
for a failure and could not tell. `BuyResponse` now carries `upstream_status`,
and a non-2xx is logged at WARN naming the amount charged.

The envelope stays `200` deliberately: returning the provider's `404` would
invite a retry, and a retry costs again. `@agentpay/client` exposes it as
`purchase.ok` / `purchase.upstreamStatus`, and `buyMany` stops on the first one
rather than spending a budget on errors.

Rolling the charge back was considered and rejected. The high-water mark
advances atomically before the forward; unwinding it would open the gap the
ordering exists to close, where a crash between forwarding and recording yields
free data. A wasted charge is a billing dispute; free data is theft.

### Fail-closed discipline

Every verification path defaults to reject. Specifically: an unreachable RPC
node is **not** the same as a missing account. `RpcSessionFetcher`
distinguishes `AccountNotFound` (a client error) from any other RPC failure
(which denies). The same distinction appears in the console: a chain read that
fails renders as *unknown*, never as *not settled*.

---

## 5. Evidence log and Merkle anchoring

`gateway/src/evidence.rs` — 606 lines of pure functions, no I/O, so it is
directly testable.

### The hash chain

Every decision — allowed *and* refused — becomes one entry:

```
entry_hash = SHA256(prev_hash ‖ session ‖ cumulative_le ‖ nonce_le ‖ decision)
```

`prev_hash` for sequence 0 is 32 zero bytes. The `decision` strings are
**frozen** — they are part of the hash preimage, so renaming
`ERR_CLAIM_NOT_MONOTONIC` would invalidate every historical entry. Treat them
as a wire format.

Because each entry commits to its predecessor, you cannot remove or reorder an
entry without breaking every hash after it.

### The Merkle tree

Leaves are the entry hashes in sequence order. Internal nodes are
`SHA256(left ‖ right)`. An odd node at any level is duplicated.

Node duplication is normally CVE-2012-2459 (two different leaf sets producing
the same root). **It is neutralised here** because each leaf already commits to
its predecessor — a duplicated leaf cannot be a valid successor of itself, so
the ambiguous second preimage is not a well-formed log.

### Anchoring

At settlement the gateway computes the root from the log and passes it into
`settle_session`, which stores it in the `SettlementRecord` PDA. The root is
**computed, never supplied by the caller** — an API that accepted a root would
let a gateway commit to a log it does not have.

### Inclusion proofs

`POST /v1/evidence/proof` returns the leaf hash, the sibling path with
left/right sides, the root, and the leaf index. The console recomputes the root
from that path in the browser with WebCrypto.

This matters: the gateway also returns `verified_locally`, but that is the
gateway marking its own homework. The browser's recomputation is independent.

### The three-way comparison

The Verifier shows three roots:

| Value | Source | Who controls it |
| --- | --- | --- |
| recomputed in browser | WebCrypto over the proof path | the reader |
| root reported by gateway | the gateway's evidence log | the gateway |
| root committed on chain | the `SettlementRecord` PDA | **nobody — it is a public fact** |

Only the third decides the audit. Before it existed the page compared two
numbers that both came from the gateway, and a gateway that committed a
different root than its log produces would have passed unnoticed.

The verdict wording follows the third value: *Anchored* when the chain agrees,
an explicit warning when it committed something different, and "nothing is
anchored until this session settles" when no settlement exists.

---

## 6. The console — frontend

Next.js 16.3 App Router, React 19.3, Tailwind 4.3, TypeScript. `web/src/`,
3,261 lines. Dark, high-density operator UI.

### Four pages

**Monitor** (`/`) — the operations view. Four stats across the top, a sessions
table with a high-water-mark progress bar per session, and a live claim feed of
signed decisions newest-first, filterable by allowed/denied. Each session row
shows consumed vs. remaining against the escrowed allowance.

**Verifier** (`/verifier`) — the proof view, and the most important page for a
demo. Load a session, see its full evidence log as a ladder where each entry
links to its predecessor's hash, click any entry, and watch the Merkle path
recomputed hop by hop in the browser. Ends in the three-way root comparison.

**Settlement** (`/settle`) — pick a settleable session, review the breakdown
(vault balance, cumulative claims, refundable to agent, evidence entries),
press *Settle on-chain*. Returns a real devnet signature and the committed
root.

**Playground** (`/playground`) — a claim simulator for exploring the rules
without a wallet: build a claim, see which rule would refuse it and why.

**Agents** (`/agents`) — stages 1 to 4. Create an agent bound to a wallet, set
its envelope and mode, watch spend against that envelope, suspend or reinstate
it. States plainly what creating an agent does *not* do: no wallet is created,
no key held, no money moved.

**Registry** (`/registry`) — stages 5 to 7. Register providers, see the live
aggregated catalogue, and run the planner against an agent's envelope. An
unreachable provider is shown as *down*, never silently absent.

**Approvals** (`/approvals`) — the human half of human-controlled mode. Polls
every five seconds, because an agent is blocked until someone acts.

There is also a session detail page at `/session/{pubkey}`.

### Frontend rules that are not negotiable

**Money never touches a float.** Amounts arrive as decimal strings of `u64`
micro-USDC and are rendered with `BigInt` plus string slicing. There is no
`parseFloat` anywhere in the amount path. `web/src/lib/format.ts` owns this.

**Status is derived, never assumed.** `web/src/lib/session-status.ts` mirrors
`evaluate_claim`'s ordering so the badge on a row agrees with what the gateway
would actually do. An early version derived status from `is_settled` alone and
showed sessions as "Active" with the word "expired" beside them, on sessions
where every claim would have been refused.

**Nothing asserts money it has not verified.** `Escrowed (live)` counts only
sessions whose escrow was confirmed on chain, and says how many were excluded.
Settlement excludes unverified sessions and explains why rather than hiding
them silently.

**Mock data is labelled.** `web/src/lib/api.ts` carries fallback fixtures for
when the gateway is unreachable, shaped exactly like real responses. Every
result carries `live: true|false` and the UI must render the false case
visibly. Seeded numbers must never be mistaken for on-chain state.

### Gateway access

The browser never calls the gateway directly.
`web/src/app/api/gw/[...path]/route.ts` is a same-origin proxy, so there is no
CORS to loosen on the gateway and no gateway URL baked into client bundles.

### A development note

Next 16 dev mode does not hydrate inside some embedded browser panes because
the HMR websocket is blocked — React never mounts and the page looks broken.
`npm run build && npm start` works. Worth knowing before debugging a phantom.

### Frontend work that is still open

- No wallet adapter. An agent's pubkey is typed or pasted into the Agents page;
  keys themselves are still files the scripts read. This is the remaining half
  of stage 3 — see §11.
- No pagination on the sessions table, claim feed or approval queue.
- No pagination on the sessions table or claim feed.
- No live updates: pages fetch on mount. A websocket or polling layer is
  unbuilt.
- No mobile layout. It is a desktop-density dashboard.

---

## 7. Data model

Postgres 16. Migrations in `gateway/migrations/`, run by sqlx at boot — which
is why the gateway container waits on `service_healthy`, not merely `started`.

- `0001_init.sql` — `sessions`, `claim_tickets`
- `0002_evidence.sql` — `evidence_log`
- `0003_chain_verified.sql` — adds `sessions.chain_verified`
- `0004_agents_registry.sql` — `agents`, `agent_policies`, `providers`, `approvals`
- `0005_operators.sql` — `operators`, plus `approvals.decided_by` / `decided_by_label`

### `sessions`

```
session_pubkey   varchar(44)  PK
agent_pubkey     varchar(44)  not null
provider_pubkey  varchar(44)  not null
mint_pubkey      varchar(44)  not null
deposited_total  bigint       not null, CHECK (> 0)
expires_at       bigint       not null
settled_at       timestamptz  null      -- null means unsettled
created_at       timestamptz  not null default now()
chain_verified   boolean      not null default false
```

Index `idx_sessions_unsettled` is partial, `WHERE settled_at IS NULL`.

### `claim_tickets` — the high-water mark

```
session_pubkey     varchar(44)  PK   -- one row per session, not per claim
cumulative_amount  bigint  CHECK (> 0)
nonce              bigint  CHECK (>= 0)
expires_at         bigint
signature          bytea   CHECK (octet_length = 64)
received_at        timestamptz default now()
```

**The primary key is the session.** This table holds exactly one row per
session: the highest claim ever accepted, with the signature that authorised
it. That row *is* the high-water mark, and keeping the signature means the
settlement can be rebuilt from the database alone after a restart.

### `evidence_log` — append-only

```
id                 bigserial PK
session_pubkey     varchar(44)
sequence_id        bigint
cumulative_amount  bigint
nonce              bigint
decision           varchar(32)
prev_hash          bytea
entry_hash         bytea
signature          bytea  null
created_at         timestamptz default now()
UNIQUE (session_pubkey, sequence_id)
```

Both child tables cascade-delete from `sessions`.

### Control-plane tables

`agents` (identity, wallet, mode, status), `agent_policies` (the envelope),
`providers` (the registry), `approvals` (the human queue). `0004` carries the
column comments; three points are worth repeating here:

- `agents.agent_pubkey` is **unique**. Two records sharing one key would make
  the policy applied to a claim ambiguous.
- Spend is **derived, never stored**. `agent_spend` sums `claim_tickets` and
  counts `ALLOWED` evidence rows. A second counter would eventually disagree
  with the numbers actually enforced, and the wrong one would be enforcing the
  budget.
- `approvals.state` includes `consumed`, set when an approved spend is made.
  That is what makes one approval authorise exactly one purchase.

Note on Postgres: `SUM` over `BIGINT` returns `NUMERIC`, so `agent_spend` casts
explicitly. Without the cast it fails to decode; a silent version of that would
have mis-stated a budget.

### A caveat to state plainly

The log is append-only **by convention and by the hash chain, not by a database
grant**. A DBA with write access can delete rows. What they cannot do is delete
rows *and keep the chain valid* — `verify_chain` would catch it, and the Merkle
root committed on-chain would no longer match. Tamper-evident, not
tamper-proof. Do not describe it as immutable.

### `u64` vs `bigint`

Postgres has no unsigned 64-bit integer. `to_i64` refuses any value above
`i64::MAX` rather than silently storing it as negative and corrupting a
balance. There is a test for exactly that boundary.

---

## 8. Running it

### Prerequisites

Docker and Docker Compose. That is all for running it. To build the program or
run the devnet scripts you additionally need Rust 1.98.1, Solana CLI 4.1.2,
Anchor 1.2.0 and Node 25.

### Start everything

```bash
cp .env.example .env
docker compose up -d --build
```

Four services come up health-ordered:

| Service | Host port | Notes |
| --- | --- | --- |
| `postgres` | 5434 | 5434 to avoid colliding with a local 5432 |
| `provider` | 4021 | the demo resource seller |
| `gateway` | 8080 | waits for postgres to be *healthy* |
| `web` | 3100 | the console |

Works unchanged on Windows, macOS and Linux. Ports bind to `127.0.0.1` only.

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | compose-provided | Postgres connection |
| `AGENTPAY_RPC_URL` | devnet | Solana RPC |
| `AGENTPAY_PROGRAM_ID` | `3aKGM6Cb…` | Deployed program |
| `AGENTPAY_BIND_ADDR` | `0.0.0.0:8080` | Listen address |
| `AGENTPAY_PROVIDER_KEYPAIR` | unset | Path to the provider key. **Unset means verify-only**: `/v1/session/settle` returns `ERR_SETTLEMENT_UNAVAILABLE`. A valid deployment mode. |
| `AGENTPAY_UPSTREAM_URL` | `http://provider:4021` | The provider behind `/v1/buy` |
| `AGENTPAY_NETWORK` / `AGENTPAY_ALLOW_MAINNET` | — | Mainnet requires an explicit opt-in |
| `AGENTPAY_TRUST_OPEN_REQUESTS` | unset | **Development only.** Disables on-chain reconciliation. |
| `AGENTPAY_ADMIN_TOKEN` | unset | Guards the control plane. Optional **only** on a loopback bind; anything else refuses to start without it. Minimum 16 characters. Generate with `openssl rand -hex 32`. |
| `AGENTPAY_OPEN_RATE_LIMIT` | 20 | Requests/min per IP on `/v1/session/open`, which costs an RPC read. |
| `AGENTPAY_RATE_LIMIT` | 600 | Requests/min per IP everywhere else. |
| `AGENTPAY_REQUIRE_AGENT_POLICY` | unset | Refuse any session whose agent has no authorized record. Off by default: the control plane is additive and must not start refusing traffic that used to pass. |
| `AGENTPAY_LOG` | `info,tower_http=warn` | Tracing filter |

### Two footguns worth knowing

**Compose interpolates an unset `${VAR}` to `""`, not to nothing.** The gateway
would have tried to open a keypair at path `""` and crashed.
`config.rs::optional_env` treats empty and whitespace-only as unset.

**Containers keep their creation-time environment.** Changing `.env` and
running `docker compose up -d` will not update a running container. Use
`--force-recreate`. A stale container once held a program id of `1111…11111`
(the System Program) while `.env` was correct.

### `AGENTPAY_TRUST_OPEN_REQUESTS` — read this before setting it

It skips reconciliation at `/v1/session/open`, so the gateway believes whatever
deposit the caller asserts. That is uncollateralized credit creation: claims
get authorised against escrow that does not exist, and the provider delivers
resources for a settlement that can never happen.

It exists because `npm run demo` uses synthetic sessions. **Never set it in
production.** Sessions opened under it are recorded `chain_verified = false`
and excluded from settlement.

### Provider key for settlement

```bash
cp ~/.config/solana/agentpay-provider.json secrets/provider.json
# then in .env:
#   AGENTPAY_PROVIDER_KEYPAIR=/secrets/provider.json
docker compose up -d --force-recreate gateway
```

`secrets/` is gitignored except for `.gitkeep` and `README.md`. The gateway
logs `settlement enabled provider=…` at boot when the key loads.

### Demo scripts

| Command | What it does |
| --- | --- |
| `npm run demo` | 8 enforcement scenarios against synthetic sessions (needs the trust flag) |
| `npm run buy` | An agent actually buying data: 402 → sign → 200 + payload |
| `npm run evidence:v1-legacy` | Real escrow, 7 claims, settles, proves the root against the chain |
| `npm run stage-settleable:v1-legacy` | The same but **stops before settling**, leaving a session for the Settlement page |
| `npm run reconcile:v1-legacy` | Opens one real session and tries to register it under 8 lies; all must be refused |
| `npm run policy:v1-legacy` | The control plane end to end: create, authorize, plan, buy, then be refused five ways |
| `npm run sdk-demo:v1-legacy` | The same purchases as `demo-buy`, through the SDK — six lines instead of 194 |
| `npm run sdk-test` | The SDK suite, including the claim-encoding parity vector |

The devnet scripts default `ANCHOR_PROVIDER_URL`, `ANCHOR_WALLET` and
`AGENTPAY_PROVIDER_KEYPAIR` to the standard locations — an explicitly set value
always wins, so a run is never silently redirected to another cluster.

---

## 9. Testing

### Gateway unit and integration tests

```bash
cargo test --manifest-path gateway/Cargo.toml          # 99 hermetic
```

For the 16 Postgres-backed tests you need a **separate, disposable** database:

```bash
docker exec agentpay-postgres-1 createdb -U agentpay agentpay_test
TEST_DATABASE_URL=postgres://agentpay:agentpay@127.0.0.1:5434/agentpay_test \
  cargo test --manifest-path gateway/Cargo.toml -- --include-ignored   # 115
```

**Read this before pointing it anywhere else.** The suite writes sessions and
does not roll them back. It used to be documented against `DATABASE_URL` — the
database a running gateway serves from — and 70 test rows accumulated there,
which the console rendered as 263 USDC of escrow across sessions whose accounts
do not exist on any cluster. Their `expires_at` was around 1,003,600, January
1970, from the suite's `NOW` constant.

`connect_db()` now reads `TEST_DATABASE_URL` and asserts the database name
contains `test` before writing anything. Pointing it at `agentpay` fails with:

```
refusing to run write tests against database "agentpay":
the name must contain "test", because these tests leave rows behind
```

### The attack suite

```bash
npm test        # 24 tests against the program
```

Every test is written as an attack that must fail with a specific error code,
not as a happy path. Replay, regression, nonce reuse, over-deposit, wrong
signer, forged signature, tampered Ed25519 instruction indices, unauthorised
settler, double settlement, refund before expiry.

### Devnet end-to-end

```bash
npm run evidence:v1-legacy     # the full loop, including the Merkle proof
npm run reconcile:v1-legacy    # 8 lies at /v1/session/open, all must be refused
npm run restart-test        # state survives a gateway restart
```

`npm run policy:v1-legacy` is the control-plane equivalent: 22 checks against a
real devnet escrow covering agent creation, wallet binding, authorization,
planning, purchases inside the envelope, and refusals by allowlist, price cap,
call limit, suspension and approval. Its load-bearing assertion is that a
policy refusal leaves the high-water mark untouched and the next honest
purchase still succeeds.

`evidence-devnet` is the one to run if you only run one. It recomputes the
Merkle root in TypeScript with an independent SHA-256 implementation, so a bug
in the gateway's own Merkle code cannot make it pass.

### Testing conventions to preserve

**Never `Pubkey::new_unique()` in database tests.** It increments a
process-static counter, so every `cargo test` run yields the identical sequence
and collides with the previous run's rows. A concurrency test passed in-suite
and failed 20/20 in isolation because of this. Use UUID-derived random keys —
`random_pubkey()` in `db.rs`.

**Pin parsers to real bytes.** `chain.rs` holds base64 of real devnet accounts
as test vectors for both `Session` and `SettlementRecord`. One test asserts
that a naive struct layout would read `deposited_total = 835041178529265003`
instead of `2000000` — it deserializes without error, which is exactly why the
offsets need pinning rather than trusting.

**Count effects, not status codes.** The buy test counts hits on a throwaway
upstream. A refused request that still reached the provider is a free-data leak
that a status-code assertion would miss.

---

## 10. Security model

### The invariants, and what each one closes

| Invariant | Enforced where | Attack it closes |
| --- | --- | --- |
| Cumulative amount strictly increases | gateway `evaluate_claim` + program | Replay of an old claim, and regression to a lower total |
| Nonce strictly increases | gateway | Reuse of a nonce with a different amount |
| Cumulative ≤ deposited_total | both | Claiming more than was escrowed |
| Agent key comes from stored state, never the request | gateway step 3 | Opening tracking under an attacker-controlled key |
| Ed25519 signer == `session.agent` | program, via sysvar introspection | Third-party forged claims |
| All three precompile index fields == `u16::MAX` | program | Pointing the precompile at a different message |
| Verified message == reconstructed message | program | Signing one thing, settling another |
| Only `session.provider` may settle | program | Anyone draining the vault |
| `settlement` PDA must not already exist | program | Double settlement |
| Refund only to `session.agent`'s token account | program | Permissionless refund being redirected |
| Session fields reconciled against the chain at open | gateway `/v1/session/open` | Uncollateralized credit creation |
| Price of the resource == claim delta | gateway buy path | Paying 0.0005 for a 0.025 resource |
| Nothing forwarded upstream before admission | gateway buy path | Free data on a refused claim |
| Policy evaluated before the high-water mark moves | gateway buy path | A refusal bricking the session by consuming a nonce |
| Suspension outranks every other policy rule | `policy.rs::evaluate` | Revocation being defeated by an approval click |
| An approval is single-use, per resource and price | `consume_approval` | One human click authorising unbounded spending |
| Only a *pending* approval can be decided | `decide_approval` | A second click flipping a rejection into permission |
| An unreadable status reads as suspended, an unreadable mode as human | `policy.rs` | A corrupted column granting autonomy or spending |
| One agent record per wallet | `agents.agent_pubkey` UNIQUE | Ambiguity about which policy applies to a claim |
| The control plane requires an admin token | `auth.rs` | A stranger approving their own spend, or suspending someone else's agent |
| A non-loopback bind without a token is fatal at boot | `config.rs` | Exposing the control plane unauthenticated by forgetting to set one |
| The token is compared over SHA-256 digests | `auth.rs::secret_eq` | Recovering it byte by byte from response timing |

### Authentication, and the boundary it draws

The control plane changed the threat model, and the change is worth stating
plainly because it was introduced by this codebase and had to be closed.

Before the control plane, an unauthenticated caller could do almost nothing.
Every money-path request needs a valid Ed25519 signature over a claim, and
every session is reconciled against the chain. The control plane added
operations that need **no signature at all**: create an agent, set its
envelope, suspend it, register a provider, decide an approval.

Unguarded, that meant anyone who could reach the port could **approve their own
pending spend** — defeating human-controlled mode entirely — and **suspend
somebody else's agent**, a denial of service against a running workload.

`AGENTPAY_ADMIN_TOKEN` closes it. What is behind it and what is not:

| Behind the token | Open, deliberately |
| --- | --- |
| `/v1/agents*` — identity, envelope, suspension | `/v1/buy`, `/v1/claim/verify`, `/v1/session/*` |
| `/v1/providers*` — the registry | `/v1/session/{pubkey}` — one session, by its own address |
| `/v1/approvals*` — human decisions | `/v1/session/{k}/evidence`, `/settlement`, `/v1/evidence/proof` |
| `/v1/agent/plan` | `/v1/catalogue`, `/health` |
| `/v1/sessions`, `/v1/decisions/recent` — the listings | |

The last row is the distinction worth keeping: **reading a session you can
already name is not the same as enumerating everybody's.** An agent needs the
first to resume its counters and check its remaining escrow, and the evidence
for that session is public by design. A directory of every agent's wallet,
deposit and spend, handed to anonymous callers, is information disclosure that
public verifiability never required — so the listings moved behind the token.

Two reasons for that split:

- **The money path must not be behind a shared secret.** It is protected by
  signatures and on-chain reconciliation. Adding a token would break every
  agent and add nothing an attacker could not already defeat by simply not
  having a valid signature.
- **Public verification must stay public.** A third party being able to check a
  decision against the chain *without the operator's permission* is the
  product. Putting evidence behind a token would make the audit trail depend on
  the very party it exists to check.

#### The boot rule

A token is optional **only** while the gateway is bound to a loopback address.
Bound anywhere else, an absent or short token is fatal at startup:

```
agentpay-gateway cannot start:

  AGENTPAY_BIND_ADDR is 0.0.0.0:8080, which is reachable from outside this
  machine, but AGENTPAY_ADMIN_TOKEN is not set. …
```

The ordering is the point. Failing at boot means an operator is watching a
deploy; failing at the first request means a stranger found it first. You
cannot expose this control plane unauthenticated by forgetting something.

A token shorter than 16 characters is also refused, because `admin123` is worse
than no token: it looks like security.

#### Per-operator credentials, and the approval trail

`AGENTPAY_ADMIN_TOKEN` still works — every existing deployment keeps running,
and it is the bootstrap path for minting the first per-operator credential.
Alongside it, `operators` holds one credential per person.

| Endpoint | Does |
| --- | --- |
| `POST /v1/operators` | Mints a token. **Shown once** — only its SHA-256 hash is stored |
| `GET /v1/operators` | Lists them. Never returns a token or a hash |
| `POST /v1/operators/{id}/status` | Revokes one credential, leaving everybody else working |
| `POST /v1/operators/me/rotate` | Replaces **your own** token. The old one stops working on the next request |

`auth::require_admin` resolves whichever token was presented to an `Operator`
and puts it in the request extensions. `decide_approval` reads it, so every
decision records **who made it**.

Three details that are load-bearing:

- **The shared token is checked first, and needs no database.** During an
  incident where Postgres is unreachable, an operator holding it can still act,
  while an unknown token is refused rather than admitted.
- **`decided_by_label` is a snapshot, not a join.** Renaming or deleting an
  operator must not rewrite who approved what last year. An audit record that
  changes when a row elsewhere changes is not an audit record.
- **Tokens are generated by the gateway**, 256 bits from the same CSPRNG used
  for ids, and a caller-supplied one is refused. That is what makes a plain
  SHA-256 digest correct here rather than bcrypt: there is no low entropy to
  defend, because nobody gets to choose a weak token.

**Rotation is self-service only, and that is a security property rather than a
missing feature.** An operator rotating somebody else's credential would
receive the new token themselves, and every decision they then made would be
recorded under the other person's name — breaking the one thing the trail is
for. The honest recovery for a lost credential is to **disable it and mint a
new operator**: a new id, so history stays truthful about who held what.

There is no grace period. Two live credentials for one identity would mean a
stolen token keeps working for the length of the window, which is the opposite
of what rotation is for. A revoked operator cannot rotate back into service
either.

The shared token cannot be rotated through the API — it lives in
`AGENTPAY_ADMIN_TOKEN`, not in `operators`, and the attempt is refused
`ERR_SHARED_TOKEN_NOT_ROTATABLE` rather than silently doing nothing.

A decision made with the shared token is recorded as `op_shared_token`, which
is truthful — "whoever held the shared token" — and makes deployments that have
not yet moved to per-operator credentials visible in the audit rather than
silent.

#### Rate limiting

`/v1/session/open` performs a Solana RPC read on **every** request and needs no
credential — by design, since reconciliation is what makes the endpoint
trustworthy. Unlimited, that lets anyone burn the gateway's metered RPC quota
and take reconciliation down for everyone else. Default **20/min per client IP**
(`AGENTPAY_OPEN_RATE_LIMIT`).

Everything else gets a loose **600/min** (`AGENTPAY_RATE_LIMIT`). The money path
is gated by signatures and by a shape check that runs before any I/O, so an
attacker without a valid claim is refused before the expensive work — a tight
limit there would break legitimate high-volume agents and stop nothing.

Two implementation points a reviewer will look for:

- **The map is bounded and evicts.** A naive per-IP map turns a rate limiter
  into a memory exhaustion bug the moment an attacker rotates source addresses.
  Idle buckets are evicted, the map is capped, and **at the cap new clients are
  refused rather than admitted** — a limiter that fails open under pressure
  protects nothing at the moment it matters. A poisoned lock refuses too.
- **It keys on the TCP peer, not `X-Forwarded-For`.** A caller can forge that
  header and get a fresh bucket per request. Behind a reverse proxy the proxy
  must set the peer address; only it knows which hop to believe.

Token bucket rather than a fixed window, because a window lets a client spend a
full allowance at the end of one window and again at the start of the next.

#### Details that matter

- The comparison digests both sides with SHA-256 before comparing, so it is
  constant-time over a fixed length. A plain `==` would short-circuit at the
  first differing byte and let an attacker recover the token character by
  character.
- The token is never logged — not even a prefix. A rejected guess in a log file
  is still a guess somebody can read.
- The console reads it **server-side**, in the `/api/gw` route handler, and
  attaches it to the outgoing request. It is never shipped to a browser; the
  variable deliberately has no `NEXT_PUBLIC_` prefix. Verified by grepping the
  built client bundle and the served HTML for it.

### The three-layer trust boundary

Human authorization, agent autonomy and gateway enforcement are three separate
layers, and the separation is what makes an autonomous agent safe to run. Each
layer can fail without the ones below it failing.

| Layer | Trusted to | **Not** trusted to | Enforced by |
| --- | --- | --- | --- |
| **Human** | Decide how much money exists and for how long | — (this is the root of authority) | `open_session`: the deposit and expiry are on-chain facts |
| **Agent** | Choose what to buy and how often, and sign claims | Exceed the deposit, replay a claim, misprice a resource, or reach the provider unadmitted | Gateway: signature, ordering, high-water mark, price match |
| **Gateway** | Verify claims, order them, submit settlement | Invent a deposit, settle more than the highest signed claim, or commit a Merkle root its own log does not produce | Chain: reconciliation at open, program-side claim verification, the `SettlementRecord` PDA, the three-way root comparison (§5) |

Read that bottom row carefully: **the gateway is inside the trust boundary, not
outside it.** It holds the provider's hot key and could in principle misbehave.
What it cannot do is settle an amount the agent never signed — the program
verifies the agent's Ed25519 signature independently — or claim an evidence
root that does not match its own log, because a third party can recompute the
root in a browser and compare it against the chain.

A compromised agent costs at most the escrowed deposit. A compromised gateway
cannot exceed the highest claim the agent actually signed. A compromised
provider gets nothing it was not already going to be paid.

### The authorization model today, and what it does not express

What `open_session` authorizes is precise and chain-enforced:

- **How much** — `deposited_total`, a hard ceiling. No claim above it is
  admissible at either layer.
- **Until when** — `expires_at`, after which settlement is refused and refund
  becomes permissionless.
- **To whom** — `provider`, the only key permitted to settle this session.
- **By whom** — `agent`, the only key whose signature is accepted.

That is a genuine, useful authorization envelope, and it is the reason an
autonomous agent is bounded by custody rather than by its own correctness.

What the escrow does **not** express, the off-chain envelope now does
(`agent_policies`, evaluated in `policy.rs`):

- **Per-resource limits** — `allowed_resources`, an allowlist. Empty means
  unrestricted, which is what an unfilled form field submits.
- **Per-call cap** — `max_per_call`, independent of the remaining budget.
- **Total budget** — `max_total`, across every session the agent holds, not
  per session.
- **Call count** — `max_calls`.
- **Approval thresholds** — `approval_threshold`, above which a human decides.
- **Revocation before expiry** — `status = 'suspended'` stops the agent at the
  gateway immediately, without settling the session or stopping the gateway.

Two limits to state plainly:

- Suspension binds only what passes through **this** gateway. It does not claw
  back the escrow and does not recall a settlement in flight.
- There is still no rate limit in time ("50 calls per hour"). `max_calls` is a
  total, not a rate.

Still **proposed, not built**: sub-budgets within a session, budgets spanning
providers with separate ceilings each, and time-windowed rate limits.

### Where the chain cannot help you

Because claims are cumulative, the chain sees exactly **one** settlement per
session. It has no way to know that claim #7 was presented twice, or that a
claim for a lower total arrived after a higher one. **Off-chain claim replay is
defended entirely by the gateway's high-water mark.** If the gateway's state is
lost or rolled back, that defence is gone.

This is why `claim_tickets` is durable, why `admit_claim` is transactional, and
why there is a restart-durability test. A senior reviewer should push hardest
here.

### Reconciliation at open

`/v1/session/open` reads the `Session` account and verifies **every** field the
gateway will later rely on — agent, provider, mint, deposit, expiry — not just
the deposit. `agent` matters most: claim signatures are verified against the
key recorded here.

`POST /v1/session/reconcile` re-runs the same check after the fact, for
sessions admitted while reconciliation was disabled. It verifies the *stored*
record against the chain, so a row invented under the trust flag cannot promote
itself — it is refused with the same code it would have got at open.
`chain_verified` only ever travels `false → true`.

### One distinction that caused a real bug

**Unverified is not unbacked.** `chain_verified = false` means nobody looked,
not that there is no escrow. The console once hid such sessions behind the
sentence "no on-chain escrow", and that sentence was false: session
`9BKdE533…` had a real program-owned escrow of 2,000,000 micro-USDC with a
750,000 high-water mark, unsettled and inside its window. It was invisible in
the UI until the sentence was corrected and the re-check offered. Settling it
moved the 750,000 for real.

The general lesson, which shows up three times in this codebase: **never
conflate "we did not check" with "it is not there", and never conflate "the
request failed" with "the answer is no".**

---

## 11. Known gaps

Stated plainly, because a handover that oversells is worse than useless. **This
is hackathon-grade, not production-grade.**

### Blocking for production

- **No audit.** The program has never been reviewed by anyone outside this
  project.
- **Single gateway instance.** The high-water mark is per-instance state with
  no leader election or distributed lock. Two gateway replicas against one
  database would serialise on `SELECT … FOR UPDATE`, but this has never been
  tested, and nothing prevents a second instance from being started.
- **The gateway holds the provider's hot key** in a file. No HSM, no KMS, no
  rotation.
- **No notification path.** The approvals page polls; nothing pages a human
  when a spend is waiting.
- **Append-only by convention.** See the data model caveat.

### Untested paths

- **Token-2022.** The `token_interface` code path compiles but has never
  executed. Every test uses `TOKEN_PROGRAM_ID`.
- **Compute-unit headroom** under adversarial input sizes.
- **Vault substitution** is structurally blocked by `has_one = vault` plus the
  seeds constraint, but has no dedicated test.
- **Concurrent duplicate settlement** on the gateway side. On-chain the
  `settlement_record` PDA makes it impossible; the gateway-side dedup hazard is
  untested.

### Not built

- **The SDK is TypeScript only.** `@agentpay/client` exists (`sdk/`), but a
  Python or Go agent still hand-rolls the 73-byte encoding. The parity vector
  in `sdk/test/run.ts` is the thing to port first.
- **Not x402 wire-compatible.** It uses HTTP 402 with its own header scheme.
  Interop with the emerging x402 ecosystem would need a compatibility layer.
- **No refund UI.** `refund_session` exists on-chain and is permissionless
  after expiry, but nothing in the console calls it. Expired sessions with real
  escrow sit there until someone calls it manually.
- **No metrics or tracing export.** Structured logs only.

### Remaining work on the agent flow

Stages 1 to 7 are built (§2). What is left, stated as work rather than absence:

**Wallet adapter (the rest of stage 3).** An agent's pubkey is typed into the
console and its private key is a JSON file the scripts read. Production needs a
browser wallet adapter and a signing path that never puts the raw key on disk.
There is also a decision to make that the demos currently dodge: whether the
human's wallet and the agent's key should be the same key. In the scripts they
effectively are, which is fine for a demo and wrong for production.

**Task planning (the rest of stage 7).** `POST /v1/agent/plan` answers "how
many calls can this agent afford?" — the *bound* on the decision. Deciding how
many calls a given task actually needs is still the application's job. That is
arguably where it belongs, but nothing in this repo does it.

**Provider trust in the registry.** Anyone who can reach the gateway can
register a provider. There is no ownership, no verification that a base URL
belongs to the party claiming it, and no signature over a catalogue. For a
multi-tenant deployment this is the first thing to fix.

**Per-agent rate limiting.** The gateway limits per client IP (§10), but an
agent's *policy* has no rate: `max_calls` is a total, so an agent authorized
for 1,000 calls can spend them in a second.

**Notifications.** The approvals page polls every five seconds. Nothing pushes,
emails or pages a human when a spend is waiting.

**Sub-budgets.** One envelope per agent. Per-session or per-provider ceilings
inside that envelope do not exist.

**What none of this requires.** No change to the program, the claim format, the
evidence log or the settlement path. The control plane sits above the
enforcement pipeline and hands it the same signed claims either way — which is
why it could be built without touching any on-chain invariant, and why the
remaining items can be too.

### Competitive honesty

This is not category-creating. Mastercard, AWS (via x402), Nevermined, Axiru
and Nobulex are all working in agent payments; Nobulex in particular describes
an Ed25519-signed, hash-chained, independently verifiable log that is close to
this design.

What is genuinely differentiated is the **enforcement-plus-evidence
combination**: refusals are first-class, they are anchored on-chain, and a
third party can verify one in a browser without trusting the operator. Lead
with that, not with novelty.

---

## 12. Where to start reading

Repository: `https://github.com/tahaiqbal8/agentpay`

### A reading order that works

0. `docs/RUNBOOK.md` — if you want it **running** before you read about it.
1. `docs/decisions.md` — **start here** for the reasoning. 20 numbered decisions, each stating
   what was chosen and what it closes. It is the design rationale, including
   the mistakes.
2. `programs/agentpay/src/lib.rs` — 617 lines, readable in one sitting.
3. `gateway/src/state.rs` — `evaluate_claim` is the heart of the enforcement
   logic and is about 40 lines. Then `gateway/src/policy.rs::evaluate`, its
   control-plane counterpart: same shape, same reason for being pure.
4. `gateway/src/routes.rs` — `verify_claim` and `buy`, for the orderings.
5. `gateway/src/evidence.rs` — pure functions, easy to reason about.
6. `tests/attacks.ts` — 24 attacks; the fastest way to learn the threat model.
7. `sdk/README.md` — what integrating actually looks like, and
   `scripts/sdk-demo.ts` for the same thing running against devnet.

### File map

```
programs/agentpay/src/lib.rs     the on-chain program
gateway/src/                     15 modules; money path + control plane
sdk/                             @agentpay/client — the integration surface
sdk/src/claim.ts                 the encoding, pinned to the Rust vector
gateway/src/auth.rs              the control-plane token guard
gateway/src/ratelimit.rs         bounded token-bucket limiting
gateway/src/policy.rs            the permission envelope, pure
gateway/src/registry.rs          providers and aggregated catalogues
gateway/src/control.rs           agents, providers, approvals, planner
gateway/src/control_db.rs        control-plane persistence
web/src/app/                     7 pages + session detail
web/src/lib/                     api client, formatting, status derivation
demo-provider/server.js          a provider with no payment code
tests/                           attack suite + devnet end-to-end
scripts/                         demo and staging scripts
gateway/migrations/              4 SQL migrations
docs/                            decisions, deploy, docker, server setup, pitch
```

### Other documents in the repo

| File | Contents |
| --- | --- |
| `docs/RUNBOOK.md` | Zero to running, then the flow step by step — the operational half of this document |
| `docs/decisions.md` | D1–D25, the design rationale |
| `docs/DEPLOY.md` | Deploying the program and gateway |
| `docs/DOCKER.md` | Compose on Windows, macOS, Linux |
| `docs/SERVER_SETUP.md` | Bare-metal server setup |
| `docs/HACKATHON_KT.md` | Knowledge transfer notes |
| `docs/PITCH_AND_QA.md` | Pitch and anticipated questions |

### Current devnet state, as verified

Program v1 `3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U`, upgrade authority
`78Q6uycbMfTre1zRiyx6dQvUv1yWEjGzmvuj5Brd3VHc`. This records the state as
verified at the time of writing; the v2 program's own devnet evidence is in
[RELEASE_V2.md](RELEASE_V2.md) §G–H.

Four sessions settled on-chain. Each was verified by reading the account
directly rather than trusting the gateway:

| Session | Deposit | Settled | Merkle root on chain |
| --- | --- | --- | --- |
| `ArqVZrM9pZ…` | 3,000,000 | 1,100,000 | `b939fca7…` |
| `Bj6wadPKPv…` | 3,000,000 | 1,100,000 | `7e72ae57…` |
| `Csq8kfR3gE…` | 2,000,000 | 750,000 | `f74a1a6e…` |
| `9BKdE533eA…` | 2,000,000 | 750,000 | `aeb3cc0b…` |

All 54 evidence entries were recomputed independently in Python — outside the
project's own code — and all 54 matched. Every root above equals the one
recomputed from the log.

### A note on the working style this codebase assumes

The recurring rule here is **do not assert what you have not verified**.
Account layouts are pinned to real bytes, not to structs someone wrote down.
The Merkle root is recomputed in a second language. The UI refuses to display a
balance it has not confirmed on chain. Denials are tested by counting side
effects, not status codes.

Three separate production-visible bugs in this project came from the same root
cause: treating an unverified value as a verified one. If you add a number to
the UI, be able to say where it came from and who could have lied about it.
