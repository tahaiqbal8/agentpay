/**
 * Leaves one genuinely settleable session waiting in the console.
 *
 * Every other devnet script settles at the end, which is right for a test —
 * it proves the whole path — but it means the Settlement page never has
 * anything to act on, and the Settle button is never seen doing its job.
 *
 * This opens a real escrow on chain, registers it honestly so the gateway
 * reconciles it, drives a claim ladder through the enforcement path, and then
 * STOPS. The settlement is deliberately left for a human to trigger.
 *
 * Nothing here is mocked. The vault holds real devnet tokens and the session
 * account is readable with `solana account`.
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
import bs58 from "bs58";
import * as fs from "fs";
import {
  buildClaimMessage,
  chainTime,
  deriveSession,
  deriveVault,
  makeProvider,
  randomSessionId,
  throttle,
  withRpcRetry,
} from "../tests/helpers";

const BASE = process.env.GATEWAY ?? "http://127.0.0.1:8080";
const KEYPAIR_PATH =
  process.env.AGENTPAY_PROVIDER_KEYPAIR?.trim() ||
  `${process.env.HOME}/.config/solana/agentpay-provider.json`;
const DEPOSIT = 3_000_000n; // 3 USDC
/** An hour is long enough to read the page, click around, and still settle. */
const WINDOW_SECS = 3600;

function fail(msg: string): never {
  console.error(`\nFAILED: ${msg}\n`);
  process.exit(1);
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

(async () => {
  if (!fs.existsSync(KEYPAIR_PATH)) {
    fail(
      `No provider keypair at ${KEYPAIR_PATH}\n\n` +
        `  solana-keygen new --no-bip39-passphrase -o ${KEYPAIR_PATH}\n`
    );
  }

  const anchorProvider = makeProvider();
  anchor.setProvider(anchorProvider);
  const program = new anchor.Program(require("../target/idl/agentpay.json"), anchorProvider);
  const connection = anchorProvider.connection;
  const treasury = (anchorProvider.wallet as any).payer as Keypair;
  const providerKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")))
  );

  console.log(`cluster  ${connection.rpcEndpoint}`);
  console.log(`program  ${program.programId.toBase58()}\n`);

  // ---- real escrow, real tokens ------------------------------------------
  const agent = Keypair.generate();
  console.log("1. funding the agent and minting");
  await withRpcRetry("fund", async () => {
    await throttle(connection);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: treasury.publicKey,
        toPubkey: agent.publicKey,
        lamports: 15_000_000,
      }),
      SystemProgram.transfer({
        fromPubkey: treasury.publicKey,
        toPubkey: providerKp.publicKey,
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
  // settle_session transfers into this account and will not create it, so the
  // Settle button would fail later if it did not exist now.
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
  const expiresAt = (await chainTime(connection)) + WINDOW_SECS;

  console.log("2. opening the escrow on chain");
  const openSig = await withRpcRetry("openSession", async () => {
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

  const vaultHeld = BigInt((await connection.getTokenAccountBalance(vault)).value.amount);
  if (vaultHeld !== DEPOSIT) fail(`vault holds ${vaultHeld}, expected ${DEPOSIT}`);
  console.log(`   ${session.toBase58()}`);
  console.log(`   vault holds ${vaultHeld} micro-USDC  (${openSig.slice(0, 16)}…)\n`);

  // ---- register, reconciled against the chain -----------------------------
  console.log("3. registering with the gateway");
  const open = await post("/v1/session/open", {
    session: session.toBase58(),
    agent: agent.publicKey.toBase58(),
    provider: providerKp.publicKey.toBase58(),
    mint: mint.toBase58(),
    deposited_total: DEPOSIT.toString(),
    expires_at: expiresAt.toString(),
  });
  if (open.status !== 200) {
    fail(`gateway refused the session: ${open.status} ${JSON.stringify(open.body)}`);
  }
  console.log("   reconciled against the chain\n");

  // ---- a ladder with refusals in it, so the evidence is worth reading -----
  const claimExpiry = BigInt(expiresAt);
  const signClaim = (cumulative: bigint, nonce: bigint) => ({
    session: session.toBase58(),
    cumulative_amount: cumulative.toString(),
    nonce: nonce.toString(),
    expires_at: claimExpiry.toString(),
    signature: bs58.encode(
      nacl.sign.detached(buildClaimMessage(session, cumulative, nonce, claimExpiry), agent.secretKey)
    ),
  });

  console.log("4. driving claims (the refusals are the point)");
  const ladder: Array<[bigint, bigint, string]> = [
    [200_000n, 1n, "allowed"],
    [650_000n, 2n, "allowed"],
    [650_000n, 3n, "replay of the same total"],
    [100_000n, 4n, "regression to a lower total"],
    [900_000n, 2n, "nonce reuse"],
    [50_000_000n, 9n, "more than the vault holds"],
    [1_100_000n, 5n, "allowed"],
  ];
  let highest = 0n;
  for (const [cum, nonce, note] of ladder) {
    const r = await post("/v1/claim/verify", { claim: signClaim(cum, nonce) });
    const verdict = r.status === 200 ? "ALLOW " : "REFUSE";
    const code = r.status === 200 ? "" : ` ${r.body?.reason_code}`;
    if (r.status === 200) highest = cum;
    console.log(`   ${verdict} ${String(cum).padStart(9)}  ${note}${code}`);
  }

  // ---- and stop, deliberately --------------------------------------------
  console.log(`
5. leaving it unsettled

   The escrow is real and the gateway will settle it, but nothing here
   calls settle. That is for the Settlement page to do.

   session   ${session.toBase58()}
   vault     ${DEPOSIT} micro-USDC
   owed      ${highest} micro-USDC  (the highest claim; the rest never reach the chain)
   window    ${Math.round(WINDOW_SECS / 60)} minutes

   Open http://localhost:3100/settle and press Settle.
   Verify it afterwards with:
     solana account ${session.toBase58()} -u devnet
`);
})().catch((e) => {
  console.error("\nUNCAUGHT:", e?.message ?? e);
  process.exit(1);
});
