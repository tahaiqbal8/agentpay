# AgentPay — Pitch & Judge Q&A Prep

> **How to use this.** Section 1 is the two-minute pitch. Section 2 is the
> answer bank. Section 3 is the part that actually matters: the four questions
> where the honest answer is *"we haven't built that"*, and how to say so
> without losing the room.
>
> **Every number here is verifiable in the repo.** Nothing is rounded up for
> effect. If a judge asks you to prove a figure, you can.

---

# Section 1 — The pitch (2 minutes)

## The problem

An automated client needs to buy a thousand API calls. Each one costs a
fraction of a cent. **Every existing payment rail breaks on this shape of
traffic.**

**Card rails and Stripe** carry a fixed per-transaction cost — roughly 30¢ plus
a percentage. On a $0.001 call that is a **300× overhead**. Worse, cards assume
a human: a cardholder who can be charged back, a billing address, a dispute
window measured in months. An automated client has none of those. You end up
extending *credit* to software and reconciling later, which is exactly the
exposure nobody wants.

**Ordinary blockchain transactions** fail differently. Even on a cheap L1, a
transaction per call means a transaction fee per call, plus block latency in the
request path. A sub-cent call cannot wait for consensus, and it certainly cannot
pay for it.

**And here is the part everyone skips.** Suppose you solve the cost problem.
You still cannot answer the question a finance team actually asks:

> *"Prove this agent could not have overspent."*

Existing rails produce a receipt for what **was** spent. None of them produce
evidence of what was **refused**.

## The solution

AgentPay is a **bar tab for automated clients**, with a cryptographic receipt.

| Step | What happens | On chain? |
|---|---|:--:|
| **1. Deposit** | Agent escrows 5 USDC into a session vault | ✅ 1 tx |
| **2. Spend** | Agent makes 1,000 calls, each carrying a signed cumulative claim | ❌ 0 tx |
| **3. Settle** | The **single highest** claim settles the whole session | ✅ 1 tx |

**1,000 paid calls cost 2 transactions, not 1,000.**

The trick is that claims are **cumulative, not incremental**. Claim #40 says
*"total owed is 1.234567"* — not *"add 0.05"*. So only the highest claim ever
needs to reach the chain, a dropped claim is superseded by the next one, and
replaying an old claim buys nothing because it does not increase.

Between the agent and the chain sits an enforcement gateway that holds the
escrow authority. Its policy checks are therefore **binding, not advisory** — and
every decision it makes, **allowed and refused**, is hash-chained into an
append-only log whose Merkle root is committed on-chain at settlement.

> **The one-line pitch.** Anyone can prove an agent *paid*. AgentPay proves an
> agent was **stopped** — and anchors that proof on a public chain.

## Why Solana

Three properties, in order of how load-bearing they are:

**1. The Ed25519 precompile.** This is the one that is genuinely hard to
replicate elsewhere. Solana can verify an Ed25519 signature natively as a
separate instruction, which is how the on-chain program confirms the *agent*
authorised a claim without the gateway being able to forge it. On a chain where
signature verification costs execution budget, this design gets expensive fast.

**2. Cost.** Our real devnet settlement cost **0.00001 SOL** in fees. At that
price, settling is effectively free relative to the value being moved, which is
what makes a per-session settlement model viable at all.

**3. Finality.** ~400ms means opening and closing a session is not a workflow
the agent has to be designed around.

> **Honest framing.** The deferred-claim scheme itself is chain-agnostic. What
> Solana provides is a fee floor low enough that per-session settlement is not
> absurd, and a precompile that keeps the gateway out of custody. Say that
> rather than claiming Solana is the only possible chain — a judge who knows
> state channels will respect the precision.

---

# Section 2 — Answer bank

## Role 1 · Technical & Cryptography Judge

### Q1. How do you enforce non-repudiation and prevent replay off-chain?

**Non-repudiation** comes from the signature. Every claim is Ed25519-signed by
the agent over **73 canonical bytes**:

```
"agentpay:claim:v1" ‖ session(32) ‖ cumulative_le(8) ‖ nonce_le(8) ‖ expiry_le(8)
```

Three things matter about that encoding:

- **Domain separation.** The `agentpay:claim:v1` prefix means a signature
  produced for another protocol over a 73-byte blob cannot be replayed here.
- **Fixed-width fields.** Every field is fixed size, so concatenation is
  unambiguous without length prefixes. No two distinct claims can share a
  preimage. *(We do not sign JSON — two encodings of the same object would both
  be valid, which is a forgery surface.)*
- **The session is inside the signature.** A claim cannot be moved to a
  different session.

The public key is taken from the **session record**, never from the request. A
claim carrying its own pubkey would let anyone mint valid claims.

**Replay defence is the high-water mark.** Because claims are cumulative and
must **strictly increase**, re-sending a paid claim is inert — it does not
increase, so it is refused as `ERR_CLAIM_NOT_MONOTONIC`. The `nonce` must
strictly increase too, catching claims that rise in amount but arrive out of
order.

> **Follow-up they will ask: "What about concurrent duplicate submissions?"**
>
> The read-decide-write cycle runs inside one transaction holding
> `SELECT … FOR UPDATE` on the session row. We have a test that fires **16
> concurrent identical claims** and asserts exactly 1 admitted, 15 refused,
> 0 errors — and it passes 20/20 runs in isolation.
>
> That test found a real bug, which is worth telling them: it originally passed
> in the suite and failed alone, because `Pubkey::new_unique()` reuses a
> process-static counter and collided with the previous run's rows. Catching
> that is the reason we trust the result now.

---

### Q2. Explain the Merkle inclusion proof. Why recompute in the browser?

**Two structures, two jobs.**

The **hash chain** makes the log tamper-evident *in order*:

```
entry_hash = SHA256(prev_hash ‖ session ‖ cumulative_le ‖ nonce_le ‖ decision)
```

Change, reorder, or delete any entry and every link after it breaks. The
**Merkle tree** over those entry hashes then lets you prove one decision against
a single 32-byte root without publishing the whole log.

**Why recompute client-side:** the gateway returns a `verified_locally` flag,
but that is **the gateway marking its own homework**. The console therefore
recomputes the root in the browser with **WebCrypto** from the leaf and the
sibling path. The green *"Cryptographically validated"* badge only appears when
*your* browser reproduces the root.

The final step is the one that closes the loop: compare that root against the
one stored in the on-chain `SettlementRecord`. At that point neither the gateway
nor the console is trusted — only Solana is.

> **Bonus point worth volunteering.** Duplicating the last node on an odd level
> is a known Merkle weakness (CVE-2012-2459): two distinct leaf sets can produce
> the same root. Here each leaf commits to its predecessor **and** its sequence
> position, so a differing leaf set breaks the chain and is detectable
> independently of the root.

**Live proof:** on a real devnet session, the denial at sequence 5
(`ERR_CLAIM_EXCEEDS_DEPOSIT`, cumulative 99.000000) verified in 3 hops against
the on-chain root `f1176eaf…`. Both negative controls hold — the same proof does
not verify a different leaf, and a tampered proof does not verify.

---

### Q3. What if the Gateway goes offline with unsettled claims in escrow?

**Funds are never stuck, because the gateway never had custody.** The escrow
program is the only authority over the vault.

Two recovery paths, neither needing the gateway:

1. **Before expiry** — the provider can still settle by submitting the highest
   claim it holds directly to the program. The gateway is a convenience, not a
   dependency.
2. **After expiry** — `refund_session` is **permissionless**. *Anyone* can call
   it, and the funds can only ever move to the agent's own token account, so a
   stranger triggering it cannot redirect them. Recovery does not require the
   agent to be online or hold SOL for fees.

There is a test that **kills the gateway mid-session and recovers the funds
on-chain with the gateway never involved**.

