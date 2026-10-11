# AgentPay — Pitch Deck Content (11 slides, copy-ready)

**Design direction:** graphite `#08090c` background, surfaces `#0f1116` /
`#161921`, indigo accent `#7c5cfc`, emerald `#10b981` for verified, amber
`#f59e0b` for refusals, red `#ef4444` for faults only. White `#f5f7fa` text,
muted `#9ca3af`. Monospace for keys, roots and signatures. These are the live
console's own tokens, so the deck and the product look like one thing.

**Rules for this deck:** one message per slide. No paragraph longer than two
lines. Every number either has a source or is labelled an assumption.

---

## Slide 1 — Introduction

**Title**
```
AgentPay
```

**Tagline**
```
Policy-bounded payments for automated services —
with proof of every refusal, anchored on Solana.
```

**Sub-line**
```
Crypto World's Fair 2026 · Solana track · Pakistan
```

**Presenter:** _[NEEDS CONFIRMATION — see Slide 7]_

**Layout:** Logo centred upper third. Tagline beneath in 28–32pt. Presenter
name and hackathon line small at the bottom. Nothing else.

**Speaker notes (~15s):** "AgentPay is a payment control layer for software
that spends money on someone's behalf. I'll show you a limit that is actually
enforced, and a receipt that you can check without trusting me."

---

## Slide 2 — Problem

**Title**
```
Software is being given spending authority faster
than anyone has built the controls for it.
```

**Three points**
```
A limit you ask for is not a limit.
Card and API rails enforce inside the provider's own database — you audit the
spender's own books.

Per-call settlement does not fit per-call prices.
A sub-cent API call cannot carry an on-chain transaction fee.

Nobody records the refusals.
Every system proves what was paid. None proves what was stopped.
```

**Visual:** three stacked rows, each with a small amber icon. No stock imagery.

**On numbers:** do **not** put a headline market statistic here unless it is
sourced and specifically about *controlled automated payments*. A generic "AI
market size" number invites exactly the challenge you cannot answer. The third
point is stronger than any statistic, because it is checkable in thirty seconds
against any competitor's docs.

**Speaker notes (~25s):** "If you give a piece of software your card, you trust
it twice — that it spends on the right things, and that it tells you the truth
about what it spent. Removing the second half of that trust is the whole point
of this project."

---

## Slide 3 — Solution

**Title**
```
A human sets the rule. The chain holds the ceiling.
Every decision becomes evidence.
```

**The flow — this is the slide's main visual**
```
POLICY  →  REQUEST  →  ALLOW / DENY  →  EVIDENCE  →  SETTLEMENT  →  VERIFY
```

Render it as the console's own lifecycle rail: indigo connectors, emerald
ticks, one short line under each stage.

```
POLICY        A person sets how much, on what, until when
REQUEST       An authorized client signs each request
ALLOW/DENY    Checked before any money moves
EVIDENCE      Each decision hashed into a chain
SETTLEMENT    One Solana transaction closes the session
VERIFY        Anyone can recompute the record
```

**Speaker notes (~25s):** "A person funds an escrow on Solana and sets the
envelope. The client spends inside it. Every request is admitted or refused
*before* the provider is contacted, and every decision — including the
refusals — is hashed into a chain whose root ends up on chain."

---

## Slide 4 — Competitive advantage

**Title**
```
Most of this space proves an agent paid.
AgentPay proves an agent was stopped.
```

**Comparison table** (from `AGENTPAY_COMPETITIVE_ANALYSIS.md`)

| | Enforced before spend | Ceiling on chain | Refusals as evidence | Third-party verifiable |
|---|---|---|---|---|
| **AgentPay** | ✅ | ✅ | ✅ | ✅ |
| x402 (protocol) | out of scope | — | — | — |
| Skyfire (identity) | identity-led | — | not described | not described |
| Crossmint (wallet) | spending controls | — | not described | not described |
| Sapiom (cost control) | ✅ | — | operator-held traces | not described |
| Card / API rails | provider-side | — | ❌ | ❌ |

**Footnote on the slide, in small type — keep it:**
```
"Not described" = not confirmed from public documentation, not a claim the
capability is absent. x402 and Skyfire are complements, not substitutes.
```

**Speaker notes (~30s):** "Most of these are different layers, and several are
complements — x402 defines how a service asks to be paid, not whether a request
is permitted. Where I'll draw the line is the last column. A trace is a record
the operator keeps. Our evidence root is on Solana, so you can check it without
trusting us." *If challenged, concede readily: these competitors are more
mature, and several rows are unknowns rather than gaps.*

---

## Slide 5 — Product (real screenshots only)

**Title**
```
Live on devnet. Verifiable in your own browser.
```

**Five screenshots from `https://13-200-171-103.sslip.io`:**

1. **Overview** — the lifecycle rail with 9 of 9 stages lit, plus the money band.
   Caption: `Escrow 15.000000 = Spent 0.007500 + Remaining 14.992500 — real devnet data`
2. **Agents / policy** — the spending envelope.
   Caption: `A human sets the envelope. The client cannot widen it.`
3. **Activity feed** — showing an allowed request and an amber refusal.
   Caption: `Refusals are recorded with the same weight as approvals.`
4. **Verifier — VERIFIED** — the three roots matching.
   Caption: `Browser root = Gateway root = On-chain root`
5. **Session detail / settlement** — the on-chain record.
   Caption: `One settlement transaction closes a session of many claims.`

**Do not** put source code on this slide. **Do not** use a mock screen.

**Speaker notes (~20s):** "This is the deployed console, not a mockup. The
fourth screen is the one that matters — three independent views of the same
root, and the third one is read off Solana."

