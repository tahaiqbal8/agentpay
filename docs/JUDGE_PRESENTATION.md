# AgentPay

### Payment Control, Policy Enforcement, Evidence & On-Chain Settlement

**Judge Presentation & Live Demo Guide**

| | |
| --- | --- |
| **Network** | Solana Devnet |
| **Protocol** | V2 |
| **Program** | `ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m` |
| **Deployed at** | https://13-200-171-103.sslip.io |

```
https://13-200-171-103.sslip.io
```

> **Live now.** A settled session is already verifiable there — judges need
> nothing installed.

To run the whole lifecycle again, in front of them:

```bash
npm run demo:v2
```

> **One command. That is the whole demo.**
> Everything in this document comes out of it.

*Every figure in this guide was read back from Solana devnet or recomputed independently. Nothing is illustrative.*

---

## 2. 30-second elevator pitch

> Software is starting to buy things on its own — data, APIs, compute.
>
> But you cannot hand an agent your wallet and hope for the best.
>
> AgentPay is the layer in between. A human sets a spending limit. The money goes into an escrow on Solana that nothing can exceed. Every purchase the agent makes is signed, and our gateway checks it against the policy before a single request reaches the provider.
>
> Every decision — including every refusal — gets hashed into a chain and anchored on Solana.
>
> So afterwards, anyone can prove exactly what that agent spent. Without trusting us.

*Roughly 28 seconds spoken at a normal pace.*

---

## 3. The problem

**How do you let an automated client spend money on its own without handing it unrestricted control of funds?**

Today the honest answer is: you don't. You give it an API key with a credit card behind it and you hope. That leaves six concrete risks:

| Risk | What goes wrong |
| --- | --- |
| **Unrestricted spending** | An agent in a loop burns the whole balance. Nothing structurally stops it. |
| **Replayed claims** | A captured payment message is submitted twice and pays twice. |
| **Unauthorized resources** | The agent buys something nobody approved it to buy. |
| **Gateway manipulation** | Whoever runs the payment layer can quietly change amounts or destinations. |
| **No auditability** | When the bill arrives, there is no way to prove which calls were legitimate. |
| **Unclear settlement** | Who actually moved the money, on whose authority, and can anyone check? |

The last two are the ones that matter to an auditor, and the ones nobody solves.

---

## 4. The solution

AgentPay is a payment control and audit layer between an automated client and the APIs it buys from.

```
        Human
          │  creates the agent, sets the spending envelope
          ▼
        Agent  ──── Ed25519 keypair
          │
          │  opens an escrow on Solana
          ▼
   ┌──────────────────────────────────────────────┐
   │  ESCROW (Solana, program V2)                 │
   │    vault holds the deposit                   │
   │    provider destination  ── in the PDA seeds │
   │    settlement authority  ── written once     │
   └──────────────────────────────────────────────┘
          │
          │  signed cumulative claim (73 bytes)
          ▼
   ┌──────────────────────────────────────────────┐
   │  GATEWAY                                     │
   │    price → 402 → decode → expiry → session   │
   │    → signature → price match → policy        │
   │    → admit_claim → forward → evidence        │
   └──────────────────────────────────────────────┘
          │                            │
    refused │                          │ allowed
          │                            ▼
          │                        Provider API
          │                            │
          ▼                            ▼
   ┌──────────────────────────────────────────────┐
   │  EVIDENCE                                    │
   │    SHA-256 hash chain, refusals included     │
   │    → Merkle root                             │
   └──────────────────────────────────────────────┘
          │
          │  settle_session, signed by the AUTHORITY
          ▼
   ┌──────────────────────────────────────────────┐
   │  SETTLEMENT (on chain)                       │
   │    vault ──► provider destination            │
   │    SettlementRecord: root + cumulative       │
   └──────────────────────────────────────────────┘
          │
          ▼
   Independent verification — in any browser
   Browser root = Gateway root = On-chain root
```

**The one-line claim:** AgentPay never holds the provider's private key, and the money still lands in the provider's account — because the program binds the destination.

---

## 5. How the system works

| Component | In one sentence |
| --- | --- |
| **Human authorization** | A person creates the agent and defines what it may spend. |
| **Agent** | An Ed25519 keypair that signs every purchase it makes. |
| **Policy** | The envelope: total cap, per-call cap, allowed resources, call count. |
| **Escrow** | A vault on Solana holding the deposit. The absolute ceiling. |
| **Signed claim** | A 73-byte message the agent signs, stating its running total. |
| **Gateway** | Verifies the claim and applies the policy *before* forwarding anything. |
| **Provider** | The API being bought from. It never handles payment logic. |
| **Evidence chain** | Every decision hashed into a chain — refusals as well as purchases. |
| **Merkle root** | One hash summarising the whole log, committed on chain at settlement. |
| **Settlement authority** | AgentPay's own key, which can trigger settlement and nothing else. |
| **Verifier** | A browser page that recomputes the root from scratch and compares three sources. |