> **The harder version of this question — be ready for it.**
>
> *"What does the gateway losing its database cost you?"*
>
> This is the sharper risk, and we should raise it rather than wait. The
> high-water mark is the only thing stopping an agent replaying an old claim to
> get a second resource for the same money — **the chain cannot help**, because
> it sees one settlement at close and has no view of individual requests.
>
> So before durable storage, **a gateway restart was a security event.** That is
> why session state is in PostgreSQL and rehydrated on cold start. We test it
> with `kill -9` mid-session: after restart, replaying the pre-restart claim is
> still refused, and a new legitimate claim's delta is measured from the
> **restored** mark, not from zero.

---

## Role 2 · Product & Business Stakeholder

### Q4. Who is the ICP — agent developers, API providers, or end users?

**The paying customer is the API provider.** They have the revenue problem: they
cannot profitably serve sub-cent calls today, so they either bundle into
subscriptions that mis-price usage, or they do not serve that traffic at all.

**The agent developer is the adopter** — they integrate the client — but they
are not who writes the cheque.

**The end user never sees AgentPay**, and should not.

> **The wedge is narrower than "automation".** The realistic first customer is an
> API provider **already** seeing agent traffic they cannot price: scraping,
> inference, data, RPC. They feel the pain without being convinced of anything.

> ⚠️ **Say this plainly.** This is positioning, not traction. We have **no
> design partner and no pilot**. A judge who asks "who have you talked to?"
> deserves "nobody yet — this is a hackathon build" rather than a fabricated
> pipeline. That answer costs less than being caught.

---

### Q5. How do you handle volatility — escrow in SOL versus USDC?

**Correcting the premise first: you cannot escrow native SOL.** The vault is an
SPL token account and every transfer goes through `transfer_checked` against a
specific mint. Native SOL is not a token, so it is **not supported at all** —
holding SOL would require wrapping it (wSOL), which is then just another SPL
mint.

So the volatility question resolves differently than asked:

- **The program is mint-agnostic.** The session records its mint, and the
  program validates it on every single instruction. A wrong-mint or substituted
  token account is refused — we test that as an attack.
- **Volatility is therefore a choice the session opener makes**, not something
  the protocol imposes. Open with USDC and you have no FX exposure between
  deposit and settlement.
- **Our test mints are 6-decimal USDC-shaped**, and all arithmetic is integer
  micro-USDC in `u64` with checked operations. No float touches an amount
  anywhere — not in Rust, not in TypeScript, not in the UI rendering.

> **Honest gap to volunteer:** Token-2022 mints — the ones supporting transfer
> fees and interest-bearing behaviour — **have zero test coverage**. The code
> path exists via `token_interface` and reads the mint's owning program from
> chain rather than assuming, but it has never executed. A transfer-fee mint
> could break the amount arithmetic in ways we have not verified.

---

### Q6. How does this compare to L2 state channels or Lightning?

**It *is* a unidirectional payment channel** — and we should say that plainly,
because the literature is a decade deep and a judge who recognises an honest
implementation will trust the rest of the answer more.

| | Lightning | Generic state channel | **AgentPay** |
|---|---|---|---|
| Direction | bidirectional | bidirectional | **unidirectional** |
| Routing | multi-hop network | none | none |
| Counterparty risk | channel partner | counterparty | bounded to **one claim increment** |
| Dispute window | challenge period | challenge period | **none — expiry instead** |
| **Evidence of refusals** | ❌ | ❌ | ✅ **the differentiator** |

**What we deliberately do *not* do:** routing, bidirectional balance, watchtowers,
or fraud-proof challenge periods. Those exist to solve problems a unidirectional,
short-lived, single-counterparty channel does not have. Dropping them removes
most of the complexity — and most of the attack surface.

> **The actual differentiator is not the channel.** Payment channels are solved.
> What nobody ships is the **enforcement and evidence layer**: a policy that
> binds because the enforcer holds escrow authority, and a tamper-evident record
> of every decision — including denials — anchored on-chain. That is the seam
> AgentPay occupies.

---

## Role 3 · Security & Compliance Auditor

### Q7. If an agent key is compromised, what limits the loss?

**The deposit. Exactly and only the deposit.**

