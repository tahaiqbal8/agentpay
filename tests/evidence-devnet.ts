// ─── V1 LEGACY ───────────────────────────────────────────────────────────────
// Drives the OLD program, 3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U, via
// idl/agentpay-v1.json. It is regression coverage for sessions opened before
// the v2 cutover — it is NOT a demonstration of AgentPay.
// Run it as `npm run evidence:v1-legacy`. The demo is `npm run demo:v2`.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * End-to-end evidence test against Solana devnet.
 *
 * Opens a real escrow session, drives a mix of allowed and DENIED claims
 * through the gateway, settles on-chain, then checks the Merkle root the
 * program actually stored against a root recomputed here from the published
 * log — using an independent SHA-256 implementation, so a bug in the gateway's
 * own Merkle code cannot make this pass.
 *
 * The denial is the point. Anyone can show an agent paid; this shows an agent
 * was STOPPED, and proves it against a root committed on-chain.
 */
import * as anchor from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash } from "crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import * as fs from "fs";
import {
  buildClaimMessage,
  chainTime,
  deriveSession,
  deriveSettlementRecord,
  deriveVault,
  makeProvider,
  randomSessionId,
  throttle,
  withRpcRetry,
} from "./helpers";

const BASE = process.env.GATEWAY ?? "http://127.0.0.1:8080";
// Defaults to the standard location so the script runs with no env at all.
const KEYPAIR_PATH =
  process.env.AGENTPAY_PROVIDER_KEYPAIR?.trim() ||
  `${process.env.HOME}/.config/solana/agentpay-provider.json`;
const DEPOSIT = 2_000_000n;

// @types/node distinguishes Buffer<ArrayBuffer> from Buffer<ArrayBufferLike>;
// everything here is the latter so the two never have to unify.
type Bytes = Buffer<ArrayBufferLike>;

const sha256 = (...parts: Bytes[]): Bytes =>
  createHash("sha256").update(Buffer.concat(parts)).digest();

function fail(msg: string): never {
  console.error(`\nFAILED: ${msg}\n`);
  process.exit(1);
}