---

## Slide 6 — Market

**Title**
```
Market: controlled spend by automated services
```

**Put the *method* on the slide, not a single large number.**

```
TAM   Machine-initiated service spend requiring an enforced limit
SAM   Teams running automated clients against paid APIs, on crypto rails
SOM   Design-partner pilots reachable in 12 months
```

**Required on the slide:**
```
Preliminary bottom-up estimate. Assumptions and workings in
AGENTPAY_MARKET_SIZING.md — not audited market research.
```

See `AGENTPAY_MARKET_SIZING.md` for the model. **Do not invent a precise
headline figure.** A judge who asks "where did that number come from" and gets
a confident answer about *method* scores better than one who gets a big number
with no provenance.

**Speaker notes (~25s):** "I'd rather show you how I'd size this than quote a
number I can't defend. The honest version is bottom-up: how many teams run
automated clients against paid APIs, what they spend, and what fraction needs
an enforced limit rather than a dashboard."

---

## Slide 7 — Team ⚠️ **BLOCKED — NEEDS YOUR INPUT**

**Do not fill this in from guesswork.** Per slide, for each real contributor:

```
[Name]
[Actual role — e.g. protocol engineer, full-stack, DevOps]
[Relevant skills]
[What they actually built in this repository]
```

**What I can see from the repository:** the GitHub remote is
`github.com/tahaiqbal8/agentpay`; local commits in this working session are
authored by `arbaz-6007`. **I will not infer a team from that.**

If AgentPay is a solo project, say so plainly — "built solo over N weeks,
program through to deployment" is a credible, checkable claim and reads better
than a padded roster. Do not list mentors, friends or family as engineers.

**Speaker notes:** keep to 15 seconds. Who built it, and one line of evidence
that they could.

---

## Slide 8 — Go-to-market

**Title**
```
Developers first. The verifier is the pitch.
```

**Already done — say only these**
```
Public repository and a live, deployed verifier anyone can open
End-to-end devnet demo reproducible with one command
```

**Next — label as plans**
```
Solana developer communities and Superteam Pakistan
Design-partner conversations with teams running automated clients
SDK + docs so a first integration is under an hour
Open-source integration with an existing payment-request standard (x402)
```

**Measurable milestones**
```
10 design-partner conversations
3 developer integrations against the SDK
1 pilot running continuously for 30 days
```

**Speaker notes (~25s):** "The product is its own best demo, because anybody can
verify a session without an account. That's the wedge: the verifier is public,
so the first interaction with AgentPay doesn't need a sales call."

⚠️ **Do not claim users, customers, partnerships or traction.** None exist.

---

## Slide 9 — Funding

**Title**
```
What funding buys: an audit, a pilot, and mainnet readiness.
```

**Ask — confirmed**
```
$15,000  (6 months)
```
Sized to the hackathon's own awards: the next-20 pool pays $15,000 per project
and the Solana track pays $10,000. Asking for roughly one award is coherent
against a devnet prototype; asking for half a million is not — and a judge will
read the restraint as a sign you know what stage you are at.

**Allocation — totals 100%**

| Category | % | of $15,000 | What it buys |
|---|---|---|---|
| Independent security review | 40% | $6,000 | External review of the program and the claim/evidence path |
| Engineering — mainnet readiness | 25% | $3,750 | Key management, monitoring, incident response |
| Developer experience | 15% | $2,250 | SDK hardening, docs, a one-hour first integration |
| Infrastructure | 10% | $1,500 | Hosting, CI, a durable devnet/mainnet environment |
| Pilot support | 10% | $1,500 | Design-partner onboarding and discovery |
| **Total** | **100%** | **$15,000** | |

**Milestones the money finances**
```
Security review complete and findings addressed
One design partner running a 30-day pilot
Mainnet readiness review signed off
```

**Speaker notes (~25s):** "The largest line is an external audit, and that's
deliberate. This has never been audited, it's devnet-only, and the honest next
step for anything that touches money is someone else trying to break it."

---

## Slide 10 — Stage and milestones

**Title**
```
Stage: deployed devnet demo. Not audited. Not mainnet.
```

**Done** *(each one verifiable)*
```
Solana program v2 live on devnet — ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m
End-to-end run, 25 checks, 0 failures — 11 Oct 2026
Evidence root committed on chain and independently recomputed
Policy refusal and replay refusal both recorded as evidence
150 gateway tests + SDK suite passing
Public console and verifier deployed over HTTPS
```

**Next**
```
Independent security review
Mainnet readiness review
Design-partner pilots
Third-party SDK integrations
```

**Speaker notes (~20s):** "I want to be exact about the stage. This is a
deployed devnet demo with an end-to-end run you can reproduce. It has not been
audited and it is not on mainnet, and I'm not going to describe it as either."

---

## Slide 11 — Close

**Title**
```
Spending you can bound. Decisions you can prove.
```

**Closing line**
```
Anyone can prove an agent paid.
AgentPay proves an agent was stopped.
```

**Links**
```
Live        https://13-200-171-103.sslip.io
Judge view  https://13-200-171-103.sslip.io/?judge=1
Code        https://github.com/tahaiqbal8/agentpay
Contact     [NEEDS CONFIRMATION]
```

**Layout:** closing line large and centred; links small, monospace, beneath.

---

## Build checklist

- [ ] Capture the 5 screenshots from the live deployment at 1440×900, dark
- [ ] Logo file (the console mark is an "A" tile — may need exporting standalone)
- [ ] Fill Slide 7 with real contributors
- [ ] Confirm the funding figure on Slide 9
- [ ] Contact link on Slide 11
- [ ] Export to PDF and open it to confirm it renders