An attacker holding the agent key can sign claims up to `deposited_total` and no
further — the program enforces `cumulative_amount <= deposited_total` on chain,
so even a fully cooperating gateway cannot exceed it.

Concretely, the blast radius is:

| Bounded by | Mechanism |
|---|---|
| **Amount** | `cumulative <= deposited_total`, enforced on chain |
| **Time** | Session `expires_at`, max 30 days by construction |
| **Destination** | Funds move only to the **designated provider** |
| **Frequency** | v2: settlement is repeatable but **monotonic** — a cumulative amount lower than or equal to the one already settled is refused, so no settlement can be replayed for value. v1: `init` on `SettlementRecord` → exactly once |

**What the attacker cannot do:** drain other sessions, redirect funds to
themselves, or exceed the escrow. Compromising the agent key loses *that
session's deposit*, to *that session's provider*. It is a capability scoped by
construction.

> **The related question: "What if the *gateway* is compromised?"**
>
> Under program **v2** the gateway holds its **own** settlement-authority key,
> not the provider's. That key is a permission to *submit* a settlement and
> nothing more. Three on-chain constraints bound it:
> `provider_token_account.owner == session.provider` (cannot redirect — and
> `provider` is in the session PDA's seeds, so it cannot be changed after the
> session is opened), the Ed25519 precompile checking the **agent's** signature
> (cannot exceed what was authorised), and monotonicity on the cumulative
> amount (cannot replay a settlement for value).
>
> **So a compromised gateway can settle early or low — costing the provider
> revenue — but cannot move money to an attacker.** The custody claim survives a
> full compromise, which is the whole point of the trust boundary.
>
> Two honest qualifications. **First**, sessions still held by the older
> program v1 do require the provider's own key, and the gateway still holds one
> for them until they drain — see
> [MIGRATION_V1_V2.md](MIGRATION_V1_V2.md). **Second**, a compromised *control
> plane* can change a provider's registered settlement address for **future**
> sessions. Existing sessions are safe because their provider is in the PDA
> seeds; this one cannot be fixed in the program and must be disclosed to
> providers.

---

### Q8. How do you resolve disputes if a service was not rendered?

**We don't. There is no arbitration layer, and I want to be precise about what
exists instead.**

What the protocol gives you is a **bound on the loss**, not a remedy:

- The agent signs a claim, then the provider serves the request. If the provider
  takes the claim and withholds the response, the agent loses **exactly one
  claim increment** — the delta between the last claim and this one, which for a
  sub-cent API call is a sub-cent loss.
- The agent's response is to **stop signing**. The provider cannot settle for
  more than the highest claim it holds, so withholding caps the provider's own
  revenue immediately.
- Every decision is in the evidence log with its Merkle proof, so a dispute has
  **a cryptographic record to argue over** rather than two conflicting
  spreadsheets.

> ⚠️ **Do not oversell this.** The evidence log proves *what the gateway
> decided*. It does **not** prove the provider actually served the response —
> that would need a signed receipt from the provider, which we do not collect.
> A judge who presses on this is right to.
>
> **The honest position:** micro-payments make arbitration economically absurd —
> nobody arbitrates a $0.0001 dispute. Bounding the loss to one increment and
> making the record tamper-evident is the correct design for this value range.
> Arbitration belongs to a different product at a different price point.

---

## Role 4 · Developer Experience & Integration

### Q9. How many lines of code to integrate into a Next.js or FastAPI backend?

**Today, more than it should be — because there is no SDK.** I am not going to
quote you a flattering number for something we haven't built.

What exists is a working HTTP API and a reference client in the repo. An
integration today means:

| Piece | Effort | Why |
|---|---|---|
| Canonical claim encoding | ~15 lines | Must be **byte-exact** — 73 bytes, fixed-width, LE |
| Ed25519 signing | ~5 lines | Any standard library |
| Call `/v1/claim/verify` | ~10 lines | One POST, check the reason code |
| Session open / settle | ~20 lines | Two more endpoints |

