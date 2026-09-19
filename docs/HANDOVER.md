# AgentPay Engineering Handover

2026-09-19

A Solana enforcement and audit layer for autonomous agent payments.
Devnet program `3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U`.

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

---

## 3. The on-chain program

`programs/agentpay/src/lib.rs` — 617 lines, Anchor 1.2.0, deployed to devnet at
`3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U`.

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
| GET | `/v1/sessions` | All sessions with high-water marks |
| GET | `/v1/decisions/recent` | The claim feed |
| GET | `/v1/session/{pubkey}/evidence` | Full evidence log plus Merkle root |
| GET | `/v1/session/{pubkey}/settlement` | The root the program actually stored |
| POST | `/v1/evidence/proof` | Merkle inclusion proof for one decision |

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
**signature** → price match (`ERR_PRICE_MISMATCH`) → `admit_claim` → *only
then* forward upstream.

The price-match step exists because `admit_claim` checks ordering and the
deposit ceiling but not *what is being bought*. Without it an agent could
present a 0.0005 claim and take the 0.025 resource.

This is verified by a test that counts hits on a throwaway upstream rather than
checking a status code — a refused request that still reached the provider
means the agent got free data, and a status code would not reveal it.

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

- No wallet adapter. The console is an operator tool, not an agent client — by
  design, but an agent-facing UI would need one.
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
| `npm run evidence-devnet` | Real escrow, 7 claims, settles, proves the root against the chain |
| `npm run stage-settleable` | The same but **stops before settling**, leaving a session for the Settlement page |
| `npm run reconcile-devnet` | Opens one real session and tries to register it under 8 lies; all must be refused |

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
npm run evidence-devnet     # the full loop, including the Merkle proof
npm run reconcile-devnet    # 8 lies at /v1/session/open, all must be refused
npm run restart-test        # state survives a gateway restart
```

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
- **No rate limiting and no authentication** on any endpoint. Anyone who can
  reach the gateway can open sessions and submit claims.
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

- **No SDK.** Integration means writing HTTP calls and an Ed25519 signature by
  hand — roughly 50 lines. A client library is the obvious next deliverable and
  would be the highest-leverage work for adoption.
- **Not x402 wire-compatible.** It uses HTTP 402 with its own header scheme.
  Interop with the emerging x402 ecosystem would need a compatibility layer.
- **No refund UI.** `refund_session` exists on-chain and is permissionless
  after expiry, but nothing in the console calls it. Expired sessions with real
  escrow sit there until someone calls it manually.
- **No metrics or tracing export.** Structured logs only.

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

1. `docs/decisions.md` — **start here.** 20 numbered decisions, each stating
   what was chosen and what it closes. It is the design rationale, including
   the mistakes.
2. `programs/agentpay/src/lib.rs` — 617 lines, readable in one sitting.
3. `gateway/src/state.rs` — `evaluate_claim` is the heart of the enforcement
   logic and is about 40 lines.
4. `gateway/src/routes.rs` — `verify_claim` and `buy`, for the orderings.
5. `gateway/src/evidence.rs` — pure functions, easy to reason about.
6. `tests/attacks.ts` — 24 attacks; the fastest way to learn the threat model.

### File map

```
programs/agentpay/src/lib.rs     the on-chain program
gateway/src/                     11 modules, 6,677 lines
web/src/app/                     4 pages + session detail
web/src/lib/                     api client, formatting, status derivation
demo-provider/server.js          a provider with no payment code
tests/                           attack suite + devnet end-to-end
scripts/                         demo and staging scripts
gateway/migrations/              3 SQL migrations
docs/                            decisions, deploy, docker, server setup, pitch
```

### Other documents in the repo

| File | Contents |
| --- | --- |
| `docs/decisions.md` | D1–D20, the design rationale |
| `docs/DEPLOY.md` | Deploying the program and gateway |
| `docs/DOCKER.md` | Compose on Windows, macOS, Linux |
| `docs/SERVER_SETUP.md` | Bare-metal server setup |
| `docs/HACKATHON_KT.md` | Knowledge transfer notes |
| `docs/PITCH_AND_QA.md` | Pitch and anticipated questions |

### Current devnet state, as verified

Program `3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U`, upgrade authority
`78Q6uycbMfTre1zRiyx6dQvUv1yWEjGzmvuj5Brd3VHc`.

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