---

## 6. Human authorization

Two different things, often confused. Keep them separate when you speak.

### Human authorization — the standing envelope

A person creates the agent, then authorizes it with:

- **max_total** — the ceiling across everything
- **max_per_call** — the ceiling on one purchase
- **allowed_resources** — an allowlist of endpoints
- **max_calls** — an optional call limit

This is set once. The agent then operates inside it without asking anybody.

**The envelope can only narrow what the escrow already permits. It never widens it.**

### Per-purchase approval — one decision, one spend

Separate mechanism. A spend needs an explicit human decision when either:

- the agent is in **human** mode — every spend needs a person, or
- the agent is **autonomous** and the spend is at or above its **approval_threshold**.

While it waits the agent is refused with `ERR_APPROVAL_REQUIRED` — refused, not held open — and retries after the decision. Approving authorizes **that one purchase**, bound to that resource at that price. The console page is `/approvals`.

> **Note for the demo:** the canonical run uses an agent in `autonomous` mode operating inside its envelope, so it does **not** trigger a per-purchase approval. Show `/approvals` to explain the mechanism; do not claim the demo exercised it.

---

## 7. V2 security model

| Control | How it works |
| --- | --- |
| **Ed25519 signed claims** | The agent signs a 73-byte message: `"agentpay:claim:v1"(17) ‖ session(32) ‖ cumulative(8) ‖ nonce(8) ‖ expires_at(8)`. The domain prefix stops a signature from another protocol being replayed here. |
| **Cumulative claims** | A claim states the running total, not an increment. Paying the highest one pays for everything beneath it — one transfer, not one per call. |
| **High-water mark** | The gateway only accepts a strictly higher cumulative. Equal is a replay; lower is a regression. Both refused. |
| **Nonce monotonicity** | The sequence number must increase. An out-of-order claim is refused. |
| **Expiry** | Claims and sessions expire, with 30 seconds of clock-skew tolerance. Sessions are capped at 30 days. |
| **Price matching** | The claimed amount must match the provider's published price for that resource. |
| **Policy enforcement** | Total, per-call, allowlist and call count, applied before anything is forwarded. |
| **Escrow ceiling** | Enforced by the program. No policy, bug or compromised gateway can exceed the deposit. |
| **Provider destination binding** | The destination is in the session PDA's seeds. It cannot be changed after the session opens. |
| **Settlement authority** | Written once at `open_session`. It can trigger a settlement and nothing else — the amount is fixed by the agent's signature, the destination by the seeds. |
| **Evidence chain** | `SHA256(prev ‖ session ‖ cumulative ‖ nonce ‖ decision)`. Tamper-evident, refusals included. |
| **Merkle root** | Committed on chain in a `SettlementRecord`, so any single decision can be proved to a stranger. |

**Enforcement order in `/v1/buy`:**

```
price → 402 → decode → expiry → session → signature
      → price match → policy → admit_claim → forward → evidence
```

The claim is admitted **before** the request is forwarded. That is why a refused claim never reaches the provider.

---

## 7b. What a hardening pass found — and what it did not

Worth having ready: a judge who asks "what did you find when you audited it?"
is asking whether you looked, not whether it was perfect.

**Four gaps were found and fixed.**

| Gap | What it was | Fix |
|---|---|---|
| Evidence was append-only by convention | The runtime role held UPDATE/DELETE/TRUNCATE, and `evidence_log` carried `ON DELETE CASCADE` from `sessions` — so deleting one session erased its whole evidence chain without touching the table | Database triggers refuse UPDATE, DELETE and TRUNCATE, cascade included |
| Rate limits keyed on the TCP peer | Behind nginx the peer *is* nginx, so every public client shared one bucket | `AGENTPAY_TRUSTED_PROXIES` — the header is believed only from listed addresses, walked right to left |
| A V1 read path used the wrong program | `GET /v1/session/{s}/settlement` derived the record address from the primary program, so a settled V1 session read as `settled: false` | Owner picks the address, length picks the version — one fetch |
| No security headers on the deployment | The console sent none and advertised its stack | Five headers at nginx, version banner off |

