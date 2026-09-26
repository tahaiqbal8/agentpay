# Judge Mode — Specification

**Status:** partially implemented 2026-09-26. See "Implementation status" at
the end for exactly which parts shipped and which did not.

## Purpose

Make the deployed URL safe and legible to hand to someone who has never seen
AgentPay, has thirty seconds, and will click things.

Judge Mode is a **presentation mode over real data**. It is not a demo mode, not
a sandbox, and not a mock. It changes what is *shown* and what is *reachable*.
It never changes what is *true*.

---

## The three hard rules

1. **Real backend data only.** Every number rendered in Judge Mode comes from
   the same gateway endpoints the normal console uses. If an endpoint returns
   nothing, Judge Mode shows an empty state — it never substitutes a placeholder,
   a sample, or a remembered value.
2. **Nothing that mutates.** No page reachable in Judge Mode may call a POST,
   PUT, or DELETE that changes state. This rules out `/agents`, `/registry`,
   `/approvals`, and `/settle`.
3. **No unearned claims.** The existing `SecurityControls` three-state design
   (`on` / `off` / **`unknown`**) is the correct precedent and must be preserved.
   A control whose state cannot be determined shows `unknown`, never a tick.

---

## Activation

Query parameter: `?judge=1`, persisted to `sessionStorage` so navigation keeps
it. A visible chip in the header reads **"Judge view — read only"** with a
"Show full console" link next to it.

Rationale for a query parameter rather than a build flag or a role:
- It requires no authentication system (§3 of `UX_ARCHITECTURE_REVIEW.md`).
- It is honest: nothing is hidden *from* anyone; the full console is one click
  away and the chip says so.
- It leaves the normal console untouched for the operator.

**Judge Mode is not a security boundary and must never be described as one.**
The security boundary is the gateway's admin token, which lives server-side.
Judge Mode is a curtain, not a lock. Anyone can remove `?judge=1`.

---

## What Judge Mode shows

Three routes, in this order:

| Order | Route | Why |
|---|---|---|
| 1 | `/` Overview — restructured | Answers "what is this" |
| 2 | `/session/[pubkey]` | One complete story, end to end |
| 3 | `/verifier` | The payoff: independent recomputation |

Nav collapses from seven items in three groups to **three items in no groups**.

### Hidden in Judge Mode

`/agents`, `/registry`, `/approvals`, `/settle`, `/playground`.

`/settle` is the important one: it moves real devnet SOL. `/playground` is
hidden not because it is dishonest — it is scrupulously honest — but because a
local simulation sitting one nav item away from a cryptographic verifier is a
distinction a thirty-second visitor will not make.

---

## The Overview page in Judge Mode

Current landing page: 8 blocks, 28 interactive controls on the first screen,
2.21–3.32 screens of scrolling depending on viewport.

Judge Mode target: **one screen, four blocks, under 6 interactive controls.**

### Block 1 — The claim (new copy, existing data)

The sentence the product is currently missing, rendered large:

> **An agent tried to spend more than it was allowed. The system refused — and
> it can prove that to someone who doesn't trust it.**

Directly beneath, three facts read from the live backend:

```
{n} decisions enforced     {m} refused     evidence root anchored on Solana
```

If the backend returns zero decisions, this block renders:

> *No decisions recorded yet. Run `npm run demo:v2` to produce some.*

It does **not** invent a number. This is the rule that makes Judge Mode
defensible.

### Block 2 — The lifecycle, with its sentences visible

The existing `PaymentLifecycle` component, with one change: the nine `detail`
strings render **under each label** instead of living in a `title` tooltip.

```
Human         Agent            Policy          Escrow           Claim
A person      Identity bound   Spending        Funds locked     Agent signs a
creates the   to a keypair     envelope set    on Solana        cumulative claim
agent

Enforcement      Evidence         Settlement        Verified
Gateway          Decision hashed  Escrow moves      Root anchored
verifies and     into a chain     to the provider   and recomputed
decides
```

Stages remain lit from real data — the existing `lifecycleReached` derivation is
correct and must not be replaced by a timer or a constant.

On viewports under ~800px the strip currently hides 5 of 9 stages behind a
horizontal scroll. In Judge Mode it must wrap to a vertical list instead, so the
payoff stages (Settlement, Verified) are never the invisible ones.

### Block 3 — One session, named

Not a sortable table. The single most recent session with evidence, rendered as
a sentence plus a link:

> Session `Eb62…AucjA` — spent 0.0045 of 3 USDC across 9 decisions, 3 refused.
> Evidence root anchored. **Verify this session →**

The link goes to `/verifier` pre-loaded with that session, so the judge reaches
the payoff in one click rather than by pasting a pubkey.

### Block 4 — Security controls

