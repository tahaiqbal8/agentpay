# AgentPay — Settlement Custody Redesign

**Status: IMPLEMENTED. Option C (§5) was built, deployed to devnet as program
v2 `ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m`, and verified there. See
[RELEASE_V2.md](RELEASE_V2.md) for the evidence and
[MIGRATION_V1_V2.md](MIGRATION_V1_V2.md) for the migration state.**

**This document is kept as the design record, and is written in the present
tense of the time it was produced.** Where it says "the program" without
qualification, it describes **v1** — the program as it stood before the
redesign. v1 is still deployed and still serves the sessions it already holds,
so that description remains accurate for those sessions. Options A, B and D
were considered and not built.

Read-only analysis of the Anchor program at commit `09855df`, program id
`3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U` (v1).

Classification used throughout:
`[NO CHANGE]` `[PROGRAM CHANGE]` `[GATEWAY CHANGE]` `[NEW SIGNING MESSAGE]`
`[ACCOUNT MODEL CHANGE]` `[MIGRATION]`

---

# 0. The finding that reframes the question

**The program already verifies the agent's Ed25519 signature over the exact
settlement amount, and the destination is already immutable per session.**

`settle_session` today:

```rust
let expected = build_claim_message(&session_key, cumulative_amount, nonce, claim_expires_at);
verify_ed25519_claim(
    &ctx.accounts.instructions_sysvar,
    &ctx.accounts.session.agent,   // ← the agent, not the provider
    &expected,
)?;
```

and its accounts:

```rust
pub provider: Signer<'info>,

#[account(
    seeds = [SESSION_SEED, session.agent.as_ref(), session.provider.as_ref(), session.session_id.as_ref()],
    has_one = provider @ AgentPayError::UnauthorizedSettler,   // signer == session.provider
)]
pub session: Account<'info, Session>,

#[account(
    constraint = provider_token_account.owner == provider.key(),  // destination bound
)]
pub provider_token_account: InterfaceAccount<'info, TokenAccount>,
```

So, today, already:

| Property | Enforced by | Depends on `provider: Signer`? |
| --- | --- | --- |
| The amount was authorised by the agent | Ed25519 precompile introspection over the 73-byte claim | **No** |
| The amount cannot exceed the deposit | `cumulative_amount <= deposited_total` | **No** |
| The amount must increase | `cumulative_amount > cumulative_settled` | **No** |
| Funds go only to `session.provider` | `has_one = provider` + `token_account.owner == provider` | **No** |
| `session.provider` can never change | it is a PDA seed | **No** |
| Settlement happens at most once | `init` on the `SettlementRecord` PDA | **No** |

**`provider: Signer` protects neither the amount nor the destination.** Both
are already protected by stronger, non-custodial constraints.

What it actually provides is exactly two things:

1. `payer = provider` — the provider funds the `SettlementRecord` rent.
2. **Choice of moment and of claim.** Only the provider decides *when* to
   settle and therefore *which* of the agent's signed claims becomes final.

Point 2 is the entire security question. It is not about theft.

---

# 1. Current settlement flow

```
Agent signs claim_N  ──────────────────┐   (off chain, 73 bytes)
                                       │
Gateway: verify → policy → admit → forward → evidence
                                       │
Provider (holding its own key) calls settle_session:
   ├─ Ed25519 instruction carrying agent's signature over claim_N
   ├─ session PDA (agent, provider, session_id)
   ├─ settlement_record PDA  (init → once only)
   ├─ vault PDA
   └─ provider_token_account (owner == session.provider)
                                       │
Program: expiry → claim expiry → monotonic → ≤ deposit
       → verify_ed25519_claim(agent)
       → transfer delta: vault → provider_token_account
       → write SettlementRecord {claim_hash, merkle_root, settled_amount}
       → session.is_settled = true
```

The gateway satisfies `provider: Signer` by loading
`AGENTPAY_PROVIDER_KEYPAIR` and refusing any session whose provider differs:

```rust
if provider_keypair.pubkey() != record.provider { ... refuse ... }
```

---

# 2. The exact custody problem

