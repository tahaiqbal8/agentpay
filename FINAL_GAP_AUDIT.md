# AgentPay Final Gap Audit

Payment control, policy enforcement, evidence, and on-chain settlement for
automated services and authorized software clients.

**Scope:** a code-first security, correctness and reliability pass over the
whole repository, followed by fixes, regression tests, a fresh devnet run and
an independent on-chain check of that run.

**Rule applied throughout:** a gap is marked fixed only when a test fails
without the fix and passes with it, or when a live check shows the behaviour
change. Nothing here is marked fixed because the code "looks correct".

---

## Executive Summary

Three engineering gaps were found, fixed, and covered by regression tests. A
further seven areas were audited and found **already covered** — those are
reported as verified, not as new work, because claiming otherwise would be
checkbox theatre.

| | |
|---|---|
| Gaps fixed this pass | 3 |
| Areas audited and already sound | 7 |
| Tests added | 15 |
| Gateway tests | 148 hermetic · 45 Postgres — all passing |
| Fresh devnet run | passed, independently verified on chain |
| AgentPay platform fee | **none — and none was added** |

The single most consequential finding: `evidence_log` carried
`ON DELETE CASCADE` from `sessions`, so deleting one session row erased its
entire evidence chain without touching `evidence_log` at all. `usage_records`
had deliberately been denied that foreign key for exactly this reason. The
billing table was protected from an erasure the cryptographic record was not.

---

## Fixed Engineering Gaps

### 1. Evidence was append-only by convention only

**Problem.** The runtime role held `UPDATE`, `DELETE` and `TRUNCATE` on
`evidence_log`. Worse, the table carried `ON DELETE CASCADE` from `sessions`:
one `DELETE FROM sessions` erased an entire evidence chain, and nothing in the
audit trail would show `evidence_log` had been touched.

**Root cause.** The hash chain detects tampering *after the fact*. Nothing
prevented the mutation, and the cascade was a path that bypassed the table
entirely. `usage_records` was explicitly denied a foreign key to `sessions`
with the comment *"a deleted session must not silently erase the record that
the customer was billed for those calls"* — the same reasoning had not been
applied to the evidence table.

**Fix.** `gateway/migrations/0007_evidence_append_only.sql` installs a
row-level trigger (`BEFORE UPDATE OR DELETE`) and a statement-level trigger
(`BEFORE TRUNCATE`) that raise `restrict_violation`. A trigger, not a `REVOKE`:
the runtime role owns the table and an owner can re-grant anything it revokes
from itself. The `REVOKE` is applied as well, as defence in depth and as a
readable statement of intent.

**Files.** `gateway/migrations/0007_evidence_append_only.sql` (new).

**Tests.** `db::pg_tests::evidence_rows_cannot_be_updated_deleted_or_cascaded_away`
— asserts UPDATE, DELETE and the cascading `DELETE FROM sessions` all fail, and
that the row count is unchanged afterwards.

**Verification.**

```
UPDATE         -> ERROR: evidence_log is append-only: UPDATE is not permitted
DELETE         -> ERROR: evidence_log is append-only: DELETE is not permitted
TRUNCATE       -> ERROR: evidence_log is append-only: TRUNCATE is not permitted
DELETE session -> ERROR: evidence_log is append-only: DELETE is not permitted
INSERT         -> works: 244 -> 247 rows across one demo run
```

The test was proven non-vacuous: with
`ALTER TABLE evidence_log DISABLE TRIGGER evidence_log_no_mutate` it **fails**;
with the trigger enabled it **passes**. Enforced on the deployed server too —
the same `UPDATE` is refused there.

---

### 2. Rate limits keyed on the TCP peer, which behind a proxy is the proxy

**Problem.** `client_ip` used the peer address and ignored `X-Forwarded-For`
entirely. Behind nginx — which is how AgentPay is actually deployed — the peer
is always nginx, so every public client shared one bucket and one noisy client
could rate-limit everybody else.

**Root cause.** The original behaviour was the *safe* default and deliberately
so: trusting `X-Forwarded-For` unconditionally lets an attacker pick a fresh
bucket per request, which is worse than no limit because it looks like one.
What was missing was a way to say which hop may be believed.

