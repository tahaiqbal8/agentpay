# AgentPay Runbook

Zero to a working system, then the whole flow demonstrated end to end.

Follow this top to bottom and you will have AgentPay running, an agent
authorized and spending, a refusal recorded, and a settlement anchored on
Solana that a stranger can verify without trusting you.

**This is the operational guide.** For *why* anything is built the way it is,
read [HANDOVER.md](HANDOVER.md); for the decisions and their rejected
alternatives, [decisions.md](decisions.md).

Every command below is copy-pasteable. Expected output is shown so you can tell
success from failure without guessing.

---

## Part 0 — What you are about to run

Four processes, and one sentence each:

| Component | Does |
| --- | --- |
| **Anchor program** (Solana devnet) | Holds the escrow. The only thing with custody. |
| **Gateway** (Rust, :8080) | Verifies every claim, enforces policy, settles on chain. |
| **Console** (Next.js, :3100) | The operator UI. |
| **Demo provider** (Node, :4021) | Sells data. Contains no payment code at all. |

Postgres sits behind the gateway on :5434.

The idea in one line: **an agent escrows once, buys many times off-chain, and
one transaction settles everything — while every decision, including every
refusal, is committed to the chain as a Merkle root.**

---

## Part 1 — Prerequisites

To **run** it: Docker and Docker Compose. That is all.

To **build the program** or run the devnet scripts, additionally:

```bash
rustc --version    # 1.98.1
solana --version   # 4.1.2
anchor --version   # 1.2.0
node --version     # 25.x
```

You also need a devnet wallet with SOL:

```bash
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/id.json
solana airdrop 2 -u devnet
solana balance -u devnet
```

The settlement key is generated below, under "Optional: enable settlement".

> If the airdrop is rate-limited, use <https://faucet.solana.com>. You need
> roughly 0.5 SOL; each devnet script spends a few thousandths.

---

## Part 2 — Start the system

```bash
git clone https://github.com/tahaiqbal8/agentpay
cd agentpay
cp .env.example .env
```

### Set the admin token — do this before starting

The control plane (agents, policies, providers, approvals) is guarded by a
shared token. **Without it, anyone who can reach the port can approve their own
spends and suspend other people's agents.**

```bash
echo "AGENTPAY_ADMIN_TOKEN=$(openssl rand -hex 32)" >> .env
```

The gateway will refuse to start if it is bound anywhere other than loopback
without one. That refusal is deliberate — see Part 7.

### Optional: enable settlement

Without a settlement key the gateway verifies claims but cannot settle.

**New sessions open under program v2 and settle with AgentPay's own key** —
not the provider's. That key can trigger a settlement and nothing else: the
amount is fixed by the agent's signature and the destination by
`session.provider`, both enforced on chain.

```bash
mkdir -p secrets
solana-keygen new --no-bip39-passphrase -o secrets/settlement-authority.json
chmod 600 secrets/settlement-authority.json
solana airdrop 1 -u devnet $(solana-keygen pubkey secrets/settlement-authority.json)
echo "AGENTPAY_SETTLEMENT_AUTHORITY_KEYPAIR=/secrets/settlement-authority.json" >> .env
```

It needs a little devnet SOL of its own for fees and `SettlementRecord` rent —
budget ~0.02 SOL per new settlement record.

**Only if you also have v1 sessions to drain** — the old program requires the
provider's own signature, so settling those needs a provider key as well:

```bash
cp ~/.config/solana/agentpay-provider.json secrets/provider.json
chmod 600 secrets/provider.json
echo "AGENTPAY_PROVIDER_KEYPAIR=/secrets/provider.json" >> .env
```

A fresh install does not need this. See
[MIGRATION_V1_V2.md](MIGRATION_V1_V2.md).

`secrets/` is gitignored, and nothing in it is ever committed.

### Bring it up

```bash
docker compose up -d --build
```

Four services start in health order. Check:

```bash
curl -s http://127.0.0.1:8080/health
```

```json
{"status":"ok","program_id":"3aKGM6Cb…","ephemeral_state":false,"state_backend":"POSTGRES"}
```