One gateway process can settle for exactly one provider, because it must hold
that provider's private key. To host N providers, AgentPay would hold N private
keys and become a custodian.

**But per §0, custody is not required to protect the money.** It is required
only to satisfy a signer check that guards *timing*. That is a much smaller
problem than it looks, and it has a non-custodial answer.

---

# 3. Option A — permissionless settlement, fixed destination

Remove `provider: Signer`. Anyone may submit a valid agent-signed claim; funds
can only reach `session.provider`.

**Does `amount <= deposit` suffice to authorise the amount?**
No — and it does not have to. The **agent's Ed25519 signature** authorises the
amount. A caller cannot invent an amount; they can only present an amount the
agent actually signed. `amount <= deposit` is a secondary bound.

**So what breaks?**

> ### The stale-claim lock-out
>
> `settlement_record` is `init`, so settlement happens **once**. An attacker who
> has seen an early claim — say `cumulative = 100_000` from a session that
> later reached `750_000` — submits that early claim first. Settlement
> succeeds, the PDA now exists, and **no further settlement is possible**. The
> provider receives 100,000 instead of 750,000. The remaining 650,000 returns
> to the agent at expiry via the permissionless `refund_session`.

This is not theft from the vault; it is **under-payment of the provider**, and
the beneficiary is the agent. A **malicious agent** can therefore pay for
750,000 of API calls and settle only the first 100,000 of them.

Claims are presented to the gateway over the wire and recorded in a public
evidence log, so early claims are not secret. This attack is cheap.

**Verdict: Option A alone is unsafe.** Not because the amount is unauthorised,
but because *which authorised amount becomes final* is up for grabs.

---

# 4. Option B — a separate agent-signed settlement authorization

Introduce a new domain-separated message:

```
"agentpay:settle:v1" ‖ session(32) ‖ provider(32) ‖ cumulative(8) ‖ nonce(8) ‖ expires_at(8)
```

**Assessment: unnecessary, and it adds risk.**

The agent **already signs** `cumulative_amount` for this session under
`"agentpay:claim:v1"`. A settlement authorization would carry the same
commitment under a different domain. It would:

- add a second signing path to every agent and to the SDK `[NEW SIGNING MESSAGE]`
- create a new way for agent and gateway to disagree about the final amount
- not fix §3, because a *stale settlement authorization* is exactly as
  replayable as a stale claim

**Correctly rejecting the reuse question:** the brief is right that the 73-byte
claim format must not be casually repurposed. But it is not being repurposed —
`settle_session` has verified claims under `"agentpay:claim:v1"` since the
program was written. That is the existing design, not a new reuse.

The one thing a settlement message could add is binding the **provider** into
the signed bytes. That is already redundant: `session` is in the seeds derived
from `provider`, so a signature over `session` transitively commits to the
provider.

**Verdict: reject.** It solves nothing §5 does not solve more simply, and every
new signing path is new attack surface.

---

# 5. Option C — a session-bound settlement authority `[RECOMMENDED]`

Replace the provider signer with an authority chosen **at session open** and
recorded immutably on the session.

```rust
pub struct Session {
    ...
    pub settlement_authority: Pubkey,   // [ACCOUNT MODEL CHANGE]
}
```

`settle_session` accepts a `settler: Signer` where:

```rust
require!(
    settler.key() == session.settlement_authority || settler.key() == session.provider,
    AgentPayError::UnauthorizedSettler
);
```

- **AgentPay's hosted gateway holds its own key** as `settlement_authority`. It
  is AgentPay's key. It is never the provider's key. No custody.
- **The provider retains its own path.** If AgentPay disappears, is compromised,
  or is fired, the provider signs with its own wallet — from a browser wallet,
  once, manually. No service to run.
- `payer` becomes the settler, so AgentPay funds the rent. At 0.00001 SOL that
  is a rounding error and a reasonable hosting cost.

Destination remains bound by the existing constraints — unchanged `[NO CHANGE]`.

### But Option C alone still has the §3 problem

A compromised gateway can settle at a **stale, lower** agent-signed amount and
lock the provider out. Funds are not stolen, but the provider is under-paid.

