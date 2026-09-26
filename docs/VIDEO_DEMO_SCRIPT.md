# AgentPay — Video Demo Script

**Target length:** 3:00. A 90-second cut is marked with ✂.
**Rule:** every number spoken on camera is read off a real devnet run. Nothing
is staged, seeded, or mocked. If a step fails on the day, say so and show the
error — a system that proves things cannot be demonstrated with a fake.

**Surfaces used:** the deployed console at `https://13-200-171-103.sslip.io`
and one terminal running `npm run demo:v2`.

---

## The spine

The demo has one job: get the viewer to the sentence *"it refused, and it can
prove it."* Everything before that is setup; everything after is corroboration.

```
Who allowed it  →  What it tried  →  What was refused  →  Why you can believe me
   0:00–0:35         0:35–1:05          1:05–1:45              1:45–2:45
```

---

## 0:00 — 0:20 · The problem (no UI yet)

> "If you give a piece of software your card, you are trusting it twice. Once
> that it spends on the right things, and again that it tells you the truth
> about what it spent.
>
> AgentPay removes the second half of that trust."

**On screen:** title card only. Do not open the console yet — a dashboard on
screen during the framing makes the viewer read instead of listen.

✂ *Keep. Cut to two sentences: "Software that spends your money asks you to
trust it twice — that it spends correctly, and that it reports honestly.
AgentPay removes the second."*

---

## 0:20 — 0:35 · What it is, in one breath

**On screen:** the console landing page, top of the page only.

> "A human funds an escrow on Solana and sets a spending limit. An automated
> client spends inside it. Every single purchase is checked against that limit
> before any money moves — and every decision, including the refusals, is
> hashed into a chain and anchored on-chain."

Point at the lifecycle strip while saying it: Human → Agent → Policy → Escrow →
Claim → Enforcement → Evidence → Settlement → Verified.

> "Nine steps. That is the whole system."

✂ *Keep.*

---

## 0:35 — 1:05 · The human sets the limit

**On screen:** terminal, `npm run demo:v2`, steps 2–3 scrolling.

> "Here a person creates an agent, binds it to a keypair, and sets the envelope.
> This is the only point where a human is involved. The agent cannot widen it."

**On screen:** switch to the console → Agents page → the agent's policy.

> "Three USDC, escrowed on devnet. Whatever happens next, that number is the
> ceiling, and it is enforced by a program on Solana, not by a promise in our
> database."

✂ *Compress to 10 seconds: terminal only, say "a human sets a three-USDC
envelope; the agent cannot widen it."*

---

## 1:05 — 1:45 · The refusal — **this is the moment**

**On screen:** terminal, demo step 8 then step 9.

> "The agent goes shopping. Each purchase is signed as a *cumulative* total —
> not 'charge me thirty cents', but 'my running total is now one dollar twenty'.
> Only the highest total ever reaches the chain, so a replayed message cannot
> double-charge.
>
> And then it tries to overspend."

**Pause on step 9's output.** Let it sit for a beat.

> "Refused. Not an error — enforcement. The gateway checked the claim against
> the human's policy and declined it before any money moved."

**On screen:** console → Overview → the REFUSED stat card.

> "Thirty-three percent of the last nine decisions were refusals. On most
> dashboards that would be a bug report. Here it is the product working."

✂ *Keep all of it. If only one thing survives the cut, it is this block.*

---

## 1:45 — 2:20 · The proof

**On screen:** console → Verifier.

> "Now the part that matters. Every decision — allowed and refused — was hashed
> into a chain, and the root of that chain was written to a Solana account at
> settlement.
>
> This page is not asking the gateway whether it was honest. It fetches the
> evidence, recomputes the hash chain **in your browser**, fetches the root the
> Solana program actually stored, and compares them."

**On screen:** the verification result.

> "They match. Which means the gateway could not have quietly dropped a refusal
> or invented a charge — the root would not reconcile."

Then, briefly:

> "And this works for someone with no account and no access to our control
> plane. Evidence is a public endpoint. The parts that let you *act* need a
> token; the parts that let you *audit* never do."

✂ *Compress to 25 seconds: show the Verifier matching, say "recomputed in your
browser against the root the Solana program stored — and the evidence endpoint
is public, so you don't need our permission to check."*

---

## 2:20 — 2:45 · On-chain corroboration

**On screen:** terminal, demo steps 11–12; then a Solana explorer on the
settlement account.

> "Settlement is signed by AgentPay's own authority — not by a provider key we
> hold. And this is the raw account on devnet. The evidence root is sitting at
> byte offset 72, exactly the value the browser just recomputed."

✂ *Cut entirely. It is corroboration; the Verifier already made the point.*

---

## 2:45 — 3:00 · Close

> "A human sets the limit. Software spends inside it. Every decision is
> enforced before the money moves, recorded so it cannot be edited afterwards,
> and provable to someone who does not trust us.
>
> That is AgentPay."

**On screen:** the lifecycle strip, all nine stages lit.

✂ *Keep the first sentence and the last four words.*

---

## Rules for the recording

1. **Never show `/settle` or `/registry` on camera.** Both mutate state; `/settle`
   moves real devnet SOL. If the run needs settlement, do it in the terminal.
2. **Never show `/playground` in a section about verification.** It is a local
   simulation and the video has no room to explain the distinction. Skip it.
3. **Do a real run before recording** so the numbers on the Overview page are
   fresh. A page reading "0 active sessions" while you narrate a live demo is
   the single most damaging thing that can happen on camera.
4. **Do not zoom past the refusal.** Every instinct will be to hurry through the
   failure. The failure is the demo.
5. **If something breaks, keep it in.** A gateway that refuses a malformed claim
   on camera is better evidence than a clean run.

---

## Pre-flight checklist

```bash
npm run demo:v2
```

- [ ] Demo completes all 14 steps
- [ ] Overview shows a non-zero session count
- [ ] Verifier reports a match on a real session
- [ ] Console loads over **HTTPS** (WebCrypto is unavailable over plain HTTP —
      the Verifier will report "DOES NOT VERIFY" and it will not be true)
- [ ] `/settle` and `/registry` closed in every tab you might switch to