```bash
docker logs agentpay-gateway-1 2>&1 | grep -E "settlement|admin token|reconciliation"
```

You want to see:

```
settlement enabled provider=BjA8GXW7…
control plane requires an admin token
on-chain session reconciliation enabled
```

If any line is missing, stop and fix it now — each one is a capability you will
need later.

> **Footgun.** Containers keep their creation-time environment. After editing
> `.env`, `docker compose up -d` alone will **not** update a running container.
> Use `docker compose up -d --force-recreate gateway`.

Open <http://localhost:3100>. Six pages: Monitor, Verifier, Settlement, Agents,
Registry, Approvals.

---

## Part 3 — Canonical V2 demo

**This is the demo. One command, program v2, real devnet.**

```bash
npm install
npm run demo:v2
```

It loads `AGENTPAY_ADMIN_TOKEN`, `AGENTPAY_PROGRAM_ID` and `AGENTPAY_RPC_URL`
from `.env` itself — nothing to export. It needs `docker compose up -d`
running and a devnet wallet holding ~0.1 SOL; it spends roughly 0.02–0.05
devnet SOL in rent and fees.

Fourteen stages, each one verified against the chain or the gateway rather
than against the value the script submitted. Abridged, from a real run:

```
 5. the agent opens an escrow, binding AgentPay as settlement authority
   session PDA                  7axQ7wTJCzVkShTgarpUxRL3eCBAvauhP6jtKGokep8i
   settlement_authority (chain) DLuD55GehdW6pNnv82NUs9hwbwN4mXssXwm8ucv4FH6s
   PASS  session account is 219 bytes                 the v2 layout

 8. the agent buys, signing a cumulative claim each time
   PASS  bought /weather                              cumulative 1000
   PASS  bought /quote                                cumulative 1500

 9. enforcement: the gateway refuses what the human did not allow
   PASS  /analyse refused                             ERR_POLICY_RESOURCE_NOT_ALLOWED
   PASS  the mark did not move                        still 1500
   PASS  a reused nonce refused                       ERR_NONCE_NOT_MONOTONIC

11. settlement — signed by AgentPay's authority, NOT a provider key
   provider balance after       0 -> 1500  (+1500)
   vault balance after          3000000 -> 2998500  (-1500)
   transaction signers          DLuD55GehdW6pNnv82NUs9hwbwN4mXssXwm8ucv4FH6s
   PASS  the provider key never signed                AgentPay holds no provider key here

12. the root the program stored, checked independently
   PASS  independently recomputed root MATCHES        7d733e13b31641b63d350f84…
   PASS  reported as the LATEST root                  not final — settlement is repeatable

14. what remains is still the agent's
   PASS  conservation holds                           1500 + 2998500 = 3000000
```

Five lines worth reading twice:

- **`session account is 219 bytes`** — the v2 layout. A v1 session is 187. The
  gateway refuses any other length rather than guessing.
- **`/analyse refused` … `the mark did not move`** — a refusal is not just a
  rejected response; the cumulative high-water mark is unchanged, so nothing
  was spent and a replay of it cannot spend either.
- **`the provider key never signed`** — the whole point of v2. The money
  still lands in the provider's account because the program binds the
  destination in the session PDA's seeds.
- **`not final — settlement is repeatable`** — the stored root is the *latest
  committed* root, not an immutable one. A proof exported now will not verify
  against a later root.
- **`conservation holds`** — what the provider received plus what remains in
  the vault equals the deposit, exactly.

Verify the settlement yourself, against the chain rather than the script:

```bash
solana confirm -v <the settlement tx from the output> -u devnet
```

### V1 is legacy — never demo it

`3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U` is still deployed and still
serves every session opened before the cutover. Every script that drives it is
suffixed `:v1-legacy` and carries a banner at the top of the file.

**Do not run any `:v1-legacy` command to demonstrate AgentPay.** They exercise
the old custody model, where AgentPay holds the provider's private key — the
thing v2 exists to remove. They are kept only as regression coverage for
sessions that already exist. See [MIGRATION_V1_V2.md](MIGRATION_V1_V2.md).

---