async function post(path: string, body: any): Promise<{ status: number; body: any }> {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(BASE + path);
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

/** Independent reimplementation of the gateway's entry hash. */
function entryHash(
  prevHash: Bytes,
  session: PublicKey,
  cumulative: bigint,
  nonce: bigint,
  decision: string
): Bytes {
  const cum = Buffer.alloc(8);
  cum.writeBigUInt64LE(cumulative);
  const non = Buffer.alloc(8);
  non.writeBigUInt64LE(nonce);
  return sha256(prevHash, session.toBuffer(), cum, non, Buffer.from(decision, "utf8"));
}

/** Independent reimplementation of the gateway's Merkle root. */
function merkleRoot(leaves: Bytes[]): Bytes {
  if (leaves.length === 0) return Buffer.alloc(32);
  let level: Bytes[] = leaves;
  while (level.length > 1) {
    const next: Bytes[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left; // duplicate odd
      next.push(sha256(left, right));
    }
    level = next;
  }
  return level[0];
}

/** Independent proof verifier. */
function verifyProof(leaf: Bytes, proof: Array<{ hash: string; side: string }>, root: Bytes) {
  let cur: Bytes = leaf;
  for (const node of proof) {
    const sib = Buffer.from(node.hash, "hex");
    cur = node.side === "right" ? sha256(cur, sib) : sha256(sib, cur);
  }
  return cur.equals(root);
}

(async () => {
  if (!fs.existsSync(KEYPAIR_PATH)) {
    fail(
      `No provider keypair at ${KEYPAIR_PATH}\n\n` +
        `  solana-keygen new --no-bip39-passphrase -o ${KEYPAIR_PATH}\n\n` +
        `Or point AGENTPAY_PROVIDER_KEYPAIR at an existing one.`
    );
  }

  const anchorProvider = makeProvider();
  anchor.setProvider(anchorProvider);
  const program = new anchor.Program(// The DEPLOYED program is v1. `target/` holds whichever version was
    // last compiled, which is not a statement about what is on devnet.
    require("../idl/agentpay-v1.json"), anchorProvider);
  const connection = anchorProvider.connection;
  const treasury = (anchorProvider.wallet as any).payer as Keypair;
  const providerKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")))
  );

  const health = (await get("/health")).body;
  if (health.state_backend !== "POSTGRES") {
    fail(`gateway must run with DATABASE_URL; backend is ${health.state_backend}`);
  }
  console.log(`cluster  ${connection.rpcEndpoint}`);
  console.log(`backend  ${health.state_backend}\n`);

  // ---- on-chain session ---------------------------------------------------
  const agent = Keypair.generate();
  console.log("1. funding + mint + ATAs");
  await withRpcRetry("fund", async () => {
    await throttle(connection);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: treasury.publicKey,
        toPubkey: agent.publicKey,
        lamports: 15_000_000,
      })
    );
    return sendAndConfirmTransaction(connection, tx, [treasury], { commitment: "confirmed" });
  });

  const mint = await withRpcRetry("createMint", () =>
    createMint(connection, treasury, treasury.publicKey, null, 6, undefined,
      { commitment: "confirmed" }, TOKEN_PROGRAM_ID)
  );
  const agentAta = getAssociatedTokenAddressSync(mint, agent.publicKey, false, TOKEN_PROGRAM_ID);
  const providerAta = getAssociatedTokenAddressSync(
    mint, providerKp.publicKey, false, TOKEN_PROGRAM_ID
  );
  await withRpcRetry("atas", async () => {
    await throttle(connection);
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(treasury.publicKey, agentAta, agent.publicKey, mint, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountInstruction(treasury.publicKey, providerAta, providerKp.publicKey, mint, TOKEN_PROGRAM_ID),
      createMintToInstruction(mint, agentAta, treasury.publicKey, DEPOSIT, [], TOKEN_PROGRAM_ID)
    );
    return sendAndConfirmTransaction(connection, tx, [treasury], { commitment: "confirmed" });
  });

  const sessionId = randomSessionId();
  const session = deriveSession(program.programId, agent.publicKey, providerKp.publicKey, sessionId);
  const vault = deriveVault(program.programId, session);
  const settlementRecord = deriveSettlementRecord(program.programId, session);
  const expiresAt = (await chainTime(connection)) + 3600;

  console.log("2. opening escrow session on chain");
  await withRpcRetry("openSession", async () => {
    await throttle(connection);
    return program.methods
      .openSession(Array.from(sessionId), new anchor.BN(DEPOSIT.toString()), new anchor.BN(expiresAt))
      .accountsPartial({
        agent: agent.publicKey, provider: providerKp.publicKey, mint, session, vault,
        agentTokenAccount: agentAta, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc({ commitment: "confirmed" });
  });
  console.log(`   ${session.toBase58()}\n`);

  await post("/v1/session/open", {
    session: session.toBase58(),
    agent: agent.publicKey.toBase58(),
    provider: providerKp.publicKey.toBase58(),
    mint: mint.toBase58(),
    deposited_total: DEPOSIT.toString(),
    expires_at: expiresAt.toString(),
  });

  const exp = BigInt(expiresAt);
  const signClaim = (cum: bigint, nonce: bigint) => ({
    session: session.toBase58(),
    cumulative_amount: cum.toString(),
    nonce: nonce.toString(),
    expires_at: exp.toString(),
    signature: bs58.encode(
      nacl.sign.detached(buildClaimMessage(session, cum, nonce, exp), agent.secretKey)
    ),
  });

  // A realistic mix: the agent is stopped three times.
  console.log("3. driving claims (allowed AND denied)");
  const attempts: Array<[bigint, bigint, string]> = [
    [100_000n, 1n, "ALLOWED"],
    [400_000n, 2n, "ALLOWED"],
    [400_000n, 3n, "ERR_CLAIM_NOT_MONOTONIC"],
    [50_000n, 4n, "ERR_CLAIM_NOT_MONOTONIC"],
    [900_000n, 2n, "ERR_NONCE_NOT_MONOTONIC"],
    [99_000_000n, 9n, "ERR_CLAIM_EXCEEDS_DEPOSIT"],
    [750_000n, 5n, "ALLOWED"],
  ];
  for (const [cum, nonce, expected] of attempts) {
    const r = await post("/v1/claim/verify", { claim: signClaim(cum, nonce) });
    const got = r.status === 200 ? "ALLOWED" : r.body?.reason_code;
    if (got !== expected) fail(`claim ${cum}/${nonce}: expected ${expected}, got ${got}`);
    console.log(`   ${String(r.status).padEnd(4)} cumulative=${String(cum).padEnd(9)} ${got}`);
  }
  const highest = 750_000n;

  // ---- recompute the chain independently ----------------------------------
  console.log("\n4. recomputing the chain locally from the published log");
  const ev = await get(`/v1/session/${session.toBase58()}/evidence`);
  if (ev.status !== 200) fail(`evidence endpoint: ${JSON.stringify(ev.body)}`);
  if (!ev.body.chain_valid) fail(`gateway reports broken chain: ${ev.body.chain_error}`);
  if (ev.body.entry_count !== attempts.length) {
    fail(`expected ${attempts.length} entries, got ${ev.body.entry_count}`);
  }

  let prev: Bytes = Buffer.alloc(32);
  const leaves: Bytes[] = [];
  for (let i = 0; i < attempts.length; i++) {
    const e = ev.body.entries[i];
    if (e.sequence_id !== i) fail(`sequence gap at ${i}: got ${e.sequence_id}`);
    if (!Buffer.from(e.prev_hash, "hex").equals(prev)) fail(`broken link at seq ${i}`);
    const mine = entryHash(prev, session, BigInt(e.cumulative_amount), BigInt(e.nonce), e.decision);
    if (!mine.equals(Buffer.from(e.entry_hash, "hex"))) {
      fail(`entry hash mismatch at seq ${i}: gateway and local disagree`);
    }
    leaves.push(mine);
    prev = mine;
  }
  const localRoot = merkleRoot(leaves);
  if (localRoot.toString("hex") !== ev.body.merkle_root) {
    fail(`local root ${localRoot.toString("hex")} != gateway ${ev.body.merkle_root}`);
  }
  console.log(`   chain verified locally, ${leaves.length} entries`);
  console.log(`   root ${localRoot.toString("hex")}`);

  // ---- settle -------------------------------------------------------------
  console.log("\n5. settling on chain");
  const settle = await post("/v1/session/settle", { session: session.toBase58() });
  if (settle.status !== 200) fail(`settle: ${JSON.stringify(settle.body, null, 2)}`);
  console.log(`   sig  ${settle.body.signature}`);
  console.log(`   root ${settle.body.merkle_root} (${settle.body.evidence_entries} entries)`);

  // ---- the actual audit: on-chain root vs locally recomputed root ----------
  console.log("\n6. reading the root back from the chain");
  const record = await (program.account as any).settlementRecord.fetch(settlementRecord);
  const onChainRoot = Buffer.from(record.merkleRoot);
  console.log(`   on-chain  ${onChainRoot.toString("hex")}`);
  console.log(`   local     ${localRoot.toString("hex")}`);
  if (!onChainRoot.equals(localRoot)) {
    fail("on-chain Merkle root does not match the locally recomputed evidence root");
  }
  if (onChainRoot.equals(Buffer.alloc(32))) fail("on-chain root is all zeroes");
  if (BigInt(record.settledAmount.toString()) !== highest) {
    fail(`settled ${record.settledAmount}, expected ${highest}`);
  }
  console.log(`   MATCH — settled ${record.settledAmount} micro-USDC`);

  // ---- inclusion proof for a DENIAL ---------------------------------------
  console.log("\n7. proving a DENIAL is covered by the on-chain root");
  const denialSeq = attempts.findIndex(([, , d]) => d === "ERR_CLAIM_EXCEEDS_DEPOSIT");
  const proofRes = await post("/v1/evidence/proof", {
    session: session.toBase58(),
    sequence_id: denialSeq,
  });
  if (proofRes.status !== 200) fail(`proof: ${JSON.stringify(proofRes.body)}`);
  const p = proofRes.body;
  console.log(`   seq ${p.sequence_id}: ${p.decision} (cumulative=${p.cumulative_amount})`);
  console.log(`   proof length ${p.proof.length} for ${p.total_leaves} leaves`);

  const leafBuf = Buffer.from(p.leaf_hash, "hex");
  if (!leafBuf.equals(leaves[denialSeq])) fail("returned leaf does not match locally computed leaf");
  if (!verifyProof(leafBuf, p.proof, onChainRoot)) {
    fail("inclusion proof does not verify against the ON-CHAIN root");
  }
  console.log(`   proof verifies against the on-chain root`);

  // A proof must not verify a leaf it was not issued for.
  if (verifyProof(leaves[0], p.proof, onChainRoot)) {
    fail("proof verified a different leaf — the proof system is broken");
  }
  const tampered = p.proof.map((n: any, i: number) =>
    i === 0 ? { ...n, hash: "00".repeat(32) } : n
  );
  if (verifyProof(leafBuf, tampered, onChainRoot)) fail("tampered proof verified");
  console.log(`   negative controls hold (wrong leaf and tampered proof both rejected)`);

  console.log(
    `\nPASS  the agent was stopped 4 times, and that is provable against` +
    `\n      a root committed on-chain at` +
    `\n      https://explorer.solana.com/tx/${settle.body.signature}?cluster=devnet\n`
  );
})().catch((e) => {
  console.error("UNCAUGHT:", e?.message ?? e);
  process.exit(1);
});