### The fix: monotonic, repeatable settlement `[PROGRAM CHANGE]`

The program **already contains the logic**:

```rust
require!(cumulative_amount > ctx.accounts.session.cumulative_settled, ClaimNotMonotonic);
let delta = cumulative_amount - session.cumulative_settled;
session.cumulative_settled = cumulative_amount;
```

Only the `init` constraint on `SettlementRecord` forces once-only. Change the
record from create-once to **create-or-advance**, and:

- settling early at 100,000 transfers 100,000
- settling again at 750,000 transfers the 650,000 delta
- settling again at 750,000 or below is refused by the existing monotonic check
- the vault can never pay out more than `cumulative_settled`, which can never
  exceed `deposited_total`

**Stale-claim settlement stops being an attack and becomes a no-op delay.**
Anyone — gateway, provider, or a stranger — can push settlement forward. Nobody
can push it backward.

Do **not** use Anchor's `init_if_needed` for this: it is a known
reinitialization footgun. Use an explicit `create` instruction plus an
`advance` path, or a manually-checked discriminator. This detail must be part
of the audit scope.

---

# 6. Option D — provider signature as optional authorization

Keep `provider: Signer` as one of several accepted settlers, never as the only
one. This is already folded into §5 as the fallback branch. As a *standalone*
design it is the status quo and does not solve custody.

**Verdict: keep as a fallback, reject as the primary mechanism.**

---

# 7. Threat model

Under the recommended design (§5: session-bound authority + monotonic
repeatable settlement + immutable destination).

| # | Threat | What happens | Funds lost? | By whom | Recoverable | On-chain constraint |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Honest gateway** | settles at the highest admitted claim | no | — | — | all of the below |
| 2 | **Compromised gateway** | can settle any *agent-signed* amount to the provider's fixed wallet; can settle low, or not at all | **no theft**; provider payment delayed | provider (timing only) | yes — anyone settles again higher | `token_account.owner == session.provider`; Ed25519 over amount; monotonic |
| 3 | **Malicious provider** | can settle itself at any agent-signed amount | no | — | — | cannot exceed a signed claim or the deposit |
| 4 | **Malicious agent** | presents stale low claim to under-pay | **no** — provider re-settles higher | — | yes | monotonic advance |
| 5 | **Third-party attacker** | may trigger settlement; funds go to the provider regardless | no | — | — | destination bound to `session.provider` |
| 6 | **Replay of authorization** | resubmitting a settled claim | no | — | — | `cumulative > cumulative_settled` refuses equal or lower |
| 7 | **Double settlement** | second settle at the same amount | no | — | — | same monotonic check |
| 8 | **Over-settlement** | amount above the escrow | no | — | — | `cumulative <= deposited_total` **and** `cumulative + refunded <= deposited_total` |
| 9 | **Wrong destination** | gateway names an attacker's token account | **impossible** | — | — | `owner == session.provider`; provider is a PDA seed |
| 10 | **Stale authorization** | old claim past `claim_expires_at` | no | — | — | `now <= claim_expires_at + skew` |
| 11 | **Concurrent settlement** | two txs, same session | one wins | no | — | account write lock + monotonic check refuses the loser |
| 12 | **Gateway DB corruption** | gateway loses the high-water mark | no theft; may settle stale or refuse | provider (timing) | yes | chain never trusts the DB; amount needs an agent signature |
| 13 | **Gateway DB rollback** | gateway replays an older state | cannot settle backwards | no | — | `cumulative_settled` lives **on chain**, not in Postgres |
| 14 | **Solana tx replay** | rebroadcast a settle tx | fails | no | — | blockhash expiry + monotonic check |
| 15 | **Provider wallet rotation** | provider changes wallet | old sessions still pay the old wallet | no | — | see §14 |

## The property the brief asked for

> A compromised gateway must not be able to redirect provider payment to an
> arbitrary wallet, and at worst can submit an already-authorized amount but
> cannot manufacture authorization for an amount the agent never authorized.

**This property is achieved, and it is achieved today** — it does not require a
new agent-signed settlement message. It follows from two constraints that
already exist:

- `provider_token_account.owner == session.provider`, with `provider` baked
  into the session PDA seeds → **redirection is impossible**
- `verify_ed25519_claim(session.agent, claim_message(cumulative_amount))` →
  **the gateway cannot manufacture an amount**

The recommended change removes the custody requirement **without weakening
either**, and the monotonic-settlement change strictly *improves* the
compromised-gateway case from "can permanently under-pay" to "can delay".

---

# 8. Recommended architecture

```
Provider registers a settlement wallet address   (address only — never a key)
        │
open_session binds, immutably, for this session:
        ├─ agent                 (PDA seed)
        ├─ provider              (PDA seed)  ← destination owner
        └─ settlement_authority              ← who may trigger
        │
Agent signs cumulative claims        "agentpay:claim:v1"   [NO CHANGE]
        │
Gateway: verify → policy → admit → forward → evidence      [NO CHANGE]
        │
settle_session, callable by settlement_authority OR provider
        ├─ amount bounded by the agent's signature          [NO CHANGE]
        ├─ destination bound to session.provider            [NO CHANGE]
        └─ monotonic, repeatable                            [PROGRAM CHANGE]
        │
        ▼
Immutable provider wallet
```

AgentPay holds: its own settlement authority key.
AgentPay never holds: any provider private key.
The provider runs: nothing.

---

# 9. Exact Anchor account/state changes

```rust
pub struct Session {
    pub agent: Pubkey,
    pub provider: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub deposited_total: u64,
    pub cumulative_settled: u64,
    pub refunded_total: u64,
    pub expires_at: i64,
    pub session_id: [u8; 16],
    pub bump: u8,
    pub vault_bump: u8,
    pub is_settled: bool,
+   pub settlement_authority: Pubkey,   // [ACCOUNT MODEL CHANGE] +32 bytes
}
```

`SettlementRecord` gains nothing structurally but changes lifecycle from
create-once to create-then-advance `[PROGRAM CHANGE]`:

```rust
pub struct SettlementRecord {
    pub session: Pubkey,
    pub claim_hash: [u8; 32],     // latest settled claim
    pub merkle_root: [u8; 32],    // latest committed root  ← see §17
    pub settled_at: i64,          // latest
    pub settled_amount: u64,      // now CUMULATIVE, not the delta
    pub bump: u8,
}
```

> `settled_amount` currently stores the **delta** of the single settlement.
> Under repeatable settlement it must become the cumulative total, or a reader
> cannot tell what was paid overall. This is a semantic change to a published
> field and every consumer must be updated — the gateway's `chain.rs` decoder
> and the console both read it.

---

# 10. Exact instruction changes

| Instruction | Change |
| --- | --- |
| `open_session` | accept `settlement_authority: Pubkey` as an argument; store it. Default it to `provider` when the caller does not care. `[PROGRAM CHANGE]` |
| `settle_session` | `provider: Signer` → `settler: Signer`; add the OR check; `payer = settler`; record becomes create-or-advance `[PROGRAM CHANGE]` |
| `refund_session` | `[NO CHANGE]` |
| claim verification | `[NO CHANGE]` |

---

# 11. Authorization messages

**No new signing message.** `[NO CHANGE]`

The only signed message remains the 73-byte
`"agentpay:claim:v1" ‖ session ‖ cumulative_le ‖ nonce_le ‖ expires_at_le`.
The SDK, the gateway's `claim.rs`, and the byte-pinned cross-language test are
all untouched.

---

# 12. Replay protection

Unchanged and sufficient: `cumulative_amount > session.cumulative_settled` is
evaluated **on chain**, so a replayed settlement — of any age, from any caller,
after any gateway database loss — is refused. The high-water mark for
*settlement* has always lived on chain; only the mark for *admission* lives in
Postgres, and they protect different things.

---

# 13. Concurrent settlement

Two settlements for one session in the same slot: Solana serialises writes to
the `session` account. The first advances `cumulative_settled`; the second
fails the monotonic check unless it carries a strictly higher amount, in which
case it correctly pays the remaining delta. No lock, no coordination, no
double-spend.

