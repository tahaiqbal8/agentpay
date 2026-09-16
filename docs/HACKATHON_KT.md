# AgentPay — Knowledge Transfer

**Audience:** teammates and judges, technical and non-technical.
**Repo root:** `~/Projects/AgentPay`
**Program (devnet):** `3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U`

---

## 1. The one-paragraph version

An AI agent needs to pay for a thousand API calls costing a fraction of a cent
each. Paying on-chain per call costs more in fees than the calls are worth.
AgentPay lets the agent make those calls off-chain against an escrowed deposit,
enforces the owner's spending limits **at the moment of spend**, and settles the
whole session in **one** Solana transaction — while producing a cryptographic
receipt proving every decision, including the ones where the agent was **refused**.

> **The pitch in one line.** Anyone can show that an agent paid. AgentPay proves
> that an agent was *stopped* — and anchors that proof on a public chain.

---

## 2. Why the denial is the product

This is the part worth internalising before a judge asks.

A spending policy that lives in a dashboard is **advice**. A policy enforced by
the component that holds escrow authority is **binding**. AgentPay holds that
position, and the thing a finance team actually needs is not "here is the
receipt for what we spent" — it is **"prove the agent could not overspend."**

That is why denials are stored in the evidence log alongside approvals, and why
the UI colours them **amber, not red**. A denial is the system working. Colour it
like an outage and operators learn to dismiss the main output.

---

## 3. The flow, step by step

```
   OWNER                AGENT                GATEWAY              SOLANA
     │                    │                     │                    │
  1. │ deposits 5 USDC ───┼─────────────────────┼───────────────────▶ │ escrow vault
     │                    │                     │                    │  (Session PDA)
     │                    │                     │                    │
  2. │                    │  open session ─────▶│ reads the account  │
     │                    │                     │ ◀──────────────────│ reconcile
     │                    │                     │                    │
  3. │                    │  signed claim  ────▶│ verify → decide    │
     │                    │  cumulative=0.10    │ → append evidence  │
     │                    │ ◀──── ALLOWED ──────│                    │
     │                    │                     │                    │
     │                    │  signed claim  ────▶│                    │
     │                    │  cumulative=99.00   │ ✗ over the cap     │
     │                    │ ◀── DENIED ─────────│ → append evidence  │
     │                    │   (×N requests)     │                    │
     │                    │                     │                    │
  4. │                    │  close session ────▶│ merkle root of all │
     │                    │                     │ decisions ────────▶│ ONE settle tx
     │                    │                     │                    │  + root on-chain
     │                    │                     │                    │
  5. │  auditor verifies any single decision against that root ──────▶│
```

| Step | Name | Where it happens | Cost |
|:--:|---|---|---|
| 1 | **Deposit** | Solana — `open_session` | 1 tx |
| 2 | **Track** | Gateway — reconciled against chain | 0 tx |
| 3 | **Claim** | Gateway — off-chain, ~ms | 0 tx, ×1000s |
| 4 | **Settle** | Solana — `settle_session` | **1 tx total** |
| 5 | **Audit** | Anyone, anywhere | 0 tx |

**The saving:** 1,000 paid calls cost **2 transactions**, not 1,000.

---

## 4. System components

| Layer | Tech | Lines | Job |
|---|---|--:|---|
| **Program** | Rust + Anchor 1.2 | 617 | Holds the money. The only authority over funds. |
| **Gateway** | Rust + Axum | 5,977 | Verifies claims, enforces limits, writes evidence, settles. |
| **State** | PostgreSQL + sqlx 0.8 | 2 migrations | High-water marks + append-only evidence log. |
| **Console** | Next.js 16, React 19, Tailwind 4 | 4,500 | Monitor, verifier, settlement, playground. |

### 4.1 The Anchor program — *holds the money*

Three instructions:

| Instruction | Who signs | What it does |
|---|---|---|
| `open_session` | agent | Moves USDC into a vault PDA, records the terms |
| `settle_session` | provider | Pays the **highest** claim, commits the evidence root |
| `refund_session` | agent, or **anyone** after expiry | Returns the unspent remainder |

> **Why `refund` is permissionless after expiry.** Funds can only ever move to
> the agent's own token account, so a stranger triggering it cannot redirect
> them. This is what makes "the agent gets its money back with no gateway and no
> provider cooperation" *true* rather than a promise. There is a test that kills
> the gateway and recovers funds with it never involved.

### 4.2 The gateway — *enforces the rules*