**The one worth telling as a story:** `usage_records` had *deliberately* been
denied a foreign key to `sessions`, with a comment saying a deleted session
"must not silently erase the record that the customer was billed for those
calls." The billing table was protected from exactly the erasure the
cryptographic record was not.

**Seven areas were audited and already sound** — claim security, policy
enforcement, the evidence hash chain, settlement, custody, the API surface and
secret handling. No tests were added there, because coverage existed.

**Eight limitations were reviewed and accepted, not fixed.** Four of them
because fixing would make things worse: closing the `SettlementRecord` to
reclaim rent would destroy the proofs it anchors; adding a resource name to
evidence would change the hash preimage and invalidate every root ever
published; a partial Token-2022 test would turn "untested" into "believed to
work"; removing the V1 provider key would strand the sessions that need it.

> **What I say:** *"We audited it, we fixed four things, and we wrote down the
> eight we did not — including four where the fix would have been worse than the
> gap. That list is in the repository."*

**Test counts after the pass:** 148 gateway hermetic, 45 Postgres-backed, all
passing. Full reasoning: [FINAL_GAP_AUDIT.md](../FINAL_GAP_AUDIT.md).

---

## 8. Live demo — exact commands

AgentPay is deployed and running. Judges do not need anything installed — they
open a URL.

> ### THE URL
>
> ## https://13-200-171-103.sslip.io
>
> Real HTTPS, Let's Encrypt certificate. A session is already settled and
> verifiable there right now.

### Before the judges arrive — 30 seconds

```bash
ssh ubuntu@13.200.171.103 'cd ~/AgentPay && sudo docker compose ps'
```

*Expect four services — `gateway`, `postgres`, `provider`, `web` — all `running (healthy)`.*

```bash
curl -s https://13-200-171-103.sslip.io/ -o /dev/null -w '%{http_code}\n'
```

*Expect `200`.*

### To run a fresh lifecycle live

> ## ONE COMMAND FOR THE JUDGE
>
> ```bash
> ssh ubuntu@13.200.171.103 'cd ~/AgentPay && npm run demo:v2'
> ```
>
> On the server itself it is simply `npm run demo:v2`. Nothing else. Do not
> offer alternatives.

Runtime is roughly two to three minutes against public devnet. It spends about
0.02–0.05 devnet SOL in rent and fees. Each run creates its own agent, escrow
and session — it never reuses the last one.

### ⚠ Use the HTTPS URL, never the IP and port

`http://13.200.171.103:3100` is closed at the firewall, deliberately. If the
console is ever served over plain HTTP on an IP address, browsers withhold
`crypto.subtle` — the page is not a *secure context* — and the Verifier cannot
recompute anything. It then displays **"DOES NOT VERIFY"**, which looks like a
failure and is not one. Section 11 explains this.

---

## 9. Live demo — 9 steps

### STEP 1 — Run the canonical demo

**What I do:** `npm run demo:v2`

**What the judge sees:** A banner, then numbered stages scrolling past with green `PASS` markers.

**What I say:** *"One command. This runs the whole lifecycle against real Solana devnet."*

---

### STEP 2 — Human authorization

**What I do:** Point at stages 2 and 3.

**What the judge sees:**
```
2. a human creates an agent and binds its wallet
   PASS  agent created
3. the human sets the spending envelope
   max_total 1000000 · max_per_call 2000 · allowed /weather, /quote
   PASS  envelope stored    narrows the escrow, never widens it
```

**What I say:** *"A person creates the agent and sets the limit. The agent cannot widen it."*

---

### STEP 3 — Bounded escrow

**What I do:** Point at stage 5.

**What the judge sees:**
```
session PDA                  Eb62WN5exY1fZthDT7kiKzULCfe2p2yJw4BFFA9AucjA
settlement_authority (chain) 7zKU8vFeWEn9M2FVm7bYa5aMtT9srUTJEeca7FDK9ff2
PASS  session account is 219 bytes     the v2 layout
```

**What I say:** *"The money sits in an escrow on Solana. This deposit is the absolute ceiling — no bug in my gateway can exceed it."*

---

### STEP 4 — Successful signed claims

**What I do:** Point at stage 8.

**What the judge sees:**
```
PASS  bought /weather     cumulative 1000
PASS  bought /quote       cumulative 1500
```

**What I say:** *"Every call carries a claim the agent signed. Claims are cumulative, so only the highest one ever reaches the chain."*

---

### STEP 5 — Policy refusal

**What I do:** Point at stage 9, first refusal.

