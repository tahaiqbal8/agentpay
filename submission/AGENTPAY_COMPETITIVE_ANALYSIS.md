# AgentPay — Competitive Analysis

**Researched 11 Oct 2026.** Sources are listed per entry.

> **Source-quality warning, stated up front.** A large share of the public
> comparison writing in this space is published by **Nevermined**, which is
> itself a vendor in it. Those pages are marketing, not independent review, and
> are treated here as claims rather than findings. Where a capability could not
> be confirmed from a primary source, this document says so instead of
> guessing — including where that is inconvenient for AgentPay.

---

## 1. The landscape, honestly

Agent payments is not one market. It is at least four layers, and most of the
named projects occupy a different one from AgentPay:

| Layer | What it answers | Examples |
|---|---|---|
| **Protocol** | How does a service ask to be paid? | x402 (Linux Foundation) |
| **Identity** | Which agent is this, and is it allowed to act? | Skyfire |
| **Wallet / rails** | How does value actually move? | Coinbase x402, Crossmint |
| **Orchestration** | Metering, pricing, credits, multi-rail settlement | Nevermined |
| **Enforcement + evidence** | Was this request allowed, and can a stranger check? | **AgentPay** |

Most of these are **complements, not substitutes**. A judge who hears "x402 is
a competitor" should hear it corrected: x402 defines how a service *requests*
payment; it does not decide whether a given request is *permitted*, and it does
not produce a record of the requests that were refused.

---

## 2. Entry by entry

### x402 — open HTTP payment standard
- **What it does:** standardises how a service requests payment before granting access; facilitator model. The Linux Foundation launched the x402 Foundation in April 2026.
- **Users:** service operators and client developers wanting a common payment-request format.
- **Relation to AgentPay:** **complementary.** x402 is the handshake; AgentPay is the policy decision and the record behind it. A sensible future direction is for AgentPay to speak x402 at its edge.
- **Demonstrated difference today:** AgentPay enforces a human-set envelope and records refusals. x402 does not define either.

### Coinbase x402 — crypto-native implementation
- **What it does:** connects the x402 pattern to crypto payment infrastructure.
- **Noted limitation (from comparison writing, vendor-authored):** a crypto-first architecture can leave gaps for teams needing hybrid rails.
- **Relation to AgentPay:** adjacent. Different layer; AgentPay is not a wallet or a rail.

### Skyfire — agent identity and credentials
- **What it does:** agent identity, authentication, access, checkout and payment credentials under a "Know Your Agent" model.
- **Relation to AgentPay:** **complementary.** Skyfire answers *who is this agent*; AgentPay answers *is this particular spend within what its owner allowed, and can that be proved afterwards*.
- **Honest note:** public material on Skyfire is thinner on **enforcement** than on identity. That is an absence of evidence, not evidence of absence — do not claim on a slide that Skyfire cannot enforce limits.

### Nevermined — orchestration above the protocols
- **What it does:** connects x402, MCP, A2A, AP2; delegated spending, Flex Credits, pricing, metering, multi-rail settlement; supports agents that pay and agents that charge.
- **Relation to AgentPay:** the closest in ambition, and the broadest in scope. Nevermined covers more surface; AgentPay goes deeper on one thing — a chain-enforced ceiling plus independently verifiable evidence including refusals.
- **Honest note:** "delegated spending" is cited in their material but not explained in what was retrievable. **Do not assert** that their delegated spending lacks on-chain enforcement without reading their docs.

### Crossmint — agent cards and wallets
- **What it does:** agent cards, stablecoin wallets, checkout, transfers, spending controls.
- **Relation to AgentPay:** overlapping on *spending controls*, different on *provability*. Crossmint is a wallet/rails product.

### Sapiom — agent cost control
- **What it does:** agent-level cost tracking, spending and usage limits, real-time monitoring, detailed execution traces.
- **Relation to AgentPay:** **the closest functional overlap on limits.** Sapiom tracks and limits spend with execution traces.
- **The real difference:** a trace is a record the operator keeps. AgentPay's evidence root is committed to Solana, so the record can be checked by someone who does not trust the operator. That is the distinction to draw — not "they have no limits", which would be false.

