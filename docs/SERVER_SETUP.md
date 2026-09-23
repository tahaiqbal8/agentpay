# AgentPay — Bare-Metal Setup

From a **fresh machine** to a running stack. If you only need to redeploy an
existing install, use [DEPLOY.md](DEPLOY.md) instead.

---

## 1. What you actually need

### Hardware

| | Demo / dev | Production gateway |
|---|---|---|
| CPU | 2 cores | 2–4 cores |
| RAM | 4 GB | 4 GB (8 GB while compiling) |
| Disk | 15 GB | 20 GB |
| Network | any | static egress to Solana RPC |

> **The disk figure is mostly Rust.** A clean `cargo build` of the gateway pulls
> ~450 crates and the `target/` directory reaches several GB. On a 2-core box the
> first build takes **10–20 minutes**. Budget for it, or build elsewhere and ship
> the binary — it is statically self-contained apart from libc and OpenSSL.

### OS

Tested on **macOS 15 (arm64)**. Linux x86_64 is the expected server target —
nothing in the stack is macOS-specific, but the install commands below differ
slightly. Debian 12 / Ubuntu 22.04+ recommended.

### Which parts do you actually need?

You do **not** need all four on one box.

| Component | Needed for | Can live elsewhere? |
|---|---|---|
| **Gateway** (Rust) | everything | no — this is the service |
| **PostgreSQL** | durable state | ✅ managed DB |
| **Console** (Next.js) | the UI | ✅ Vercel |
| **Solana toolchain** | only to *build/deploy the program* | ✅ not needed at runtime |

> **Key point for a production server:** once the program is deployed, the
> gateway talks to Solana over plain HTTP RPC. **You do not need `solana-cli`,
> `anchor`, or a validator on the server.** Only a build machine needs them.

---

## 2. Toolchain install

### 2.1 System packages (Debian/Ubuntu)

```bash
sudo apt-get update && sudo apt-get install -y \
  build-essential pkg-config libssl-dev curl git ca-certificates
```

`libssl-dev` is required — sqlx uses native-tls for the Postgres connection.

### 2.2 Rust — needed on any machine that builds the gateway

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustc --version    # 1.98.1 here
```

### 2.3 Node — needed for the console and the test/demo scripts

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v            # v25.9.0 here; 20+ is fine
```

### 2.4 Docker — only if running Postgres locally

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # log out and back in
```

### 2.5 Solana + Anchor — **build machines only**

Skip this entirely on a runtime server.

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version   # 4.1.2 here

cargo install --git https://github.com/otter-sec/anchor avm --force
avm install latest && avm use latest
anchor --version   # 1.2.0 here
```