**What the judge sees:**
```
PASS  /analyse refused        ERR_POLICY_RESOURCE_NOT_ALLOWED
PASS  the mark did not move   still 1500
```

**What I say:** *"`/analyse` is outside the envelope. Refused — and the provider was never contacted."*

---

### STEP 6 — Replay refusal

**What I do:** Point at stage 9, second refusal.

**What the judge sees:**
```
PASS  a reused nonce refused    ERR_NONCE_NOT_MONOTONIC
```

**What I say:** *"A replayed claim. The protocol refuses it, and a refusal costs nothing."*

---

### STEP 7 — Evidence chain

**What I do:** Point at stage 10.

**What the judge sees:**
```
entries      3
decisions    ALLOWED, ALLOWED, ERR_NONCE_NOT_MONOTONIC
chain_valid  true
PASS  hash chain intact
```

**What I say:** *"Every decision is hashed into a chain — including the refusals. They are recorded, not discarded."*

---

### STEP 8 — V2 settlement

**What I do:** Point at stage 11.

**What the judge sees:**
```
provider balance after   0 -> 1500  (+1500)
vault balance after      3000000 -> 2998500  (-1500)
transaction signers      7zKU8vFeWEn9M2FVm7bYa5aMtT9srUTJEeca7FDK9ff2
PASS  the provider key never signed
```

**What I say:** *"One name in that signer list: our own authority. The provider's private key does not exist on my servers — and the money still landed in the provider's account, because the program binds the destination."*

---

### STEP 9 — Independent verification + conservation

**What I do:** Open the Verifier, click the red entry. Then point back at stage 14.

**What the judge sees:** **Verified — Browser = Gateway = Chain**, three identical roots. Then `1500 + 2998500 = 3000000`.

**What I say:** *"Recomputed in this browser. Not our word — and not mine either; that third root came off the chain. And the arithmetic closes: nothing appeared, nothing vanished."*

---

## 10. Browser demo

Console: **https://13-200-171-103.sslip.io**

| Route | Show | Priority |
| --- | --- | --- |
| `/` | Payment lifecycle strip, KPIs, Security controls panel | **High** |
| `/session/Eb62WN5exY1fZthDT7kiKzULCfe2p2yJw4BFFA9AucjA` | Escrow figures, 9-of-9 lifecycle, claim activity | **High** |
| `/verifier?session=Eb62WN5exY1fZthDT7kiKzULCfe2p2yJw4BFFA9AucjA` | Three-root verification | **Highest** |
| `/settle` | Settlement flow and the latest committed root | **High** |
| `/agents` | The envelope that bounds the agent | Medium |
| `/approvals` | Per-purchase human control | Medium |
| `/registry` | What is on offer, and at what price | Low |
| `/playground` | Claim simulator, no spending | Optional |

**Suggested order:** Overview → Session → **Verifier** → Settlement.

**What to say on each:**

- **Overview** — *"Nine stages, all green. Every tick comes from data, not a timer."*
- **Session** — *"Deposited, settled, remaining. And the refusal, in plain English."*
- **Verifier** — the main event. See below.
- **Settlement** — *"Latest committed root. Not final — settlement is repeatable."*

---

## 11. Verifier — the main proof

This is the screen that wins the room. Open it, click the red entry, stop talking for a second.

```
        ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
        │  BROWSER ROOT   │   │  GATEWAY ROOT   │   │  ON-CHAIN ROOT  │
        │     MATCH       │ = │     MATCH       │ = │     MATCH       │
        │  02078c46…2e38  │   │  02078c46…2e38  │   │  02078c46…2e38  │
        │  computed here  │   │    reported     │   │    committed    │
        └─────────────────┘   └─────────────────┘   └─────────────────┘

                          ✓  VERIFIED
```

Three independent sources:

1. **Browser root** — recomputed from the leaf and the sibling path using WebCrypto, in the judge's own browser.
2. **Gateway root** — what our server claims.
3. **On-chain root** — what the Solana program actually stored.

**What I say:** *"The browser recomputes this from scratch. It does not ask the gateway for the answer. When all three match, you have not taken anyone's word for anything."*

**Do not overclaim.** This proves one decision is covered by a root committed on Solana. It does not prove the gateway is honest about decisions it never logged, and it is not an audit of the program.

### Why this page needs HTTPS

The browser leg is done with **WebCrypto** (`crypto.subtle`), and browsers only
expose that API in a **secure context** — HTTPS, or `localhost`. Over plain HTTP
on an IP address, `crypto.subtle` is `undefined`, the recomputation throws, and
the page reports **"DOES NOT VERIFY"**.

