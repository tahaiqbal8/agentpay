# AgentPay v2 — release record

Frozen at tag `v2-devnet-verified`.

Everything below was run against **real Solana devnet** unless a line says
LOCAL. Nothing here has been audited.

---

## The accurate claim

> AgentPay does not hold provider private keys for new v2 sessions; provider
> funds remain bound to the session's provider destination, and settlement
> amounts remain backed by agent-signed cumulative claims.

That is the whole claim. It does not say the protocol is trustless, audited,
production-ready, that the Merkle root is final, or that a provider needs no
wallet. Those would all be false — see **J. Limitations**.

---

## A. Final architecture

```
  Human ── defines the envelope ──┐
                                  ▼
  Agent (Ed25519) ── signed cumulative claim ──► Gateway
                                                   │ verify → policy → admit
                                                   │        → forward → evidence
                                                   ▼
                                              Provider API
                                                   │
  AgentPay settlement authority ── settle_session ─┤
                                                   ▼
                                    Solana: vault ──► provider destination
                                            (immutable, in the PDA seeds)
```

The gateway holds **its own** settlement-authority key. It can trigger a
settlement and nothing else: the amount is fixed by the agent's Ed25519
signature over the 73-byte claim, and the destination by `session.provider`,
which is baked into the session PDA's seeds and cannot change.

## B. Old vs new program

| | v1 | v2 |
| --- | --- | --- |
| Program id | `3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U` | `ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m` |
| `Session` | 187 bytes | 219 bytes (`settlement_authority`) |
| Who settles | the provider only | authority **or** provider |
| Settlement | once | monotonic, repeatable |
| `settled_amount` | that settlement's delta | the cumulative total |
| `merkle_root` | final | the **latest** |
| Status | untouched, still live | deployed, verified |

v1 was not modified. Sessions it holds settle and refund under their original
rules. See `docs/MIGRATION_V1_V2.md`.

## C. Gateway changes

- `chain.rs` decodes **both** layouts. Both programs write the same
  discriminator, so the LENGTH distinguishes them — 187, 219, or refuse.
  Wrong offsets do not error, they return plausible garbage; that is what the
  length check prevents.
- `settlement_authority` decodes as `Option<Pubkey>`. `None` means "v1, the
  field does not exist", not "the field is zero".
- `submit_settlement` takes the settler and the payee as separate arguments.
  The destination used to be derived from the signer — correct under v1 where
  they were the same key, silently wrong under v2.
- Which key signs is read from the chain, never from configuration. A session
  that cannot be read fails closed.
- `legacy_program_id` routes settlement to the program that OWNS the session.
- `/health` publishes the settlement authority, so an agent can bind it.
- `/v1/session/{s}/settlement` gains `root_may_advance`.
- `AGENTPAY_SETTLEMENT_AUTHORITY_KEYPAIR` is a new variable, never a rename of
  `AGENTPAY_PROVIDER_KEYPAIR`.

**`/v1/buy` ordering is unchanged**: price → 402 → decode → expiry → session →
signature → price match → policy → admit_claim → forward → evidence.

## D. SDK changes

`settle()` no longer claims settlement is one-shot. `Settlement.merkleRoot` is
documented as the latest root and `cumulativeAmount` as the session total, not
the transaction's delta. New `gatewayInfo()` reads the authority to bind.

**The 73-byte claim is byte-identical.** `matches_the_typescript_signer_byte_for_byte`
and `layout_matches_the_program` both pass.

## E. Console changes

One change, in the Verifier: when the chain reports the root can still
advance, it says so beside the proof. No layout, colour, typography or
accessibility work was touched; no metric, page or API invented.

## F. Migration

`docs/MIGRATION_V1_V2.md`. Retirement condition: for every session under the
old program, `deposited_total - cumulative_settled - refunded_total == 0`.
Until then the legacy branch and `AGENTPAY_PROVIDER_KEYPAIR` stay.

## G. Deployment evidence

```
program id   ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m
deploy tx    3rUgEhx58AANEYAy9h3Bm7x7p3ht7CCUivQmafCeifpnEhjxGnmXEd6CxRmFhYvypnmP9nD9hbiribRyrRwJ8fQL
slot         502473131
owner        BPFLoaderUpgradeab1e11111111111111111111111
executable   true
data length  262032 bytes
authority    78Q6uycbMfTre1zRiyx6dQvUv1yWEjGzmvuj5Brd3VHc
```

Deployed bytes were dumped back and hashed against the tested artifact:

```
local    5c756b9632c51fad785fd071b3223b0208897eb1175c240e6eae42d11bf331d6
deployed 5c756b9632c51fad785fd071b3223b0208897eb1175c240e6eae42d11bf331d6
```

That check caught a real problem before it shipped: an intermediate build had
left a 242,000-byte artifact where the tested one was 262,032.

## H. End-to-end devnet evidence

`npm run e2e-v2`:

```
settlement tx   4NmrPb4ZEWFYapuQh8GUJ8bLqjZX9EKWLJ7NpvCbxWkFaroyYd83RD4Eb7p2RwVAB8yi7UMJATBZRGfyyXCLUH5U
session PDA     42YsFsmhXLEWVBj4LvnkfZhnDMip9vc6q6ACGVPtHFRp   (219 bytes)
authority       DLuD55GehdW6pNnv82NUs9hwbwN4mXssXwm8ucv4FH6s
provider ATA    0 -> 1500        vault 3000000 -> 2998500
settled_amount  1500 (cumulative)          root_may_advance  true
merkle_root     05fbebc0393b27518b32043d57820e5b6276305e8da6dfc0c227c274e2d22339
                recomputed independently — MATCH
proof           seq 2 · ERR_NONCE_NOT_MONOTONIC, 2 hops, against the committed root
signers         DLuD55Geh… only. The provider key did not sign.
```

Dual-program routing, one gateway, same session of work:

```
5Q831GJC2hYoLtzwCxUyRag8U2kodb3JFJjw8MdAxp3n → ApjxJK…  v2
4CSTy1rb2jKrA2Y8y5VtzBv2FgqGfAaUpLnEek7A2J3o → 3aKGM6…  v1 (legacy)
```

Custody evidence (`tests/devnet-evidence.ts`):

```
settle 1  39Tk5eRiS4awZFy7ZNZtAfDjsuiihfpTuxAc6oc7ZFRhQ2aUFeKbYud2WFCLujyWAXc76wtrPcvYyGLhchA4wwCr
          100 · provider 0→100 · vault 1000→900
settle 2  5JS7p7aPpYS52L6hPA6eiCgc8xWz6NAsrQShJRBcCMGFkfKa8WUiLcZ3EWoa2rtSnzqVeqqieV8JchgGaz2BUm3e
          750 · provider 100→750 · vault 900→250 · delta moved 650
rejected  750→100 ClaimNotMonotonic · 750→750 ClaimNotMonotonic
          stranger UnauthorizedSettler · attacker destination TokenAccountOwnerMismatch
          forged amount ClaimMessageMismatch
fallback  5RRsCFvXQJHBKcqfjf4cnfwsSoRWmF7zz3xsUUA4LtSq1Lni3a2EwnHq6QQqsGzRDmq4HGW32pLMhuMP9Tu1rkZM
```

## I. Security results

| # | Property | Where proven |
| --- | --- | --- |
| 1 | v2 sessions need no provider private key | devnet e2e — signers list |
| 2 | Authority can settle | devnet |
| 3 | Provider fallback can settle | devnet |
| 4 | Gateway cannot redirect funds | devnet |
| 5 | Gateway cannot manufacture an amount | devnet |
| 6 | Stale low settlement can be advanced | devnet |
| 7 | Lower/equal cumulative cannot regress | devnet |
| 8 | Concurrent settlement cannot double-pay | LOCAL |
| 9 | Old v1 sessions still work | devnet |
| 10 | v2 sessions use the new program | devnet |
| 11 | 73-byte claim unchanged | byte-pinned tests |
| 12 | Merkle/evidence verification correct | devnet, recomputed independently |
| 13 | Metering cannot block payment | CHECK(false) + full suite still passed |
| 14 | Workspace isolation intact | live HTTP + 42 DB tests |
| 15 | Expiry rules hold | LOCAL |
| 16 | Partial settlement + refund exact | LOCAL |
| 17 | Rotation affects new sessions only | LOCAL |
| 18 | `/v1/buy` ordering unchanged | code + attack suite |

8, 15, 16 and 17 are LOCAL because they need timing control or a 35-second
expiry wait that a public cluster makes unreliable, not because they were
skipped.

## J. Limitations

- **Not audited.** Neither program, ever.
- **Devnet only.** Mainnet needs an audit first.
- **The root is the latest, not final.** Repeatable settlement is why. A
  proof exported now will not verify against a later root.
- **The provider still needs a wallet address**, should keep its key as a
  fallback, and needs it across rotation. The claim is that AgentPay does not
  hold that key — not that it does not exist.
- **A compromised control plane can change a provider's registered settlement
  address for FUTURE sessions.** Existing sessions are safe — their provider is
  in the PDA seeds. This cannot be fixed in the program, which never learns
  what a provider "should" be. It must be disclosed to providers.
- **`SettlementRecord` is not in the v2 IDL**, because the account became
  `UncheckedAccount`. Decode it by offset, as the gateway does.
- **Migration is not finished.** `AGENTPAY_PROVIDER_KEYPAIR` is still
  configured and still required for v1 sessions.
- **Rate limiting keys on the TCP peer**, so behind a load balancer every
  tenant shares a bucket.

## K. Commits and tags

```
d043868  program v2
6444a28  20 custody invariants (local)
5cbaeb8  gateway: both Session layouts
a4c2335  gateway: settle without a provider key
ec8322c  SDK and console
7fd8cd2  migration plan
f1b7510  dual-program IDLs
d129437  DEPLOYED and devnet verified
f612494  dual-program routing + devnet e2e

tags     program-v2-local-verified → v2-devnet-verified
```

## L. Devnet verified

Program deployment · 20/20 custody invariants · the full lifecycle · dual-program
routing · old-program compatibility · independent root recomputation · refusal
proof · workspace isolation · usage metering.

## M. Not externally audited

All of it. No third party has reviewed the program, the gateway, the custody
model, or the migration. The create-or-advance `SettlementRecord` lifecycle,
the settler OR-check, and the arithmetic on `cumulative_settled` /
`refunded_total` are the parts an audit should look at first.
