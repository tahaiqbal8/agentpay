/**
 * Mock agent driver — scripted claim traffic for a live demo.
 *
 * Signs real Ed25519 claims with a locally generated agent key and walks the
 * gateway through allowed and denied scenarios. Every response is a genuine
 * gateway decision; nothing here is faked.
 *
 * WHAT THIS DOES NOT DO: settle on-chain. Settlement needs a real escrow
 * account funded on devnet, which this script does not create. Use
 * `npm run evidence-devnet` for the full loop including a real settlement
 * transaction. This script is the fast path for demonstrating enforcement.
 *
 * Because the session pubkey here is synthetic, the gateway must be started
 * with AGENTPAY_TRUST_OPEN_REQUESTS=1 (development only — it disables the
 * on-chain reconciliation added in D8).
 *
 *   npm run demo                 # one scripted pass, 8 scenarios
 *   npm run demo -- --watch      # continuous traffic until Ctrl-C
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { buildClaimMessage } from "../tests/helpers";

const BASE = process.env.GATEWAY ?? "http://127.0.0.1:8080";
const DEPOSIT = 5_000_000n; // 5 USDC, in micro-USDC
const WATCH = process.argv.includes("--watch");

const C = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  green: "\x1b[32m",
  amber: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

const agent = Keypair.generate();
const provider = Keypair.generate();
const mint = Keypair.generate();
const session = Keypair.generate().publicKey;
const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);

function usdc(micro: bigint | string): string {
  const v = BigInt(micro).toString().padStart(7, "0");
  return `${v.slice(0, -6)}.${v.slice(-6)}`;
}

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

/** Signs with `signer`, which is the real agent unless we are forging. */
function claim(cumulative: bigint, nonce: bigint, signer: Keypair = agent) {
  const msg = buildClaimMessage(session, cumulative, nonce, expiresAt);
  return {
    session: session.toBase58(),
    cumulative_amount: cumulative.toString(),
    nonce: nonce.toString(),
    expires_at: expiresAt.toString(),
    signature: bs58.encode(nacl.sign.detached(msg, signer.secretKey)),
  };
}

interface Scenario {
  label: string;
  cumulative: bigint;
  nonce: bigint;
  expect: string;
  signer?: Keypair;
  why: string;
}

const SCENARIOS: Scenario[] = [
  { label: "first claim", cumulative: 100_000n, nonce: 1n, expect: "ALLOWED",
    why: "cumulative and nonce both increase, inside the deposit" },
  { label: "ladder advances", cumulative: 400_000n, nonce: 2n, expect: "ALLOWED",
    why: "delta of 0.300000 authorised for this request" },
  { label: "exact replay", cumulative: 400_000n, nonce: 3n, expect: "ERR_CLAIM_NOT_MONOTONIC",
    why: "cumulative did not increase — replaying a paid claim buys nothing twice" },
  { label: "regression", cumulative: 50_000n, nonce: 4n, expect: "ERR_CLAIM_NOT_MONOTONIC",
    why: "cumulative went backwards below the high-water mark" },
  { label: "nonce reuse", cumulative: 900_000n, nonce: 2n, expect: "ERR_NONCE_NOT_MONOTONIC",
    why: "amount rose but the sequence number did not — out of order" },
  { label: "over the cap", cumulative: 99_000_000n, nonce: 9n, expect: "ERR_CLAIM_EXCEEDS_DEPOSIT",
    why: "more than was ever escrowed; the chain would refuse this too" },
  { label: "forged signature", cumulative: 600_000n, nonce: 10n, expect: "ERR_INVALID_SIGNATURE",
    signer: Keypair.generate(),
    why: "signed by a key that is not the session agent" },
  { label: "recovery after denials", cumulative: 750_000n, nonce: 11n, expect: "ALLOWED",
    why: "the mark was never moved by any refused claim" },
];

function badge(code: string): string {
  if (code === "ALLOWED") return `${C.green}ALLOWED${C.reset}`;
  if (code === "ERR_INVALID_SIGNATURE") return `${C.red}${code}${C.reset}`;
  return `${C.amber}${code}${C.reset}`;
}

async function openSession(): Promise<boolean> {
  const res = await post("/v1/session/open", {
    session: session.toBase58(),
    agent: agent.publicKey.toBase58(),
    provider: provider.publicKey.toBase58(),
    mint: mint.publicKey.toBase58(),
    deposited_total: DEPOSIT.toString(),
    expires_at: expiresAt.toString(),
  });

  if (res.status === 200) return true;

  if (res.body?.reason_code === "ERR_SESSION_ACCOUNT_NOT_FOUND") {
    console.error(
      `\n${C.red}The gateway is reconciling sessions against Solana.${C.reset}\n` +
        `This script uses a synthetic session that does not exist on chain.\n\n` +
        `Restart the gateway with:\n` +
        `  ${C.cyan}AGENTPAY_TRUST_OPEN_REQUESTS=1${C.reset} bash scripts/run-gateway.sh\n\n` +
        `That flag is development-only: it disables the check that stops a caller\n` +
        `claiming a deposit that was never escrowed. For the real path with a real\n` +
        `on-chain session, run ${C.cyan}npm run evidence-devnet${C.reset} instead.\n`
    );
    return false;
  }

  console.error(`\n${C.red}Could not open session:${C.reset}`, JSON.stringify(res.body, null, 2));
  return false;
}

