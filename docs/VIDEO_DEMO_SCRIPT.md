# AgentPay — Technical Demo Video Script

**Target: 3:00.** Written against the UI deployed on 11 Oct 2026 and the
canonical devnet run of the same date. Supersedes the pre-redesign version of
this file.

**Surfaces:** the deployed console at `https://13-200-171-103.sslip.io` and one
terminal running `npm run demo:v2`.

**The one rule:** every number spoken on camera is read off a real devnet run.
If a step fails on the day, say so and show the error. A system whose entire
claim is "you can check this" cannot be demonstrated with a staged result.

---

## The spine

One job: get the viewer to *"it refused, and it can prove it."*

```
Who allowed it → What it tried → What was refused → Why you can believe me
  0:00–0:40        0:40–1:35        1:35–2:10           2:10–3:00
```

---

## 0:00 — 0:20 · The problem

**On screen:** title card only. Do not open the console — a dashboard on screen
during the framing makes the viewer read instead of listen.

> "If you give a piece of software your card, you are trusting it twice. Once
> that it spends on the right things, and again that it tells you the truth
> about what it spent.
>
> AgentPay removes the second half of that trust."

---

## 0:20 — 0:40 · What it is

**On screen:** `https://13-200-171-103.sslip.io` — top of the Overview page.
Point at the lifecycle rail while speaking.

> "A human funds an escrow on Solana and sets the spending rules. An automated
> client spends inside it. Every request is checked against those rules before
> any money moves — and every decision, including the refusals, is hashed into
> a chain and anchored on-chain."

Read the nine stages off the rail: Human, Agent, Policy, Escrow, Claim,
Enforcement, Evidence, Settlement, Verified.

> "Nine steps. That's the whole system."

**What the judge should notice:** each stage carries a plain-English line, and
the rail is lit from live data — 9 of 9 complete.

---

## 0:40 — 1:10 · The human sets the limit

**On screen:** terminal, `npm run demo:v2`, steps 2–3.

> "A person creates the agent, binds it to a keypair, and sets the envelope:
> one USDC total, two thousand micro-USDC per call, and only two resources —
> `/weather` and `/quote`. This is the only point a human is involved, and the
> agent cannot widen it."

**Then:** Overview → the money band.

> "Three USDC escrowed on devnet. Whatever happens next, the program will not
> release more than that — the ceiling is on chain, not in our database."

---

## 1:10 — 1:35 · An allowed request

**On screen:** terminal, step 8.

> "The agent buys. Each purchase is signed as a *cumulative* total — not
> 'charge me a thousand', but 'my running total is now a thousand'. Only the
> highest total ever reaches the chain, so a replayed message cannot
> double-charge, and a dropped one is superseded by the next."

**Then:** console → activity feed, the emerald rows.

> "Two allowed. Running total fifteen hundred."

---

## 1:35 — 1:55 · The policy refusal — **the moment**

**On screen:** terminal, step 9, first half. **Pause on the output.**

> "Now it tries to buy `/analyse`, which the human did not allow."
>
> *(beat)*
>
> "`ERR_POLICY_RESOURCE_NOT_ALLOWED`. Refused — and look at the next line: the
> high-water mark did not move. Still fifteen hundred. The refusal cost
> nothing, because the provider was never contacted."

---

## 1:55 — 2:10 · The replay refusal

**On screen:** terminal, step 9, second half.

> "And this one replays a nonce it already used. `ERR_NONCE_NOT_MONOTONIC`.
> Not an error — enforcement. Both of these are now *evidence*."

**Then:** console → activity feed, amber rows.

> "Amber, not red. Red is reserved for a genuine fault. A refusal is the
> product working."

---

## 2:10 — 2:30 · Evidence

**On screen:** terminal, step 10.

> "Three entries: allowed, allowed, refused. The decision string is inside the
> hash, so a refusal cannot be quietly edited into an approval — the chain
> breaks if you try. `chain_valid: true`."

