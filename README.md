# AgentPay

**Enforcement and audit layer for autonomous agent payments on Solana.**

An AI agent makes a thousand API calls costing a fraction of a cent each.
Settling each one on-chain costs more than the call is worth. AgentPay lets the
agent spend off-chain against an escrowed deposit, enforces the owner's limits
**at the moment of spend**, and settles the whole session in **one** Solana
transaction — while producing a cryptographic record of every decision,
including the ones where the agent was **refused**.

> Anyone can prove an agent *paid*. AgentPay proves an agent was **stopped** —
> and anchors that proof on-chain.

```
deposit ──▶ 1,000 signed claims off-chain ──▶ one settlement + evidence root
  1 tx                  0 tx                            1 tx
```

Claims are **cumulative**, not incremental: claim #40 says *"total owed is
1.234567"*, not *"add 0.05"*. So only the highest claim ever reaches the chain,
a dropped claim is superseded by the next, and replaying an old claim is inert
because it does not increase.

---

## Status

Deployed and exercised on **Solana devnet**, frozen at tag
`v2-devnet-verified`. **Not externally audited — not for mainnet.**
See [DEPLOY.md](docs/DEPLOY.md) §0.

Devnet verification means the program behaves as described on a public test
cluster with throwaway value. It is not a security review and not production
readiness.

**Two programs are live at once.** New sessions open under v2; sessions opened
under v1 keep settling and refunding under v1 until they drain. The gateway
decides which is which by reading the session account's owner and length from
the chain — never from configuration.

| | |
|---|---|
| Program v2 (devnet, active) | `ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m` |
| Program v1 (devnet, legacy) | `3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U` |
| Custody invariants (devnet) | 20 |
| On-chain attack tests | 24 |
| Gateway tests | 178 with Postgres · 136 hermetic |
| Real settlement | fee **0.00001 SOL** |

**v2 custody, in one sentence:** AgentPay does not hold provider private keys
for new v2 sessions — the settlement *amount* is fixed by the agent's Ed25519
signature over the claim, and the *destination* is `session.provider`, which
sits in the session PDA's seeds and cannot be changed after the session opens.
A provider keeps its own wallet and can always settle for itself.

Evidence: [RELEASE_V2.md](docs/RELEASE_V2.md) · migration state:
[MIGRATION_V1_V2.md](docs/MIGRATION_V1_V2.md)

---

## Layout

| Path | What |
|---|---|
| `programs/agentpay/` | Anchor program — holds the escrow, the only authority over funds |
| `demo-provider/` | An ordinary API with **no payment code** — what the gateway sells access to |
| `gateway/` | Rust + Axum — verifies claims, enforces limits, writes evidence, settles |
| `web/` | Next.js console — monitor, Merkle verifier, settlement, playground |
| `tests/` | Attack suite + devnet end-to-end |
| `scripts/` | Run, deploy, demo |
| `docs/` | Everything below |

---

## Docs

| Read this | For |
|---|---|
| **[RUNBOOK.md](docs/RUNBOOK.md)** | Zero to running, then the whole flow step by step — start here |
| **[sdk/README.md](sdk/README.md)** | Integrating an agent — three lines, not 194 |
| **[HANDOVER.md](docs/HANDOVER.md)** | Full engineering handover — architecture, backend, frontend, data model, security, gaps |
| **[DOCKER.md](docs/DOCKER.md)** | Docker Compose on Windows / macOS / Linux |
| [SERVER_SETUP.md](docs/SERVER_SETUP.md) | Fresh machine → running stack, without Docker |
| [DEPLOY.md](docs/DEPLOY.md) | Deploying each component; mainnet caveats |
| **[RELEASE_V2.md](docs/RELEASE_V2.md)** | The v2 release record — devnet evidence, security results, limitations |
| **[MIGRATION_V1_V2.md](docs/MIGRATION_V1_V2.md)** | Two live programs, how they are told apart, and what is left to drain |
| [RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) | Handover checklist for this release |
| [SETTLEMENT_CUSTODY.md](docs/SETTLEMENT_CUSTODY.md) | Design record for the v2 custody model (options considered, one built) |
| [SAAS_ARCHITECTURE.md](docs/SAAS_ARCHITECTURE.md) | Commercial architecture report — mostly not implemented, read the status ledger |
| [HACKATHON_KT.md](docs/HACKATHON_KT.md) | How it works, end to end |
| [PITCH_AND_QA.md](docs/PITCH_AND_QA.md) | Pitch + judge Q&A |
| [decisions.md](docs/decisions.md) | Every security decision and its rejected alternative |

---

## Quick start

**Docker (any OS — Windows, macOS, Linux):**

```bash
cp .env.example .env
docker compose up -d --build     # first build ~10-20 min (Rust)
```

Then open **http://localhost:3100**. See [DOCKER.md](docs/DOCKER.md).

**Or run the parts directly:**

```bash
./scripts/dev-db.sh up                                    # Postgres :5434
DATABASE_URL="postgres://agentpay:agentpay@127.0.0.1:5434/agentpay" \
  bash scripts/run-gateway.sh                             # Gateway  :8080
npm --prefix web run dev                                  # Console  :3100
```