**Fix.** `AGENTPAY_TRUSTED_PROXIES` names the addresses whose header may be
believed. From anyone else the header is still ignored completely. The header
is walked right to left, skipping hops that are themselves trusted, so entries
a client prepended are never reached. Empty by default — behaviour is unchanged
unless an operator opts in.

**Files.** `gateway/src/ratelimit.rs`, `gateway/src/config.rs`,
`gateway/src/routes.rs`, `gateway/src/main.rs`, `.env.example`.

**Tests.** Ten, in `ratelimit::proxy_tests`:

| Test | Asserts |
|---|---|
| `a_direct_client_cannot_spoof_its_way_into_a_fresh_bucket` | untrusted peer's header ignored, three spoof attempts |
| `with_no_trusted_proxies_the_header_is_always_ignored` | empty list means believe nobody |
| `a_trusted_proxy_reveals_the_real_client` | the deployment case |
| `two_clients_behind_one_proxy_get_separate_buckets` | the bug this fixes |
| `a_chain_of_trusted_proxies_is_walked_from_the_right` | multi-hop |
| `client_supplied_hops_to_the_left_are_not_believed` | prepended lies unreachable |
| `malformed_forwarding_headers_fail_safe` | six malformed inputs |
| `one_bad_hop_does_not_poison_the_whole_header` | skip, don't abort |
| `a_trusted_proxy_with_no_header_keys_on_the_peer` | absent header |
| `naming_a_trusted_proxy_in_the_header_does_not_help_an_attacker` | no escape by impersonation |

**Verification.** 10 passed, 0 failed. Configured on the deployed server as
`AGENTPAY_TRUSTED_PROXIES=127.0.0.1,::1`, matching its nginx.

---

### 3. `GET /v1/session/{s}/settlement` read v1 sessions at the wrong address

**Problem.** The handler derived the settlement-record PDA from
`state.program_id` regardless of which program owned the session. For a session
opened under the legacy program, that address holds nothing — so a settled v1
session was reported `settled: false`. A false negative that reads as a fact.

**Root cause.** The settle path already routes by the session account's owner
and carries a comment warning against precisely this mistake. The read path was
never brought in line.

**Fix.** One fetch of the session account yields both answers: the **owner**
picks the record address, the **length** picks the version. An account owned by
neither known program is refused rather than read as a session. A session the
chain cannot confirm keeps the previous behaviour, because with no owner there
is no better address to name.

**Files.** `gateway/src/routes.rs`.

**Tests.** `settle::tests::the_settlement_record_address_depends_on_the_owning_program`
and `settle::tests::settlement_records_do_not_collide_across_sessions`.

**Verification** — live, against a real v1 session
`4CSTy1rb2jKrA2Y8y5VtzBv2FgqGfAaUpLnEek7A2J3o`:

| | Before | After |
|---|---|---|
| `settled` | `false` | `true` |
| `settlement_record` | `CBYvZUSd…rQqX` (v2-derived, empty) | `A7V1PEEP…B3WTf` |
| `merkle_root` | — | `c0512d31…d56ea6` |
| `root_may_advance` | — | `false` |

The chain confirms independently: `A7V1PEEP…B3WTf` is owned by the v1 program
and holds that root. A v2 session is unaffected — same record, and
`root_may_advance` still `true`.

---

## Security Properties Verified

Audited this pass and found **already covered**. No new tests were written
where coverage existed; writing duplicates and reporting them as work would be
the checkbox theatre this audit was asked to avoid.