---

## 2:30 — 2:50 · Settlement

**On screen:** terminal, step 11.

> "One transaction closes the session. Fifteen hundred to the provider, and the
> evidence root written alongside it.
>
> Note the signer: AgentPay's own settlement authority. The provider's key
> never signs — we don't hold one. Holding this key can trigger a settlement
> and nothing else; the amount is fixed by the agent's signature and the
> destination by the session inside the program."

---

## 2:50 — 3:00 · Browser = Gateway = Chain

**On screen:** console → Verifier, pre-loaded with the session → press
**Verify proof**.

> "And this is the point. Your browser recomputes the chain itself, fetches the
> root Solana actually stored, and compares them."

**Let the three rows land:**

```
BROWSER ROOT    f4c17919…edd15c   MATCH
GATEWAY ROOT    f4c17919…edd15c   MATCH
ON-CHAIN ROOT   f4c17919…edd15c   MATCH
```

> "Three independent views of the same root. Anyone can do this — no account,
> no token. Anyone can prove an agent paid. AgentPay proves an agent was
> stopped."

---

## The verified run to reference (11 Oct 2026 — 25 checks, 0 failures)

| | |
|---|---|
| Session | `F9uv8RFszLAuKUdRea121aSwoSUGT5ftPfXXi8Ux8Nfc` |
| Settlement tx | `5HQWGghSpGaYNUG3Pzym2dXhWMrrvF3BtaYxRssLS4QvAiGaEEP1EmnTkB67ZK65Wan1wJ8hoeq5j2k4SupjXWpX` |
| Evidence root | `f4c179199c66d6e5981509c2594c05fd8d237e6df0f8f001c89097f511edd15c` |
| Program v2 | `ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m` |
| Settlement authority | `7zKU8vFeWEn9M2FVm7bYa5aMtT9srUTJEeca7FDK9ff2` |
| Conservation | 1500 + 2998500 = 3000000 |

Verifier deep link:
`https://13-200-171-103.sslip.io/verifier?session=F9uv8RFszLAuKUdRea121aSwoSUGT5ftPfXXi8Ux8Nfc`

**If you re-run the demo before recording, these values change.** Re-read them
off the new run rather than reciting these.

---

## Pre-flight

```bash
npm run demo:v2
```

- [ ] 25 PASS / 0 FAIL
- [ ] Overview shows a non-zero session count and the lifecycle at 9 of 9
- [ ] Verifier shows **Verified** with all three roots matching
- [ ] Console loaded over **HTTPS** — over plain HTTP the verifier reports a
      failure that is not real, because WebCrypto needs a secure context
- [ ] `/settle` and `/registry` closed in every tab you might switch to

## Rules for the recording

1. **Never show `/settle` or `/registry` on camera.** Both mutate state;
   `/settle` spends real devnet SOL. Settle from the terminal.
2. **Never show `/playground` in a verification section.** It is an honest
   local simulation, but the video has no room to explain the distinction.
3. **Run the demo fresh before recording** so the Overview numbers are current.
   Narrating a live demo over a page reading zero is the worst thing that can
   happen on camera.
4. **Do not hurry past the refusals.** They are the demo.
5. **If something breaks, keep it in.** A gateway refusing a malformed claim on
   camera is better evidence than a clean run.
6. **If you show a previous run rather than a live one, say so**: "this is a
   verified run from earlier today." Never present an old screenshot as fresh.

## Known limitation to disclose if asked

Settlement waits on Solana confirmation. When devnet's `getAccountInfo` was
degraded on 27 Sep 2026, settlement timed out. The routes that wait on the
chain now carry a 60-second deadline rather than the blanket 15 seconds
(`AGENTPAY_CHAIN_TIMEOUT_SECS`), but a sufficiently degraded cluster will still
fail — and should. Say this plainly rather than hoping nobody asks.
