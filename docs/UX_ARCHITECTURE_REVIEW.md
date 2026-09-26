# AgentPay — UX and Architecture Communication Review

**Date:** 2026-09-26
**Scope:** review only. No production code was changed to produce this document.
**Trigger:** a senior reviewer said *"Too many things are happening, and looking at the UI I cannot immediately understand what the system does."*

Every number below was measured against the live deployment at
`https://13-200-171-103.sslip.io` or read out of the source, not estimated.

---

## 0. The verdict in one paragraph

The reviewer is right, but the usual diagnosis is wrong. The problem is **not**
that AgentPay fails to explain itself — the explanation exists, it is accurate,
and it is well written. The problem is that the explanation is **outranked**.
On the landing page, one paragraph of explanation competes with eight blocks of
operator telemetry and 28 interactive controls, and the only element that is
genuinely explanatory — the lifecycle strip — has had its explanatory text
removed from the screen and hidden in a hover tooltip. What reaches the eye is
nine abstract nouns and a row of zeros.

**The fix is subtraction and promotion, not addition.** Nothing needs to be
built. The story is already in the repository; it is being told by the CLI demo
and not by the UI.

---

## 1. Does the implementation match the stated conceptual flow?

The claimed flow is:

> Human Policy → Authorized Software Client → Signed Claim → Gateway Enforcement
> → Provider → Evidence → Solana Settlement → Independent Verification

**Yes. This is the one thing that is not a problem.** The canonical demo
(`npm run demo:v2`, `tests/e2e-v2-devnet.ts`) walks fourteen steps that map onto
that flow without a gap:

| # | Demo step | Flow stage |
|---|---|---|
| 1 | the gateway says which program and which authority it uses | — (provenance) |
| 2 | a human creates an agent and binds its wallet | Human → Client |
| 3 | the human sets the spending envelope | Human Policy |
| 4 | funding: a test mint, an escrow, and the agent's wallet | — (setup) |
| 5 | the agent opens an escrow, binding AgentPay as settlement authority | Escrow |
| 6 | the gateway reconciles the escrow against the chain | Escrow |
| 7 | the agent discovers what is on offer, and plans | Client |
| 8 | the agent buys, signing a cumulative claim each time | Signed Claim |
| 9 | enforcement: the gateway refuses what the human did not allow | Gateway Enforcement |
| 10 | evidence: every decision, refusals included | Evidence |
| 11 | settlement — signed by AgentPay's authority, NOT a provider key | Solana Settlement |
| 12 | the root the program stored, checked independently | Independent Verification |
| 13 | a refusal is provable to somebody with no account | Independent Verification |
| 14 | what remains is still the agent's | Settlement |

**The finding is uncomfortable: the CLI tells the story better than the UI
does.** Step 9 ("the gateway refuses what the human did not allow") and step 13
("a refusal is provable to somebody with no account") are the two sentences that
make AgentPay different from a payments dashboard. Neither appears on the
landing page.

### The one real mismatch

The UI's nine lifecycle stages are honest, but the nav does not follow them. A
visitor is offered seven nav items in three groups (Operate / Control / Verify)
whose order has no relationship to the order things actually happen in. The
sequence exists in one component and nowhere else in the navigation.

---

## 2. Density: what the first screen actually costs

Measured on the live deployment:

| Viewport | Screens of scrolling | Lifecycle strip |
|---|---|---|
| 1440 × 900 | **2.21** | fits |
| 1280 × 720 (projector) | **2.78** | fits |
| 375 × 812 (phone) | **3.32** | clips — **5 of 9 stages off-screen** |

- **28 interactive controls** are visible on the first screen; **54** on the page.
- The page has **8 distinct content blocks** but only **3 `h2`-level headings**
  and 4 `h3` — so it cannot be skimmed by structure.
- **10 specialist terms** appear on the landing page alone: `evidence` (29),
  `escrow` (29), `stranded` (12), `cumulative` (11), `settlement` (8),
  `nonce` (2), `high-water` (2), `Merkle` (2), `Ed25519` (2), `PDA` (1).

A reviewer giving the page thirty seconds sees roughly one third of it, meets
`PDA` and `Merkle` before learning what the product is for, and is offered
28 things to click.

### 2a. The lifecycle strip is the biggest single miss

`web/src/components/lifecycle.tsx:21-31` defines nine stages, each with a
plain-English `detail`:

