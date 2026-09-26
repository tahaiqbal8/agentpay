# AgentPay — Proposed Information Architecture

**Status:** §3 (navigation) shipped 2026-09-26, with two deviations recorded in
§3a. The rest of this document remains a proposal.

---

## 1. The principle

The system already has a canonical order — the nine lifecycle stages, which the
fourteen-step demo follows exactly. The navigation does not use it.

**Proposal: make the navigation the second telling of the story.** A visitor who
reads only the sidebar should absorb the flow without clicking anything.

---

## 2. Current structure

```
OPERATE
  Overview      Sessions & live claims
  Agents        Identity & authorization
CONTROL
  Approvals     Human-decided spends
  Registry      Providers & catalogue
VERIFY
  Verifier      Merkle proofs
  Settlement    On-chain settle
  Playground    Claim simulator
```

Three problems:

1. **The groups name activities, not stages.** "Operate / Control / Verify" is
   an operator's mental model. A newcomer has no idea which one contains the
   answer to "what does this do".
2. **Order is unrelated to sequence.** Agents (stage 2) sits above Approvals
   (stage 3) sits above Registry (setup) sits above Verifier (stage 9). The
   actual order is scattered.
3. **`Playground` is under `Verify`.** A local simulation that explicitly cannot
   produce a valid signature is one nav item away from the real cryptographic
   verifier. This is the single most confusing adjacency in the product.

---

## 3. Proposed structure

```
                          ← the story, in order

Overview            What AgentPay does
                    ─────────────────────────────
SET UP
  Agents            Who is allowed to spend
  Policies          How much, on what
  Registry          What is for sale
SPEND
  Sessions          Live escrows and running totals
  Decisions         Every allow and refuse
  Approvals         Spends a human decided
PROVE
  Verifier          Recompute the evidence yourself
  Settlement        What was written to Solana
                    ─────────────────────────────
  Simulator         Try the rules without spending
```

### What changed and why

| Change | Reason |
|---|---|
| Groups renamed **Set up / Spend / Prove** | Verbs in lifecycle order. The sidebar now reads as a sentence. |
| `Overview` pulled out of any group | It answers "what is this", which is not a stage. |
| `Playground` → **`Simulator`**, moved out of Prove, placed last and visually separated | Removes the misleading adjacency. "Simulator" states what it is; "Playground" suggests a sandbox of the real thing. |
| `Decisions` promoted to a nav item | The refusals are the product's argument. They are currently a card on the Overview page with a filter, reachable only by scrolling. |
| `Policies` split from `Agents` | Policy is lifecycle stage 3 and the only place a human's intent is expressed. It deserves a name. |
| `Settlement` moved under Prove | It is evidence, not an operation. (The *act* of settling stays an operator action; see §5.) |

### 3a. What actually shipped

```
Overview            What AgentPay does

SET UP
  Agents            Who may spend
  Approvals         Spends a human decides
  Registry          What is for sale
SPEND
  Sessions          Live escrows & totals        → /#sessions
PROVE
  Verifier          Check the record yourself
  Settlement        What Solana recorded
ADVANCED
  Playground        Try the rules, spend nothing
```

Two deviations from §3, both deliberate:

1. **Playground sits under `Advanced`, not last-under-Prove.** The requirement
   was that it must not read as equivalent to the Verifier. A separate group
   states the difference outright rather than relying on spacing to imply it.
2. **`Decisions` and `Policies` were not split into their own routes, and
   `Playground` keeps its name.** Both would have meant new pages or renamed
   surfaces, which is more than a simplification pass should do. `Decisions`
   remains a card on Overview; `Policies` remains part of Agents.

`Sessions` links to `/#sessions` — an anchor onto Overview's table, not a new
route. It shows as the active row when a specific session is open at
`/session/[pubkey]`, so the two entries never both highlight.

---

## 4. Page responsibilities

Each page answers exactly one question. If it answers two, it is two pages.

| Page | The one question | Audience |
|---|---|---|
| Overview | What is AgentPay? | Everyone, first visit |
| Agents | Who is allowed to spend? | Operator |
| Policies | How much, on what, until when? | Operator |
| Registry | What is for sale? | Operator |
| Sessions | What is being spent right now? | Operator |
| Decisions | What was allowed, and what was refused? | Operator + judge |
| Approvals | What needed a human? | Operator |
| Verifier | Can I check this without trusting you? | Judge, auditor, sceptic |
| Settlement | What is on Solana? | Judge, auditor |
| Simulator | What would the rules do? | Learner |