### Traditional payment APIs (Stripe and similar)
- **What they do:** mature rails, excellent developer experience, spending controls inside the provider's own system.
- **The real difference:** the owner audits the spender's books. There is no artefact a third party can independently recompute. Also, per-call settlement economics do not suit sub-cent API calls.
- **Honest note:** these are far more mature, more reliable, and more widely integrated than AgentPay. Say so if asked.

---

## 3. What AgentPay can actually claim

**Demonstrated in the current implementation and verified on devnet:**

1. **Refusals are first-class evidence.** Every refused request is hash-chained with the same weight as an approval, and the decision string is inside the hash, so a refusal cannot be edited into an approval without breaking the chain. Verified: `ERR_POLICY_RESOURCE_NOT_ALLOWED` and `ERR_NONCE_NOT_MONOTONIC` both appear in the committed evidence, and a refusal's inclusion proof validates against the on-chain root.
2. **The ceiling is a program, not a database row.** The escrow vault is a PDA; the program will not release more than was deposited regardless of what the gateway asks for.
3. **Independent verification with no account.** The browser recomputes the chain and compares it to the root Solana stored. The evidence endpoint is public; only the control plane needs a token.
4. **Settlement without provider custody.** Settlement is signed by AgentPay's own authority; the destination is fixed inside the program by `session.provider`. Verified on devnet: the provider key never signs.
5. **Sub-cent economics.** Cumulative claims mean a thousand off-chain calls settle in one transaction.

**Future opportunity, not a current difference:**
- Speaking x402 at the edge.
- Multi-rail / fiat settlement.
- Multi-provider sessions.

**Claims that require validation before being put on a slide:**
- Whether any named competitor offers on-chain escrow with dispute/hold semantics — *could not be confirmed either way* from available sources.
- Whether Nevermined's delegated spending enforces on chain.
- Any statement of the form "no one else does X."

---

## 4. One-slide comparison (Slide 4)

Axes chosen because AgentPay can demonstrate every row on devnet today.

| | Limit enforced **before** spend | Ceiling held **on chain** | **Refusals** recorded as evidence | Verifiable by a **third party** |
|---|---|---|---|---|
| **AgentPay** | Yes | Yes (escrow PDA) | Yes | Yes — recompute in browser vs Solana |
| x402 (protocol) | Out of scope | Out of scope | Out of scope | Out of scope |
| Skyfire (identity) | Identity-led | — | Not described | Not described |
| Crossmint (wallet) | Spending controls | — | Not described | Not described |
| Sapiom (cost control) | Yes | — | Traces, operator-held | Not described |
| Stripe / card rails | Yes, provider-side | — | No | No |

**"Not described" means exactly that** — not confirmed from public material, not
a claim that the capability is missing. Say that out loud if a judge asks; it
is more credible than a clean row of crosses.

### The sentence for the slide

> Most of this space proves that an agent **paid**.
> AgentPay proves an agent was **stopped** — and anchors that proof on Solana.

---

## Sources

- [x402 vs Coinbase x402 vs Skyfire — Nevermined](https://nevermined.ai/blog/x402-vs-coinbase-x402-vs-skyfire) *(vendor-authored)*
- [Crossmint vs Skyfire vs Coinbase x402 — Nevermined](https://nevermined.ai/blog/crossmint-vs-skyfire-vs-coinbase-x402) *(vendor-authored)*
- [Sapiom alternatives — Nevermined](https://nevermined.ai/blog/sapiom-alternatives) *(vendor-authored)*
- [Stripe vs Skyfire vs Nevermined](https://nevermined.ai/blog/stripe-vs-skyfire-vs-nevermined) *(vendor-authored)*
- [Coinbase x402 alternatives — Nevermined](https://nevermined.ai/blog/coinbase-x402-alternatives) *(vendor-authored)*

**Gap to close if time allows:** read the primary docs for x402, Skyfire and
Nevermined directly. The current picture rests too heavily on one vendor's
comparison pages, and a judge who knows this space will notice.
