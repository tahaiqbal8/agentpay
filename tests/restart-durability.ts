/**
 * Proves the durable store does the one job it exists for: a gateway restart
 * must not reopen claim replay.
 *
 * Run in two phases around a real process restart:
 *
 *   npm run restart-test -- phase1   # open a session, walk a claim ladder
 *   <kill and restart the gateway>
 *   npm run restart-test -- phase2   # old claim must be refused, new one allowed
 *
 * Phase 1 writes the session and agent key to a scratch file so phase 2 can
 * sign as the same agent. The gateway process between the two phases shares no
 * memory with the first; only PostgreSQL carries the high-water mark across.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import * as fs from "fs";
import { buildClaimMessage } from "./helpers";

const BASE = process.env.GATEWAY ?? "http://127.0.0.1:8080";
const STATE_FILE = process.env.RESTART_STATE ?? "/tmp/agentpay-restart-state.json";
const DEPOSIT = 5_000_000n;

async function post(path: string, body: any): Promise<{ status: number; body: any }> {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

function fail(msg: string): never {
  console.error(`\nFAILED: ${msg}\n`);
  process.exit(1);
}

function signClaim(agent: Keypair, session: PublicKey, cumulative: bigint, nonce: bigint, exp: bigint) {
  return {
    session: session.toBase58(),
    cumulative_amount: cumulative.toString(),
    nonce: nonce.toString(),
    expires_at: exp.toString(),
    signature: bs58.encode(
      nacl.sign.detached(buildClaimMessage(session, cumulative, nonce, exp), agent.secretKey)
    ),
  };
}

async function phase1() {
  const agent = Keypair.generate();
  const session = Keypair.generate().publicKey;
  const exp = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const health = (await fetch(BASE + "/health").then((r) => r.json())) as any;
  console.log(`backend: ${health.state_backend}`);
  if (health.state_backend !== "POSTGRES") {
    fail(`gateway must run with DATABASE_URL set; backend is ${health.state_backend}`);
  }

  const open = await post("/v1/session/open", {
    session: session.toBase58(),
    agent: agent.publicKey.toBase58(),
    provider: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    deposited_total: DEPOSIT.toString(),
    expires_at: exp.toString(),
  });
  if (open.status !== 200) fail(`open failed: ${JSON.stringify(open.body)}`);
  console.log(`opened  ${session.toBase58()}  durability=${open.body.state_durability}`);

  for (const [cum, nonce] of [
    [100_000n, 1n],
    [250_000n, 2n],
    [900_000n, 3n],
  ] as const) {
    const r = await post("/v1/claim/verify", { claim: signClaim(agent, session, cum, nonce, exp) });
    if (r.status !== 200) fail(`claim ${cum} rejected: ${JSON.stringify(r.body)}`);
    console.log(`  ALLOW cumulative=${cum} delta=${r.body.delta}`);
  }

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({
      agent: Array.from(agent.secretKey),
      session: session.toBase58(),
      expiresAt: exp.toString(),
      highWaterMark: "900000",
    })
  );
  console.log(`\nhigh-water mark is 900000. state -> ${STATE_FILE}`);
  console.log("now restart the gateway, then run phase2");
}

async function phase2() {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const agent = Keypair.fromSecretKey(Uint8Array.from(saved.agent));
  const session = new PublicKey(saved.session);
  const exp = BigInt(saved.expiresAt);

  console.log(`session ${session.toBase58()} (opened before the restart)\n`);

  // 1. The session itself must still be known. On the in-memory store this
  //    alone would already be gone.
  const probe = await post("/v1/claim/verify", {
    claim: signClaim(agent, session, 900_000n, 4n, exp),
  });
  if (probe.status === 404) {
    fail("session was forgotten across the restart — the durable store is not working");
  }

  // 2. Replaying the pre-restart high-water mark must be refused.
  if (probe.status === 200) {
    fail(
      "REPLAY SUCCEEDED across the restart: cumulative=900000 was admitted twice. " +
        "The agent just obtained a second resource for the same money."
    );
  }
  if (probe.body?.reason_code !== "ERR_CLAIM_NOT_MONOTONIC") {
    fail(`expected ERR_CLAIM_NOT_MONOTONIC, got ${probe.body?.reason_code}`);
  }
  console.log(`  ${probe.status} replay of cumulative=900000  ${probe.body.reason_code}`);

  // 3. A lower claim must also be refused.
  const lower = await post("/v1/claim/verify", {
    claim: signClaim(agent, session, 500_000n, 5n, exp),
  });
  if (lower.status === 200) fail("regression to cumulative=500000 was admitted");
  console.log(`  ${lower.status} regression to 500000        ${lower.body.reason_code}`);

  // 4. A genuinely higher claim must still work, and its delta must be measured
  //    against the restored mark — not from zero.
  const next = await post("/v1/claim/verify", {
    claim: signClaim(agent, session, 1_000_000n, 6n, exp),
  });
  if (next.status !== 200) fail(`legitimate claim refused: ${JSON.stringify(next.body)}`);
  if (next.body.previous_cumulative !== "900000") {
    fail(
      `delta measured against ${next.body.previous_cumulative}, expected 900000 — ` +
        `the mark was not restored correctly`
    );
  }
  console.log(
    `  200 cumulative=1000000 delta=${next.body.delta} (measured against ${next.body.previous_cumulative})`
  );

  console.log("\nPASS  high-water mark survived the restart and still blocks replay");
}

const phase = process.argv[2];
(async () => {
  if (phase === "phase1") await phase1();
  else if (phase === "phase2") await phase2();
  else fail("usage: restart-durability.ts <phase1|phase2>");
})().catch((e) => {
  console.error("UNCAUGHT:", e?.message ?? e);
  process.exit(1);
});
