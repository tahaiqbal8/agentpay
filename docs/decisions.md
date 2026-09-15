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
| Agave / Solana CLI | 4.2.2 (`src:e29e5d91`) |
| anchor-cli | 1.2.0 (provenance-verified via avm) |
| Anchor-managed SBF toolchain | 4.1.2 |

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

## Still unverified — compiles, but not yet executed

`anchor build` proves the code typechecks. It proves **nothing** about runtime
behaviour. These remain open until the attack test suite runs against a validator:

| Assumption | Risk |
|---|---|
| Ed25519 precompile data layout `[num_sigs u8][padding u8][7 × u16 offsets]` is parsed correctly | **High** — silently wrong parsing means claim verification passes on forged input |
| `u16::MAX` self-reference sentinel is what real clients emit | **High** — if clients emit the literal instruction index, strict checking rejects *valid* claims and settlement never works |
| `init` on `settlement_record` actually rejects the second settle | Medium — the double-settle defence, untested |
| Permissionless post-expiry refund works with no agent signature | Medium — the central trust claim, untested |
| PDA signer seeds authorise the vault transfer | Medium — untested |

**No instruction in this program has ever been executed.** Nothing here should be
treated as working until Phase 3 (attack suite) is green.

# External facts verified this session, with sources

- Anchor current release **1.2.0** (2026-09-04) — [anchor-lang.com/docs/installation](https://www.anchor-lang.com/docs/installation)
- Anchor repo transferred `coral-xyz` → **`otter-sec/anchor`** (confirmed by GitHub redirect: identical star/fork/commit counts on both URLs)
- Anchor 1.0 breaking change: **CPI context no longer takes program `AccountInfo`** (#2762) — [release notes](https://www.anchor-lang.com/docs/updates/release-notes/1-0-0)
- Anchor 1.0 breaking change: TS package `@coral-xyz/anchor` → **`@anchor-lang/core`** (#4141) — affects the test suite, not this file
- Anchor 1.x requires **Solana 3.0+** (#4031)
- Solana/Agave CLI install channel and current tag **v4.3.0-rc.1** — [docs.anza.xyz/cli/install](https://docs.anza.xyz/cli/install)
- Docs reference `solana-cli 4.1.2` + `anchor-cli 1.2.0` + `rustc 1.85.0` as a known-good triple
