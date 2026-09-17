# AgentPay — Deployment Guide

Four things deploy separately: the **program** (Solana), the **database**
(Postgres), the **gateway** (Rust), and the **console** (Next.js).

Order matters: program → database → gateway → console. Each one needs the
previous one's address or URL.

---

## 0. Read this first

> **This code has not been audited.** It moves tokens, holds a signing key, and
> has known untested paths (§6). Devnet is fine today. **Mainnet is not**, and
> the honest reason is that nobody outside this repo has reviewed the escrow
> program.
>
> Deploying to mainnet is a one-way door: the program ID becomes public, users
> deposit real USDC, and a bug in `settle_session` is a bug that costs someone
> money. Ship to devnet, demo on devnet, and treat mainnet as a separate project
> that starts with an audit.

---

## 1. The program (Solana)

### Current state

| | |
|---|---|
| Cluster | **devnet** |
| Program ID | `3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U` |
| Upgrade authority | `78Q6uycbMfTre1zRiyx6dQvUv1yWEjGzmvuj5Brd3VHc` |
| Size | 243,560 bytes |
| Rent locked | ~1.24 SOL |

It is **upgradeable** — the authority above can replace the bytecode in place,
keeping the same program ID and all existing sessions.

### Redeploy after a code change

```bash
cd ~/Projects/AgentPay
./scripts/deploy-devnet.sh
```

The script refuses to deploy if `declare_id!`, `Anchor.toml`, and the keypair
disagree — a mismatch there silently deploys to a different address, which is
the classic way to lose an afternoon.

Needs ~2.55 SOL (deploy + tests). If the CLI faucet is rate-limited, use
https://faucet.solana.com with the deployer address.

### What mainnet would additionally require

| Requirement | Why |
|---|---|
| Security audit | See §0 |
| ~2 SOL real | Rent for a 243 KB program |
| Upgrade authority decision | Keep it (can patch bugs) or burn it (users can trust immutability). **Both are defensible; pick deliberately.** |
| Real USDC mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` — not the test mints |
| Token-2022 testing | Currently zero coverage (§6) |

To actually do it (**after** the above):

```bash
solana program deploy target/deploy/agentpay.so \
  --program-id target/deploy/agentpay-keypair.json \
  --url mainnet-beta --keypair <funded-mainnet-wallet>
```

---

## 2. The database (PostgreSQL)

### Local / demo

```bash
./scripts/dev-db.sh up     # container on :5434
```

### Production

Use a **managed** Postgres (RDS, Cloud SQL, Neon, Supabase). Not the dev
container — it has no backups and no volume guarantees.

> **Why this database is security infrastructure, not just storage.** The
> high-water mark in `claim_tickets` is the only thing stopping an agent
> replaying an old claim to get a second resource for the same money. The chain
> cannot help: it sees one settlement at session close and has no view of
> individual requests.
>
> **Losing this database re-opens claim replay for every live session.** Back it
> up like you would a ledger.

Requirements:

| Setting | Value |
|---|---|
| Version | 16+ (tested on 16-alpine) |
| TLS | **Required.** Use `?sslmode=require` in the URL |
| Connections | ≥ 25 (gateway pool is 20) |
| Backups | Point-in-time recovery on |

Migrations run automatically at gateway startup — no separate step.

### Recommended hardening (not done by default)

The evidence log is append-only **by convention**; nothing stops a role with
`UPDATE`/`DELETE` from rewriting history. Tampering stays *detectable* (the hash
chain breaks), but you can make it *harder*:

```sql
-- Give the gateway a role that cannot rewrite evidence.
REVOKE UPDATE, DELETE ON evidence_log FROM agentpay;
```

The gateway only ever INSERTs into `evidence_log`, so this costs nothing.

---

## 3. The gateway (Rust)

### Build

```bash
cd gateway && cargo build --release
# binary: gateway/target/release/agentpay-gateway
```

Copy the binary **and** the `migrations/` directory — migrations are embedded at
compile time, so the binary is self-contained, but keep the source alongside for
the next build.

### Environment

| Variable | Required | Notes |
|---|:--:|---|
| `AGENTPAY_RPC_URL` | ✅ | Refuses a URL containing `mainnet` unless `AGENTPAY_ALLOW_MAINNET=1` |
| `AGENTPAY_PROGRAM_ID` | ✅ | |
| `AGENTPAY_BIND_ADDR` | — | Default `127.0.0.1:8080` |
| `DATABASE_URL` | **yes in prod** | Absent → in-memory, loses marks on restart |
| `AGENTPAY_PROVIDER_KEYPAIR` | — | Absent → verify-only, cannot settle |
| `AGENTPAY_TRUST_OPEN_REQUESTS` | ❌ | **Never set this in production** (§5) |
| `AGENTPAY_LOG` | — | e.g. `info,tower_http=warn` |

### systemd unit

```ini
[Unit]
Description=AgentPay gateway
After=network-online.target

