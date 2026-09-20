# @agentpay/client

Client for [AgentPay](https://github.com/tahaiqbal8/agentpay) — deferred,
enforced agent payments on Solana.

## Why this exists

Integrating by hand means building a 73-byte message with the right field order
and endianness, signing it, base64-ing a JSON envelope into a header, tracking a
cumulative total and a nonce across every purchase, and reading the 402 to learn
the price first. `scripts/demo-buy.ts` is 194 lines of exactly that.

Getting any of it wrong fails at **settlement**, not at the request. An
integrator can ship something that appears to work for a whole session and then
discover the provider cannot be paid.

## Install

```bash
npm install @agentpay/client
```

No runtime dependencies. Bring your own signer.

## Buying

```ts
import { AgentPayClient } from "@agentpay/client";
import nacl from "tweetnacl";

const pay = new AgentPayClient({
  gateway: "http://127.0.0.1:8080",
  session: sessionPubkey,        // the escrow opened on chain
  expiresAt: sessionExpiry,
  signer: {
    publicKey: agentKeypair.publicKey,
    sign: (msg) => nacl.sign.detached(msg, agentKeypair.secretKey),
  },
});

const weather = await pay.buy("/weather?city=Lahore");
console.log(weather.data, weather.price, weather.cumulative);
```

That is the whole integration. The client quotes the resource, signs a
cumulative claim for the new total, retries with it attached, and advances its
counters **only on success**.

### Resuming

Claims are cumulative and strictly increasing, so a client that restarts at
zero against a session with history has every claim refused as non-monotonic.

```ts
const pay = await AgentPayClient.resume({ gateway, session, expiresAt, signer });
```

### Buying in bulk

```ts
const run = await pay.buyMany("/weather", 20, (i) => `?city=${cities[i]}`);

run.purchases;  // the ones that succeeded — real, and already paid for
run.spent;      // what this call cost
run.stoppedBy;  // why it stopped early, if it did
```

It stops at the first refusal rather than continuing. Budget, call limit and
suspension do not clear by themselves, so carrying on would produce a burst of
identical failures.

## You are charged per call, not per success

The claim is admitted **before** the request is forwarded, which is what stops
a refused claim from ever reaching the provider. The consequence is that a
provider answering `404` or `500` has still cost the agent money.

```ts
const bought = await pay.buy("/weather?city=Atlantis");
bought.ok;             // false
bought.upstreamStatus; // 404
bought.price;          // charged anyway
```

`buy` does not throw for this, because the purchase itself did not fail —
payment and forwarding both worked — and retrying would cost again. `buyMany`
stops when it sees one, rather than spending the budget on errors.

## Settling

```ts
const state = await pay.sessionState();
state.remaining;       // escrow left — the absolute bound
state.evidenceCount;   // decisions recorded, refusals included

const settled = await pay.settle();
settled.signature;     // a real, confirmed on-chain transaction
settled.merkleRoot;    // the evidence root the program stored
```

One transaction settles every purchase in the session. Because claims are
cumulative, only the highest ever reaches the chain — the intermediate ones do
not need to. The transaction also commits the Merkle root of every decision,
refusals included, which is what makes a denial provable afterwards.

Settlement is one-shot: the program's settlement PDA cannot be created twice,
so a second attempt is refused by the chain itself, not merely by the gateway.

## Waiting for a human

In human-controlled mode every spend needs a decision, and `buy` refuses with
`ERR_APPROVAL_REQUIRED` while raising a proposal.

```ts
const bought = await pay.buyWhenApproved("/analyse", { timeoutMs: 120_000 });
```

It polls until somebody decides, then retries. Kept separate from `buy` because
a method named `buy` returning only after an unbounded human delay would be
surprising, and a caller with a request deadline needs the refusal rather than
the wait.

After the timeout it throws the original refusal. A rejection and an unattended
queue look the same from here, and waiting forever on a spend a human already
declined would be worse than giving up.

## Retries

```ts
const pay = new AgentPayClient({ ..., retry: { retries: 3, backoffMs: 250 } });
```

Off by default, and it retries **transient** failures only — the gateway
failing to reach its database, the chain or the provider. A policy refusal or a
bad claim is a decision: retrying it cannot change the answer, and for anything
that got as far as being charged it costs money.

## Handling refusals

```ts
import { AgentPayError } from "@agentpay/client";

try {
  await pay.buy("/analyse");
} catch (e) {
  if (e instanceof AgentPayError) {
    if (e.needsApproval) { /* a human must decide; retry after they do */ }
    else if (e.outOfAuthority) { /* budget, allowlist, suspension — retrying will not help */ }
    else if (e.transient) { /* the gateway could not reach something; back off */ }
    console.log(e.reasonCode);
  }
}
```

The three getters exist because a bare `403` cannot tell them apart, and the
correct response differs: wait, give up, or retry.

## Operator API

`AgentPayControl` is a **separate class on purpose**. It holds the admin token
and can widen an envelope, suspend an agent, and approve spends. Keeping it out
of `AgentPayClient` means an agent process that never constructs it cannot do
those things, whatever else goes wrong in it.

```ts
import { AgentPayControl } from "@agentpay/client";

const control = new AgentPayControl({ gateway, adminToken: process.env.AGENTPAY_ADMIN_TOKEN });

const agent = await control.createAgent({
  label: "Research bot",
  agent_pubkey: agentKeypair.publicKey.toBase58(),
  mode: "autonomous",
});

// Amounts are micro-USDC decimal strings, never numbers: above 2^53 a
// JavaScript number rounds, and these are budgets.
await control.authorize(agent.agent_id, {
  max_total: "5000000",
  max_per_call: "25000",
  allowed_resources: ["/weather", "/quote"],
  approval_threshold: "10000",
});

const plan = await control.plan(agent.agent_id, "/weather", 50);
await control.setStatus(agent.agent_id, "suspended");
```

**Never put the admin token in a browser bundle or an agent process.**

## What this package does not do

- It does not hold or generate keys. You pass a signer.
- It does not open escrows. That is a chain transaction the human signs.
- It does not decide what to buy or how much of it.

An envelope set through `AgentPayControl` can only **narrow** what the on-chain
escrow already permits. It never grants an agent more spending power.

## Tests

```bash
npm test
```

The suite that matters is the first one: it pins the claim encoding against the
same hex vector `gateway/src/claim.rs` asserts. If either side's encoding
changes, both fail together instead of drifting apart quietly.