> ⚠️ **Verify these install sources before running them.** Anchor moved from
> `coral-xyz` to `otter-sec`, and the URL above is what
> [anchor-lang.com/docs/installation](https://www.anchor-lang.com/docs/installation)
> served when this was written. Both commands pipe a remote script into a shell,
> so check the current official docs rather than trusting this file.

### 2.6 Versions that are known to work together

| Tool | Version |
|---|---|
| rustc / cargo | 1.98.1 |
| solana-cli (Agave) | 4.1.2 |
| anchor-cli / avm | 1.2.0 |
| Node / npm | 25.9.0 / 11.12.1 |
| PostgreSQL | 16 |
| Next.js / React / Tailwind | 16.3 / 19.3 / 4.3 |
| sqlx | 0.8 |

> Anchor and `solana-cli` are **coupled** — Anchor 1.x requires Solana 3.0+.
> Upgrading one without the other produces serialization failures at runtime
> rather than compile errors, which is the worst way to find out.

---

## 3. Clone and build

```bash
git clone https://github.com/tahaiqbal8/agentpay.git
cd agentpay
```

### 3.1 Gateway

```bash
cd gateway && cargo build --release && cd ..
# → gateway/target/release/agentpay-gateway
```

Migrations are **embedded at compile time**, so the binary is self-contained and
needs no separate migration step at deploy.

### 3.2 Console

```bash
npm --prefix web ci
npm --prefix web run build
```

### 3.3 Test/demo scripts (optional)

```bash
npm ci        # root package.json — TypeScript test + demo tooling
```

### 3.4 Program (build machines only)

```bash
anchor build
```

---

## 4. Secrets you must create

Nothing sensitive ships in the repo. You generate these yourself.

### 4.1 Provider keypair — only if the gateway should settle

```bash
solana-keygen new --no-bip39-passphrase -o /etc/agentpay/provider.json
chmod 600 /etc/agentpay/provider.json
```

> Without it the gateway runs **verify-only**: it still verifies claims and
> enforces limits, but `/v1/session/settle` returns
> `ERR_SETTLEMENT_UNAVAILABLE`. That is a legitimate deployment mode.

**This key must match the `provider` recorded in each session**, or settlement
fails with `ERR_WRONG_PROVIDER_KEY`.

### 4.2 Database credentials

Managed Postgres: take the connection string from your provider. Local Docker:

```bash
./scripts/dev-db.sh up     # prints a DATABASE_URL for :5434
```

### 4.3 Deployer wallet — build machines only

```bash
solana-keygen new -o ~/.config/solana/id.json
```

> Holds the program's **upgrade authority**. Keep it off the runtime server —
> it has no business there, and a compromised gateway box should not be able to
> replace the program.

---

## 5. Environment

```bash
# /etc/agentpay/secrets.env   (chmod 600)
DATABASE_URL=postgres://user:pass@host:5432/agentpay?sslmode=require
# AgentPay's OWN key — settles v2 sessions (the current program).
AGENTPAY_SETTLEMENT_AUTHORITY_KEYPAIR=/etc/agentpay/settlement-authority.json
# LEGACY — a provider's own key, settles v1 sessions only. Remove once the
# last v1 session has drained. See docs/MIGRATION_V1_V2.md.
AGENTPAY_PROVIDER_KEYPAIR=/etc/agentpay/provider.json
```

```bash
# non-secret, fine in the unit file
AGENTPAY_BIND_ADDR=127.0.0.1:8080
AGENTPAY_RPC_URL=https://api.devnet.solana.com
# v2 opens new sessions; v1 stays reachable so its sessions can still settle.
AGENTPAY_PROGRAM_ID=ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m
AGENTPAY_LEGACY_PROGRAM_ID=3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U
AGENTPAY_LOG=info,tower_http=warn
```

| Variable | Required | If absent |
|---|:--:|---|
| `AGENTPAY_RPC_URL` | ✅ | refuses to start |
| `AGENTPAY_PROGRAM_ID` | ✅ | refuses to start |
| `DATABASE_URL` | prod | **in-memory — loses state on restart** |
| `AGENTPAY_PROVIDER_KEYPAIR` | — | verify-only, cannot settle |
| `AGENTPAY_BIND_ADDR` | — | `127.0.0.1:8080` |
| `AGENTPAY_TRUST_OPEN_REQUESTS` | ❌ | **never set in production** |

> **Two of these degrade silently rather than failing.** Missing `DATABASE_URL`
> means every gateway restart forgets the claim high-water marks, which re-opens
> claim replay for every live session. `AGENTPAY_TRUST_OPEN_REQUESTS=1` lets a
> caller assert a deposit that was never escrowed. Neither throws an error —
> check for them explicitly (§8).

---

## 6. Run it

### Development — three terminals

```bash
./scripts/dev-db.sh up                                    # :5434
DATABASE_URL="postgres://agentpay:agentpay@127.0.0.1:5434/agentpay" \
AGENTPAY_PROVIDER_KEYPAIR="$HOME/.config/solana/agentpay-provider.json" \
  bash scripts/run-gateway.sh                             # :8080
npm --prefix web run dev                                  # :3100
```

Open **http://localhost:3100**

### Production — systemd

`/etc/systemd/system/agentpay-gateway.service`:

```ini
[Unit]
Description=AgentPay gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agentpay
WorkingDirectory=/opt/agentpay
ExecStart=/opt/agentpay/agentpay-gateway
Restart=always
RestartSec=5

Environment=AGENTPAY_BIND_ADDR=127.0.0.1:8080
Environment=AGENTPAY_RPC_URL=https://api.devnet.solana.com
Environment=AGENTPAY_PROGRAM_ID=ApjxJKBUUd8EEAovQe74jS9qZsRCAC2bwe8hTx7TpS9m
Environment=AGENTPAY_LEGACY_PROGRAM_ID=3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U
Environment=AGENTPAY_LOG=info,tower_http=warn
EnvironmentFile=/etc/agentpay/secrets.env

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/agentpay

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin agentpay
sudo systemctl daemon-reload
sudo systemctl enable --now agentpay-gateway
journalctl -u agentpay-gateway -f
```

### Reverse proxy

Bind the gateway to loopback and terminate TLS in front of it.

```nginx
server {
    listen 443 ssl;
    server_name gateway.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### Console

```bash
AGENTPAY_GATEWAY_URL=https://gateway.example.com npm --prefix web start   # :3100
```

> The browser never contacts the gateway directly — `/api/gw/[...path]` proxies
> server-side. So the gateway must be reachable **from the console's server**,
> not from the user's browser, and its URL is never shipped to the client.

---

## 7. Firewall

| Port | Who | Notes |
|---|---|---|
| 443 | public | nginx |
| 3100 | loopback | console |
| 8080 | loopback | gateway — **never expose** |
| 5432/5434 | gateway only | database |

Outbound: HTTPS to your Solana RPC endpoint.

---

## 8. Verify it actually works

Run all four. The first two catch the silent degradations from §5.

```bash
# 1. Durable state? ephemeral_state must be false.
curl -s localhost:8080/health | jq
```

```bash
# 2. Reconciliation on? This line must appear, and TRUST_OPEN must not.
journalctl -u agentpay-gateway | grep -iE "reconciliation enabled|TRUST_OPEN"
```

```bash
# 3. Database reachable and migrated.
curl -s localhost:8080/v1/sessions | jq '.sessions | length'
```

```bash
# 4. Console reaches the gateway through its proxy.
curl -s localhost:3100/api/gw/health | jq
```

Expected on a healthy install:

```json
{ "status": "ok", "ephemeral_state": false, "state_backend": "POSTGRES" }
```

### End-to-end

```bash
npm run demo            # needs AGENTPAY_TRUST_OPEN_REQUESTS=1 — dev only
npm run evidence:v1-legacy # full on-chain loop; spends devnet SOL
```

---

## 9. When it does not work

| Symptom | Cause | Fix |
|---|---|---|
| `error: linker 'cc' not found` | no build toolchain | install `build-essential` |
| `failed to run custom build command for openssl-sys` | missing headers | install `libssl-dev` / `pkg-config` |
| `password authentication failed` (28P01) | wrong creds, or container recreated with different `POSTGRES_USER` | check `DATABASE_URL` matches the container's env |
| `Connection refused` on :5434 | Postgres not running | `./scripts/dev-db.sh up` |
| Console shows `DEMO…` keys | gateway unreachable | start the gateway; check `AGENTPAY_GATEWAY_URL` |
| `ERR_SESSION_ACCOUNT_NOT_FOUND` | session not on chain — reconciliation working correctly | use a real session, or `AGENTPAY_TRUST_OPEN_REQUESTS=1` for local demos |
| `ERR_CHAIN_UNAVAILABLE` | RPC unreachable | **fails closed by design** — check `AGENTPAY_RPC_URL` |
| `ERR_SETTLEMENT_UNAVAILABLE` | no provider keypair | set `AGENTPAY_PROVIDER_KEYPAIR` |
| `ERR_WRONG_PROVIDER_KEY` | key ≠ session's provider | use the keypair the session was opened against |
| Dashboard renders but never populates | Next dev HMR socket blocked (some embedded browsers) | `npm --prefix web run build && npm --prefix web start` |
| Airdrop rate-limited | devnet faucet per-IP cap | https://faucet.solana.com |

---

## 10. Before calling it production

- [ ] `AGENTPAY_TRUST_OPEN_REQUESTS` **not** set
- [ ] `/health` → `"state_backend":"POSTGRES"`
- [ ] `DATABASE_URL` uses `sslmode=require`
- [ ] Database backups / PITR on
- [ ] `provider.json` `chmod 600`, owned by the service user
- [ ] Gateway on loopback, TLS at the proxy
- [ ] Deployer/upgrade key **not** on this server
- [ ] `REVOKE UPDATE, DELETE ON evidence_log FROM agentpay;` applied
- [ ] Program ID in env matches the deployed program

> **Read [DEPLOY.md §0](DEPLOY.md) before mainnet.** This code has not been
> audited. It moves tokens and holds a signing key. Devnet is appropriate;
> mainnet starts with an audit.