```
Human       → "A person creates the agent"
Agent       → "Identity bound to a keypair"
Policy      → "Spending envelope set"
Escrow      → "Funds locked on Solana"
Claim       → "Agent signs a cumulative claim"
Enforcement → "Gateway verifies and decides"
Evidence    → "Decision hashed into a chain"
Settlement  → "Escrow moves to the provider"
Verified    → "Root anchored and recomputed"
```

Those nine sentences *are* the thirty-second explanation the reviewer asked for.

**They never render.** `detail` is passed only as `title={stage.detail}`
(`lifecycle.tsx:90`) — a native browser tooltip. The DOM confirms it: the nine
labels read exactly `Human, Agent, Policy, Escrow, Claim, Enforcement, Evidence,
Settlement, Verified`. Nine nouns, no verbs. A reader learns the *sequence* and
not the *meaning*, and on a phone learns only four ninths of the sequence.

This is the highest-leverage change in the entire review, and it is a rendering
change to one component.

### 2b. The KPI row promotes the wrong four numbers

The four stat cards sit directly under the hero — the most prominent position on
the page after the headline. On the live deployment they currently read:

```
ACTIVE SESSIONS  0     none live right now · 3 settled, 0 expired
ESCROWED         0     nothing is currently accepting claims
CLAIMED CUMULATIVE  0.0045   across all sessions
REFUSED          33%   3 of last 9 — enforcement, not errors
```

The numbers are real and the empty-state copy is careful. But the effect of
promoting them is that **the second thing a judge reads about AgentPay is that
nothing is happening.** Three zeros and a four-decimal fraction.

The one genuinely compelling number is buried in fourth place: **33% refused —
"enforcement, not errors."** That is the product's whole argument, sitting in
the least-read card, phrased as a footnote.

---

## 3. Should the console have a login?

**No. And the reason is architectural, not preference.**

The auth boundary was measured directly against the gateway:

| Endpoint | Without a token |
|---|---|
| `/health` | 200 — public |
| `/v1/catalogue` | 200 — public |
| `/v1/session/{s}/evidence` | **200 — public, deliberately** |
| `/v1/decisions/recent` | 401 |
| `/v1/sessions` | 401 |
| `/v1/agents` | 401 |
| `/v1/providers` | 401 |
| `/v1/approvals` | 401 |

This shape is correct and it is the product's thesis expressed as an access
policy: **the verification surface is public; the control surface is
authenticated.** Anyone can audit; only the operator can act. The admin token
lives server-side in the Next proxy and never reaches the browser
(`web/src/app/api/gw/[...path]/route.ts:20` carries a comment explaining the
deliberate absence of a `NEXT_PUBLIC_` prefix), and the gateway is not
browser-reachable at all — port 8080 is closed and nginx proxies only the
console.

Adding a login would place a **second, weaker authentication system in front of
a boundary that is already authenticated**, and would invite a judge to probe
it. A hand-rolled demo login is a liability; the token is not.

### What to say instead of what to build

There is a real gap, and it should be stated rather than papered over: the
console is a single trusted operator surface with **no per-user identity**, so
anyone who reaches the URL acts as the operator. The honest framing:

> The console is an operator tool. The security boundary is the gateway's
> token, which the console holds server-side and never ships to the browser.
> Per-operator identity is an SSO integration, not a protocol change — the
> enforcement and evidence guarantees do not depend on who is logged in.

That sentence belongs in the judge document. A login screen does not belong in
the product.

---

## 4. Page-by-page classification

Derived from which API functions each page actually calls.

| Route | Writes? | Classification | Reasoning |
|---|---|---|---|
| `/` Overview | read-only | **PRIMARY DEMO** | The only page that explains. Needs restructuring, not removal. |
| `/verifier` | read-only¹ | **PRIMARY DEMO** | The payoff. Independent recomputation in the browser. |
| `/session/[pubkey]` | read-only | **PRIMARY DEMO** | Where a single story can be told end to end. |
| `/agents` | `createAgent`, `authorizeAgent`, `setAgentStatus` | **ADMIN** | Setup, not narrative. |
| `/approvals` | `decideApproval` | **SECONDARY** | Good story ("a human decided"), but only with seeded data. |
| `/registry` | `registerProvider`, `deleteProvider`, `plan` | **ADMIN** | Catalogue maintenance. |
| `/settle` | `settle`, `reconcile` | **ADMIN — handle with care** | **Moves real devnet SOL.** Never leave this open during a live demo. |
| `/playground` | read-only | **SHOULD BE RELABELLED** | See below. |

¹ `/verifier` issues a POST to `/v1/evidence/proof`, but it is a read: it
computes a proof, it does not mutate.

