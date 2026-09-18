# secrets/

Mounted read-only into the gateway container at `/secrets`.

To enable on-chain settlement, put a Solana keypair here:

```bash
solana-keygen new --no-bip39-passphrase -o secrets/provider.json
```

and set this in `.env`:

```
AGENTPAY_PROVIDER_KEYPAIR=/secrets/provider.json
```

That path is the **container** path, not a host path — it is the same string on
Windows, macOS and Linux.

Without it the gateway runs verify-only: claims are still verified and limits
still enforced, but `/v1/session/settle` returns `ERR_SETTLEMENT_UNAVAILABLE`.

**Nothing in this directory is committed.** See `.gitignore`.
