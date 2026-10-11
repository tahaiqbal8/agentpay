# AgentPay — Colosseum Project Profile (copy-ready)

**Hackathon:** Crypto World's Fair (Colosseum), 14 Sep – 12 Oct 2026
**Verified deadline:** *"Deadline for submissions is 13 Oct (6:59 AM UTC)"* — Superteam Earn.
That is **13 Oct 11:59 AM PKT** = **12 Oct 11:59 PM PDT**.
**Ecosystem track:** Solana ($100,000 pool, 10 × $10,000)
**Country:** Pakistan

> Every claim below is marked with its evidence level. Nothing marked
> *Implemented* or *Verified on devnet* is aspirational. Nothing is claimed as
> audited, production-ready, or on mainnet, because none of that is true.

---

## 1. Project name

```
AgentPay
```

## 2. One-line tagline

```
Policy-bounded payments for automated services — with proof of every refusal, anchored on Solana.
```

Alternates, if a shorter field is needed:

```
Spending limits for software clients, enforced before the money moves.
```
```
Anyone can prove an agent paid. AgentPay proves an agent was stopped.
```

## 3. Short description (≤ 280 characters — check the portal's real limit)

```
A human funds an escrow and sets spending rules. Automated clients spend inside
it. AgentPay allows or refuses every request before money moves, hash-chains
each decision, and anchors the evidence root on Solana — so what was spent can
be checked without trusting the gateway.
```
*(277 characters.)*

## 4. Extended description

```
Software that spends money asks you to trust it twice: that it spends on the
right things, and that it reports honestly about what it spent. AgentPay
removes the second half of that trust.

A person funds an escrow on Solana and sets the spending envelope — how much in
total, how much per call, which resources, until when. An authorized client
then spends inside that envelope. Every request is checked against the policy
and against the on-chain deposit BEFORE any money moves, and the decision —
allowed or refused — is hashed into an append-only chain. At settlement, the
root of that chain is written to a Solana account alongside the amount.

Two things make the result checkable rather than merely claimed. First, the
refusals are recorded with the same weight as the approvals, so the log cannot
be quietly trimmed to flatter the gateway. Second, the verifier recomputes the
whole chain in the browser and compares it against the root the Solana program
actually stored — if the gateway ever committed a root its own log could not
produce, the comparison fails in public.

Claims are cumulative rather than incremental: a claim says "the total owed is
now 1.234567", not "add 0.05". Only the highest claim ever reaches the chain, a
dropped claim is superseded by the next one, and replaying an old claim is
inert because it does not increase the total. That is what lets a thousand
sub-cent calls settle in one transaction instead of a thousand.
```

## 5. Problem statement

```
Automated services are being given spending authority faster than anyone has
built the controls for it. The two things an owner actually needs — a limit
that is enforced rather than requested, and a record they can check without
trusting the operator — are exactly what current rails do not provide.

Card and API rails enforce limits inside the provider's own database, so the
owner audits the spender's own books. Crypto rails settle each payment on
chain, which is honest but costs more than a sub-cent API call is worth. And
across both, the thing that is never recorded is the refusal: systems prove
what was paid, not what was stopped.
```

## 6. Solution statement

```
AgentPay sits between the client and the service as an enforcement point with
a memory.

  Policy  →  Request  →  Allow / Deny  →  Evidence  →  Settlement  →  Verify

The human sets the policy. The escrow on Solana is the hard ceiling — the
program will not release more than was deposited, whatever the gateway says.
Each request is admitted or refused against the policy before the provider is
contacted. Each decision is hash-chained. One settlement transaction closes the
session and anchors the evidence root on chain. Anyone — with no account and no
access to the control plane — can recompute that root in their browser and
compare it to what Solana stored.
```

## 7. Technical overview

| Layer | What it is | Status |
|---|---|---|
| Solana program (Anchor) | Escrow vault, cumulative-claim settlement, Ed25519 precompile introspection, permissionless refund after expiry | **Verified on devnet** |
| Gateway (Rust / Axum) | Policy enforcement, claim verification, evidence hash chain, settlement submission | **Implemented, 150 tests pass** |
| State (Postgres) | Sessions, decisions, append-only evidence enforced by database triggers | **Implemented** |
| Console (Next.js / React) | Operator surface + public browser verifier | **Deployed** |
| SDK (TypeScript) | Client that signs cumulative claims | **Implemented, test suite passes** |

**Canonical claim** — 73 bytes, signed by the agent:
`"agentpay:claim:v1"(17) ‖ session(32) ‖ cumulative_le(8) ‖ nonce_le(8) ‖ expires_at_le(8)`

**Evidence entry** — `SHA256(prev ‖ session ‖ cumulative_le ‖ nonce_le ‖ decision)`.
The decision string is part of the hash, so a refusal cannot be edited into an
approval without breaking the chain.