Trusted for **availability and policy**. Never for **custody**.

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Liveness + which state backend is in use |
| `/v1/session/open` | POST | Start tracking (reconciled against chain first) |
| `/v1/claim/verify` | POST | **The hot path.** Authorise or refuse one claim |
| `/v1/session/settle` | POST | Build + submit the settlement transaction |
| `/v1/sessions` | GET | Session list for the dashboard |
| `/v1/decisions/recent` | GET | Live feed |
| `/v1/session/{pubkey}/evidence` | GET | Full hash chain + Merkle root |
| `/v1/evidence/proof` | POST | Inclusion proof for one decision |

> ⚠️ **Common mistake:** the claim endpoint is `/v1/claim/verify`, **not**
> `/v1/claim/authorize`.

### 4.3 PostgreSQL — *remembers*

| Table | Holds | Why it matters |
|---|---|---|
| `sessions` | terms + settled flag | Survives restart |
| `claim_tickets` | **one row** — the high-water mark + its signature | The replay defence |
| `evidence_log` | **append-only**, one row per decision | The audit trail |

> **Why durability is a security property, not a nicety.** The high-water mark
> is the only thing stopping an agent replaying an old claim to get a second
> resource for the same money. The chain cannot help — it sees one settlement at
> close and has no view of individual requests. So before Postgres, **a gateway
> restart was a security event.** There is a test that `kill -9`s the gateway
> mid-session and proves the replay is still refused afterwards.

### 4.4 The console — *makes it checkable*

Four pages: **Monitor**, **Verifier**, **Settlement**, **Playground**.

---

## 5. Key mechanics

### 5.1 High-water mark

Claims are **cumulative**, not incremental. Claim #40 says *"total owed is
1.234567"*, not *"add 0.05"*.

```
claim 1:  cumulative = 0.10   →  ALLOWED  (delta 0.10)
claim 2:  cumulative = 0.40   →  ALLOWED  (delta 0.30)
claim 3:  cumulative = 0.40   →  DENIED   ERR_CLAIM_NOT_MONOTONIC
claim 4:  cumulative = 0.05   →  DENIED   ERR_CLAIM_NOT_MONOTONIC
```

Three consequences fall out for free:

1. **Only the highest claim ever needs to settle.** The other 999 never touch the chain.
2. **A lost claim doesn't matter** — the next one supersedes it.
3. **Replay is inert.** Re-sending a paid claim buys nothing, because it does not increase.

> **A refused claim never advances the mark.** After the two denials above, the
> next legitimate claim is still measured against **0.40**. Demonstrable in the
> Playground.

### 5.2 Monotonic nonce

`cumulative` alone is not enough — two claims could rise in amount but arrive out
of order. The `nonce` (sequence number) must **also** strictly increase, and it
is inside the signed bytes, so it cannot be edited without invalidating the claim.

Both checks live in **one function**, `evaluate_claim`, used by the in-memory
store *and* the Postgres store. The ordering rules are deliberately **not**
reimplemented in SQL — a second copy would drift, and the SQL copy is the one
nobody unit-tests.

### 5.3 The evidence log

Each decision is hashed to its predecessor:

```
entry_hash = SHA256(prev_hash ‖ session ‖ cumulative_le ‖ nonce_le ‖ decision)
```

Changing, reordering, or deleting any entry breaks every link after it. At
settlement, the entry hashes become the leaves of a Merkle tree, and the 32-byte
root goes **on-chain**.

> **Only authenticated decisions are recorded.** `ERR_INVALID_SIGNATURE`,
> `ERR_MALFORMED_CLAIM`, and `ERR_SESSION_UNKNOWN` are decided *before* the
> signature is checked. Logging them would let anyone who learns a session
> pubkey append leaves to a session they have nothing to do with and shift the
> root committed on-chain. **An append-only log anyone can append to is not
> evidence.** Those attempts go to the application log instead.

### 5.4 Client-side verification

The console recomputes the Merkle root **in your browser** with WebCrypto:

```
leaf → sha256(running ‖ sibling) → … → root
```

The gateway returns a `verified_locally` flag, but that is the gateway marking
its own homework. The green **"Cryptographically validated"** badge appears only
when *your browser* reproduces the root independently.

### 5.5 Zero-trust model

| Party | Trusted for | **Not** trusted for |
|---|---|---|
| Agent | nothing | anything — every claim is signature-checked |
| Provider | nothing | may withhold; loss bounded to one claim increment |
| **Gateway** | availability, policy | **custody** |
| Program | everything | — it *is* the authority |

**If the gateway is fully compromised, what happens?**

It holds one key: the provider's, needed because `settle_session` requires that
signature. The program bounds what that key can do:

- `provider_token_account.owner == provider` → funds cannot be redirected
- the Ed25519 precompile checks the **agent's** signature → cannot settle above what the agent authorised
- `init` on `SettlementRecord` → cannot settle twice

So a compromised gateway can settle **early** or **low**, costing the provider
revenue. It **cannot** move money to an attacker. The custody claim survives.

---

## 6. Local setup

### 6.1 Prerequisites

| Tool | Version here |
|---|---|
| rustc | 1.98.1 |
| solana-cli | 4.1.2 |
| anchor | 1.2.0 |
| node | v25.9.0 |
| Docker | for Postgres |

### 6.2 Three processes, in order

**① PostgreSQL** — port `5434` (deliberately *not* 5432/5433, which other
projects commonly occupy)

```bash
cd ~/Projects/AgentPay && ./scripts/dev-db.sh up
```

**② Gateway** — port `8080`

```bash
cd ~/Projects/AgentPay && \
DATABASE_URL="postgres://agentpay:agentpay@127.0.0.1:5434/agentpay" \
AGENTPAY_PROVIDER_KEYPAIR="$HOME/.config/solana/agentpay-provider.json" \
bash scripts/run-gateway.sh
```

**③ Console** — port `3100`

```bash
cd ~/Projects/AgentPay && npm --prefix web run dev
```

Then open **http://localhost:3100**

> The console proxies to the gateway through `/api/gw` (same-origin, so no CORS
> to loosen). **Nothing appears unless the gateway is on `:8080`.**

### 6.3 Environment variables

| Variable | Required | Effect |
|---|:--:|---|
| `AGENTPAY_RPC_URL` | ✅ | Solana RPC. Refuses `mainnet` unless overridden |
| `AGENTPAY_PROGRAM_ID` | ✅ | Deployed program |
| `DATABASE_URL` | — | Absent → in-memory, **loses marks on restart** |
| `AGENTPAY_PROVIDER_KEYPAIR` | — | Absent → verify-only, cannot settle |
| `AGENTPAY_TRUST_OPEN_REQUESTS` | — | `=1` disables chain reconciliation. **Dev only** |

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| UI shows `DEMO…` keys + red banner | Gateway not on `:8080` | Start step ② |
| `password authentication failed` (28P01) | Postgres container recreated with different creds | `./scripts/dev-db.sh down && ./scripts/dev-db.sh up` |
| `ERR_SESSION_ACCOUNT_NOT_FOUND` on open | Session isn't on-chain (reconciliation working) | Use a real session, or `AGENTPAY_TRUST_OPEN_REQUESTS=1` |
| `ERR_SETTLEMENT_UNAVAILABLE` | No provider keypair | Set `AGENTPAY_PROVIDER_KEYPAIR` |
| `ERR_CHAIN_UNAVAILABLE` | RPC unreachable | Check `AGENTPAY_RPC_URL`. **Fails closed by design** |
| Dashboard renders but never populates | Next dev HMR socket blocked (some embedded browsers) | `npm --prefix web run build && npm --prefix web start` |
| Airdrop rate-limited | Devnet faucet per-IP limit | Use https://faucet.solana.com |

---

## 8. Live demo script

### 8.1 Setup (once, before presenting)

Start the gateway **with the dev flag** so the demo needs no devnet round trips:

```bash
AGENTPAY_TRUST_OPEN_REQUESTS=1 DATABASE_URL="postgres://agentpay:agentpay@127.0.0.1:5434/agentpay" bash scripts/run-gateway.sh
```

Put the **Monitor** page on screen at http://localhost:3100.

### 8.2 Scenario 1 + 2 — happy path and denials, in one command

```bash
npm run demo
```

Eight scenarios, paced ~1s apart so the feed is watchable:

| # | Scenario | Cumulative | Nonce | Result |
|--:|---|---:|--:|---|
| 1 | first claim | 0.100000 | 1 | 🟢 `ALLOWED` |
| 2 | ladder advances | 0.400000 | 2 | 🟢 `ALLOWED` |
| 3 | exact replay | 0.400000 | 3 | 🟠 `ERR_CLAIM_NOT_MONOTONIC` |
| 4 | regression | 0.050000 | 4 | 🟠 `ERR_CLAIM_NOT_MONOTONIC` |
| 5 | nonce reuse | 0.900000 | 2 | 🟠 `ERR_NONCE_NOT_MONOTONIC` |
| 6 | over the cap | 99.000000 | 9 | 🟠 `ERR_CLAIM_EXCEEDS_DEPOSIT` |
| 7 | forged signature | 0.600000 | 10 | 🔴 `ERR_INVALID_SIGNATURE` |
| 8 | recovery after denials | 0.750000 | 11 | 🟢 `ALLOWED` |

