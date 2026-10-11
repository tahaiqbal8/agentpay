# AgentPay — Pitch Video Script

**Target: 3:30–4:00.** Deck presented over Zoom or Loom, camera on if possible.
This is a **separate deliverable** from the technical demo video
(`docs/VIDEO_DEMO_SCRIPT.md`). Do not submit one for the other unless the
portal explicitly allows it.

Speak it; don't read it. Each slide's text below is a spoken paragraph, not
bullets to recite.

---

### Slide 1 — Introduction · 0:00–0:15

> "Hi — I'm [NAME], and this is AgentPay: policy-bounded payments for
> automated services, with proof of every refusal anchored on Solana.
>
> In the next three minutes I want to show you a spending limit that is
> actually enforced, and a receipt you can check without trusting me."

---

### Slide 2 — Problem · 0:15–0:50

> "Software is being given spending authority faster than anyone has built the
> controls for it.
>
> There are three problems. First, a limit you *ask for* is not a limit — card
> and API rails enforce inside the provider's own database, so you end up
> auditing the spender's own books. Second, per-call settlement doesn't fit
> per-call prices; a sub-cent API call can't carry a transaction fee. And
> third — the one nobody talks about — **nothing records the refusals.** Every
> system proves what was paid. None of them proves what was stopped.
>
> That third one is the gap I built into."

---

### Slide 3 — Solution · 0:50–1:25

> "AgentPay sits between the client and the service as an enforcement point
> with a memory.
>
> A human sets the policy — how much, on what, until when. The escrow on
> Solana is the hard ceiling: the program will not release more than was
> deposited, whatever my gateway says. Every request is admitted or refused
> *before* the provider is contacted. Every decision is hashed into a chain.
> One settlement transaction closes the session and writes the root of that
> chain on chain.
>
> Policy, request, allow or deny, evidence, settlement, verify. Six steps, and
> the last one is the one that matters."

---

### Slide 4 — Competitive advantage · 1:25–2:00

> "Let me be careful here, because several of these are complements rather
> than competitors. x402 is a protocol for how a service *asks* to be paid —
> it doesn't decide whether a request is permitted. Skyfire is identity.
> Crossmint is wallets.
>
> The closest overlap is cost-control tooling, which does track and cap agent
> spend. The difference is the last column: a trace is a record the operator
> keeps. Our evidence root is on Solana, so a third party can recompute it
> without trusting the operator at all.
>
> And where the table says 'not described', that means I couldn't confirm it
> from their public docs — not that it's missing. I'd rather tell you that than
> show you a row of crosses I can't defend."

---

### Slide 5 — Product · 2:00–2:30

> "This is the deployed console — not a mockup. Live on devnet, over HTTPS.
>
> Here's the lifecycle, lit from real data. Here's the money line: escrow,
> spent, remaining — it reads as an equation because it is one. Here's the
> activity feed, and notice the amber rows: those are refusals, recorded with
> the same weight as the approvals.
>
> And this is the verifier. Browser root, gateway root, on-chain root — three
> independent views, all matching. You can open that yourself right now, no
> account needed."

---

### Slide 6 — Market · 2:30–2:55

> "On market size, I'll show you my method rather than a number I can't defend.
>
> This isn't 'the AI market'. It's organisations running automated clients
> against paid services, where the owner needs the limit *enforced* and the
> record checkable by someone outside. That second qualifier is the real
> boundary — it's where money crosses a trust line.
>
> Bottom-up, with four assumptions written down, that's roughly a three billion
> dollar pool of controlled spend, and a serviceable slice in the low hundreds
> of millions. The assumption I'm least sure of is what share of spend actually
> crosses a trust boundary — and that's the first thing I'd test with a design
> partner."

---

### Slide 7 — Team · 2:55–3:10 ⚠️ **NEEDS YOUR CONTENT**

> "[Who built this, what each person actually did, and one line of evidence
> that they could.]"

Keep it to fifteen seconds. If it is a solo build, say so — it is credible and
checkable.

---

### Slide 8 — Go-to-market · 3:10–3:30

> "Developers first, and the verifier *is* the pitch — because anyone can
> verify a session without an account, the first interaction with AgentPay
> doesn't need a sales call.
>
> What exists today: a public repo and a live verifier. What's next: Solana
> developer communities, design-partner conversations with teams running
> automated clients, and an SDK where a first integration takes under an hour.
>
> I'm measuring three things: ten design-partner conversations, three
> integrations, and one pilot running for thirty days. No users today — I'm not
> going to claim traction I don't have."

---

### Slide 9 — Funding · 3:30–3:50

> "I'm asking for fifteen thousand dollars over six months.
>
> Forty percent of that is an independent security review, and that's the
> largest line deliberately. This has never been audited and it is devnet-only.
> For anything that touches money, the honest next step is paying someone else
> to try to break it.
>
> The rest: mainnet readiness, developer experience, infrastructure, and pilot
> support. It buys a completed audit, one design partner running for thirty
> days, and a mainnet readiness review."

---

### Slide 10 — Stage · 3:50–4:05

> "To be exact about the stage: this is a deployed devnet demo. There's an
> end-to-end run you can reproduce with one command — twenty-five checks, zero
> failures, as of today. It has not been audited, and it is not on mainnet. I'm
> not going to describe it as either."

---

### Slide 11 — Close · 4:05–4:20

> "Spending you can bound. Decisions you can prove.
>
> Anyone can prove an agent paid. AgentPay proves an agent was stopped — and
> anchors that proof on Solana.
>
> The console and the code are both public. Thank you."

---

## Recording checklist

- [ ] Microphone tested — listen back to 15 seconds before committing
- [ ] Camera tested, light on your face, plain background
- [ ] Notifications off; close Slack, mail, anything that can pop
- [ ] Deck exported to PDF and open full-screen
- [ ] Screen share set to the deck window, not the whole desktop
- [ ] One full rehearsal out loud, timed
- [ ] Record
- [ ] Watch it back: is the audio intelligible? Is small text legible at 1080p?
- [ ] Upload, set link sharing to **anyone with the link**
- [ ] Open the link in a private window to confirm a stranger can watch it

## Delivery notes

- Under-run rather than over-run. A tight 3:30 beats a rambling 5:00.
- Slow down on Slides 3 and 5 — those carry the argument.
- You will be tempted to hurry past Slide 7 and Slide 10. Don't: naming the
  team honestly and naming the stage honestly are both credibility, not
  weakness.
- If you misspeak, stop and retake the slide. Don't apologise on camera.