| Property | Implementation | Test | Result |
|---|---|---|---|
| Amount cannot be forged | `lib.rs:173` `verify_ed25519_claim` | `attacks.ts` — *rejects a tampered amount (signs 1 USDC, submits 4)* | PASS |
| Signature must be the session's agent | Ed25519 precompile introspection | `attacks.ts` — *rejects a claim signed by a key that is not the session agent* | PASS |
| Precompile cannot be spoofed | all three ix-index fields `u16::MAX` | `attacks.ts` — three tests: no Ed25519 ix, not immediately preceding, referencing another ix | PASS |
| Cumulative is monotonic | `lib.rs:164` `> cumulative_settled` | `attacks.ts` — *rejects a replayed claim*, *rejects a non-monotonic cumulative* | PASS |
| Escrow is the ceiling | `lib.rs:168` `<= deposited_total` | `attacks.ts` — *rejects a claim exceeding the deposit* | PASS |
| Concurrent claims never sum | `SELECT … FOR UPDATE` | `db::pg_tests::concurrent_claims_take_the_maximum_never_the_sum` **(added)** | PASS |
| One admission under races | row lock | `db::pg_tests::concurrent_duplicate_claims_admit_exactly_one` | PASS |
| One settlement change under races | — | `db::pg_tests::concurrent_settlements_report_exactly_one_change` **(added)** | PASS |
| Destination cannot be redirected | `lib.rs:655` `provider_token_account.owner == session.provider` | `attacks.ts` — *rejects a substituted provider token account* | PASS |
| Provider is in the PDA seeds | `lib.rs:563` | `settle::tests::pdas_use_the_documented_seeds` | PASS |
| Only an authorized settler | `UnauthorizedSettler` | `attacks.ts` — *rejects settlement by a wallet that is not an authorized settler* | PASS |
| Wrong mint refused | `MintMismatch` | `attacks.ts` — *rejects a wrong mint at settlement* | PASS |
| Claim cannot cross sessions | session in the 73 bytes | `verify::rejects_a_claim_replayed_onto_another_session` | PASS |
| Domain separation | `"agentpay:claim:v1"` | `claim::domain_is_seventeen_bytes` | PASS |
| Canonical bytes | 73-byte layout | `claim::matches_the_typescript_signer_byte_for_byte` | PASS |
| Malformed claims refused | wire decoding | `claim::wire_rejects_float_amounts`, `wire_rejects_short_signature`, `verify::rejects_garbage_and_zero_signatures` | PASS |
| Integer overflow safe | checked arithmetic | `claim::expiry_overflow_does_not_panic`, `policy::a_budget_that_would_overflow_refuses_rather_than_wrapping` | PASS |
| Policy applied before forwarding | `/v1/buy` ordering | `buy::paid_path_tests` (4 tests) | PASS |
| Suspended agent refused | `policy.rs` | `policy::a_suspended_agent_is_refused_whatever_it_asks_for` | PASS |
| Policy boundaries exact | `policy.rs` | `policy::the_call_limit_is_exhausted_at_the_limit_not_after_it` + 14 others | PASS |
| Evidence tamper detected | hash chain | `evidence::editing_an_entry_in_place_is_detected`, `rewriting_an_entry_and_its_hash_breaks_the_next_link`, `deleting_an_entry_is_detected` | PASS |
| Reordering detected | Merkle | `evidence::root_is_order_dependent` | PASS |
| Evidence cannot be mutated in the DB | migration 0007 | `db::pg_tests::evidence_rows_cannot_be_updated_deleted_or_cascaded_away` **(added)** | PASS |
| Rate limit cannot be spoofed | trusted-proxy walk | `ratelimit::proxy_tests` (10) **(added)** | PASS |

### API surface, probed live

| Probe | Result |
|---|---|
| Malformed JSON | `400` |
| Empty body | `400` |
| Wrong types | `422` |
| 4.8 MB body | `413` — a body limit is enforced |
| `../../etc/passwd` in a path | `401` / `400` |
| URL-encoded traversal | `400` |
| `' OR 1=1--` in a path | `400` |
| SQL injection in an authenticated field | stored as a literal string; `evidence_log` intact at 247 rows |
| Error body | `reason_code` + `message` + `request_id` — no stack trace, no internals |
| Response headers | no `Server` version banner |

All queries are parameterised; `grep` for string-interpolated SQL finds nothing.

### Secrets and deployment

| Check | Result |
|---|---|
| Admin token in git history | 0 |
| Admin token in the web build | 0 |
| Keypair arrays in the shipped bundle | 0 |
| Private keys in `web/.next/static` (the only thing the browser receives) | 0 |
| `NEXT_PUBLIC_` variables in `web/src` | 1 — a **comment** explaining the var deliberately lacks that prefix so Next cannot inline it |
| Secret files tracked in git | 0 |
| Keys echoed by any API response | 0 |
| Port exposure (server) | 22, 80 (redirect only), 443 open · 3100, 8080, 5434, 4021 closed |
| Privileged containers | none |

One scanner hit was chased to the end rather than waved away: a
`BEGIN … PRIVATE KEY` match inside `web/.next/standalone/.../libvips-cpp.dylib`.
It is **error-message text compiled into a C library** (`sharp`'s image
backend) — strings like *"No PEM-encoded private key found"* — and it is a
macOS binary that the Linux container never loads. Not a key.