Then drive traffic through it:

```bash
AGENTPAY_TRUST_OPEN_REQUESTS=1 bash scripts/run-gateway.sh   # dev only
npm run demo
```

Eight scenarios — two allowed, four denied, a forged signature, then a recovery
claim proving the high-water mark never moved during the denials.

Or watch an agent **actually buy things**:

```bash
npm run buy
```

```
402 weather   price 0.001000
200 weather   paid 0.001000  ✓ from provider
    {"city":"Lahore","temp_c":24,"condition":"Haze"}
...
403 analyse   ERR_CLAIM_EXCEEDS_DEPOSIT
    no data returned — the provider was never contacted
```

Both of those run against synthetic sessions.

---

## Canonical V2 demo

**One command. This is the demo.**

```bash
npm run demo:v2
```

It runs the whole lifecycle against **real Solana devnet** under program v2
(`ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m`): a human creates an agent and
sets a spending envelope, the agent funds an escrow that binds AgentPay's
settlement authority, discovers the catalogue, plans, buys `/weather` and
`/quote` against signed cumulative claims, is **refused** `/analyse` by policy
and refused again on a replayed nonce, has every decision written to a hash
chain, and is settled by AgentPay's authority — which never holds the
provider's key. The Merkle root is then recomputed independently, a refusal is
proved against it, and conservation is checked.

It reads `AGENTPAY_ADMIN_TOKEN`, `AGENTPAY_PROGRAM_ID` and `AGENTPAY_RPC_URL`
from `.env` itself. You do not need to export anything.

Prerequisites: `docker compose up -d` running, and a devnet wallet with
~0.1 SOL. The run spends roughly 0.02–0.05 devnet SOL in rent and fees.

Full step-by-step, including the manual `curl` version of each stage:
[RUNBOOK.md — Canonical V2 demo](docs/RUNBOOK.md#canonical-v2-demo).

### V1 is legacy

`3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U` is still deployed and still
serves every session opened before the cutover. Its scripts are kept as
regression coverage and are all suffixed `:v1-legacy`:

```bash
npm run evidence:v1-legacy          # V1 — NOT the demo
npm run stage-settleable:v1-legacy  # V1 — leaves a V1 session for the UI
```

**Never run a `:v1-legacy` command to demonstrate AgentPay.** They exercise the
old custody model, in which AgentPay holds the provider's private key — the
thing v2 exists to remove. See [MIGRATION_V1_V2.md](docs/MIGRATION_V1_V2.md).

---

## Trust model

| Party | Trusted for | **Not** trusted for |
|---|---|---|
| Agent | nothing | every claim is signature-checked |
| Provider | nothing | withholding is bounded to one claim increment |
| **Gateway** | availability, policy | **custody** |
| Program | — | it *is* the authority |

For **v2** sessions the gateway holds its **own** settlement-authority key —
not the provider's. It is a permission to submit a settlement, nothing else.
Three on-chain constraints bound it: funds can only reach
`session.provider`'s own account and that field is in the PDA seeds, the
Ed25519 precompile checks the *agent's* signature so the amount cannot exceed
what was authorised, and the cumulative amount is monotonic so a settlement
cannot be replayed for value.

**A fully compromised gateway can settle early or low, costing the provider
revenue. It cannot move money to an attacker.**

Two qualifications, stated rather than buried. **v1** sessions still require
the provider's own key, and the gateway holds one for them until they drain.
And a compromised **control plane** can change a provider's registered
settlement address for *future* sessions — existing sessions are safe, this
cannot be fixed in the program, and providers must be told.

---

## Known gaps

Stated up front rather than discovered later:

- **No external security audit.** The blocker for mainnet. Neither program has
  been reviewed by a third party.
- **Devnet only.** Mainnet needs the audit first.
- **The v2 Merkle root is the latest, not final.** Repeatable settlement is why:
  a later settlement commits a root over more leaves, so a proof exported now
  may not verify against a later root.
- **Migration v1 → v2 is not finished.** `AGENTPAY_PROVIDER_KEYPAIR` is still
  required for v1 sessions, so the gateway still holds a provider key for those.
- **The provider still has a wallet.** It should keep its key as a fallback.
  The claim is that AgentPay does not hold it, not that it does not exist.
- **A compromised control plane can change a provider's registered settlement
  address for future sessions.** Existing sessions are safe — their provider is
  in the PDA seeds. Must be disclosed to providers.
- **Token-2022 untested** — code path exists via `token_interface`, never executed.
- **Single gateway instance** — row locks serialise per session; multi-instance is unproven.
- **Rate limiting keys on the TCP peer**, so behind a load balancer every tenant shares a bucket.
- **Evidence log is append-only by convention** — `REVOKE UPDATE, DELETE` is a documented deployment step, not a default.
- **Not x402-compatible** — `/v1/buy` speaks its own `agentpay-deferred-v1` scheme. Interoperating with the x402 spec is separate work.

---

## License

Not yet licensed. All rights reserved by the authors pending a decision.
