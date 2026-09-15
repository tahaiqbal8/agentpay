/**
 * Live smoke test against a running gateway.
 * Signs real claims with a real Ed25519 key and walks the claim ladder.
 *
 * Uses synthetic session pubkeys that do not exist on chain, so the gateway
 * must be started with AGENTPAY_TRUST_OPEN_REQUESTS=1 to skip reconciliation.
 * That flag is development-only; see docs/decisions.md D16. For the real path,
 * use `npm run reconcile-devnet`.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { buildClaimMessage } from "./helpers";

const BASE = process.env.GATEWAY ?? "http://127.0.0.1:8080";

const agent = Keypair.generate();
const provider = Keypair.generate();
const mint = Keypair.generate().publicKey;
const session = Keypair.generate().publicKey;
const DEPOSIT = 5_000_000n;

function sign(cumulative: bigint, nonce: bigint, expiresAt: bigint) {
  const msg = buildClaimMessage(session, cumulative, nonce, expiresAt);
  const sig = nacl.sign.detached(msg, agent.secretKey);
  return {
    session: session.toBase58(),
    cumulative_amount: cumulative.toString(),
    nonce: nonce.toString(),
    expires_at: expiresAt.toString(),
    signature: bs58.encode(sig),
  };
}

async function post(path: string, body: any) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function show(label: string, r: { status: number; body: any }) {
  const code = r.body?.reason_code ?? r.body?.decision ?? "";
  const extra = r.body?.delta ? ` delta=${r.body.delta}` : "";
  console.log(`  ${String(r.status).padEnd(4)} ${label.padEnd(46)} ${code}${extra}`);
}

(async () => {
  const exp = BigInt(Math.floor(Date.now() / 1000) + 3600);

  console.log("\n-- health --");
  const h = await fetch(BASE + "/health").then((r) => r.json());
  console.log(" ", JSON.stringify(h));

  console.log("\n-- open session --");
  show(
    "open",
    await post("/v1/session/open", {
      session: session.toBase58(),
      agent: agent.publicKey.toBase58(),
      provider: provider.publicKey.toBase58(),
      mint: mint.toBase58(),
      deposited_total: DEPOSIT.toString(),
      expires_at: exp.toString(),
    })
  );
  show(
    "duplicate open (expect ERR_SESSION_ALREADY_OPEN)",
    await post("/v1/session/open", {
      session: session.toBase58(),
      agent: agent.publicKey.toBase58(),
      provider: provider.publicKey.toBase58(),
      mint: mint.toBase58(),
      deposited_total: DEPOSIT.toString(),
      expires_at: exp.toString(),
    })
  );

  console.log("\n-- claim ladder (expect ALLOW) --");
  for (const [cum, nonce] of [
    [20_000n, 1n],
    [45_000n, 2n],
    [45_001n, 3n],
  ] as const) {
    show(`cumulative=${cum} nonce=${nonce}`, await post("/v1/claim/verify", { claim: sign(cum, nonce, exp) }));
  }

  console.log("\n-- attacks (expect denials) --");
  show("exact replay of last claim", await post("/v1/claim/verify", { claim: sign(45_001n, 4n, exp) }));
  show("regression to lower cumulative", await post("/v1/claim/verify", { claim: sign(30_000n, 5n, exp) }));
  show("reused nonce", await post("/v1/claim/verify", { claim: sign(60_000n, 3n, exp) }));
  show("exceeds deposit", await post("/v1/claim/verify", { claim: sign(DEPOSIT + 1n, 9n, exp) }));

  const forged = sign(90_000n, 10n, exp);
  forged.signature = bs58.encode(nacl.sign.detached(
    buildClaimMessage(session, 90_000n, 10n, exp),
    Keypair.generate().secretKey
  ));
  show("signature from a different key", await post("/v1/claim/verify", { claim: forged }));

  const tampered = sign(95_000n, 11n, exp);
  tampered.cumulative_amount = "4000000";
  show("amount tampered after signing", await post("/v1/claim/verify", { claim: tampered }));

  const expired = sign(96_000n, 12n, BigInt(Math.floor(Date.now() / 1000) - 3600));
  show("expired claim", await post("/v1/claim/verify", { claim: expired }));

  const unknown = { ...sign(1_000n, 1n, exp), session: Keypair.generate().publicKey.toBase58() };
  show("unknown session", await post("/v1/claim/verify", { claim: unknown }));

  console.log("\n-- ladder still intact after the attacks --");
  show("cumulative=50000 nonce=20 (expect ALLOW)", await post("/v1/claim/verify", { claim: sign(50_000n, 20n, exp) }));

  console.log("\n-- settle (expect 501 ERR_NOT_IMPLEMENTED) --");
  show("settle", await post("/v1/session/settle", { session: session.toBase58() }));
  console.log();
})();
