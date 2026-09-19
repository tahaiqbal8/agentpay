/**
 * An agent that actually buys things.
 *
 * This is the piece that was missing. `demo-agent.ts` proves the gateway
 * enforces limits; this proves an agent can *purchase* — 402, sign, pay, receive
 * real data from a provider that has no idea payments exist.
 *
 * Each response is checked for `served_by: "demo-provider"`, so the data is
 * demonstrably the provider's rather than something the gateway made up.
 *
 * Needs AGENTPAY_TRUST_OPEN_REQUESTS=1 (synthetic session pubkey, dev only).
 *
 *   npm run buy
 */
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { buildClaimMessage } from "../tests/helpers";

const GATEWAY = process.env.GATEWAY ?? "http://127.0.0.1:8080";
const DEPOSIT = 50_000n; // 0.05 USDC — small on purpose, so the cap is reachable

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

/** Amount the gateway has accepted so far. The agent tracks it itself. */
let cumulative = 0n;
let nonce = 0n;

const usdc = (v: bigint | string) => {
  const s = BigInt(v).toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
};

function signedClaim(next: bigint, n: bigint) {
  const msg = buildClaimMessage(session, next, n, expiresAt);
  return {
    session: session.toBase58(),
    cumulative_amount: next.toString(),
    nonce: n.toString(),
    expires_at: expiresAt.toString(),
    signature: bs58.encode(nacl.sign.detached(msg, agent.secretKey)),
  };
}

/**
 * One purchase, the full 402 dance.
 *
 * Step 1 asks without paying and expects 402 — the agent does not assume it
 * knows the price. Step 2 pays exactly what was quoted.
 */
async function buy(resource: string, query = ""): Promise<boolean> {
  const url = `${GATEWAY}/v1/buy/${resource}${query ? "?" + query : ""}`;

  // --- 1. ask, unpaid -----------------------------------------------------
  const quote = await fetch(url);

  // 404 here is the gateway refusing to price something the provider does not
  // sell. That is correct behaviour, not a failure — a gateway that priced
  // unknown resources would be selling goods that do not exist.
  if (quote.status === 404) {
    const b = (await quote.json()) as any;
    console.log(`  ${C.amber}404${C.reset} ${resource.padEnd(22)} ${C.amber}${b.reason_code}${C.reset}`);
    console.log(`      ${C.dim}${b.message}${C.reset}`);
    return false;
  }
  if (quote.status !== 402) {
    console.log(`  ${C.red}expected 402, got ${quote.status}${C.reset}`);
    return false;
  }
  const terms = (await quote.json()) as any;
  const price = BigInt(terms.price);
  console.log(
    `  ${C.dim}402${C.reset} ${resource.padEnd(22)} ` +
      `${C.dim}price${C.reset} ${usdc(price)} ${C.dim}(${terms.network})${C.reset}`
  );

  // --- 2. pay exactly the asking price ------------------------------------
  const next = cumulative + price;
  nonce += 1n;
  const res = await fetch(url, {
    headers: {
      // base64 of the JSON claim
      "x-agentpay-claim": Buffer.from(JSON.stringify(signedClaim(next, nonce))).toString("base64"),
    },
  });
  const body = (await res.json()) as any;

  if (res.status === 200) {
    // The mark only advances when the gateway says it did.
    cumulative = BigInt(body.cumulative_amount);
    const served = body.served_by === "demo-provider";
    console.log(
      `  ${C.green}200${C.reset} ${resource.padEnd(22)} ` +
        `${C.dim}paid${C.reset} ${usdc(body.delta)} ` +
        `${C.dim}total${C.reset} ${usdc(cumulative)} ` +
        `${served ? C.green + "✓ from provider" : C.red + "✗ NOT from provider"}${C.reset}`
    );
    console.log(`      ${C.cyan}${JSON.stringify(body.data)}${C.reset}`);
    return true;
  }

  console.log(
    `  ${C.amber}${res.status}${C.reset} ${resource.padEnd(22)} ` +
      `${C.amber}${body.reason_code}${C.reset}`
  );
  console.log(`      ${C.dim}${body.message}${C.reset}`);
  console.log(`      ${C.dim}no data returned — the provider was never contacted${C.reset}`);
  return false;
}

(async () => {
  console.log(`\n${C.bold}AgentPay — an agent buying things${C.reset}`);
  console.log(`${C.dim}gateway ${GATEWAY}${C.reset}`);
  console.log(`${C.dim}session ${session.toBase58()}${C.reset}`);
  console.log(`${C.dim}budget  ${usdc(DEPOSIT)} USDC${C.reset}\n`);

  const open = await fetch(`${GATEWAY}/v1/session/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: session.toBase58(),
      agent: agent.publicKey.toBase58(),
      provider: provider.publicKey.toBase58(),
      mint: mint.publicKey.toBase58(),
      deposited_total: DEPOSIT.toString(),
      expires_at: expiresAt.toString(),
    }),
  });
  if (open.status !== 200) {
    const b = (await open.json()) as any;
    console.error(`${C.red}session open failed: ${b?.reason_code}${C.reset}`);
    if (b?.reason_code === "ERR_SESSION_ACCOUNT_NOT_FOUND") {
      console.error(
        `\nThis script uses a synthetic session. Start the gateway with\n` +
          `  ${C.cyan}AGENTPAY_TRUST_OPEN_REQUESTS=1${C.reset}\n`
      );
    }
    process.exit(1);
  }

  console.log(`${C.bold}Shopping${C.reset}`);
  await buy("weather", "city=lahore");
  await buy("weather", "city=karachi");
  await buy("quote");
  await buy("weather", "city=tokyo");

  console.log(`\n${C.bold}Now something it cannot afford${C.reset}`);
  console.log(
    `${C.dim}budget ${usdc(DEPOSIT)}, spent ${usdc(cumulative)}, ` +
      `/analyse costs 0.025000${C.reset}`
  );
  // Repeated until the cap actually bites, so the denial is real rather than staged.
  for (let i = 0; i < 3; i++) {
    const ok = await buy("analyse", "subject=solana");
    if (!ok) break;
  }

  console.log(`\n${C.bold}And something that is not for sale${C.reset}`);
  await buy("nuclear-codes");

  const ev = (await fetch(`${GATEWAY}/v1/session/${session.toBase58()}/evidence`).then((r) =>
    r.json()
  )) as { entry_count: number; merkle_root: string; chain_valid: boolean };

  console.log(`\n${C.bold}Session summary${C.reset}`);
  console.log(`  spent            ${usdc(cumulative)} of ${usdc(DEPOSIT)} USDC`);
  console.log(`  evidence entries ${C.cyan}${ev.entry_count}${C.reset}`);
  console.log(`  chain intact     ${ev.chain_valid ? C.green + "yes" : C.red + "NO"}${C.reset}`);
  console.log(`  merkle root      ${C.cyan}${ev.merkle_root}${C.reset}`);
  console.log(
    `\n  ${C.dim}Console: http://localhost:3100/session/${session.toBase58()}${C.reset}`
  );
  console.log(
    `  ${C.dim}Settling now would commit that root on-chain in ONE transaction.${C.reset}\n`
  );
})().catch((e) => {
  console.error(`\n${C.red}UNCAUGHT${C.reset}`, e?.message ?? e);
  console.error(`Is the stack up?  docker compose ps`);
  process.exit(1);
});