**Three things to say out loud while this runs:**

1. *"Watch the amber badges — that's the enforcement layer refusing to spend."*
2. *"Scenario 8 is the important one. After four denials the mark is still 0.40,
   so the next real claim is measured from there. **A refused claim never moves
   the mark.**"*
3. *"Eight attempts, but the log has **seven** entries. The forged signature is
   excluded — unauthenticated attempts can't be allowed to pad someone else's
   root."*

For continuous background traffic instead:

```bash
npm run demo -- --watch
```

### 8.3 Scenario 3 — cryptographic proof

The script prints a verifier link. Open it, then:

1. Click the **`CLAIM_EXCEEDS_DEPOSIT`** entry in the chain ladder.
2. The right panel shows the sibling path, hop by hop.
3. Compare **"recomputed in browser"** against **"root reported by gateway"**.
4. Green badge: **Cryptographically validated**.

> *"That root is recomputed by your browser with WebCrypto. And this is a
> **denial** — we're proving the agent was refused, not that it paid."*

### 8.4 Scenario 4 — fallback mode

In another terminal:

```bash
pkill -f agentpay-gateway
```

Refresh the Monitor. The UI turns red, every key becomes `DEMO…`, and the banner
reads *"Everything below is seeded placeholder data, not on-chain state."*

> *"When we can't reach the gateway we don't quietly show stale numbers. We say
> so, three ways at once."*

Restart with step ② to recover.

### 8.5 The full on-chain loop (real devnet money)

```bash
npm run evidence-devnet
```

Opens a real escrow session, drives 7 claims, settles on devnet, then verifies
the on-chain Merkle root against one recomputed with an **independent**
TypeScript SHA-256 implementation.

> Costs devnet SOL and is **irreversible per session**. Run it once before the
> demo and keep the explorer link, rather than live on stage.

---

## 9. Manual API calls

`/health`, `/v1/sessions`, and `/v1/decisions/recent` work with plain curl:

```bash
curl -s localhost:8080/v1/sessions | jq '.sessions[0]'
```

> ⚠️ **`/v1/claim/verify` cannot be driven by hand.** Every claim carries an
> Ed25519 signature over 73 canonical bytes
> (`"agentpay:claim:v1" ‖ session ‖ cumulative_le ‖ nonce_le ‖ expiry_le`).
> Hand-writing that is impractical — a curl without a valid signature returns
> `ERR_INVALID_SIGNATURE`, which is the gateway working correctly. Use
> `npm run demo`, which signs properly.

---

## 10. Test suite

| Suite | Count | Command |
|---|--:|---|
| Gateway (hermetic, no DB/cluster) | **83** | `cargo test --manifest-path gateway/Cargo.toml` |
| Gateway + Postgres | **101** | `DATABASE_URL=… cargo test … -- --include-ignored` |
| Anchor attack suite | **24** | `./scripts/test-local.sh` |
| Devnet end-to-end | — | `npm run evidence-devnet` |

Every attack test is written as an attack that **must fail**, and asserts the
**exact** error code — a test that fails for an unrelated reason proves nothing
about the defence it claims to test.

---

## 11. Known limitations — state these before a judge finds them

Credibility is worth more than a clean slate.

| Gap | Status |
|---|---|
| **Token-2022** | Code path exists, never executed. Only classic SPL Token is tested. |
| **Append-only is convention** | Nothing revokes `UPDATE`/`DELETE` from the app role. Tampering is *detectable*, not *impossible*. |
| **Gateway holds the provider key** | Bounded on-chain, but provider-side signing is the correct end state. |
| **Monotonicity untested on-chain** | Single-settle makes `cumulative_settled` always 0 at settle, so the ordering comparison is unreachable in the program. Enforced and tested in the gateway. |
| **Single gateway instance** | Row locks serialise per session, but multi-instance deployment is unproven. |
| **`AGENTPAY_TRUST_OPEN_REQUESTS`** | Demo convenience that disables a real security control. Never in production. |

---

## 12. Cheat sheet

```bash
./scripts/dev-db.sh up          # postgres  :5434
bash scripts/run-gateway.sh     # gateway   :8080
npm --prefix web run dev        # console   :3100

npm run demo                    # 8 scripted scenarios
npm run demo -- --watch         # continuous traffic
npm run evidence-devnet         # full on-chain loop (spends SOL)
./scripts/dev-db.sh psql        # inspect the database
```

**If someone remembers one sentence:**

> AgentPay turns "trust us, the agent stayed in budget" into a 32-byte root on
> Solana that anyone can check — including the times the agent was stopped.
