# AgentPay — Docker Compose

One command, three services, identical on **Windows, macOS (Intel and Apple
Silicon) and Linux**.

```bash
cp .env.example .env
docker compose up -d --build
```

Open **http://localhost:3100** — that is the UI.

> ⚠️ **Not `:8080`.** That is the gateway's JSON API, not a web page. Visiting
> it returns a small index telling you so. The console is on **3100**.

> Every base image is multi-arch (`amd64` + `arm64`), so there is no
> `platform:` pin anywhere and no emulation. Apple Silicon builds and runs
> natively.

---

## 1. What comes up

| Service | Host port | Image | Purpose |
|---|---|---|---|
| `web` | **3100** | built locally, 431 MB | Operator console |
| `provider` | 4021 *(loopback)* | built locally | Demo API — **no payment code in it** |
| `gateway` | 8080 *(loopback)* | built locally, 175 MB | JSON API — **not a web page** |
| `postgres` | 5434 *(loopback)* | `postgres:16-alpine` | High-water marks + evidence log |

**Only 3100 is meant for you.** The gateway and database bind to `127.0.0.1`
on the host, so they are not reachable from your network.

Startup is ordered by **health**, not by "started": the gateway waits for
Postgres to accept queries, because sqlx runs migrations at boot and would fail
against a database still initialising. The console then waits for the gateway.

---

## 2. Prerequisites per OS

### Windows

**Docker Desktop with the WSL2 backend.** Hyper-V-only will not work well.

```powershell
winget install Docker.DockerDesktop
```

Then in Docker Desktop → Settings → General, confirm *"Use the WSL 2 based
engine"* is ticked.

> ⚠️ **Clone the repo inside WSL2, not on `C:\`.**
>
> ```bash
> wsl
> cd ~                     # NOT /mnt/c/Users/...
> git clone https://github.com/tahaiqbal8/agentpay.git
> ```
>
> Bind mounts across the Windows/Linux filesystem boundary (`/mnt/c`) are
> **several times slower**. A Rust build that takes 12 minutes in the WSL2
> filesystem can take 40+ minutes on `/mnt/c`. This is the single biggest
> Windows gotcha.

**Line endings** are handled: `.gitattributes` forces LF on shell scripts and
Dockerfiles. Without it, Git for Windows would check out CRLF and containers
would fail with a confusing `\r: not found`.

### macOS

Docker Desktop, [OrbStack](https://orbstack.dev) (lighter, faster), or Colima.

```bash
brew install --cask docker        # or: brew install orbstack
```

Apple Silicon needs no special handling — verified on `arm64`.

### Ubuntu / Debian

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
newgrp docker        # or log out and back in
```

> Use **`docker compose`** (plugin, space) — not `docker-compose` (the old
> standalone binary). The v1 tool does not support the `depends_on` health
> conditions this file relies on. `sudo apt install docker-compose` installs the
> wrong one.

---

## 3. First run

```bash
git clone https://github.com/tahaiqbal8/agentpay.git
cd agentpay
cp .env.example .env
docker compose up -d --build
```

> **The first build compiles ~450 Rust crates: 10–20 minutes on 2 cores.**
> Dependencies live in their own Docker layer, so later builds after a source
> change take seconds. This is normal, not a hang — watch it with
> `docker compose logs -f gateway`.

Check it worked:

```bash
docker compose ps
```

```
gateway    Up (healthy)
postgres   Up (healthy)
web        Up (healthy)
```

All three must say **healthy**. If the gateway is `unhealthy`, see §7.

---

## 4. Configuration

Everything is in `.env`. Defaults are devnet and work out of the box.

| Variable | Default | Effect |
|---|---|---|
| `WEB_PORT` | 3100 | Change if the port clashes |
| `GATEWAY_PORT` | 8080 | Loopback only |
| `POSTGRES_PORT` | 5434 | Deliberately not 5432/5433 |
| `AGENTPAY_RPC_URL` | devnet | Refuses `mainnet` unless overridden |
| `AGENTPAY_PROGRAM_ID` | deployed devnet program | |
| `AGENTPAY_PROVIDER_KEYPAIR` | *(blank)* | Blank → verify-only |
| `AGENTPAY_TRUST_OPEN_REQUESTS` | *(blank)* | **Dev only.** See §6 |

> **Blank means unset.** Compose interpolates an unset `${VAR}` to an empty
> string rather than omitting it, so the gateway treats empty and
> whitespace-only values as absent. Otherwise it would try to open a keypair at
> path `""` and exit at startup.

### Enabling settlement

Without a provider keypair the gateway runs **verify-only**: it still verifies
claims and enforces limits, but `/v1/session/settle` returns
`ERR_SETTLEMENT_UNAVAILABLE`. That is a legitimate mode.

To enable it:

```bash
solana-keygen new --no-bip39-passphrase -o secrets/provider.json
```

and in `.env`:

```
AGENTPAY_PROVIDER_KEYPAIR=/secrets/provider.json
```

> That is the **container** path — the same string on every OS. `./secrets` is
> bind-mounted read-only at `/secrets`, and a relative path behaves identically
> on Windows, macOS and Linux. Nothing in `secrets/` is committed.
>
> The key must match the `provider` recorded in each session, or settlement
> fails with `ERR_WRONG_PROVIDER_KEY`.

---

## 5. Your data survives restarts

Postgres uses a named volume, `agentpay-pgdata`. Verified:

```
before  docker compose down  →  1 session, 7 evidence rows
after   docker compose up    →  1 session, 7 evidence rows
                                "restored high-water mark cumulative=750000"
```

**This is a security property, not convenience.** The high-water mark is the
only thing stopping an agent replaying an old claim to get a second resource for
the same money — the chain cannot help, because it only ever sees one settlement
per session. Losing that state re-opens replay for every live session.

```bash
docker compose down          # keeps the volume
docker compose down -v       # DELETES it — all sessions and evidence gone
```

---

## 6. Driving traffic

The demo script signs real claims but uses **synthetic** session pubkeys that do
not exist on chain, so reconciliation must be disabled for it:

```bash
# in .env
AGENTPAY_TRUST_OPEN_REQUESTS=1
```

```bash
docker compose up -d gateway    # pick up the change
npm ci                          # host-side tooling, once
npm run demo
```

Eight scenarios — two allowed, four denied, a forged signature, then a recovery
claim proving the high-water mark never moved during the denials.

> ⚠️ **Turn it back off afterwards.** That flag disables the check that stops a
> caller asserting a deposit that was never escrowed. The gateway warns about it
> on every boot.

### An agent that actually buys something

```bash
npm run buy
```

Walks the full 402 handshake against the demo provider: ask unpaid → get a price
→ sign a claim → receive real data. Then it tries to overspend and is refused.

Every successful response is checked for `served_by: demo-provider`, so the data
is demonstrably the provider's rather than something the gateway invented. And
the provider counts its own hits:

```bash
curl -s localhost:4021/health      # "served" rises only on PAID calls
```

That counter is the proof of the security property: a denied claim never reaches
the provider, so an agent cannot get free data by sending a claim it knows will
be refused.

For the real on-chain path with real escrow, use `npm run evidence:v1-legacy` — it
needs devnet SOL and the Solana toolchain on the host, not in Docker.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `gateway` stuck `unhealthy` | Cannot reach Postgres | `docker compose logs gateway` — look for `28P01` (bad password, `.env` changed after the volume was created) |
| Build hangs at `cargo build` | Not hung — compiling ~450 crates | `docker compose logs -f gateway`; 10–20 min first time |
| `port is already allocated` | 3100/8080/5434 in use | Change `WEB_PORT` etc. in `.env` |
| Console shows `DEMO…` keys | Gateway unreachable | `docker compose ps` — is `gateway` healthy? |
| `exec format error` | Wrong-arch image | Rebuild: `docker compose build --no-cache` |
| `\r: not found` in a container | CRLF line endings | Re-clone with `.gitattributes` present, or `git config core.autocrlf false` |
| Very slow builds on Windows | Repo on `/mnt/c` | Move it into the WSL2 filesystem (§2) |
| `docker-compose: command not found` | v1 not installed | Use `docker compose` (plugin) |
| `28P01` after changing `POSTGRES_PASSWORD` | Password only applies on **first** init | `docker compose down -v` (destroys data) or change it inside the DB |
| 404 at `localhost:8080` | Wrong port — that is the API | Use **3100**. `:8080/` now returns an index |
| `/health` shows a `program_id` you did not set | Container still holds env from when it was **created** | `docker compose up -d --force-recreate gateway` |

### Useful commands

```bash
docker compose logs -f gateway            # follow the gateway
docker compose exec postgres psql -U agentpay -d agentpay
docker compose restart gateway
docker compose build --no-cache gateway
docker compose down -v                    # nuke everything including data
```

---

## 8. Production notes

This compose file is aimed at development and demos. For a server:

- Put the console behind a reverse proxy with TLS; do not expose 3100 directly.
- Use a **managed** Postgres with backups rather than the container.
- Keep `AGENTPAY_TRUST_OPEN_REQUESTS` unset.
- Apply `REVOKE UPDATE, DELETE ON evidence_log FROM agentpay;`
- Mount the provider key from a secrets manager, not a bind mount.

See [DEPLOY.md](DEPLOY.md) and [SERVER_SETUP.md](SERVER_SETUP.md).

> **And the one that matters:** this code has not been audited. Devnet is
> appropriate; mainnet starts with an audit.