That is the browser refusing to do cryptography on an insecure origin. It is not
a fault in the proof, and the root is still perfectly valid — but on stage it
reads as a failure. This is precisely why the deployment terminates TLS at nginx
and why port 3100 is closed.

| Origin | `isSecureContext` | `crypto.subtle` | Verifier |
| --- | --- | --- | --- |
| `https://13-200-171-103.sslip.io` | `true` | available | **Verified** ✅ |
| `http://13.200.171.103:3100` | `false` | `undefined` | "DOES NOT VERIFY" ❌ |
| `http://localhost:3100` | `true` | available | Verified ✅ |

**If a judge asks why it is on `sslip.io`:** *"No domain was needed. sslip.io
resolves any hostname of that shape back to the IP inside it, and Let's Encrypt
will issue a real certificate for it — so we get genuine HTTPS without buying a
domain."*

---

## 12. Settlement proof

Three properties, all visible on chain.

**1 · The settlement authority signs.**
**2 · The provider's key does not.**
**3 · The destination is bound by the session, not chosen by the signer.**

From the verified run:

| | |
| --- | --- |
| **Settlement transaction** | `3Na9CSu5nCrUb428LtuoJQ8AoVZMnxkk5pSaQNSmBCkAWaFYnJNPDj1aHGipsMNVWNkKkxJmJWBFCxE5iSNU3d1J` |
| **Settlement record** | `G7nwwHH1dzt6ZcM6X8Lg8LEAPRPBT73zPzD4Xb726tgZ` |
| **Settlement authority (signer)** | `7zKU8vFe…K9ff2` |
| **Provider signed** | **FALSE** |
| **Required signatures** | 1 |
| **Provider destination** | `6EeBWmkE3bfYivuNwPwVZyV4YyecZUTWLp5qbz3PTN9Y` |
| **Settled amount** | 1,500 micro-USDC (cumulative) |
| **Remaining escrow** | 2,998,500 micro-USDC |
| **V2 program present** | **TRUE** |
| **V1 program present** | **FALSE** |

Verify it live in front of them:

```bash
solana confirm -v 3Na9CSu5nCrUb428LtuoJQ8AoVZMnxkk5pSaQNSmBCkAWaFYnJNPDj1aHGipsMNVWNkKkxJmJWBFCxE5iSNU3d1J -u devnet
```

---

## 13. Conservation proof

```
        settled          1,500
    +   remaining    2,998,500
    ─────────────────────────────
    =   deposit      3,000,000     ✓
```

Both figures were read back from Solana after settlement — the vault's token balance and the provider's token account — not from the script's own output.

**What I say:** *"Nothing appeared and nothing disappeared. What the provider received, plus what is still the agent's, is exactly the deposit."*

The remainder is not stranded: after expiry `refund_session` is permissionless, and those funds can only ever move to the agent's own token account.

---

## 14. Failure / refusal demo

Two refusals, two different mechanisms. Both from the verified run.

### ERR_POLICY_RESOURCE_NOT_ALLOWED

| | |
| --- | --- |
| **What happened** | The agent asked for `/analyse`. |
| **Why refused** | `/analyse` is not in the human's allowlist (`/weather`, `/quote`). |
| **Provider contacted** | **No** — the claim is admitted before forwarding. |
| **Funds moved** | **No** — the high-water mark stayed at 1500. |
| **Evidence recorded** | Yes. |

*This is the human's envelope doing its job.*

### ERR_NONCE_NOT_MONOTONIC

| | |
| --- | --- |
| **What happened** | A claim arrived with nonce 2, which had already been used. |
| **Why refused** | The nonce must strictly increase. |
| **Provider contacted** | **No**. |
| **Funds moved** | **No**. |
| **Evidence recorded** | Yes — sequence 2, cumulative 2500, nonce 2. |

*This is the protocol refusing a replay, independent of any policy.*

**The line worth saying:** *"A refusal is not an error. It is the product working — and it costs nothing, because the mark never moved."*

---

## 15. V1 vs V2

| | V1 — legacy | V2 — canonical |
| --- | --- | --- |
| Program | `3aKGM6Cb…u7y5xP2U` | `ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m` |
| Session layout | 187 bytes | 219 bytes |
| Who settles | the provider, with its own private key | the settlement authority **or** the provider |
| AgentPay holds | the provider's private key | its own authority key only |
| Settlement | once | monotonic, repeatable |
| Merkle root | final | **latest committed** |
| Role | existing sessions only | **every new session and the demo** |

