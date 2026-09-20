/**
 * The same job `demo-buy.ts` does, through the SDK.
 *
 * `demo-buy.ts` is 194 lines: it builds the 73-byte message by hand, tracks a
 * cumulative total and a nonce, base64s a JSON envelope into a header, and
 * reads the 402 to learn each price. The buying in this file is six lines,
 * and the rest is setting up a real escrow on devnet so there is something to
 * spend.
 *
 * That difference is the point of the SDK. It is also where integrations go
 * wrong: every one of those hand-rolled steps fails at SETTLEMENT rather than
 * at the request, so a mistake looks like success until the money does not
 * move.
 */
import * as anchor from "@anchor-lang/core";
import {
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import * as fs from "fs";
import { AgentPayClient, AgentPayControl, AgentPayError } from "../sdk/src";
import {
  chainTime,
  deriveSession,
  deriveVault,
  ensureDevnetEnv,
  makeProvider,
  randomSessionId,
  throttle,
  withRpcRetry,
} from "../tests/helpers";

ensureDevnetEnv();

const GATEWAY = process.env.GATEWAY ?? "http://127.0.0.1:8080";
const ADMIN_TOKEN = process.env.AGENTPAY_ADMIN_TOKEN?.trim();
const KEYPAIR_PATH =
  process.env.AGENTPAY_PROVIDER_KEYPAIR?.trim() ||
  `${process.env.HOME}/.config/solana/agentpay-provider.json`;
const DEPOSIT = 2_000_000n;

const C = { g: "\x1b[32m", a: "\x1b[33m", d: "\x1b[2m", r: "\x1b[0m" };
const usdc = (v: bigint) => (Number(v) / 1e6).toFixed(6);

(async () => {
  if (!fs.existsSync(KEYPAIR_PATH)) {
    console.error(`\nNo provider keypair at ${KEYPAIR_PATH}\n`);
    process.exit(1);
  }

  // ---- setup: a real escrow, exactly as a human would open one ------------
  const provider = makeProvider();
  anchor.setProvider(provider);
  const program = new anchor.Program(require("../target/idl/agentpay.json"), provider);
  const connection = provider.connection;
  const treasury = (provider.wallet as any).payer as Keypair;
  const providerKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")))
  );
  const agentKp = Keypair.generate();

  console.log(`${C.d}opening a real escrow on devnet…${C.r}`);
  await withRpcRetry("fund", async () => {
    await throttle(connection);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: treasury.publicKey,
        toPubkey: agentKp.publicKey,
        lamports: 15_000_000,
      })
    );
    return sendAndConfirmTransaction(connection, tx, [treasury], { commitment: "confirmed" });
  });

  const mint = await withRpcRetry("mint", () =>
    createMint(connection, treasury, treasury.publicKey, null, 6, undefined,
      { commitment: "confirmed" }, TOKEN_PROGRAM_ID)
  );
  const agentAta = getAssociatedTokenAddressSync(mint, agentKp.publicKey, false, TOKEN_PROGRAM_ID);
  const providerAta = getAssociatedTokenAddressSync(mint, providerKp.publicKey, false, TOKEN_PROGRAM_ID);
  await withRpcRetry("atas", async () => {
    await throttle(connection);
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(treasury.publicKey, agentAta, agentKp.publicKey, mint, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountInstruction(treasury.publicKey, providerAta, providerKp.publicKey, mint, TOKEN_PROGRAM_ID),
      createMintToInstruction(mint, agentAta, treasury.publicKey, DEPOSIT, [], TOKEN_PROGRAM_ID)
    );
    return sendAndConfirmTransaction(connection, tx, [treasury], { commitment: "confirmed" });
  });

  const sessionId = randomSessionId();
  const session = deriveSession(program.programId, agentKp.publicKey, providerKp.publicKey, sessionId);
  const vault = deriveVault(program.programId, session);
  const expiresAt = (await chainTime(connection)) + 3600;

  await withRpcRetry("open", async () => {
    await throttle(connection);
    return program.methods
      .openSession(Array.from(sessionId), new anchor.BN(DEPOSIT.toString()), new anchor.BN(expiresAt))
      .accountsPartial({
        agent: agentKp.publicKey, provider: providerKp.publicKey, mint, session, vault,
        agentTokenAccount: agentAta, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([agentKp])
      .rpc({ commitment: "confirmed" });
  });

  await fetch(`${GATEWAY}/v1/session/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: session.toBase58(),
      agent: agentKp.publicKey.toBase58(),
      provider: providerKp.publicKey.toBase58(),
      mint: mint.toBase58(),
      deposited_total: DEPOSIT.toString(),
      expires_at: expiresAt.toString(),
    }),
  });

  // The human sets the envelope. Narrower than the escrow on purpose, so the
  // refusal below is the policy talking and not the deposit running out.
  const control = new AgentPayControl({ gateway: GATEWAY, adminToken: ADMIN_TOKEN });
  const agent = await control.createAgent({
    label: "SDK demo agent",
    agent_pubkey: agentKp.publicKey.toBase58(),
    mode: "autonomous",
  });
  await control.authorize(agent.agent_id, {
    max_total: "5000",
    max_per_call: "1000",
    allowed_resources: ["/weather", "/quote"],
  });
  console.log(`${C.d}escrow ${usdc(DEPOSIT)} USDC · envelope 0.005000 · allowlist /weather,/quote${C.r}\n`);

  // =========================================================================
  // Everything above is setup. THIS is what integrating actually looks like.
  // =========================================================================

  const pay = new AgentPayClient({
    gateway: GATEWAY,
    session: session.toBase58(),
    expiresAt,
    signer: {
      publicKey: agentKp.publicKey,
      sign: (msg) => nacl.sign.detached(msg, agentKp.secretKey),
    },
  });

  // "Multan" is deliberately not in the provider's list. A metered call is
  // charged per CALL, not per success — so the agent pays for that 404 too,
  // and the SDK makes that visible rather than printing `undefined°C`.
  for (const city of ["Lahore", "Karachi", "Multan"]) {
    const bought = await pay.buy<{ city: string; temp_c: number; condition: string }>(
      `/weather?city=${city}`
    );
    if (bought.ok) {
      console.log(
        `  ${C.g}200${C.r} ${city.padEnd(9)} paid ${usdc(bought.price)}  ` +
          `${C.d}${bought.data.temp_c}°C ${bought.data.condition} · via ${bought.servedBy}${C.r}`
      );
    } else {
      console.log(
        `  ${C.a}${bought.upstreamStatus}${C.r} ${city.padEnd(9)} paid ${usdc(bought.price)}  ` +
          `${C.a}charged, but the provider did not serve${C.r}`
      );
    }
  }

  // The envelope stops it, and the error says which rule did.
  try {
    await pay.buy("/analyse?subject=markets");
  } catch (e) {
    if (e instanceof AgentPayError) {
      console.log(
        `  ${C.a}${e.status}${C.r} analyse   ${C.a}${e.reasonCode}${C.r}  ` +
          `${C.d}${e.outOfAuthority ? "retrying will not help" : "transient"}${C.r}`
      );
    } else throw e;
  }

  // Budget exhaustion, handled without a hand-written loop.
  const run = await pay.buyMany<unknown>("/weather", 20, (i) => `?city=City${i}`);
  console.log(
    `\n  buyMany: ${run.purchases.length} of 20 succeeded, spent ${usdc(run.spent)}` +
      (run.stoppedBy ? `  ${C.a}stopped by ${run.stoppedBy.reasonCode}${C.r}` : "")
  );

  // Everything above touched the chain exactly once, at open. This is the
  // second and last time: one transaction settles every purchase.
  const state = await pay.sessionState();
  console.log(
    `\n  escrow left ${usdc(state.remaining)} of ${usdc(state.depositedTotal)} ` +
      `${C.d}· ${state.evidenceCount} decisions recorded${C.r}`
  );

  const settled = await pay.settle();
  console.log(
    `\n  ${C.g}settled${C.r} ${usdc(settled.cumulativeAmount)} USDC in one transaction\n` +
      `  ${C.d}sig   ${settled.signature}${C.r}\n` +
      `  ${C.d}root  ${settled.merkleRoot}${C.r}  ` +
      `${C.d}(${settled.evidenceEntries} decisions, refusals included)${C.r}`
  );

  console.log(
    `\n${C.g}PASS${C.r}  ${state.evidenceCount} decisions, ${usdc(pay.spent)} USDC committed,\n` +
      `      and exactly TWO chain transactions: one to open, one to settle.\n` +
      `      ${C.d}verify: solana confirm ${settled.signature} -u devnet${C.r}\n`
  );
})().catch((e) => {
  console.error("\nUNCAUGHT:", e?.message ?? e);
  process.exit(1);
});