---

## V1 / V2 Compatibility

| | V1 — legacy | V2 — canonical |
|---|---|---|
| Program | `3aKGM6Cb…u7y5xP2U` | `ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m` |
| Session layout | 187 bytes | 219 bytes |
| Who settles | the provider, with its own private key | the settlement authority **or** the provider |
| AgentPay holds | the provider's private key | its own authority key only |
| Settlement | once | monotonic, repeatable |
| Root | final | **latest committed** |
| Role | sessions opened before the cutover | every new session, and the demo |

Routing is read from the chain on every settlement — the account's **owner**
picks the program, its **length** picks the layout, and any other length is
refused. Never from configuration. The read path now does the same, which is
gap 3 above.

Verified in the fresh run: the settlement transaction contains the v2 program
and **does not contain** the v1 program.

Every script that drives v1 is suffixed `:v1-legacy` and carries a banner in
its source. The canonical demo is `npm run demo:v2` and nothing else.

---

## Current Fee Status

**AgentPay currently charges no platform fee. None was added in this pass.**

The on-chain program contains exactly three token transfer destinations:

| Instruction | From | To |
|---|---|---|
| `open_session` | agent | vault |
| `settle_session` | vault | `provider_token_account` |
| `refund_session` | vault | agent's own token account |

There is no AgentPay-owned destination anywhere, and `settle_session` transfers
the full `cumulative_amount - cumulative_settled` with no deduction. The
conservation assertion in `tests/e2e-v2-devnet.ts` is the proof: if any unit
were skimmed the arithmetic would not close and the test would fail.

`usage_records.price` is the **provider's** asking price, not a charge — the
module's own documentation says so. The `subscriptions` table exists in the
schema and is referenced by **zero** lines of gateway source.

AgentPay currently **spends** rather than earns: each settlement costs the
authority roughly 0.0013 SOL, almost all of it rent for the `SettlementRecord`,
and no instruction ever closes that account, so the rent is permanent. The cost
is per settled session and fixed, which is a real constraint on any future
pricing model — a percentage of a small session cannot cover it.

---

## Remaining Engineering Limitations

Genuine, and none of them closable by editing this repository today.

1. **Token-2022 is untested.** The program uses `token_interface`, so the code
   path exists, but no test exercises it — `Token2022` appears **0** times in
   `tests/`, against 61 uses of the classic `TOKEN_PROGRAM_ID`. Writing a test
   would mean minting a Token-2022 asset and settling against it; that is real
   work, and until it is done the honest status is *unsupported*, which is what
   the README says.
2. **Single gateway instance.** Per-session serialisation comes from
   `SELECT … FOR UPDATE` on the session row, which is correct for one process
   and for several processes against one database. What is **unproven** is
   multi-instance operation under partition or failover. No horizontal
   scalability is claimed.
3. **Rate limiting is per-process.** The trusted-proxy fix makes the *key*
   correct; the *counter* still lives in one process's memory. Distributed
   limiting would need Redis or equivalent, which was deliberately not
   introduced for a devnet demo.
4. **The `SettlementRecord` rent is never reclaimed.** No instruction closes the
   account — correctly, since it is the proof anchor — so roughly 0.0013 SOL is
   permanently sunk per settled session.
5. **`SettlementRecord` is absent from the v2 IDL**, because the account became
   `UncheckedAccount`. It must be decoded by offset, as the gateway does.
6. **Migration v1 → v2 is unfinished.** `AGENTPAY_PROVIDER_KEYPAIR` is still
   required for v1 sessions, so the gateway still holds a provider key for
   those, until they drain.
7. **A compromised control plane can change a provider's registered settlement
   address for future sessions.** Existing sessions are safe — their provider is
   in the PDA seeds. This cannot be fixed in the program, which never learns
   what a provider "should" be. It must be disclosed to providers.
8. **Evidence carries no resource name.** The hash preimage is
   session ‖ cumulative ‖ nonce ‖ decision. The console therefore cannot show
   which endpoint a claim was for, and does not pretend to.
9. **No CORS policy and no security headers** on the gateway. The console
   proxies server-side, so no browser talks to the gateway cross-origin and the
   absence is currently the safe default. A different front end would need both.

---

## External Validation Still Required