**Why the judge should only see V2:** V1 is the old custody model, where AgentPay holds the provider's private key — the exact thing V2 exists to remove. Demonstrating it would contradict the pitch.

> ### ⚠ NEVER RUN THESE DURING THE DEMO
>
> ```
> npm run evidence:v1-legacy
> npm run settle:v1-legacy
> npm run policy:v1-legacy
> npm run reconcile:v1-legacy
> npm run sdk-demo:v1-legacy
> npm run stage-settleable:v1-legacy
> npm run diagnostics:v1-legacy
> ```
>
> Every one drives the old program. Also avoid `npm run demo` and `npm run buy` — they use synthetic sessions and need a dev-only flag that skips on-chain reconciliation.

---

## 16. Judge questions & answers

**Q: Why does the agent need a signature?**
So the amount cannot be forged by us. The program verifies the agent's Ed25519 signature over the claim, so the settled amount is fixed by the agent — not by our gateway, and not by the provider.

**Q: What prevents an agent from overspending?**
Two independent limits. The escrow is a hard ceiling enforced by the program — no policy, bug or compromised gateway can exceed it. Inside that, the human's envelope caps the total, the per-call amount, and which resources are allowed.

**Q: What happens when a request is refused?**
The provider is never contacted, no funds move, and the high-water mark does not advance. The refusal is still written into the evidence chain, so it is provable afterwards.

**Q: Can the provider redirect settlement?**
No. The destination is derived from `session.provider`, which is inside the session PDA's seeds. It is fixed when the session opens and cannot be changed afterwards.

**Q: Who signs the V2 settlement?**
AgentPay's own settlement authority — `7zKU8vFe…K9ff2` in this run. Exactly one signer. The provider's key did not sign, and does not exist on our servers.

**Q: How do you prove the evidence?**
Each decision is hashed into a chain, and the chain is summarised by a Merkle root committed on chain at settlement. Any one decision can be proved with an inclusion proof, recomputed in the verifier's own browser.

**Q: Is the Merkle root final?**
No, and we are careful about this. V2 settlement is monotonic and repeatable, so a later settlement can commit a root over more entries. It is the **latest committed root**, not a final one. A proof exported now will not verify against a later root.

**Q: Can someone tamper with the evidence log in the database?**
Two layers stop it. The hash chain detects it — change a row and the next
entry's `prev_hash` no longer matches, and the gateway reports
`chain_valid: false`. Underneath that, database triggers refuse UPDATE, DELETE
and TRUNCATE outright, including a delete arriving through the cascade from
`sessions`. The test that proves it fails when the trigger is disabled.

**Q: Behind a proxy, can someone forge their way past your rate limit?**
No. `X-Forwarded-For` is believed only from addresses an operator explicitly
listed; from anyone else it is ignored completely and the TCP peer is used. The
header is walked right to left, skipping hops we already trust, so anything a
client prepended is never reached. Ten tests, including the spoof attempt.

**Q: Is AgentPay audited?**
No. Neither program has ever been externally audited. This is devnet only, and mainnet would need an audit first.

**Q: Why is V1 still present?**
It still holds sessions opened before the cutover, and those must be able to settle or refund under the rules they were opened with. It is read-and-drain only. It is removed once every V1 session has drained.

**Q: What happens if the gateway is compromised?**
It cannot manufacture an amount — that needs the agent's signature. It cannot redirect funds — the destination is in the PDA seeds. It can refuse service, and it can change a provider's *registered* address for **future** sessions. Existing sessions are safe. That residual risk is documented, not hidden.

**Q: What happens if an agent replays a claim?**
Refused, two ways over. The cumulative must strictly increase, and the nonce must strictly increase. You saw it: `ERR_NONCE_NOT_MONOTONIC`.

**Q: What happens if an agent requests an unauthorized resource?**
Refused before the request is forwarded. You saw it: `ERR_POLICY_RESOURCE_NOT_ALLOWED`.

---

## 17. Honest limitations

State these before a judge finds them. It reads as confidence, not weakness.