### 4a. `/playground` is filed in the wrong group

The page is honest about itself — `playground/page.tsx:18-27` states plainly
that the browser holds no agent key, cannot produce a signature the gateway
would accept, and that the verdict is a local projection of the Rust rules. The
in-page disclaimer at line ~275 is explicitly commented as *"the most important
sentence on the page."* That discipline is right and should be kept.

But the nav files it under **Verify**, next to the real Verifier. A local
simulation placed beside a cryptographic verifier invites exactly the confusion
the disclaimer works to prevent. It belongs under a **Learn** or **Explore**
group, or it should be hidden in Judge Mode.

### 4b. Four of seven nav pages can mutate state

Including one that spends devnet SOL. For a judge who is handed the URL and left
to click, that is unnecessary risk with no narrative upside.

---

## 5. Dead surface

`api.verifyClaim` (`web/src/lib/api.ts:302`) has **no callers**. It posts to
`/v1/claim/verify`. Either wire it into the playground — it would let that page
show a *real* gateway verdict on the parts that need no signature — or delete
it. Right now it is an unused client for a live endpoint.

---

## 6. Terminology audit

Across the UI, ranked by occurrence: `agent` (334), `session` (286),
`settle` (157), `root` (136), `evidence` (100), `provider` (94), `claim` (83),
`cumulative` (59), `escrow` (56), `policy` (55), `approval` (52),
`deposit` (49), `nonce` (36), `merkle` (44 across both casings),
`catalogue` (22), `stranded` (12), `sequence_id` (11), `monotonic` (8),
`high-water` (6), `Ed25519` (5), `PDA` (3).

The vocabulary is **consistent** — the same word means the same thing
everywhere, which is more than most projects manage. The problem is
**unstaged**: tier-3 protocol vocabulary (`PDA`, `Merkle`, `Ed25519`,
`high-water`, `monotonic`, `nonce`) appears on the landing page, before tier-1
vocabulary has been established.

Proposed staging:

| Tier | Terms | Where they may appear |
|---|---|---|
| 1 — anyone | human, agent, policy, spend, refuse, proof, funds | Landing page, hero, lifecycle |
| 2 — informed reader | escrow, claim, evidence, settlement, provider | Landing page below the fold, detail pages |
| 3 — protocol | PDA, Merkle root, Ed25519, high-water mark, nonce, monotonic, sequence_id | Verifier, session detail, docs only |

Two specific renames worth making:

- **"high-water mark"** → *"spent so far (of allowance)"* in table headers.
  Keep the precise term on the session detail page where it is explained.
- **"stranded escrow"** → *"funds still locked"*. `stranded` appears 12 times on
  the landing page and reads as a malfunction; it is a normal, recoverable state.

---

## 7. Recommendations, ranked by leverage

| # | Change | Effort | Effect |
|---|---|---|---|
| 1 | **Render the nine lifecycle `detail` strings** instead of hiding them in `title` | one component | Turns nine nouns into a nine-sentence explanation. Largest single win. |
| 2 | **Add a Judge Mode** that hides admin pages and collapses telemetry | see `JUDGE_MODE_SPEC.md` | Makes the URL safe to hand over. |
| 3 | **Promote "33% refused — enforcement, not errors"** out of the fourth KPI card | copy + layout | Leads with the argument instead of with zeros. |
| 4 | **Move `/playground` out of the Verify group** | one nav entry | Removes the one genuinely misleading adjacency. |
| 5 | **Reorder nav to follow the lifecycle** | nav config | Navigation becomes the second telling of the story. |
| 6 | **Stage the vocabulary** (§6) | copy only | A newcomer stops meeting `PDA` in the first 30 seconds. |
| 7 | **Fix the mobile lifecycle clip** (5 of 9 stages hidden) | CSS | The payoff stages stop being invisible on a phone. |
| 8 | **Wire or delete `api.verifyClaim`** | small | Removes dead surface. |

None of these touch the backend protocol, add authentication, or integrate
anything. Items 1, 3, 4, 5, 6 are presentation-layer only.

---

## 8. What NOT to do

- **Do not add a login.** §3.
- **Do not add an onboarding tour, modal, or wizard.** The complaint is that too
  much is happening; a tour adds a layer on top of the thing that is already too
  layered. Fix the page, not the page's introduction.
- **Do not fake or seed numbers to make the dashboard look busy.** The current
  empty states are honest and carefully worded. Judge Mode must read real
  backend data or show nothing — see `JUDGE_MODE_SPEC.md`.