---

## 5. Read and write, separated

Four of the seven current nav pages mutate state. The proposal keeps the
capability but stops mixing the two modes on one surface:

| Page | Reads | Writes |
|---|---|---|
| Overview, Decisions, Sessions, Verifier, Settlement, Simulator | ✓ | — |
| Agents, Policies, Registry, Approvals | ✓ | ✓ — behind an explicit action |

**Settlement is the case to be careful with.** Viewing what was settled is a
read and belongs under Prove. *Executing* a settlement spends real devnet SOL
and should live behind an explicit operator action on the session detail page,
not as a nav destination that a visitor can wander into.

---

## 6. The Overview page, restructured

Currently 8 blocks, 28 first-screen controls, 2.21–3.32 screens of scroll. The
proposal orders it by **who is asking**:

```
┌─ Screen 1 — for someone who has never heard of this ──────────┐
│                                                                │
│  Agent payments, enforced and provable                         │
│  [the existing two-sentence hero — it is good, keep it]        │
│                                                                │
│  ┌ The lifecycle, WITH its nine sentences rendered ──────────┐ │
│  │  Human → Agent → Policy → Escrow → Claim →                │ │
│  │  Enforcement → Evidence → Settlement → Verified           │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                │
│  "9 decisions enforced · 3 refused · root anchored on Solana"  │
│                              [Verify a session yourself →]     │
└────────────────────────────────────────────────────────────────┘

┌─ Screen 2 — for someone deciding whether to believe it ───────┐
│  Security controls  (existing component, unchanged)            │
│  Recent decisions   (allows and refuses, refuses emphasised)   │
└────────────────────────────────────────────────────────────────┘

┌─ Screen 3 — for the operator ─────────────────────────────────┐
│  KPI cards · Sessions table · Escrow · Stranded-escrow alert   │
└────────────────────────────────────────────────────────────────┘
```

The content is the same. The **order** changes, from "what is happening now"
(operator) to "what is this" (everyone) first.

Two specific moves:

- **The 33% refusal rate leaves the fourth KPI card** and becomes part of the
  headline fact line on screen 1. It is the argument, not a metric.
- **The KPI row moves below the fold.** Three of its four numbers currently read
  zero, and they are the second thing a visitor sees.

---

## 7. Vocabulary staging

Repeated from §6 of `UX_ARCHITECTURE_REVIEW.md` because it is an IA decision,
not a copy decision — it determines which words are allowed on which page.

| Tier | Terms | Allowed on |
|---|---|---|
| 1 | human, agent, policy, spend, refuse, proof, funds, allowance | Anywhere, including Overview screen 1 |
| 2 | escrow, claim, evidence, settlement, provider, session | Overview screens 2–3, all operator pages |
| 3 | PDA, Merkle root, Ed25519, high-water mark, nonce, monotonic, sequence_id, canonical | Verifier, Settlement, session detail, docs |

Currently all three tiers appear on Overview screen 1.

---

## 8. Sequencing

Ordered by leverage per unit of risk. Items 1–3 are presentation-only and
reversible.

| Phase | Work | Touches |
|---|---|---|
| **1** | Render the nine lifecycle sentences; fix the mobile wrap | `components/lifecycle.tsx` |
| **2** | Reorder Overview by audience; promote the refusal fact; demote the KPI row | `app/page.tsx` |
| **3** | Rename and regroup the nav; move `Playground` → `Simulator`, out of Prove | `components/shell.tsx` |
| **4** | Judge Mode per `JUDGE_MODE_SPEC.md` | `web/` only |
| **5** | Split `Policies` out of `Agents`; promote `Decisions` to a page | new routes |
| **6** | Move settlement *execution* off the nav onto session detail | `app/settle`, session detail |
| **7** | Stage the vocabulary (tier-3 terms off Overview) | copy across `web/` |
| **8** | Wire or delete `api.verifyClaim` (`lib/api.ts:302`, no callers) | `lib/api.ts` |

Phases 1–4 address the reviewer's complaint. Phases 5–8 are structural tidying
that can follow at any time.

**Nothing in this document changes the gateway, the protocol, the evidence
format, the on-chain programs, or the authentication model.**