async function scriptedPass() {
  console.log(`\n${C.bold}AgentPay — mock agent${C.reset}`);
  console.log(`${C.dim}gateway  ${BASE}${C.reset}`);
  console.log(`${C.dim}session  ${session.toBase58()}${C.reset}`);
  console.log(`${C.dim}agent    ${agent.publicKey.toBase58()}${C.reset}`);
  console.log(`${C.dim}deposit  ${usdc(DEPOSIT)} USDC${C.reset}\n`);

  if (!(await openSession())) process.exit(1);
  console.log(`${C.green}session open${C.reset} — watch the Monitor page at http://localhost:3100\n`);

  console.log(
    `${C.dim}  #  scenario                  cumulative     nonce  result${C.reset}`
  );
  console.log(`${C.dim}  ${"─".repeat(72)}${C.reset}`);

  let failures = 0;
  for (let i = 0; i < SCENARIOS.length; i++) {
    const s = SCENARIOS[i];
    const res = await post("/v1/claim/verify", {
      claim: claim(s.cumulative, s.nonce, s.signer),
    });
    const code = res.status === 200 ? "ALLOWED" : res.body?.reason_code ?? "?";
    const ok = code === s.expect;
    if (!ok) failures++;

    console.log(
      `  ${String(i + 1).padStart(2)}  ${s.label.padEnd(24)} ` +
        `${usdc(s.cumulative).padStart(12)}  ${String(s.nonce).padStart(5)}  ` +
        `${badge(code)}${ok ? "" : `  ${C.red}(expected ${s.expect})${C.reset}`}`
    );
    console.log(`      ${C.dim}${s.why}${C.reset}`);

    // Paced so the live feed on the dashboard is watchable during a demo.
    await new Promise((r) => setTimeout(r, 900));
  }

  console.log(`${C.dim}  ${"─".repeat(72)}${C.reset}`);

  const ev = (await fetch(`${BASE}/v1/session/${session.toBase58()}/evidence`).then((r) =>
    r.json()
  )) as { entry_count: number; chain_valid: boolean; merkle_root: string };
  console.log(
    `\n  evidence entries : ${C.cyan}${ev.entry_count}${C.reset} ` +
      `(${SCENARIOS.filter((s) => s.expect !== "ALLOWED" && s.expect !== "ERR_INVALID_SIGNATURE").length} denials recorded)`
  );
  console.log(`  chain intact     : ${ev.chain_valid ? C.green + "yes" : C.red + "NO"}${C.reset}`);
  console.log(`  merkle root      : ${C.cyan}${ev.merkle_root}${C.reset}`);
  console.log(
    `\n  ${C.dim}Verify it: http://localhost:3100/verifier?session=${session.toBase58()}${C.reset}`
  );
  console.log(
    `  ${C.dim}Note: ERR_INVALID_SIGNATURE is NOT in the log — unauthenticated${C.reset}`
  );
  console.log(
    `  ${C.dim}attempts are excluded so nobody can pad another session's root (D12).${C.reset}\n`
  );

  if (failures) {
    console.error(`${C.red}${failures} scenario(s) did not match the expected code.${C.reset}\n`);
    process.exit(1);
  }
}

/** Continuous traffic, for leaving on a projector during a demo. */
async function watchMode() {
  if (!(await openSession())) process.exit(1);
  console.log(
    `${C.green}watch mode${C.reset} — continuous claims, Ctrl-C to stop\n` +
      `${C.dim}session ${session.toBase58()}${C.reset}\n`
  );

  let cumulative = 0n;
  let nonce = 0n;

  for (;;) {
    nonce += 1n;
    // Roughly one in three attempts is a deliberate violation, so the feed
    // shows the enforcement layer doing something rather than a wall of green.
    const roll = Math.random();
    let label: string;
    let submitCumulative: bigint;
    let submitNonce = nonce;

    if (roll < 0.22) {
      label = "replay";
      submitCumulative = cumulative;
    } else if (roll < 0.34) {
      label = "over cap";
      submitCumulative = DEPOSIT + 1_000_000n;
    } else {
      label = "normal";
      submitCumulative = cumulative + BigInt(Math.floor(Math.random() * 60_000) + 1_000);
    }

    const res = await post("/v1/claim/verify", {
      claim: claim(submitCumulative, submitNonce),
    });
    const code = res.status === 200 ? "ALLOWED" : res.body?.reason_code ?? "?";
    if (code === "ALLOWED") cumulative = submitCumulative;

    console.log(
      `  ${new Date().toISOString().slice(11, 19)}  ${label.padEnd(9)} ` +
        `${usdc(submitCumulative).padStart(12)}  n${String(submitNonce).padStart(3)}  ${badge(code)}`
    );

    if (cumulative >= DEPOSIT - 100_000n) {
      console.log(`\n  ${C.dim}allowance nearly exhausted — stopping${C.reset}\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

(WATCH ? watchMode() : scriptedPass()).catch((e) => {
  console.error(`\n${C.red}UNCAUGHT${C.reset}`, e?.message ?? e);
  console.error(`Is the gateway running on ${BASE}?`);
  process.exit(1);
});
