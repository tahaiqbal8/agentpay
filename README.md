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

Deployed and exercised on **Solana devnet**. **Not audited — not for mainnet.**
See [DEPLOY.md](docs/DEPLOY.md) §0.

| | |
|---|---|
| Program (devnet) | `3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U` |
| On-chain attack tests | 24 |
| Gateway tests | 101 with Postgres · 83 hermetic |
| Real settlement | fee **0.00001 SOL** |

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
| [HACKATHON_KT.md](docs/HACKATHON_KT.md) | How it works, end to end |
| [PITCH_AND_QA.md](docs/PITCH_AND_QA.md) | Pitch + judge Q&A |
| [decisions.md](docs/decisions.md) | D1–D20: every security decision and its rejected alternative |

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

Both of those run against synthetic sessions. For a **real** one on devnet:

```bash
npm run evidence-devnet     # opens, drives claims, settles, proves the root
npm run stage-settleable    # the same, but stops before settling
```

`stage-settleable` leaves a funded session waiting so the console's Settlement
page has something to act on — otherwise every script settles its own session
and the Settle button is never seen working.

---

## Trust model

| Party | Trusted for | **Not** trusted for |
|---|---|---|
| Agent | nothing | every claim is signature-checked |
| Provider | nothing | withholding is bounded to one claim increment |
| **Gateway** | availability, policy | **custody** |
| Program | — | it *is* the authority |

The gateway holds one key: the provider's, because `settle_session` needs that
signature. Three on-chain constraints bound it — funds can only reach the
provider's own account, the Ed25519 precompile checks the *agent's* signature so
it cannot exceed what was authorised, and `init` on `SettlementRecord` means it
cannot settle twice.

**A fully compromised gateway can settle early or low, costing the provider
revenue. It cannot move money to an attacker.**

---

## Known gaps

Stated up front rather than discovered later:

- **No security audit.** The blocker for mainnet.
- **Token-2022 untested** — code path exists via `token_interface`, never executed.
- **Single gateway instance** — row locks serialise per session; multi-instance is unproven.
- **Evidence log is append-only by convention** — `REVOKE UPDATE, DELETE` is a documented deployment step, not a default.
- **No SDK** — integration is ~50 hand-written lines, and the claim encoding fails silently at settlement if one byte is wrong.
- **Not x402-compatible** — `/v1/buy` speaks its own `agentpay-deferred-v1` scheme. Interoperating with the x402 spec is separate work.

---

## License

Not yet licensed. All rights reserved by the authors pending a decision.