- **Not audited.** Neither program, ever. No third party has reviewed the custody model or the migration.
- **Devnet only.** Mainnet needs an audit first.
- **The root is the latest, not final.** Repeatable settlement is why.
- **V1 is still deployed** for sessions opened before the cutover, and `AGENTPAY_PROVIDER_KEYPAIR` is still configured for them. Migration is not finished.
- **The provider still needs a wallet address**, and should keep its key as a V1 fallback. The claim is that AgentPay does not *hold* it — not that it does not exist.
- **A compromised control plane can change a provider's registered settlement address for future sessions.** Existing sessions are safe; this must be disclosed to providers.
- **Evidence does not contain the resource name.** The hash preimage is session ‖ cumulative ‖ nonce ‖ decision, so the console cannot show which endpoint a claim was for.
- **`SettlementRecord` is not in the V2 IDL** — the account became `UncheckedAccount`. Decode it by offset, as the gateway does.
- **Token-2022 is untested.** The code path exists via `token_interface`; no test exercises it. Untested, not broken — and not claimed.
- **Single gateway instance.** Per-session serialisation comes from a database row lock, which is correct for one process and several against one database. Multi-instance behaviour under partition is unproven. No horizontal scalability is claimed.
- **Rate limiting is per-process.** The key is now correct behind a proxy, but the counter lives in one process's memory. Distributed limiting would need Redis, deliberately not introduced.
- **The `SettlementRecord` rent is never reclaimed** — roughly 0.0013 SOL per settled session. No instruction closes the account, correctly: it is the proof anchor.
- **No commercial validation.** No design partner, no pilot, no pricing research.

Full reasoning for every one of these, including the four where a fix would make
things worse, is in [FINAL_GAP_AUDIT.md](../FINAL_GAP_AUDIT.md).

---

## 18. Emergency / troubleshooting

**Is the site up?**
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://13-200-171-103.sslip.io/
```

**Check all four services:**
```bash
ssh ubuntu@13.200.171.103 'cd ~/AgentPay && sudo docker compose ps'
```
*All of `gateway`, `postgres`, `provider`, `web` should read `running (healthy)`.*

**Services are not running:**
```bash
ssh ubuntu@13.200.171.103 'cd ~/AgentPay && sudo docker compose up -d'
```

**Check the gateway (it is bound to localhost on the server):**
```bash
ssh ubuntu@13.200.171.103 'curl -s localhost:8080/health | python3 -m json.tool'
```

**Check the balances the demo spends from:**
```bash
ssh ubuntu@13.200.171.103 'solana balance 66VJi7nTRYBY9SEeCX2mWQLD8z6YiFm2zcapQdwVJre7 --url devnet'
```
*That is the payer. A run costs ~0.03 SOL. The settlement authority
(`7zKU8vFe…K9ff2`) is funded separately and pays only settlement fees.*

**The Verifier says "DOES NOT VERIFY":** check the address bar. If it is
`http://` on an IP, that is the secure-context problem in section 11 — switch to
`https://13-200-171-103.sslip.io`. The proof is fine; the browser is refusing to
do the maths.

**The demo failed partway:** it is safe to re-run. Each run creates a fresh
agent, session and mint; it never reuses the previous one. If it stops with an
insufficient-funds error, top up the payer above.

**Nothing responds at all:** confirm the instance is running in the AWS console.
The address is an **Elastic IP**, so it no longer changes on stop/start — but the
instance still has to be up.

> Never paste a private key, an admin token or the contents of `secrets/` into a
> terminal a judge can see. Nothing in this guide requires it.

---

## 19. The 60-second version

> Software is starting to buy things on its own, but you cannot hand an automated client your wallet.
>
> AgentPay puts a human-defined spending limit in front of the agent, backed by an escrow on Solana that nothing can exceed.
>
> One command runs the whole thing on devnet: the agent buys two resources, gets refused twice — once by policy, once for replaying a claim — and every decision is hashed into a chain and anchored on Solana.
>
> Settlement is signed by our own key, never the provider's, and the money still lands in the provider's account because the program binds the destination.
>
> Then anyone can open a browser, recompute the evidence root themselves, and see it match the root on chain.
>
> And the arithmetic closes exactly: 1,500 settled plus 2,998,500 remaining equals the 3,000,000 deposited.

---

## 20. Closing statement

> AgentPay does not give an automated client unrestricted access to money.
>
> A human defines the spending envelope. The agent proves every claim cryptographically. The gateway enforces the policy before a single request reaches a provider. Every decision — including every refusal — becomes tamper-evident evidence. And the settlement can be checked against the blockchain by anyone, without trusting us.
>
> It runs on Solana devnet today. It has not been audited, and we are not claiming it has been.
>
> But everything you just saw was real, and you can check every number yourself.

---

## Appendix — verified run data

All values read back from Solana devnet or the gateway. Verified current at the time of writing.

