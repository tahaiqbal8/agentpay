// ─── V1 LEGACY ───────────────────────────────────────────────────────────────
// Drives the OLD program, 3aKGM6Cb4Rd5sPH5YmSFc9567xNCDDKschQ4u7y5xP2U.
// Run it as `npm run reconcile:v1-legacy`. The demo is `npm run demo:v2`.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * On-chain reconciliation of /v1/session/open, against devnet.
 *
 * Opens one real escrow session, then tries to register it with the gateway
 * under a series of lies. The honest registration must succeed and every lie
 * must be refused with a specific reason code.
 *
 * The attack this closes: asserting a deposit that was never escrowed, so the
 * gateway authorises claims against credit that does not exist and the provider
 * hands over resources for a settlement that can never happen.
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
import * as fs from "fs";
import {
  chainTime,
  deriveSession,
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
const DEPOSIT = 1_500_000n;

let failures = 0;

async function post(path: string, body: any): Promise<{ status: number; body: any }> {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

function check(label: string, got: { status: number; body: any }, wantStatus: number, wantCode?: string) {
  const code = got.body?.reason_code ?? (got.status === 200 ? "OK" : "?");
  const ok = got.status === wantStatus && (!wantCode || code === wantCode);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${String(got.status).padEnd(4)} ${label.padEnd(44)} ${code}`);
  if (!ok) {
    console.log(`        expected ${wantStatus} ${wantCode ?? ""}`);
    failures++;
  }
}

(async () => {
  if (!fs.existsSync(KEYPAIR_PATH)) {
    console.error(
      `No provider keypair at ${KEYPAIR_PATH}\n\n` +
        `  solana-keygen new --no-bip39-passphrase -o ${KEYPAIR_PATH}\n`
    );
    process.exit(1);
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

  const health = (await fetch(BASE + "/health").then((r) => r.json())) as any;
  console.log(`cluster ${connection.rpcEndpoint}`);
  console.log(`backend ${health.state_backend}\n`);

  // ---- one real, funded session ------------------------------------------
  const agent = Keypair.generate();
  console.log("1. creating a real escrow session on chain");
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
  await withRpcRetry("ata", async () => {
    await throttle(connection);
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(treasury.publicKey, agentAta, agent.publicKey, mint, TOKEN_PROGRAM_ID),
      createMintToInstruction(mint, agentAta, treasury.publicKey, DEPOSIT, [], TOKEN_PROGRAM_ID)
    );
    return sendAndConfirmTransaction(connection, tx, [treasury], { commitment: "confirmed" });
  });

  const sessionId = randomSessionId();
  const session = deriveSession(program.programId, agent.publicKey, providerKp.publicKey, sessionId);
  const vault = deriveVault(program.programId, session);
  const expiresAt = (await chainTime(connection)) + 3600;

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
  console.log(`   ${session.toBase58()}  deposit=${DEPOSIT}\n`);

  const truth = {
    session: session.toBase58(),
    agent: agent.publicKey.toBase58(),
    provider: providerKp.publicKey.toBase58(),
    mint: mint.toBase58(),
    deposited_total: DEPOSIT.toString(),
    expires_at: expiresAt.toString(),
  };

  // ---- lies, each refused for its own reason ------------------------------
  console.log("2. registering under false pretences (all must be refused)");

  check(
    "deposit inflated 100x",
    await post("/v1/session/open", { ...truth, deposited_total: (DEPOSIT * 100n).toString() }),
    400, "ERR_DEPOSIT_MISMATCH"
  );
  check(
    "deposit understated",
    await post("/v1/session/open", { ...truth, deposited_total: "1" }),
    400, "ERR_DEPOSIT_MISMATCH"
  );
  check(
    "agent key substituted",
    await post("/v1/session/open", { ...truth, agent: Keypair.generate().publicKey.toBase58() }),
    400, "ERR_SESSION_FIELD_MISMATCH"
  );
  check(
    "provider substituted",
    await post("/v1/session/open", { ...truth, provider: Keypair.generate().publicKey.toBase58() }),
    400, "ERR_SESSION_FIELD_MISMATCH"
  );
  check(
    "mint substituted",
    await post("/v1/session/open", { ...truth, mint: Keypair.generate().publicKey.toBase58() }),
    400, "ERR_SESSION_FIELD_MISMATCH"
  );
  check(
    "expiry extended by a day",
    await post("/v1/session/open", { ...truth, expires_at: (expiresAt + 86400).toString() }),
    400, "ERR_SESSION_FIELD_MISMATCH"
  );
  check(
    "session that was never opened on chain",
    await post("/v1/session/open", { ...truth, session: Keypair.generate().publicKey.toBase58() }),
    404, "ERR_SESSION_ACCOUNT_NOT_FOUND"
  );
  // A funded account that is not an AgentPay session: the system program owns
  // the treasury wallet, so the owner check must reject it.
  check(
    "address owned by another program",
    await post("/v1/session/open", { ...truth, session: treasury.publicKey.toBase58() }),
    400, "ERR_NOT_A_SESSION_ACCOUNT"
  );

  // ---- the truth is accepted ---------------------------------------------
  console.log("\n3. registering honestly");
  const honest = await post("/v1/session/open", truth);
  check("all fields match the chain", honest, 200);

  check("duplicate open still refused", await post("/v1/session/open", truth), 409, "ERR_SESSION_ALREADY_OPEN");

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} check(s)\n`);
    process.exit(1);
  }
  console.log(`\nPASS  uncollateralized credit creation is closed (D8)\n`);
})().catch((e) => {
  console.error("UNCAUGHT:", e?.message ?? e);
  process.exit(1);
});