---

# 14. Provider wallet rotation

**Sessions must stay bound to the wallet they were opened with.**

- `provider` is a PDA seed. Changing it would change the session address and
  orphan the vault. It is therefore immutable by construction — this is already
  true today `[NO CHANGE]`.
- Rotation is a **registry-level** operation: the provider updates its
  settlement address, and **new** sessions bind to the new wallet. Old sessions
  settle to the old wallet.
- The provider must retain the old key until all sessions opened against it are
  settled or expired. Sessions are expiry-bounded, so this window is short and
  knowable.
- Mutable on-chain destination is explicitly rejected: it would let whoever can
  write that field redirect funds, which is the exact risk this whole document
  exists to remove.

---

# 15. Gateway compromise analysis

| Can a compromised gateway… | Answer | Why |
| --- | --- | --- |
| steal escrowed funds | **No** | destination is `session.provider`'s token account, bound via PDA seeds |
| redirect payment to an attacker wallet | **No** | same |
| inflate the settled amount | **No** | requires an Ed25519 signature from `session.agent` over that amount |
| settle an amount the agent never signed | **No** | same |
| settle a stale lower amount | **Yes** | mitigated: anyone can advance settlement afterwards |
| refuse to settle | **Yes** | mitigated: the provider can settle itself |
| forge evidence | Out of scope here | the evidence chain is a separate control |
| change the provider's registered wallet for future sessions | **Yes** | this is the residual risk — see below |

### The residual risk, stated plainly

The gateway hosts the registry, so a compromised gateway could change a
provider's **registered settlement address** so that *future* sessions bind to
an attacker's wallet. Existing sessions are safe; new ones are not.

Mitigations (all `[GATEWAY CHANGE]`, none in the program):
- the provider's settlement address requires confirmation out of band on change
- the address is displayed prominently in the provider console with a change log
- an address change notifies the provider

This is a control-plane integrity problem, not a custody problem, and it cannot
be solved by the program because the program never learns what the provider
"should" be — it only enforces what a session was opened with.

**This must be disclosed to providers.** It is the honest residual.

---

# 16. Migration from the current devnet program

**The existing program cannot be upgraded in place for existing sessions.**

Adding `settlement_authority: Pubkey` grows `Session` by 32 bytes. Existing
session accounts were allocated at the old size; deserialising them with the
new struct fails because the account data is too short. Anchor cannot grow an
account it did not allocate room for.

Options considered:
- reserved padding — there is none in the current layout
- `realloc` on every touch — adds a payer and a failure mode to the money path
- **drain and cut over** — chosen

### Chosen path `[MIGRATION]`

1. Deploy the changed program under a **new program id**.
2. The gateway runs **both** ids: old sessions resolve to the old program, new
   sessions open under the new one. `AGENTPAY_PROGRAM_ID` becomes a pair.
3. Stop opening sessions on the old program.
4. Wait out the longest session expiry. Sessions are short-lived by design.
5. Settle or refund every remaining old session. `refund_session` is already
   permissionless after expiry, so nothing can get stuck.
6. Retire the old id.

Devnet has no real value at risk, so this is a scheduling exercise, not a
financial one. On mainnet it would need announcement and a migration window.

---

# 17. What happens to existing sessions

- Existing sessions keep settling under the **old** program, with
  `provider: Signer`. The gateway keeps `AGENTPAY_PROVIDER_KEYPAIR` **for those
  sessions only**, and only for the single provider it already serves.
- Existing `SettlementRecord` accounts are untouched and remain readable.
- **Existing Merkle roots and every published inclusion proof remain valid.**
  Nothing in the evidence chain, the hash preimage, or the Merkle construction
  changes.

### One property does change, and it must be stated

Under repeatable settlement, `SettlementRecord.merkle_root` becomes the
**latest** committed root rather than a final one. The evidence log is
append-only, so a later settlement commits a root over more leaves.

- The Verifier stays correct: it fetches a fresh proof against the current log
  and compares it to the current on-chain root. Both advance together.
- But a proof **captured and published earlier** — exported, screenshotted,
  pasted into a report — will no longer verify against the new root.