```
COMMAND          npm run demo:v2
NETWORK          Solana devnet
PROGRAM (V2)     ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m
V1 PRESENT       FALSE

AGENT            "e2e v2 agent"   CnP3Mf2UA4rPMExMQt7ReQLN2tevzGY9FDtv1V5b5V5W
                 autonomous · active
ENVELOPE         max_total 1000000 · max_per_call 2000
                 allowed /weather, /quote · max_calls 10
FUNDING          3000000 micro-USDC

SESSION          Eb62WN5exY1fZthDT7kiKzULCfe2p2yJw4BFFA9AucjA
  owner          ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m
  length         219 bytes
  vault          (vault — derived from the session PDA)
  provider       6EeBWmkE3bfYivuNwPwVZyV4YyecZUTWLp5qbz3PTN9Y
  authority      7zKU8vFeWEn9M2FVm7bYa5aMtT9srUTJEeca7FDK9ff2

PURCHASES        /weather → cumulative 1000
                 /quote   → cumulative 1500
REFUSALS         ERR_POLICY_RESOURCE_NOT_ALLOWED  (/analyse)
                 ERR_NONCE_NOT_MONOTONIC          (replayed nonce)

EVIDENCE         3 entries · chain_valid true
  seq 0          ALLOWED                  cumulative 1000  nonce 1
  seq 1          ALLOWED                  cumulative 1500  nonce 2
  seq 2          ERR_NONCE_NOT_MONOTONIC  cumulative 2500  nonce 2
MERKLE ROOT      02078c467577961a9c5ee955a33fc380e3416da54a2e3dbf47053d87141b2e38
  browser        MATCH
  gateway        MATCH
  on chain       MATCH

SETTLEMENT TX    3Na9CSu5nCrUb428LtuoJQ8AoVZMnxkk5pSaQNSmBCkAWaFYnJNPDj1aHGipsMNVWNkKkxJmJWBFCxE5iSNU3d1J
  record         G7nwwHH1dzt6ZcM6X8Lg8LEAPRPBT73zPzD4Xb726tgZ
  signers        7zKU8vFeWEn9M2FVm7bYa5aMtT9srUTJEeca7FDK9ff2  (1)
  provider signed FALSE
  settled        1500 (cumulative)
  root_may_advance true

CONSERVATION     1500 + 2998500 = 3000000   ✓
```

---

## Appendix B — where this is deployed

```
URL              https://13-200-171-103.sslip.io      Let's Encrypt, auto-renewing
HOST             AWS EC2  i-06081a9c50742b671  ap-south-1  Ubuntu 24.04
ADDRESS          13.200.171.103  (Elastic IP — does not change on stop/start)
STACK            docker compose: gateway · postgres · provider · web
TLS              nginx reverse proxy → 127.0.0.1:3100; http:80 → 301 → https
HEADERS          Strict-Transport-Security max-age=86400 · X-Content-Type-Options
                 nosniff · X-Frame-Options DENY · Referrer-Policy
                 strict-origin-when-cross-origin · Cross-Origin-Opener-Policy
                 same-origin · server_tokens off · X-Powered-By hidden
                 No CSP: Next.js emits inline scripts, so a strict policy needs
                 per-response nonces and a loose one would be decoration. An
                 unverified CSP that breaks the verifier is worse than none.
                 No CORS: the gateway is not browser-reachable, so a policy
                 would describe a request that cannot happen.
CONFIG           deploy/nginx-agentpay.conf (in the repository)

OPEN TO THE WORLD    22 (ssh) · 80 (redirect only) · 443 (console)
CLOSED               3100 · 8080 (gateway) · 5434 (postgres) · 4021 (provider)

KEYS ON THE SERVER   settlement authority  7zKU8vFeWEn9M2FVm7bYa5aMtT9srUTJEeca7FDK9ff2
                     payer                 66VJi7nTRYBY9SEeCX2mWQLD8z6YiFm2zcapQdwVJre7
                     Both were generated ON the server and never transmitted.
                     .env is 0600; the keypair is 0640 and group-readable only
                     by the container runtime. Neither is in git.
```

**The authority is deliberately not the same key used locally.** A session binds
whichever authority `/health` publishes at `open_session`, so the server settles
its own sessions with its own key. If this box were ever compromised, sessions
opened elsewhere are unaffected.

**Related documents:** [RUNBOOK.md](RUNBOOK.md) · [SETTLEMENT_CUSTODY.md](SETTLEMENT_CUSTODY.md) · [MIGRATION_V1_V2.md](MIGRATION_V1_V2.md) · [RELEASE_V2.md](RELEASE_V2.md) · [PITCH_AND_QA.md](PITCH_AND_QA.md) · [DEPLOY.md](DEPLOY.md)

---

**Your one command for the judge is: `npm run demo:v2`**