## 8. How the project uses the blockchain

```
Solana is not a logo on this project — it is where three of the guarantees
actually live.

1. The spending ceiling is a program, not a policy row. The escrow vault is a
   PDA; the program will not release more than was deposited, so a compromised
   gateway cannot overspend an agent's escrow.

2. Settlement is signed by AgentPay's own settlement authority, never by a
   provider key. The destination is fixed by session.provider inside the
   program and the amount by the agent's own signature, so holding the
   settlement key is not custody of the funds — it can trigger a settlement and
   nothing else.

3. The evidence root is written to a Solana account at settlement. That is what
   makes the log checkable by a stranger: the browser recomputes the chain and
   compares it to the root the program stored, not to the root the gateway
   claims it produced.

Ed25519 signature verification uses Solana's precompile, with all three
instruction-index fields pinned to u16::MAX so the introspected instruction
cannot be swapped for a different one.

Solana specifically, because the model needs cheap, fast finality for a single
settlement that closes out a thousand off-chain claims, and a precompile for
signature verification the program can introspect.
```

## 9. Current implementation status — **be precise here**

**Verified on devnet** (program v2 `ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m`):
- Escrow open, cumulative-claim settlement, evidence root committed on chain
- Policy refusal (`ERR_POLICY_RESOURCE_NOT_ALLOWED`) and replay refusal (`ERR_NONCE_NOT_MONOTONIC`), both recorded as evidence
- Independent recomputation: browser root = gateway root = on-chain root
- Conservation: settled + remaining = deposit
- Settlement signed by AgentPay's authority; the provider key never signs

**Most recent full run — 11 Oct 2026, 25 PASS / 0 FAIL:**

| | |
|---|---|
| Session | `F9uv8RFszLAuKUdRea121aSwoSUGT5ftPfXXi8Ux8Nfc` |
| Settlement tx | `5HQWGghSpGaYNUG3Pzym2dXhWMrrvF3BtaYxRssLS4QvAiGaEEP1EmnTkB67ZK65Wan1wJ8hoeq5j2k4SupjXWpX` |
| Evidence root | `f4c179199c66d6e5981509c2594c05fd8d237e6df0f8f001c89097f511edd15c` |
| Evidence | 3 entries — ALLOWED, ALLOWED, ERR_NONCE_NOT_MONOTONIC |
| Conservation | 1500 + 2998500 = 3000000 |

**Deployed:** operator console and public verifier at https://13-200-171-103.sslip.io over HTTPS.

**Tested:** 150 gateway tests, SDK suite, end-to-end devnet demo (`npm run demo:v2`).

**NOT claimed:**
- No external security audit has been performed.
- Not deployed to mainnet, and devnet success is not production readiness.
- No users, customers, revenue, partnerships or traction.
- The $5,000 escrow figures in the demo are devnet test tokens with no value.

## 10. Future milestones

1. **Independent security review** of the program and the claim/evidence path.
2. **Mainnet readiness review** — key management, monitoring, incident response.
3. **Design-partner pilots** with teams running automated services.
4. **SDK and docs** hardening for third-party integration.
5. **Multi-provider sessions** and richer policy primitives.

These are milestones, not features.

## 11. Website description

```
Live operator console and public verifier. The verifier needs no account: paste
a session address and the browser recomputes its evidence chain and compares
the result against the root stored on Solana.
```

URL: `https://13-200-171-103.sslip.io`
Judge view (read-only, hides every state-changing surface): `https://13-200-171-103.sslip.io/?judge=1`

> **Note for the submission:** the deployment uses sslip.io with a Let's Encrypt
> certificate. HTTPS is not cosmetic — the browser verifier uses WebCrypto,
> which is only available in a secure context. Over plain HTTP it reports a
> failure that is not real.

## 12. GitHub repository description (the repo's description field is currently empty — set it)

```
Policy-bounded payments for automated services. Escrow on Solana, enforcement before spend, hash-chained evidence of every decision including refusals, and independent browser verification.
```

Repository: https://github.com/tahaiqbal8/agentpay — **public, verified 11 Oct 2026**.
Secret scan: no `.env`, keypair, PEM or admin token is tracked; `.gitignore` covers `.env*` and `secrets/*`.

## 13. Technologies

```
Solana, Anchor, Rust, Axum, TypeScript, Next.js, React, PostgreSQL, Docker,
Ed25519, SHA-256 hash chains, Merkle inclusion proofs, nginx, Let's Encrypt
```

## 14. Still needed from the submitter

- [ ] **Team members and their real roles** — cannot be invented; see the deck's Slide 7.
- [ ] **Project logo** — the console uses an "A" mark; a standalone logo file may be required.
- [ ] **Funding ask amount** — see the pitch deck, Slide 9, for a recommendation.
- [ ] **X / project social URL** — needed by the Superteam form.
