# AgentPay v2 — release & handover checklist

The frozen baseline is tag **`v2-devnet-verified`** at commit **`3f03bfa`**.
Everything below was verified against that baseline. Documentation changes
made after it do not alter any executable or payment code.

Tick these before handing the repository to anyone.

---

## Repository

- [ ] Working tree clean — `git status --porcelain` prints nothing
- [ ] On the intended commit — `git rev-parse --short HEAD`
- [ ] Tags present locally **and** on the remote:
      `program-v2-local-verified`, `v2-devnet-verified`
- [ ] **No secrets in the repository or in reachable git history.** Audited
      across all reachable refs: no keypair JSON, no `.env`, no PEM block, no
      cloud credential, no JWT. The long base58 strings in `docs/` are
      transaction signatures — each was decoded and tested, and none is key
      material. Re-run before any publication; `.gitignore` alone is not
      sufficient, because a file committed and later deleted stays reachable.
- [ ] `secrets/` contains only `.gitkeep` and `README.md` in git
- [ ] `.env` untracked and ignored

## Program

- [ ] **v2 program id** `ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m` — active,
      opens all new sessions
- [ ] **v1 program id** `3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U` —
      legacy, unmodified, still settles and refunds the sessions it holds
- [ ] Deployment transaction
      `3rUgEhx58AANEYAy9h3Bm7x7p3ht7CCUivQmafCeifpnEhjxGnmXEd6CxRmFhYvypnmP9nD9hbiribRyrRwJ8fQL`
      at slot `502473131`
- [ ] Deployed artifact hash matches the tested artifact — dumped back from
      chain and hashed, not assumed:
      `5c756b9632c51fad785fd071b3223b0208897eb1175c240e6eae42d11bf331d6`
      (262,032 bytes). This check previously caught a 242,000-byte intermediate
      build before it shipped; do not skip it.
- [ ] Upgrade authority `78Q6uycbMfTre1zRiyx6dQvUv1yWEjGzmvuj5Brd3VHc` is held
      by someone who should hold it
- [ ] Both IDLs committed under `idl/` — `target/idl/` is build output and is
      gitignored, so scripts must read the committed copies

## Gateway

- [ ] `AGENTPAY_PROGRAM_ID` = v2, `AGENTPAY_LEGACY_PROGRAM_ID` = v1
- [ ] Version is read **from the chain** on every settlement — the account's
      owner gives the program and its length gives the layout (187 → v1,
      219 → v2, anything else refused). Never from configuration.
- [ ] A session that cannot be read **fails closed**
- [ ] `AGENTPAY_SETTLEMENT_AUTHORITY_KEYPAIR` set, funded, and **not** the same
      file as `AGENTPAY_PROVIDER_KEYPAIR`
- [ ] `AGENTPAY_PROVIDER_KEYPAIR` still present **only** because v1 sessions
      have not drained. Remove it when they have.
- [ ] `/health` publishes the settlement authority, so an agent can bind it
- [ ] `AGENTPAY_ADMIN_TOKEN` set for any non-loopback bind (refused at boot
      otherwise)

## Verification

- [ ] Custody invariants **20/20** — devnet
- [ ] On-chain attack suite **24/24**
- [ ] Gateway tests — **178 with Postgres, 136 hermetic** (the 42 difference
      are the tests that need a database; they are `#[ignore]`d without one, so
      a green hermetic run is not a full run)
- [ ] Full end-to-end lifecycle on devnet, settlement tx
      `4NmrPb4ZEWFYapuQh8GUJ8bLqjZX9EKWLJ7NpvCbxWkFaroyYd83RD4Eb7p2RwVAB8yi7UMJATBZRGfyyXCLUH5U`
- [ ] Dual-program routing exercised — one gateway, a v2 session and a v1
      session in the same run
- [ ] Merkle root **recomputed independently** and matched, with a refusal
      proved against the committed root
- [ ] Workspace/tenant isolation — live HTTP plus 42 DB tests
- [ ] Usage metering proven unable to block payment — `usage_records` was
      deliberately broken with `CHECK(false)` and the full suite still passed
- [ ] Every devnet figure read back **from the chain**, not echoed from what
      the test submitted

### Known rough edge in the test entry points

`tests/custody.ts` and `tests/devnet-evidence.ts` — the two suites this release
cites as its custody evidence — have **no `npm run` script**. Run them with the
direct invocations recorded in [HACKATHON_KT.md](HACKATHON_KT.md) §10. Adding
`package.json` entries would be a sensible follow-up; it was deliberately not
done as part of a documentation-only change.

Also note `npm run evidence:v1-legacy` runs `tests/evidence-devnet.ts`, which is a
**different file** from `tests/devnet-evidence.ts`. The names are one
transposition apart. Check which one you mean.

Concurrency, expiry, partial-settlement-plus-refund and authority rotation are
verified **locally**, not on devnet — they need timing control or a 35-second
expiry wait that a public cluster makes unreliable. That is a stated limit, not
a skipped test. Never merge a local result and a devnet result into one claim.

## Limitations to hand over, in writing

- [ ] **No external audit.** Neither program, ever. The blocker for mainnet.
- [ ] **Devnet only.**
- [ ] **The v2 Merkle root is the latest, not final** — repeatable settlement
      means a later settlement commits a root over more leaves, so a proof
      exported now may not verify against a later root.
- [ ] **Migration incomplete** — `AGENTPAY_PROVIDER_KEYPAIR` is still required
      for v1 sessions, so a provider key is still held for those.
- [ ] **The provider still has a wallet** and should keep its key as a
      fallback. The claim is that AgentPay does not hold it, not that it does
      not exist.
- [ ] **A compromised control plane can change a provider's registered
      settlement address for future sessions.** Existing sessions are safe —
      their provider is in the PDA seeds. This cannot be fixed in the program
      and **must be disclosed to providers.**
- [ ] `SettlementRecord` is not in the v2 IDL (the account became
      `UncheckedAccount`); decode it by offset, as the gateway does.
- [ ] Rate limiting keys on the TCP peer, so behind a load balancer every
      tenant shares a bucket.

## The claim that is accurate

> AgentPay does not hold provider private keys for new v2 sessions; provider
> funds remain bound to the session's provider destination, and settlement
> amounts remain backed by agent-signed cumulative claims.

Not: production-ready, audited, trustless, final Merkle proofs, or a provider
with no wallet. Those are all false.