- **Do not remove the playground disclaimer.** It is doing exactly its job.
- **Do not simplify by deleting the protocol vocabulary.** Stage it (§6). The
  precision is an asset on the Verifier page; it is a tax on the landing page.

---

## 9. The sentence the product is missing

Everything above is in service of one gap. A visitor can currently read the
landing page and not learn the single fact that makes AgentPay interesting:

> **An agent tried to spend more than it was allowed, and the system said no —
> and it can prove that to someone who does not trust it.**

The data for that sentence is already on the page (33% refused, 3 of the last 9,
evidence hash-chained, root anchored on Solana). It has simply never been
written down in one place, in words a person can read in five seconds.

---

---

## 10. Implementation status (2026-09-26)

A focused simplification pass shipped items 1–7 below. It touched `web/` only —
no gateway, program, SDK, schema, protocol or auth change.

| # from §7 | Change | Shipped |
|---|---|---|
| 1 | Lifecycle `detail` strings rendered instead of hidden in `title` | ✅ |
| 1b | Lifecycle wraps to a vertical stepper below 1280px | ✅ |
| 2 | Judge view (`?judge=1`) | ✅ |
| 3 | Refusal count promoted out of the fourth KPI card | ✅ |
| 4 | Playground moved out of the Verify group | ✅ (to **Advanced**) |
| 5 | Nav reordered to follow the lifecycle | ✅ (Set up → Spend → Prove) |
| 6 | Vocabulary staged (tier-3 terms off the landing page) | ✅ (partial — see below) |
| 7 | Mobile lifecycle clip | ✅ |
| 8 | Wire or delete `api.verifyClaim` | ❌ not done |

### Measured before and after

Landing page, operator (non-judge) view:

| | Before | After |
|---|---|---|
| Lifecycle stages carrying a visible explanation | **0 of 9** | **9 of 9** |
| Stages reachable on a 375px phone | 4 of 9 | **9 of 9** |
| Interactive controls on the first screen (1440×900) | 28 | **18** |
| Interactive controls on the first screen, judge view | — | **14** (3 nav, 1 exit, 1 CTA, rest are session rows) |
| Tier-3 terms on the landing page | 10 | **5** (`PDA` and `Merkle` now only in code comments; `nonce`/`sequence_id` remain as per-row detail in the decisions feed) |

The page is **taller on mobile** — 3.32 → 4.05 screens at 375px — because nine
explanations now occupy space instead of nine tooltips occupying none. That is
the intended trade: the strip's job is to be read.

### Vocabulary: what was and was not changed

Changed on the landing page: the hero paragraph (no longer opens with
"hash-chains … anchors the evidence root"), `High-water mark` → `Spent so far`,
`Signed Ed25519 claims, newest first` → `Every request, allowed or refused —
newest first`, and the Verifier quick-action hint `Merkle proof` → `Check the
evidence`.

Deliberately left alone: `seq … · nonce …` on individual decision rows. It is
per-row detail rather than something a reader must parse to follow the story,
and removing it would delete real information from an operator surface. The
Verifier, Settlement and session-detail pages keep their full precision
unchanged.

### Public versus protected, unchanged

The boundary described in §3 was not touched and remains the architecture:

> **Anyone can inspect and verify; only authorized operators can perform
> control-plane actions.**

Evidence reads stay public; `/v1/sessions`, `/v1/agents`, `/v1/providers`,
`/v1/approvals` and `/v1/decisions/recent` still require the admin token, which
lives server-side in the Next proxy and never reaches the browser. **No login
was added.** Judge view hides control surfaces as a courtesy to a first-time
visitor; it is a curtain, not a lock, and the header says so with a visible
"Show full console" link.

### Motion

All lifecycle motion is defined **inside** `@media (prefers-reduced-motion:
no-preference)` rather than added and then switched off under `reduce`. This is
deliberate: an entrance animation's resting state is `opacity: 0`, so a rule
that merely disables the animation would leave the explanatory content
permanently invisible. Verified against the built stylesheet — every animated
rule sits inside `no-preference`, and no rule sets `opacity` outside it, so with
reduced motion the lifecycle renders complete and still.

Durations are 300–600ms, the stagger is capped at 400ms, nothing loops, and no
animation library was added.

---

## Companion documents

- `VIDEO_DEMO_SCRIPT.md` — the narrative, timed
- `JUDGE_MODE_SPEC.md` — the specification for a safe, legible judge surface
- `UI_INFORMATION_ARCHITECTURE.md` — the proposed page and nav structure