Not engineering defects. No amount of code changes these.

- **External security audit.** Neither program has ever been reviewed by a third
  party. This is the blocker for mainnet.
- **Mainnet deployment.** Requires the audit first.
- **Commercial validation.** No pilot, no revenue, no market evidence.
- **Design partner.** None. The repository's own commercial report names one
  conversation with a real API provider as the highest-value next action.
- **Pricing validation.** No pricing research has been done, and the per-session
  fixed cost above is the constraint any pricing must clear.

---

## Fresh Devnet Evidence

Generated **after** every change in this pass, on the deployed server, and then
checked against the chain rather than against the gateway's own output.

```
COMMAND           npm run demo:v2                 (on 13.200.171.103)
NETWORK           Solana devnet
PROGRAM           ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m
V1 IN THE TX      FALSE

SESSION           Eb62WN5exY1fZthDT7kiKzULCfe2p2yJw4BFFA9AucjA
  owner (chain)   ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m
  length (chain)  219 bytes

SETTLEMENT TX     3Na9CSu5nCrUb428LtuoJQ8AoVZMnxkk5pSaQNSmBCkAWaFYnJNPDj1aHGipsMNVWNkKkxJmJWBFCxE5iSNU3d1J
  err             None
  signers         7zKU8vFeWEn9M2FVm7bYa5aMtT9srUTJEeca7FDK9ff2   (1)
  provider signed FALSE
  record          G7nwwHH1dzt6ZcM6X8Lg8LEAPRPBT73zPzD4Xb726tgZ

EVIDENCE          3 entries · chain_valid true
  seq 0           ALLOWED                  cumulative 1000  nonce 1
  seq 1           ALLOWED                  cumulative 1500  nonce 2
  seq 2           ERR_NONCE_NOT_MONOTONIC  cumulative 2500  nonce 2
REFUSALS ALSO     ERR_POLICY_RESOURCE_NOT_ALLOWED  (/analyse)

ROOT              02078c467577961a9c5ee955a33fc380e3416da54a2e3dbf47053d87141b2e38
  browser         MATCH   (recomputed with WebCrypto at https://13-200-171-103.sslip.io)
  gateway         MATCH
  on chain        MATCH   (read from G7nwwHH1…726tgZ at offset 72)
  root_may_advance true

CONSERVATION      1500 + 2998500 = 3000000   ✓
```

Browser leg: `isSecureContext: true`, verdict **Verified — Browser = Gateway =
Chain**, zero console errors.

---

## Safe Claims

Every one is backed by source, a passing test, or chain evidence above.

1. AgentPay does not hold provider private keys for v2 sessions. The settlement
   transaction has exactly one signer and it is AgentPay's own authority.
2. The settled amount is fixed by the agent's Ed25519 signature. The gateway
   cannot manufacture it.
3. The destination is fixed by `session.provider`, which is in the PDA seeds and
   cannot change after the session opens.
4. A refusal never reaches the provider and never moves the high-water mark, and
   is still written to the evidence chain.
5. Evidence is append-only, enforced by database triggers, cascade included.
6. Any single decision can be proved against a root committed on Solana, and
   recomputed in a third party's browser.
7. Conservation holds: settled plus remaining equals the deposit.
8. Concurrent claims take the maximum, never the sum.
9. Rate limits cannot be bypassed by forging `X-Forwarded-For`.
10. AgentPay charges no platform fee.

## Claims We Must NOT Make

1. **Not audited.** No third party has reviewed either program.
2. **Not production-ready.** Devnet only.
3. **The root is not final.** It is the latest committed root; v2 settlement is
   repeatable, so a proof exported now may not verify against a later root.
4. **Token-2022 is not supported** — the code path exists and is untested.
5. **Not horizontally scalable** — multi-instance operation is unproven.
6. **Rate limiting is not distributed** — the counter is per process.
7. **AgentPay earns no revenue**, and has no pilot, design partner or pricing
   evidence.
8. **Not trustless.** A compromised gateway can deny service and can settle
   early or low. It cannot redirect funds.
9. **Migration is not complete** — a provider key is still held for v1 sessions.
10. **Not x402-compatible** — `/v1/buy` speaks its own `agentpay-deferred-v1`
    scheme.

---

*Generated during a full audit pass. Every figure was read from source, from a
passing test, or from Solana devnet.*