Today roots are final because settlement happens once. That is a real property
being traded away for the ability to recover from a stale settlement.

**DECIDED: recoverability wins.** Settlement is monotonic and repeatable, and
`SettlementRecord.merkle_root` is the LATEST committed root rather than a
permanently final one. The trade was accepted knowingly because a stale
settlement that permanently underpays a provider has no recovery at all, while
a stale exported proof can simply be re-exported.

Carried through to: the program (`settled_amount` is cumulative), the gateway
(`root_may_advance` on `/v1/session/{s}/settlement`), the SDK (`settle()` and
`Settlement.merkleRoot`), and the console (the Verifier warns beside the proof
when the root can still move). Nothing in the product describes the root as
final.

---

# 18. Test plan

Program:
1. settle by `settlement_authority` succeeds
2. settle by `provider` succeeds (fallback path)
3. settle by an unrelated signer fails `UnauthorizedSettler`
4. settle to a token account owned by anyone else fails
5. settle with a signature from a key that is not `session.agent` fails
6. settle with an amount the agent did not sign fails
7. settle above `deposited_total` fails
8. settle at or below `cumulative_settled` fails
9. settle low, then settle high → exactly the delta moves
10. two concurrent settlements → one wins, totals correct
11. settle after expiry + skew fails
12. `settled_amount` reads as cumulative, not delta
13. `refund_session` after partial settlement refunds exactly the remainder
14. rotation: new session binds the new wallet, old session still pays the old

Gateway:
15. no `AGENTPAY_PROVIDER_KEYPAIR` configured → settlement still works via the
    settlement authority
16. old-program sessions still settle under the old rules during migration

Regression — must be byte-identical:
17. the 73-byte claim vector test
18. every existing Merkle root recomputes to the same value
19. `npm test` (replay, forgery, high-water)
20. `npm run evidence:v1-legacy` end to end

---

# 19. Mainnet and audit requirements

Nothing here goes to mainnet without:

- an external audit of the program, scoped explicitly to: the create-or-advance
  `SettlementRecord` lifecycle (reinitialization), the settler OR-check, and
  arithmetic on `cumulative_settled` / `refunded_total`
- a written argument that no path allows payout above `deposited_total`
- review of the Ed25519 precompile introspection, including all three
  instruction-index fields being `u16::MAX`
- a decision on the §17 root-finality trade-off
- disclosure of the §15 residual registry risk to every provider

The current program has **never been audited**. That is true today and stays
true after this change.

---

# 20. What cannot be claimed after implementation

Even with all of this shipped, these statements would be **false** and must not
be made:

- ❌ "AgentPay cannot affect provider payment." It can delay it, and it controls
  the registry that future sessions bind to (§15).
- ❌ "The provider needs no wallet." It needs a wallet **address**, and should
  retain the key as a fallback and across rotation (§14).
- ❌ "Settlement is trustless." Triggering is permissioned to the settlement
  authority or the provider.
- ❌ "Funds can never be lost." Nothing here protects against a lost agent key
  or a lost provider key.
- ❌ "This is audited / production-ready / secure." It is none of these.
- ❌ "The committed root is final." Not under repeatable settlement (§17).

What **can** be claimed, and is true:

- ✅ AgentPay never holds a provider private key.
- ✅ A compromised gateway cannot redirect funds to any wallet other than the
  provider's, and cannot manufacture an amount the agent did not sign.
- ✅ The provider writes no payment code and runs no signing service.
- ✅ Every settled amount is backed by an Ed25519 signature from the agent.
- ✅ Escrow can always be recovered by the agent after expiry, permissionlessly.

---

# Summary

**Removing the provider signer does not weaken security — provided settlement
becomes monotonic and repeatable.** The custody requirement was never what
protected the money; the agent's signature and the PDA-bound destination were,
and both are already in the program today.

A protocol upgrade **is** required, and it **cannot** be done in place: the new
`Session` field forces a new program id and a drain-and-cut-over migration.

The one genuine trade-off is §17 — root finality versus settlement
recoverability. That decision should be made before any code is written.