## Part 4 — The flow, stage by stage, by hand

This is the part to walk somebody through. Set the token once:

```bash
export TOKEN=$(grep '^AGENTPAY_ADMIN_TOKEN=' .env | cut -d= -f2)
```

### 4.1 Create an agent, and bind its wallet

```bash
# Write the key to a file — the agent has to SIGN with it later. Generating it
# with --no-outfile prints a pubkey and throws the private key away, which
# produces an agent record bound to a key nobody holds.
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/demo-agent.json
AGENT_KEY=$(solana-keygen pubkey ~/.config/solana/demo-agent.json)

AGENT_ID=$(curl -s -X POST http://127.0.0.1:8080/v1/agents \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"label\":\"Research bot\",\"agent_pubkey\":\"$AGENT_KEY\",\"mode\":\"autonomous\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["agent_id"])')

echo "$AGENT_ID"
```

You get back an `agent_id` and `"policy": null` — an agent starts with **no**
envelope. A second agent on the same wallet is refused with `409
ERR_AGENT_EXISTS`, because two records for one key would make the policy
applied to a claim ambiguous.

### 4.2 Fund it — this is the only step with custody

The escrow is opened **on chain**, by the agent's key. Nothing in the gateway
can create or increase it.

For a v2 session — the one you want — this is stage 5 of `npm run demo:v2`,
which calls `open_session` with `settlement_authority` set to the key
`/health` publishes. Calling `open_session` directly works too; bind that same
authority, or AgentPay will not be able to settle the session.

`npm run stage-settleable:v1-legacy` also leaves a funded session waiting, but
it opens a **v1** session under the old program. Use it only when you
specifically want to exercise the legacy path.

**This deposit is the agent's absolute ceiling.** No policy, no bug and no
compromised gateway can exceed it.

### 4.3 Authorize — the narrower, off-chain bound

```bash
curl -s -X POST "http://127.0.0.1:8080/v1/agents/$AGENT_ID/authorize" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"max_total":"5000","max_per_call":"1000",
       "allowed_resources":["/weather","/quote"],
       "max_calls":5,"mode":"autonomous"}'
```

Amounts are micro-USDC **decimal strings**, never numbers — above 2^53 a JSON
number rounds, and these are budgets.

This can only **narrow** the escrow, never widen it. Set `mode` to `"human"` and
every spend waits for a person; leave it `"autonomous"` and only spends at or
above `approval_threshold` do.

### 4.4 Find an API

```bash
curl -s http://127.0.0.1:8080/v1/catalogue
```

Prices come from each provider's own `/_catalogue`, read live. The gateway never
invents a price — registering a provider records *where to ask*, not *what to
charge*. A provider that is down appears under `unavailable` rather than
vanishing, so "down" is not read as "does not exist".

Add another provider:

```bash
curl -s -X POST http://127.0.0.1:8080/v1/providers \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"provider_id":"weather-eu","label":"Weather EU","base_url":"http://provider:4021"}'
```

### 4.5 Decide how many calls

Two planners, for two different callers.

**As the operator**, planning for any agent:

```bash
curl -s -X POST http://127.0.0.1:8080/v1/agent/plan \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"agent_id\":\"$AGENT_ID\",\"resource\":\"/weather\",\"calls\":50}"
```

**As the agent**, planning only for the session it holds — **no admin token**:

```bash
curl -s -X POST http://127.0.0.1:8080/v1/session/plan \
  -H 'content-type: application/json' \
  -d '{"session":"<pubkey>","resource":"/weather","calls":50,
       "claim":{ … signed at the CURRENT cumulative and nonce … }}'
```

Or, in the SDK, one line:

```ts
const plan = await pay.plan("/weather", 50);
```

Identity comes from the signature, not a credential. There is **no `agent_id`
field** on the session planner — the agent is derived from the session record,
so there is nothing to enumerate.

The signed claim carries the session's **current** cumulative and nonce, which
makes it non-spendable: both the gateway and the program admit a claim only
when its cumulative is strictly greater.

Both planners are **informational only**. They reserve nothing and authorize
nothing — `/v1/buy` remains the final spending authority, and re-checks the
signature, the price and the envelope from scratch.