So roughly **50 lines** — but the claim encoding is the part that will bite,
because getting one byte wrong fails **silently at settlement**, not at
integration time. We guard against that internally with a parity test pinning
the exact 73-byte vector across Rust and TypeScript. **A third party has no such
guard**, which is precisely why an SDK is the first thing to build next.

> **The honest framing that wins this question:** "The protocol is done and
> tested; the developer experience is not. An SDK that owns the encoding is the
> difference between 50 careful lines and 5 easy ones, and it is the next thing
> we build." Judges respect a known roadmap over an invented number.

---

### Q10. If the Gateway is unreachable, how does the frontend stay honest?

**It refuses to show numbers it cannot vouch for.**

When the gateway is unreachable the console does **not** display stale figures
or silently swap in fixtures. It announces the state three ways at once:

1. A red header pill: **"Gateway offline · seeded data"**
2. A persistent banner: *"Everything below is seeded placeholder data, not
   on-chain state."*
3. Every pubkey in the fallback data is prefixed **`DEMO…`** — visually
   impossible to mistake for a real base58 key

The "Live" badge also **never renders optimistically**. Its state is
`boolean | null`, and while `null` it shows *"Connecting…"* — because showing
green before the health check returns asserts a connection the page has not
confirmed.

> **The general principle, worth stating as a design value:** a dashboard that
> quietly falls back to fixtures teaches operators to trust numbers that are not
> real. **The fallback is loud on purpose.**

**This extends past the offline case.** The UI must agree with what the chain
would actually do — and we found two bugs where it didn't:

- Sessions past expiry displayed **"Active"**, because the badge derived from
  `is_settled` alone. But `evaluate_claim` refuses expired sessions, so the UI
  was telling an operator a session could take traffic when every claim would be
  refused.
- Those same sessions offered a green **"Settle"** button — an action
  `settle_session` can only reject, since it requires
  `now <= expires_at + skew`.

Both now derive from one module that mirrors the program's own ordering, and the
status chip carries the exact reason code a claim would return. Hover an
`Expired` badge and it says *"A claim now would return ERR_SESSION_EXPIRED"*.

---

# Section 3 — The danger zone

**Four questions where the honest answer is "not built".** Rehearse these. The
instinct to bluff is strongest exactly where the ground is softest, and judges
have heard every version of the bluff.

| # | Question | The one-sentence honest answer |
|:--:|---|---|
| **1** | *"Has this been audited?"* | **"No.** It moves tokens and holds a signing key. Devnet is appropriate; mainnet starts with an audit, not with us deciding we feel good about it." |
| **2** | *"Do you have users or a design partner?"* | **"No.** This is a hackathon build. The ICP is reasoned, not validated." |
| **3** | *"Can it run multi-region / multi-instance?"* | **"No.** Row locks serialise per session, but multi-instance is unproven. One writer today." |
| **4** | *"Is the evidence log actually immutable?"* | **"Tamper-evident, not tamper-proof.** The DB owner can rewrite rows; the hash chain makes it detectable and the on-chain root pins the set. `REVOKE UPDATE, DELETE` is documented as a deployment step." |

## Numbers you can defend

| Claim | Evidence |
|---|---|
| 24 on-chain attack tests | `./scripts/test-local.sh` — each asserts an **exact** error code |
| 101 gateway tests (83 without a DB) | `cargo test … -- --include-ignored` |
| Real devnet settlement | tx `2MS8Qo4p…`, fee **0.00001 SOL** |
| Merkle root matches on-chain | recomputed with an **independent** TS implementation, not the gateway's |
| Restart survives replay | `kill -9` test, delta measured from the **restored** mark |
| Reconciliation closes credit creation | 8 lies refused with distinct reason codes, truth accepted |

## If you remember one thing

> Payment channels are a solved problem. What nobody ships is the **enforcement
> and evidence layer** — a policy that binds because the enforcer holds escrow
> authority, and a tamper-evident record of every decision, **including the
> refusals**, anchored on-chain.
>
> **Lead with the denial, not the payment.**
