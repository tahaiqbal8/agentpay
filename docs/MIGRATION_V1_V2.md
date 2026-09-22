# Migration: program v1 → v2

**Status: v2 is DEPLOYED on Solana devnet and dual-program routing is live.
New sessions open under v2; existing v1 sessions continue under v1. The
migration is NOT complete — see "The cutover" below.**

Devnet verified, at tag `v2-devnet-verified`. Not externally audited, and not
on mainnet. Those are different claims and only the first one holds.

| | |
| --- | --- |
| v1 program (deployed, legacy) | `3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U` |
| v2 program (deployed, active) | `ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m` |
| v1 `Session` | 187 bytes |
| v2 `Session` | 219 bytes (`settlement_authority`, +32) |

Deployment evidence — transaction, slot, and the hash of the deployed bytes
checked against the tested artifact — is in
[RELEASE_V2.md](RELEASE_V2.md) §G.

---

## Why two programs rather than an upgrade

`Session` grew by 32 bytes. Accounts already allocated on devnet were sized
without the field, and no program upgrade can enlarge an account somebody else
paid rent for — deserialising a v1 account with the v2 struct fails because the
data is simply too short.

So v1 keeps running for the sessions it already holds. Nothing about them
changes, and nothing needs to: they settle and refund under exactly the rules
they were opened with.

---

## How the gateway tells them apart

**Not from configuration.** From the chain, on every settlement:

```
fetch the session account
   ├─ owner  → which program wrote it
   └─ length → which layout it uses
         187 → v1
         219 → v2
         else → refuse
```

Both programs write the same 8-byte discriminator, because it is
`sha256("account:Session")[..8]` and the struct is still named `Session`. The
discriminator therefore **cannot** distinguish them and the length does. A v2
account read with v1 offsets would not error — it would return a session with
the mint where the settlement authority is. `gateway/src/chain.rs` refuses any
length that is not exactly one of the two.

A session whose account cannot be read **fails closed**. Guessing the version
picks a signing key, and the wrong key submits a transaction the program
refuses.

---

## Behaviour, per version

| | v1 session | v2 session |
| --- | --- | --- |
| Who may settle | the provider only (`provider: Signer`) | `session.settlement_authority` **or** the provider |
| Gateway holds | the provider's private key | its own authority key |
| Settlement count | exactly once (`init` on the receipt) | repeatable, monotonic |
| `settled_amount` | that one settlement's delta | the cumulative total |
| `merkle_root` | final — it can never change | the **latest**; a later settlement commits a root over more leaves |
| Destination | `session.provider` | `session.provider` — unchanged |
| Refund | permissionless after expiry | permissionless after expiry — unchanged |

The claim format, Ed25519 verification, high-water mark, nonce monotonicity,
expiry handling, evidence hash chain and Merkle construction are **identical**
across both. Nothing about a v1 session's evidence or proofs is affected by v2
existing.

---

## Keys

Two variables, deliberately separate:

```
AGENTPAY_PROVIDER_KEYPAIR              legacy. The PROVIDER's own key.
                                       Settles v1 sessions only.
                                       Delete it when the last one drains.

AGENTPAY_SETTLEMENT_AUTHORITY_KEYPAIR  AgentPay's OWN key.
                                       Settles v2 sessions.
                                       Never a provider key.
```

They are read separately and logged separately at boot so that no single edit
can point the hosted authority at a provider's key.

A gateway with only the authority configured settles v2 sessions and reports
`ERR_SETTLEMENT_UNAVAILABLE` for v1 ones — which is correct, because it
genuinely cannot settle them and should not pretend otherwise.

---

## The cutover

1. **Deploy v2.** — **DONE.** v1 keeps serving every existing session. Nothing
   changed for anyone.
2. **Point new sessions at v2.** — **DONE.** Agents read `settlement_authority`
   from `/health` and bind it at `open_session`.
3. **Stop opening v1 sessions.** — **DONE** for any gateway configured as below:
   `AGENTPAY_PROGRAM_ID` is v2, so every new session is opened under v2, and
   `AGENTPAY_LEGACY_PROGRAM_ID` is v1, which is settle-and-refund only. A
   gateway still configured with v1 as its primary program will keep opening v1
   sessions — the cutover is per-deployment configuration, not a global switch.
4. **Drain.** — **NOT DONE.** Sessions are expiry-bounded — `MAX_SESSION_DURATION_SECS` is 30
   days, so the window is knowable and finite. Each remaining v1 session either
   settles, or expires and is refunded. `refund_session` is permissionless after
   expiry, so **nothing can get stuck**: if the provider vanishes, anyone can
   return the escrow to the agent.
5. **Retire.** — **NOT DONE.** When no v1 session has a non-zero vault, remove
   `AGENTPAY_PROVIDER_KEYPAIR`. AgentPay then holds no provider key at all.

   Until that point `AGENTPAY_PROVIDER_KEYPAIR` **remains necessary**, and it
   is necessary *only* for v1 sessions. New v2 sessions never load it: they
   settle with `AGENTPAY_SETTLEMENT_AUTHORITY_KEYPAIR`, which is AgentPay's own
   key and gives its holder no power to change a settlement's amount or its
   destination.

   No completion date is set, because the drain finishes when the last v1
   session settles or expires, and that is determined by those sessions, not by
   a schedule.

### Retirement condition, precisely

The v1 path may be removed when, for every session under
`3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U`:

```
deposited_total - cumulative_settled - refunded_total == 0
```

Until then the legacy branch stays, marked as legacy, and does nothing else.

---

## What must NOT happen during migration

- **Do not modify the v1 program.** It is live and holds real escrow.
- **Do not migrate session data.** There is nothing to migrate: v1 sessions
  live and die under v1.
- **Do not reuse `AGENTPAY_PROVIDER_KEYPAIR` as the authority.** The whole
  point is that they are different keys with different powers.
- **Do not assume a session's version from configuration.** Read it from the
  chain, every time.

---

## Residual risk, stated plainly

A compromised control plane can change a provider's **registered settlement
address**, so that *future* sessions bind an attacker's wallet. Existing
sessions are safe — their provider is inside the session PDA's seeds and cannot
move.

This cannot be fixed in the program, which never learns what a provider
"should" be; it only enforces what a session was opened with. It is a
control-plane integrity problem and it must be disclosed to providers.

## What is not claimed

Neither program has been audited by any third party. Devnet verification is
not production readiness and is not a security review: it shows the program
behaves as described on a public test cluster, with throwaway value.

Specifically **not** claimed:

- not audited, not on mainnet, not production-ready
- the v2 `merkle_root` is the **latest** root, not a final one — repeatable
  settlement means a later settlement commits a root over more leaves, so a
  proof exported now may not verify against a later root
- the migration is not finished; `AGENTPAY_PROVIDER_KEYPAIR` is still required
  for v1 sessions
- the provider still has a wallet and should keep its key as a fallback. The
  claim is that AgentPay does not hold that key — not that it does not exist
- a compromised control plane can change a provider's registered settlement
  address for **future** sessions (see "Residual risk" above)