The plan is **bounded by the envelope, not by the request**: ask for 50 and you
are told how many are actually affordable, and which provider is cheapest. A
forbidden resource is listed with `refused_by` rather than hidden.

A plan **authorises nothing**, and a plan can go stale the moment another
purchase lands. Buying goes through `/v1/buy`, where the signature, the price
and the same envelope are all checked again.

### 4.6 Buy

In code, three lines:

```ts
const pay = new AgentPayClient({ gateway, session, expiresAt, signer });
const weather = await pay.buy("/weather?city=Lahore");
```

By hand, the 402 handshake:

```bash
curl -s http://127.0.0.1:8080/v1/buy/weather
```

The 402 body tells you the price, the next cumulative total, the next nonce,
**and the exact 73 bytes to sign**. That last part is in the response on purpose
— it is what integrations get wrong, and getting it wrong fails silently at
settlement rather than here.

### 4.7 Human approval

With `mode: "human"`, a purchase returns `403 ERR_APPROVAL_REQUIRED` and a
proposal appears at <http://localhost:3100/approvals>.

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/v1/approvals
curl -s -X POST "http://127.0.0.1:8080/v1/approvals/$APPROVAL_ID/decide" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"approved":true}'
```

The agent is **refused, not held** — it retries once you decide. A queued HTTP
request would occupy a connection until someone happened to look.

One approval authorises **one** purchase and is bound to that resource at that
price. A standing permission would turn a moment's inattention into an unbounded
budget.

### 4.8 Revoke

```bash
curl -s -X POST "http://127.0.0.1:8080/v1/agents/$AGENT_ID/status" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"status":"suspended"}'
```

Immediate, and it does not need the session to expire. Two limits: it binds only
what passes through **this** gateway, and it does **not** claw back the escrow or
recall a settlement in flight.

### 4.9 Settle

One transaction for the whole session, committing the Merkle root of every
decision — refusals included.

```bash
curl -s -X POST http://127.0.0.1:8080/v1/session/settle \
  -H 'content-type: application/json' -d "{\"session\":\"$SESSION\"}"
```

Or press **Settle on-chain** on <http://localhost:3100/settle>.

---

## Part 5 — Prove a refusal, in a browser

This is the demo that lands. Everything above shows an agent paying; anyone can
show that.

1. Open <http://localhost:3100/verifier>
2. Paste a settled session address
3. Pick an entry whose decision is a **refusal** — `CLAIM_EXCEEDS_DEPOSIT`,
   `POLICY_BUDGET`, anything red
4. Watch the Merkle path recompute hop by hop **in your browser**, with
   WebCrypto

You end at three roots:

| Value | Who controls it |
| --- | --- |
| recomputed in browser | the reader |
| root reported by gateway | the gateway |
| **root committed on chain** | **nobody — it is a public fact** |

Only the third decides the audit. Before it existed the page compared two
numbers that both came from the gateway, and a gateway that committed a
different root than its log produces would have passed unnoticed.

Check it yourself:

```bash
solana account <settlement_record from the page> -u devnet
```

The claim: **the agent asked for 50 USDC, was stopped, and that refusal is
provable against a root committed on Solana — without trusting the operator.**

---

## Part 6 — Testing

**Program v2 — the current protocol:**

| Command | Covers | Needs |
| --- | --- | --- |
| `cargo test --manifest-path gateway/Cargo.toml` | 129 hermetic | nothing |
| `npm run sdk-test` | 27 SDK checks incl. claim parity | nothing |
| `npm test` | 24 attacks; v2 by default, `AGENTPAY_TEST_PROGRAM=v1` for the old rules | devnet |
| `npm run demo:v2` | **the canonical demo** — the whole lifecycle | devnet |
| `npm run custody:v2` | 20 custody invariants | local validator |
| `npm run evidence:v2` | custody evidence, every figure read back from chain | devnet |

**Program v1 — legacy regression only. Never demo these.**

| Command | Covers | Needs |
| --- | --- | --- |
| `npm run policy:v1-legacy` | 45 control-plane, planner and operator checks | devnet |
| `npm run evidence:v1-legacy` | evidence + Merkle proof, old program | devnet |
| `npm run settle:v1-legacy` | provider-key settlement, the model v2 replaced | devnet |
| `npm run reconcile:v1-legacy` | 8 lies at `/v1/session/open`, all refused | devnet |
| `npm run sdk-demo:v1-legacy` | the SDK end to end, old program | devnet |
| `npm run stage-settleable:v1-legacy` | leaves a **v1** settleable session for the UI | devnet |
| `npm run diagnostics:v1-legacy` | prints actual on-chain failures, old program | devnet |

Database-backed tests need a **separate, disposable** database:

```bash
docker exec agentpay-postgres-1 createdb -U agentpay agentpay_test
TEST_DATABASE_URL=postgres://agentpay:agentpay@127.0.0.1:5434/agentpay_test \
  cargo test --manifest-path gateway/Cargo.toml -- --include-ignored