[Service]
Type=simple
User=agentpay
WorkingDirectory=/opt/agentpay
ExecStart=/opt/agentpay/agentpay-gateway
Restart=always
RestartSec=5

Environment=AGENTPAY_BIND_ADDR=127.0.0.1:8080
Environment=AGENTPAY_RPC_URL=https://api.devnet.solana.com
Environment=AGENTPAY_PROGRAM_ID=3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U
Environment=AGENTPAY_LOG=info,tower_http=warn
# Secrets come from a file that is NOT world-readable (chmod 600):
EnvironmentFile=/etc/agentpay/secrets.env

# The provider key is the one thing worth stealing here.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/agentpay

[Install]
WantedBy=multi-user.target
```

`/etc/agentpay/secrets.env`:

```
DATABASE_URL=postgres://user:pass@host:5432/agentpay?sslmode=require
AGENTPAY_PROVIDER_KEYPAIR=/etc/agentpay/provider.json
```

```bash
chmod 600 /etc/agentpay/secrets.env /etc/agentpay/provider.json
chown agentpay: /etc/agentpay/secrets.env /etc/agentpay/provider.json
```

### About the provider key

The gateway holds the provider's Solana keypair because `settle_session`
requires that signature. **Its blast radius is bounded on-chain**, not by the
server:

- `provider_token_account.owner == provider` → funds cannot be redirected elsewhere
- the Ed25519 precompile checks the *agent's* signature → cannot settle above what the agent authorised
- `init` on `SettlementRecord` → cannot settle twice

So a stolen key lets an attacker settle **early** or **low**, costing the
provider revenue. It does **not** let them move money to themselves. Still worth
protecting — use a KMS or a secrets manager rather than a file if you can.

### Reverse proxy

Do not expose `:8080` directly. Bind to loopback and put nginx/Caddy in front
for TLS.

```nginx
location /api/gw/ {
    proxy_pass http://127.0.0.1:8080/;
    proxy_set_header Host $host;
}
```

---

## 4. The console (Next.js)

### Vercel (simplest)

```bash
cd web && vercel --prod
```

Set one environment variable:

| Variable | Value |
|---|---|
| `AGENTPAY_GATEWAY_URL` | `https://gateway.yourdomain.com` |

> The browser **never** talks to the gateway directly. `/api/gw/[...path]` is a
> server-side proxy, so the gateway URL stays server-only and there is no CORS to
> loosen. That means the gateway must be reachable **from Vercel's servers**, not
> from the user's browser.

### Self-hosted

```bash
cd web && npm ci && npm run build
AGENTPAY_GATEWAY_URL=http://127.0.0.1:8080 npm start   # :3100
```

Behind the same reverse proxy, with its own systemd unit.

---

## 5. Pre-flight checklist

Run through this before calling anything "deployed":

- [ ] `AGENTPAY_TRUST_OPEN_REQUESTS` is **not** set → on-chain reconciliation active
- [ ] `/health` reports `"state_backend":"POSTGRES"` → not the in-memory store
- [ ] `DATABASE_URL` uses `sslmode=require`
- [ ] Database backups / PITR enabled
- [ ] `provider.json` is `chmod 600`, owned by the service user
- [ ] Gateway bound to `127.0.0.1`, TLS terminated at the proxy
- [ ] Program ID in gateway env matches the deployed program
- [ ] `REVOKE UPDATE, DELETE ON evidence_log` applied
- [ ] Deployer/upgrade-authority key stored offline, not on the server

Verify the two that silently degrade:

```bash
curl -s https://gateway.yourdomain.com/health | jq
# ephemeral_state must be false, state_backend must be "POSTGRES"
```

```bash
journalctl -u agentpay-gateway | grep -i "reconciliation enabled"
# must appear; "TRUST_OPEN_REQUESTS" must NOT
```

---

## 6. Known gaps — deploy with these in view

| Gap | Impact |
|---|---|
| **No security audit** | The big one. See §0. |
| **Token-2022 untested** | Code path exists, never executed. Stick to classic SPL Token mints. |
| **Single gateway instance** | Row locks serialise per session, but multi-instance is unproven. Run **one** writer. |
| **Append-only is convention** | Mitigated by the `REVOKE` in §2, but the DB owner can still rewrite. Tampering stays detectable. |
| **Provider key on the server** | Bounded on-chain; provider-side signing is the correct end state. |
| **`/v1/session/open` is unauthenticated** | Anyone who knows a real on-chain session can register it. They cannot forge claims (signatures are checked against the on-chain agent key), but rate-limit this endpoint. |

---

## 7. Rollback

**Program** — redeploy the previous `.so` with the same program ID. State
survives; only bytecode changes.

**Gateway** — swap the binary and restart. Stateless.

**Database** — migrations are additive and there are no `DROP`s. A rollback to
an earlier gateway version works against a newer schema.

**Console** — Vercel keeps previous deployments; promote one.