The existing component, unchanged. It is already the best-behaved element on the
page: it reports what the gateway *reports*, not what it *intends*, and it has an
`unknown` state. Keep it exactly as-is.

### Removed in Judge Mode

- The four-card KPI row (three of four currently read zero)
- The sortable sessions table, its search field, and its segmented filter
- The recent-decisions feed and its filter
- The quick-actions tile grid (all four lead to hidden pages)
- The stranded-escrow alert (operator concern, not a judge concern)

That removal is what takes 28 controls down to under 6.

---

## The Verifier in Judge Mode

Keep the page. Change two things:

1. **Accept `?session=` and auto-run** so arriving from Block 3 shows a result
   without the judge having to do anything.
2. **Lead with the verdict**, then the mechanism. Currently the page explains
   what it is about to do and then does it. A judge needs `VERIFIED ✓` first and
   the four-step explanation second.

Everything else about this page is right, including its willingness to say
"DOES NOT VERIFY" in red.

**Do not remove the HTTPS requirement warning.** Over plain HTTP, WebCrypto is
unavailable and the page reports a failure that is not real. That warning is
load-bearing.

---

## Terminology in Judge Mode

Tier-3 vocabulary is suppressed on the Overview page only (see §6 of
`UX_ARCHITECTURE_REVIEW.md`):

| Normal console | Judge Mode Overview |
|---|---|
| high-water mark | spent so far |
| stranded escrow | funds still locked |
| cumulative claim | running total |
| Merkle root / evidence root | *(kept — but always as "evidence root, anchored on Solana")* |
| PDA, Ed25519, nonce, monotonic, sequence_id | *(not shown on Overview; unchanged on Verifier and session detail)* |

The Verifier keeps its full precision. A judge who has reached that page has
earned the vocabulary, and vagueness there would undercut the point.

---

## Explicit non-goals

- **No login.** See §3 of `UX_ARCHITECTURE_REVIEW.md`.
- **No guided tour, modal, coach-mark, or wizard.** The complaint is that too
  much is happening. A tour is one more thing happening.
- **No seeded or demo data.** If the system is empty, Judge Mode says so.
- **No changes to the gateway, the protocol, the evidence format, or the
  programs.** Judge Mode is entirely a `web/` concern.
- **No new dependencies.**

---

## Acceptance criteria

- [ ] `?judge=1` renders Overview in **one viewport at 1280×720** with no scroll
      to reach the verify link
- [ ] Fewer than 6 interactive controls on that screen
- [ ] No route reachable in Judge Mode issues a state-changing request
- [ ] With an empty database, every block renders an honest empty state and no
      fabricated number
- [ ] All nine lifecycle sentences are readable without hovering, at 1280×720
      **and** at 375×812
- [ ] The "Show full console" link is visible and works
- [ ] Removing `?judge=1` returns the operator console exactly as it is today

---

## Implementation status (2026-09-26)

Implemented in `web/` only. No gateway, API, protocol, schema or auth change;
no new endpoint was added for this mode.

### Shipped

- `?judge=1`, persisted to `sessionStorage`, with `?judge=0` to clear
  (`web/src/lib/judge-mode.ts`)
- Header chip **"Judge view · read only"** and a working **"Show full console"**
  link
- Nav reduced from 8 entries to 3 — Overview, Sessions, Verifier. Every entry
  that reaches a state-changing surface is hidden, including `/settle`, which
  spends real devnet SOL
- Overview sheds its secondary controls: the sessions filter chips, the session
  search box, the three sortable column headers, the decisions allow/deny
  filter, and the four quick-action tiles
- First-screen interactive controls: **28 → 14**, of which 3 are nav, 1 is the
  exit link, 1 is the primary CTA, and the remainder are links on real session
  rows
- Every figure still comes from the same gateway endpoints the operator console
  uses. With no data, the page says so — there is no seeded judge fixture

### Not shipped

- **The restructured single-screen Overview** (Blocks 1–4, one screen at
  1280×720). The existing block order was kept and thinned instead. Rebuilding
  the landing page around a new block model is a redesign, and this was a
  simplification pass. Overview is 2.97 screens at 1280×720 in operator view.
- **`/verifier?session=` auto-run.** The Verifier does not read a session from
  the query string, so the CTA links to the page rather than to a pre-loaded
  result. Adding it is a small frontend change and remains worth doing.
- **The "one session, named" sentence block** replacing the sessions table.
- **Verifier verdict-first reordering.**

### Correction to this spec

The spec above lists `/session/[pubkey]` as one of Judge Mode's three routes
and omits Settlement. What shipped reaches session detail through links on the
Overview table rather than through a nav entry, and hides `/settle` entirely.
The practical effect matches the intent: three nav destinations, session detail
one click away, and no reachable surface that can change state.