```

> **Never point this at the gateway's own database.** The suite writes and does
> not roll back. It used to be documented against `DATABASE_URL`, and 70 test
> rows accumulated there which the console rendered as 263 USDC of escrow that
> never existed. The suite now refuses a database whose name lacks `test` — try
> it and see the refusal.

---

## Part 7 — Production

### Before exposing this to a network

0. **Mint per-operator credentials.** The shared token is the bootstrap path,
   not the end state: a decision made with it records only `op_shared_token`,
   never a person.

   ```bash
   curl -s -X POST http://127.0.0.1:8080/v1/operators \
     -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"label":"Zara"}'
   ```

   The token comes back **once** — only its hash is stored, so it cannot be
   shown again, only replaced. An operator replaces their own:

   ```bash
   curl -s -X POST http://127.0.0.1:8080/v1/operators/me/rotate \
     -H "Authorization: Bearer $MY_TOKEN"
   ```

   The old token stops working on the very next request, and the operator id
   and name survive — so the audit trail still attributes past decisions
   correctly. **There is no path to rotate somebody else's token**: whoever
   rotated it would receive the new one and could then act under that person's
   name. For a lost credential, disable it and mint a new operator instead.

   Revoke one without touching anybody else:

   ```bash
   curl -s -X POST http://127.0.0.1:8080/v1/operators/$OP_ID/status \
     -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"enabled":false}'
   ```

1. **Set `AGENTPAY_ADMIN_TOKEN`.** Not optional. The gateway refuses to start
   bound to anything but loopback without one, and refuses a token under 16
   characters. Generate with `openssl rand -hex 32`.
2. **Set `AGENTPAY_REQUIRE_AGENT_POLICY=1`.** Otherwise a session whose agent
   has no record is bounded only by its escrow, and anyone can open a session
   to bypass the policy layer.
3. **Never set `AGENTPAY_TRUST_OPEN_REQUESTS`.** It disables on-chain
   reconciliation, so a caller can assert a deposit that was never escrowed and
   have claims authorised against credit that does not exist.
4. **Put TLS in front.** The admin token crosses the wire.
5. **Behind a reverse proxy, set the peer address at the proxy.** The rate
   limiter keys on the TCP peer and deliberately ignores `X-Forwarded-For`,
   which a caller can forge to get a fresh bucket per request.

### Rate limits

| Variable | Default | Why |
| --- | --- | --- |
| `AGENTPAY_OPEN_RATE_LIMIT` | 20/min/IP | `/v1/session/open` does an RPC read per request and needs no credential — the path an attacker uses to burn a metered quota. |
| `AGENTPAY_RATE_LIMIT` | 600/min/IP | Loose. The money path is gated by signatures and a shape check before any I/O, so a tight limit breaks real agents and stops nothing. |

### What is behind the token, and what is not

Behind: `/v1/agents*`, `/v1/providers*`, `/v1/approvals*`, `/v1/agent/plan`,
and the listings `/v1/sessions` and `/v1/decisions/recent`.

Open, deliberately: the money path, and the public verification endpoints —
evidence, proofs, `/v1/session/{pubkey}`, `/v1/catalogue`, `/health`.

Two reasons for that split. A shared secret in front of the money path would
break every agent and stop nothing, since an attacker without a valid signature
is already refused. And a third party checking a decision **without the
operator's permission** is the product — evidence behind a token would make the
audit trail depend on the party it exists to check.

### Known gaps — state these, do not discover them

- No external audit.
- Single gateway instance. The high-water mark is per-instance state with no
  leader election.
- The gateway holds a hot settlement key in a file. No HSM, no KMS, no
  rotation. For **v2** sessions this is AgentPay's own key, which cannot
  redirect funds or change an amount; for **v1** sessions still draining it is
  the provider's own key, which is the arrangement v2 exists to end.
- The v2 Merkle root is the **latest** committed root, not a final one — a
  later settlement commits a root over more leaves. Do not call a proof final.
- Migration v1 → v2 is not finished. See
  [MIGRATION_V1_V2.md](MIGRATION_V1_V2.md).
- A compromised control plane can change a provider's registered settlement
  address for **future** sessions. Existing sessions are safe.
- **No notification path.** The approvals page polls; nothing pages a human
  when a spend is waiting.
- Anyone with the token can register a provider. No ownership, no verification
  that a base URL belongs to the party claiming it.
- Token-2022 compiles but has never executed.
- Append-only by convention and by the hash chain, **not** by a database grant.
  Tamper-evident, not tamper-proof. Do not call it immutable.

---

## Part 8 — Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `401 ERR_UNAUTHORIZED` on a control endpoint | Token missing or wrong | `export TOKEN=$(grep '^AGENTPAY_ADMIN_TOKEN=' .env \| cut -d= -f2)` |
| `429 ERR_RATE_LIMITED` | Hit the limit | Wait; `/v1/session/open` refills at 20/min |
| `ERR_SETTLEMENT_UNAVAILABLE` | No settlement key for that session's program — v2 needs `AGENTPAY_SETTLEMENT_AUTHORITY_KEYPAIR`, v1 needs `AGENTPAY_PROVIDER_KEYPAIR` | Mount the right one (Part 2) and `--force-recreate gateway` |
| Settlement page empty | Sessions have no confirmed escrow | Press **Check against the chain**, or `npm run stage-settleable:v1-legacy` |
| `ERR_SESSION_ACCOUNT_NOT_FOUND` at open | No escrow on chain for that address | Open one first |
| `ERR_CLAIM_NOT_MONOTONIC` | Client restarted its counters at zero | Use `AgentPayClient.resume()` |
| Gateway won't start, mentions the admin token | Non-loopback bind without one | Set it. This is the guard working. |
| `UNCAUGHT` in a devnet script | Usually a devnet 429 | Re-run; set `PUBLIC_RPC_THROTTLE_MS=900` |
| Console pages blank in an embedded browser | Next dev-mode HMR websocket blocked | `npm run build && npm start` |
| Stale config after editing `.env` | Container keeps creation-time env | `docker compose up -d --force-recreate` |

---

## Part 9 — Explaining this to someone in two minutes

1. **The problem.** An agent buying data makes hundreds of tiny purchases.
   On-chain each one costs more in fees than the purchase.
2. **The mechanism.** Escrow once. Every purchase after that is an off-chain
   signed claim saying *"the total you owe is now X"* — cumulative, so only the
   highest ever needs to reach the chain.
3. **The control.** A human sets what the agent may buy, how much per call, how
   many calls, and when a person must approve. The escrow is the hard ceiling
   the chain enforces; the policy can only narrow it.
4. **The part nobody else shows.** Every decision — allow *and* refuse — is
   hash-chained, and the Merkle root goes on chain with the settlement.
5. **The demo.** Open the Verifier, pick a **refusal**, watch the browser
   recompute the proof and match it against the root stored by the program.

> Anyone can show that an agent paid. This shows that an agent was **stopped**,
> and proves it against a public chain.

### The line to hold when somebody asks what AgentPay is

> **AgentPay does not decide what an agent should buy. The agent decides what it
> needs; AgentPay determines what the agent is permitted to buy, enforces those
> boundaries, and produces verifiable evidence when a purchase is refused.**
