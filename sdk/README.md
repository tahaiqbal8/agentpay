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
