# secrets/

Local secret material. Mounted read-only into the gateway container at
`/secrets`.

**Nothing in this directory is committed**, apart from this file and
`.gitkeep`. See `.gitignore` (`secrets/*` with those two exceptions). A secret
audit of the full reachable git history confirms no keypair has ever been
committed — keep it that way.

There are **two different keys** here, with different powers. They are
deliberately separate variables, and pointing both at the same file destroys
the custody property the v2 program exists to provide.

---

## `settlement-authority.json` — AgentPay's own key

Settles **v2** sessions. This is AgentPay's key, not a provider's.

Holding it is not custody. It is a permission to *submit* a settlement and
nothing more:

- it cannot change the **amount** — that is fixed by the agent's Ed25519
  signature over the 73-byte claim, checked on chain;
- it cannot change the **destination** — that is `session.provider`, which sits
  in the session PDA's seeds and cannot be changed after the session opens.

```bash
solana-keygen new --no-bip39-passphrase -o secrets/settlement-authority.json
```

```
AGENTPAY_SETTLEMENT_AUTHORITY_KEYPAIR=/secrets/settlement-authority.json
```

It needs a small SOL balance on devnet to pay transaction fees and
`SettlementRecord` rent (budget ~0.02 SOL per new settlement record).

## `provider.json` — a provider's own key, LEGACY

Settles **v1** sessions only, because the old program requires the provider's
own signature. This one *is* a provider private key, which is exactly the
arrangement v2 was built to end.

```bash
solana-keygen new --no-bip39-passphrase -o secrets/provider.json
```

```
AGENTPAY_PROVIDER_KEYPAIR=/secrets/provider.json
```

Delete it once every v1 session has drained. At that point AgentPay holds no
provider key at all — see [../docs/MIGRATION_V1_V2.md](../docs/MIGRATION_V1_V2.md).

---

Both paths are **container** paths, not host paths — the same string on
Windows, macOS and Linux. The files themselves live in this directory on the
host.

With neither key set the gateway runs verify-only: claims are still verified
and limits still enforced, but settlement returns
`ERR_SETTLEMENT_UNAVAILABLE`. With only the authority set, v2 sessions settle
and v1 sessions report `ERR_SETTLEMENT_UNAVAILABLE` — correct behaviour, not a
bug, because the gateway genuinely cannot settle them.

---

## Rules

- **Never commit a keypair**, and never commit `.env`. Both are ignored; do not
  add exceptions.
- **Never paste a secret value** into an issue, a pull request, a commit
  message, a log, a screenshot, or any document in this repository — including
  while asking for help. A key that appears anywhere in git history must be
  treated as compromised and rotated, because deleting the file later does not
  remove it from history.
- **Do not reuse one file for both variables.** They are different keys with
  different powers.
- Rotating a key affects **future** sessions only. Sessions already open keep
  the authority they were opened with, because it is written into the session
  account once and never changes.
