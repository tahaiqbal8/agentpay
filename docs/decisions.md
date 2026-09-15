# Architectural decisions — on-chain program

Per operating rule 0.6, every choice that materially affects security, custody, or
trust assumptions is recorded here with the alternative that was rejected.

## D1 — Ed25519 verification via instructions-sysvar introspection

**Chosen:** The agent's claim signature is verified by Solana's native Ed25519
precompile, submitted as the instruction immediately preceding `settle_session`.
The program reads the instructions sysvar and confirms the precompile was asked to
verify exactly `(session.agent, expected_claim_bytes)`.

**Rejected — gateway-side verification with an on-chain gateway authority.**
Simplest to build, but it makes the gateway able to forge claims up to the full
deposit. That directly contradicts the trust boundary ("gateway is trusted for
availability and policy, not custody"), so the product's central claim would be false.

**Rejected — verifying Ed25519 in pure Rust on-chain.** No syscall exists; a
software implementation does not fit the compute budget.

**Residual risk:** this is the sharpest edge in the program. The precompile runs as
a *separate* instruction and cannot report its result, so security rests entirely on
the program correctly re-reading what the precompile was asked to check. The known
attack is an instruction that makes the precompile verify one message while the
program reads a different one. `verify_ed25519_claim` defends by requiring all three
`*_instruction_index` fields to be `u16::MAX` (self-reference), so the signature,
public key, and message must all live inside the precompile instruction's own data.
**This function is the single highest-value target for review and testing.**

## D2 — Single settlement per session

**Chosen:** `SettlementRecord` is created with `init` at seeds
`[b"settlement", session]`, so a second `settle_session` fails at account creation.
The provider settles once, with the highest claim it holds.

**Divergence from the brief, flagged deliberately.** The v2 master prompt describes
cumulative monotonicity as though multiple partial settlements were expected, while
spec 2.2 describes a single settle that sets `is_settled = true`. These are not
compatible. Single-settle is implemented because it makes double-settlement
structurally impossible rather than a check that must be gotten right.

**Consequence:** the monotonicity check (`cumulative_amount > cumulative_settled`) is
currently defence-in-depth — `cumulative_settled` is always 0 when settle runs. It is
retained so that allowing partial settlement later does not silently open a hole.
**If you want multi-settle, say so — it changes this design.**

## D3 — `refunded_total` added to `Session`

**Chosen:** `Session` carries `refunded_total: u64` alongside `cumulative_settled`.
The invariant enforced is `cumulative_settled + refunded_total <= deposited_total`.

**Rejected — marking a refund by setting `cumulative_settled = deposited_total`.**
This achieves refund idempotency with no extra field, but corrupts the audit record:
the chain would report more settled than was actually paid to the provider. For a
product whose output is an audit trail, that is unacceptable.

**Divergence from spec 2.2's struct definition, deliberate.**

## D4 — Permissionless post-expiry refund

**Chosen:** after `expires_at`, *anyone* may call `refund_session`. Before expiry it
requires the agent's signature and `is_settled == true`.

**Rationale:** funds can only ever move to the agent's own token account, so a third
party triggering the refund cannot redirect them. Permissionless recovery is what
makes "the agent gets its money back with no gateway and no provider cooperation"
true — it does not depend on the agent being online or holding SOL for fees.

## D7 — The gateway holds the provider's signing key

**Chosen:** `settle_session` requires the provider's signature, so the gateway
loads a provider keypair from `AGENTPAY_PROVIDER_KEYPAIR` and signs settlement
transactions on their behalf. Without that variable the gateway runs
**verify-only**: claims are still verified and ordered, and `/v1/session/settle`
returns `ERR_SETTLEMENT_UNAVAILABLE` rather than failing somewhere deeper.

**Blast radius, bounded on-chain.** This is the only key the gateway holds, and
the program constrains what it can do:

- `provider_token_account.owner == provider` means a compromised gateway cannot
  redirect funds anywhere except the provider's own account.
- The Ed25519 precompile must verify the *agent's* signature over the claim, so
  the gateway cannot settle for more than the agent actually authorised.
- `init` on `SettlementRecord` means it cannot settle twice.

What a compromised gateway *can* do: settle earlier than the provider wanted, or
settle a lower claim than the highest one available. Both cost the provider
revenue; neither moves money to an attacker. The custody claim ("trusted for
availability and policy, not for custody") survives.

**Rejected — provider signs settlements itself.** Correct, and where this should
end up, but it requires a provider-side signing service and a callback protocol
that does not exist yet. Recorded as future work rather than pretended.

## D8 — `/v1/session/open` trusts its input

`deposited_total`, `agent`, `provider`, and `mint` are taken from the request and
are **not** reconciled against the on-chain `Session` account. A caller that
overstates `deposited_total` gets claims admitted that settlement would then
reject on-chain, because the program enforces `cumulative <= deposited_total`
itself. So the failure mode is a wasted resource, not stolen funds — but it is a
real gap, and the fix is to fetch and verify the session account at open time.

## D9 — `claim_tickets` is a high-water mark, not an audit log

**Chosen (per spec):** `claim_tickets.session_pubkey` is the PRIMARY KEY, so
there is exactly one row per session holding the highest accepted claim.

**Consequence, stated plainly.** Intermediate claims are *overwritten and
unrecoverable*. After a 40-call session the database can prove what the final
cumulative was; it cannot prove the 39 decisions that led there, and it holds
**no record of denials at all** — denied claims never reach this table.

That is in direct tension with the product thesis. "Every allowed and every
denied request is recorded, hash-chained, and committed as a Merkle root" needs
an append-only `decisions` table that this schema does not have, and the zero
merkle root currently sent to `settle_session` is the visible symptom.

This is fine as a settlement mechanism and insufficient as an evidence log. The
evidence log is separate work, not a tweak to this table.

## D10 — Ordering rules are not reimplemented in SQL

**Chosen:** `upsert_claim_high_water_mark` opens a transaction, takes
`SELECT ... FOR UPDATE` on the session row, and calls the same `evaluate_claim`
function the in-memory store uses. The conditional `WHERE EXCLUDED.cumulative >
claim_tickets.cumulative AND EXCLUDED.nonce > claim_tickets.nonce` on the upsert
is retained as defence-in-depth.

**Rejected — enforcing the rules purely in the upsert's WHERE clause.** Fewer
round trips, but it puts the security-critical logic in a second place that can
drift from the Rust copy, and the SQL copy is the one nobody unit-tests. It also
cannot express the expiry and deposit-ceiling checks without duplicating those
too.

**Why a row lock rather than a bare atomic upsert:** admitting a claim needs
session state (settled? expired? deposit ceiling?) *and* the current mark, then
a decision, then a write. Those must see a consistent world. The lock serialises
claims within one session — which they already are logically — while leaving
different sessions fully concurrent (tested).

## D11 — `sessions.expires_at` added to the specified schema

The requested schema had no expiry column, but the gateway must refuse claims on
an expired session, and after a restart it has nowhere else to learn the expiry
from. Stored as `BIGINT` unix seconds rather than `TIMESTAMPTZ` so it compares
bit-for-bit with the value the on-chain program enforces; a timezone conversion
here could drift from the chain.

## D5 — Clock skew tolerance

Expiry comparisons allow `CLOCK_SKEW_TOLERANCE_SECS = 30`. The tolerance is applied
in the *permissive* direction for settlement (a claim slightly past expiry still
settles) and therefore also delays permissionless refund by the same 30s, so the two
windows cannot overlap and double-spend the vault.

## D6 — Token-2022 via `token_interface`

All token operations use `anchor_spl::token_interface` and `transfer_checked` rather
than the legacy `token` module, so both SPL Token and Token-2022 mints work.
`transfer_checked` also forces the mint and decimals to be validated on every
transfer, which blocks substituted-mint attacks at the token program level.

---

# Verification status

**Toolchain installed and the program compiles.** `anchor build` exits clean (0 errors,
6 harmless `anchor-debug` cfg warnings), producing `target/deploy/agentpay.so` (243 KB)
and a full IDL: 3 instructions, 2 accounts, 21 error codes.

Installed versions on this machine:

| Tool | Version |
|---|---|
| rustc / cargo | 1.98.1 |
| Agave / Solana CLI | 4.1.2 (`src:182084b8`) |
| anchor-cli / avm | 1.2.0 (provenance-verified via avm) |
| Node / npm | 25.9.0 / 11.12.1 |
| `@anchor-lang/core` (TS client) | 1.2.0 |

> An earlier revision of this table recorded the Solana CLI as 4.2.2; the
> binary on PATH reports 4.1.2, which is what built and deployed the program.

## Resolved during the build

**`solana-program` was split apart in Solana 3.0.** This broke four imports that would
have been written straight from memory. `anchor_lang::solana_program` is now a thin
compatibility shim that does *not* re-export `ed25519_program`, `keccak`, or the
instructions-sysvar loaders (its `sysvar::instructions` module exposes only
`construct_instructions_data`). Resolved by taking direct dependencies:

- `solana-instructions-sysvar 3.0.1` → `load_current_index_checked`, `load_instruction_at_checked`
- `solana-sdk-ids 3.1.0` → `ed25519_program::ID`, `sysvar::instructions::ID`
- `solana-sha256-hasher 3.1.0` → claim hashing

The claim hash moved from keccak to **SHA-256**, which also aligns it with the
SHA-256 Merkle tree specified for the evidence log.

Both loader signatures were read from crate source and match usage:
`load_current_index_checked(&AccountInfo) -> Result<u16, ProgramError>` and
`load_instruction_at_checked(usize, &AccountInfo) -> Result<Instruction, ProgramError>`.

Confirmed working as written: `CpiContext::new(token_program.key(), ...)` with a
`Pubkey` under Anchor 1.x, `ctx.bumps.<name>` field access, `token::token_program`
constraint syntax, and `#[derive(InitSpace)]`.

## Runtime verification — executed against a local validator

Deployed to `solana-test-validator` (Agave 4.1.2) at program ID
`3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U`. The attack suite
(`tests/attacks.ts`, 24 tests) passes; `tests/diagnostics.ts` dumps the raw
on-chain failures for the two defences that are structural rather than Anchor
error codes, so the loose regexes in the suite are checked rather than trusted.

Every previously-open assumption is now resolved:

| Assumption | Prior risk | Outcome |
|---|---|---|
| Ed25519 precompile layout `[num_sigs u8][padding u8][7 × u16 offsets]` parsed correctly | High | **Confirmed.** Canonical header observed: `numSignatures=1, padding=0, signatureOffset=48, publicKeyOffset=16, messageOffset=112, messageSize=73` |
| `u16::MAX` self-reference sentinel is what real clients emit | High | **Confirmed.** `Ed25519Program.createInstructionWithPrivateKey` emits `65535` for all three instruction-index fields. Strict checking accepts valid claims (happy path settles) and rejects indirect references |
| `init` on `settlement_record` rejects the second settle | Medium | **Confirmed.** Second settle fails in the System Program: `Allocate: account 3robLv… already in use`. Provider balance stays at exactly one payment |
| Permissionless post-expiry refund with no agent signature | Medium | **Confirmed.** A third-party `rescuer` keypair recovered the full 3 USDC deposit to the agent's ATA; the agent never signed |
| PDA signer seeds authorise the vault transfer | Medium | **Confirmed.** Both settle and refund move tokens out of the vault under session-PDA authority |

### The indirect-reference defence is genuinely ours

Worth stating precisely, because it is easy to get false comfort here. A
standalone transaction containing the tampered Ed25519 instruction — offsets
intact but all three instruction-index fields set to `0` instead of the
sentinel — **lands successfully on chain**. The precompile accepts it. So when
the attack test gets `Ed25519IndirectReference`, that rejection is
`verify_ed25519_claim` firing, not the precompile doing the work for us.

### Honest limitation: monotonicity is still untested as such

`ClaimNotMonotonic` is covered by a test, but only in the degenerate form
`cumulative_amount == 0`. Under D2 (single settle), `cumulative_settled` is
always `0` when `settle_session` runs, so a *prior non-zero settled value*
is unreachable state and the ordering comparison cannot be exercised. The check
remains defence-in-depth for a future multi-settle design, as D2 says — but no
test currently proves it orders two non-zero claims correctly, and none can
until multi-settle exists.

### Devnet verification — Solana v4.3.0-rc.0

The same 24 tests plus the diagnostics were re-run against public devnet, whose
cluster runtime is **v4.3.0-rc.0** — a different minor version from the local
validator (4.1.2) that the program was developed against.

| | Localnet 4.1.2 | Devnet 4.3.0-rc.0 |
|---|---|---|
| Attack suite | 24 passing | **24 passing** |
| Ed25519 header offsets | 48 / 16 / 112, size 73 | **identical** |
| Instruction-index sentinels | 65535 × 3 | **identical** |
| Double settle | `Allocate: … already in use` | **identical** |
| Precompile accepts indirect reference | yes | **yes** |

Deployment:

- Program: `3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U`
- ProgramData: `8yRjSoqWWpwbUsKtXAEAzrymYaqawHDith8e6BVY53Xw`
- Deploy signature: `32umQj6KRURYVUSd1MQZo2XQeLYUu2k5BGfNGFUunVAZcdjJFPSghydvXXDt7nVXzQrn9cjpyuFhctNKbdXWaTRt`
- Slot 498755700, 243560 bytes, upgrade authority `78Q6uycb…d3VHc`

The version-skew question the run was meant to answer: **the precompile contract
did not change between 4.1.2 and 4.3.0-rc.0.** In particular 4.3.0-rc.0 still
*accepts* an Ed25519 instruction whose index fields name an instruction
explicitly rather than using the `u16::MAX` sentinel, which is what keeps
`verify_ed25519_claim` load-bearing rather than redundant. Compute for
`settle_session` rose from 7,955 CU (local) to 12,455 CU (devnet) — same
program, so this is runtime metering differences, not a code change. Both are
far inside the 203,000 CU budget.

### Public-cluster test harness

Devnet exposed two harness bugs that localnet could not:

1. `.rpc()` calls were not wrapped in `withRpcRetry`, so `429` and
   `Blockhash not found` surfaced as *test* failures and looked like security
   failures. Now wrapped, with throttling between transactions
   (`PUBLIC_RPC_THROTTLE_MS`, default 400ms). The retry predicate still refuses
   to retry anything carrying an Anchor error code, so an attack assertion can
   never be masked by a retry.
2. The expiry fixtures used a 3-second window, which is fine locally but arrives
   already expired on devnet once rate-limit backoff is counted — it failed with
   `ExpiryInPast`. The window is now cluster-dependent (3s local, 90s public).

`AnchorProvider.env()` defaults to `processed` commitment; the suite now builds
its provider at `confirmed`, which removed most spurious blockhash errors.

### Gateway settlement — executed on devnet

`POST /v1/session/settle` assembles the two-instruction transaction the program
requires, signs as the provider, and submits it. Verified end to end
(`npm run settle-devnet`): a real escrow session was opened on devnet, four
claims were authorised off-chain, and **one** transaction settled them all.

```
session    CqSLKQ5FQLNv9VEaQJFEL2cMGpsTLYRd521qfwFK6FZL
settle tx  cpdrU9cMVzePF7s34nvRMzDBB9JDS7WGgCEM22BkQtBxZkv6D4vAEvK3p7JrBYEYZCCVUB24LSbgdD6ubdAJ1Sh
slot       498820656          fee 0.00001 SOL
provider   +1,234,567 micro-USDC      vault 5,000,000 -> 3,765,433
```

Confirmed independently with `solana confirm -v` rather than trusting the
gateway's own response:

- **ix[0]** `Ed25519SigVerify`, header `[1, 0, 48,0, 255,255, 16,0, 255,255,
  112,0, 73,0, 255,255]` — one signature, offsets 48/16/112, message size 73,
  all three instruction-index fields `65535`. The message bytes carry
  `agentpay:claim:v1`.
- **ix[1]** the program, discriminator `[156,20,180,117,117,85,225,128]`
  (`sha256("global:settle_session")[..8]`), then `1234567` and nonce `4` as
  little-endian u64s, then 32 zero bytes for the evidence root.
- A second settle attempt returned `403 ERR_SESSION_SETTLED`.

The merkle root is currently **all zeroes**, meaning "no evidence committed".
That is deliberate until the evidence log exists — a fabricated digest would be
worse than an honest zero.

The token program is read from the mint account's owner rather than assumed, so
a Token-2022 mint settles through Token-2022 without special-casing. That path
still has no test.

### Durable store — the restart hole is closed

`InMemorySessionStore` is replaced by PostgreSQL via sqlx 0.8. The claim
high-water mark now survives a restart, so a gateway bounce is no longer a
security event.

Proven end to end against a real process, not just unit tests:

```
boot 1     rehydrated 50 sessions
phase 1    ladder 100000 -> 250000 -> 900000   (all ALLOW)
kill -9    no graceful shutdown; confirmed not serving
boot 2     rehydrated 51 sessions, marks restored from postgres
phase 2    replay of 900000      -> 403 ERR_CLAIM_NOT_MONOTONIC
           regression to 500000  -> 403 ERR_CLAIM_NOT_MONOTONIC
           cumulative 1000000    -> 200, delta measured against 900000
```

That last line matters: the delta was computed from the *restored* mark rather
than from zero, so the restored state is correct and not merely present.

55 tests pass with a database attached; 42 pass without one. The build is
hermetic — runtime `sqlx::query` is used rather than the `query!` macro, so
`cargo build` needs no live database and no `.sqlx` cache. The trade is losing
compile-time SQL verification; `cargo sqlx prepare` could buy it back at the
cost of a checked-in cache that can go stale.

**A test bug worth recording.** The concurrency test passed in the full suite
and failed 20/20 in isolation. The cause was `Pubkey::new_unique()`, which
increments a process-static counter and therefore produces identical pubkeys on
every `cargo test` invocation — so each run collided with the previous run's
rows and every claim was correctly rejected as non-monotonic, which the test
silently counted as "not admitted". Two fixes: genuinely random pubkeys, and
counting admitted / rejected / errored separately so a future failure is
diagnosable rather than ambiguous. It now asserts exactly 1 admitted, 15
refused, 0 errors, and passes 20/20 in isolation.

### Not covered by this suite

- Concurrent duplicate settlement (the gateway-side dedup hazard). That is an
  off-chain correctness problem and belongs to the gateway phase; on-chain, the
  `settlement_record` PDA already makes a second settle impossible.
- Token-2022 mints. Every test uses `TOKEN_PROGRAM_ID`. The `token_interface`
  code path for Token-2022 compiles but has never executed.
- Compute-unit headroom under adversarial input sizes.
- Vault substitution, which is structurally blocked by `has_one = vault` plus
  the seeds constraint, but has no dedicated test.

# External facts verified this session, with sources

- Anchor current release **1.2.0** (2026-09-04) — [anchor-lang.com/docs/installation](https://www.anchor-lang.com/docs/installation)
- Anchor repo transferred `coral-xyz` → **`otter-sec/anchor`** (confirmed by GitHub redirect: identical star/fork/commit counts on both URLs)
- Anchor 1.0 breaking change: **CPI context no longer takes program `AccountInfo`** (#2762) — [release notes](https://www.anchor-lang.com/docs/updates/release-notes/1-0-0)
- Anchor 1.0 breaking change: TS package `@coral-xyz/anchor` → **`@anchor-lang/core`** (#4141) — affects the test suite, not this file
- Anchor 1.x requires **Solana 3.0+** (#4031)
- Solana/Agave CLI install channel and current tag **v4.3.0-rc.1** — [docs.anza.xyz/cli/install](https://docs.anza.xyz/cli/install)
- Docs reference `solana-cli 4.1.2` + `anchor-cli 1.2.0` + `rustc 1.85.0` as a known-good triple
