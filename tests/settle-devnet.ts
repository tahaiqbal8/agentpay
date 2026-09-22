/**
 * End-to-end settlement against Solana devnet.
 *
 * Opens a REAL escrow session on chain, walks a claim ladder through the
 * gateway, then asks the gateway to settle and verifies the tokens actually
 * moved. Nothing here is mocked: the signature printed at the end is a
 * confirmed devnet transaction.
 *
 * Requires a gateway running with AGENTPAY_PROVIDER_KEYPAIR set to the same
 * file this script reads, because settle_session needs the provider's signature.
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
const DEPOSIT = 5_000_000n; // 5 USDC
const USDC_DECIMALS = 6;

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

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
  const idl = // The DEPLOYED program is v1. `target/` holds whichever version was
    // last compiled, which is not a statement about what is on devnet.
    require("../idl/agentpay-v1.json");
  const program = new anchor.Program(idl, anchorProvider);
  const connection = anchorProvider.connection;
  const treasury = (anchorProvider.wallet as any).payer as Keypair;

  const providerKp = loadKeypair(KEYPAIR_PATH);
  console.log(`cluster   ${connection.rpcEndpoint}`);
  console.log(`program   ${program.programId.toBase58()}`);
  console.log(`provider  ${providerKp.publicKey.toBase58()}  (gateway holds this key)`);
  console.log(
    `treasury  ${treasury.publicKey.toBase58()}  ${(
      (await connection.getBalance(treasury.publicKey)) / LAMPORTS_PER_SOL
    ).toFixed(4)} SOL\n`
  );

  // ---- on-chain setup -----------------------------------------------------
  const agent = Keypair.generate();
  console.log("1. funding agent + provider");
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
    return sendAndConfirmTransaction(connection, tx, [treasury], {
      commitment: "confirmed",
    });
  });

  console.log("2. creating mint");
  const mint = await withRpcRetry("createMint", () =>
    createMint(
      connection,
      treasury,
      treasury.publicKey,
      null,
      USDC_DECIMALS,
      undefined,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    )
  );

  const agentAta = getAssociatedTokenAddressSync(mint, agent.publicKey, false, TOKEN_PROGRAM_ID);
  // The gateway derives exactly this address, and transfer_checked requires it
  // to already exist — the program does not create it.
  const providerAta = getAssociatedTokenAddressSync(
    mint,
    providerKp.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );

  console.log("3. creating ATAs and minting to agent");
  await withRpcRetry("atas", async () => {
    await throttle(connection);
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        treasury.publicKey,
        agentAta,
        agent.publicKey,
        mint,
        TOKEN_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        treasury.publicKey,
        providerAta,
        providerKp.publicKey,
        mint,
        TOKEN_PROGRAM_ID
      ),
      createMintToInstruction(mint, agentAta, treasury.publicKey, DEPOSIT, [], TOKEN_PROGRAM_ID)
    );
    return sendAndConfirmTransaction(connection, tx, [treasury], { commitment: "confirmed" });
  });

  const sessionId = randomSessionId();
  const session = deriveSession(
    program.programId,
    agent.publicKey,
    providerKp.publicKey,
    sessionId
  );
  const vault = deriveVault(program.programId, session);
  const settlementRecord = deriveSettlementRecord(program.programId, session);
  const expiresAt = (await chainTime(connection)) + 3600;

  console.log("4. opening escrow session on chain");
  const openSig = await withRpcRetry("openSession", async () => {
    await throttle(connection);
    return program.methods
      .openSession(Array.from(sessionId), new anchor.BN(DEPOSIT.toString()), new anchor.BN(expiresAt))
      .accountsPartial({
        agent: agent.publicKey,
        provider: providerKp.publicKey,
        mint,
        session,
        vault,
        agentTokenAccount: agentAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc({ commitment: "confirmed" });
  });
  console.log(`   session ${session.toBase58()}`);
  console.log(`   sig     ${openSig}`);

  const vaultBefore = BigInt((await connection.getTokenAccountBalance(vault)).value.amount);
  const providerBefore = BigInt(
    (await connection.getTokenAccountBalance(providerAta)).value.amount
  );
  if (vaultBefore !== DEPOSIT) fail(`vault should hold ${DEPOSIT}, holds ${vaultBefore}`);
  console.log(`   vault funded: ${vaultBefore} micro-USDC\n`);

  // ---- gateway ------------------------------------------------------------
  console.log("5. registering session with gateway");
  const open = await post("/v1/session/open", {
    session: session.toBase58(),
    agent: agent.publicKey.toBase58(),
    provider: providerKp.publicKey.toBase58(),
    mint: mint.toBase58(),
    deposited_total: DEPOSIT.toString(),
    expires_at: expiresAt.toString(),
  });
  if (open.status !== 200) fail(`gateway open returned ${open.status}: ${JSON.stringify(open.body)}`);

  const claimExpiry = BigInt(expiresAt);
  function signClaim(cumulative: bigint, nonce: bigint) {
    const msg = buildClaimMessage(session, cumulative, nonce, claimExpiry);
    return {
      session: session.toBase58(),
      cumulative_amount: cumulative.toString(),
      nonce: nonce.toString(),
      expires_at: claimExpiry.toString(),
      signature: bs58.encode(nacl.sign.detached(msg, agent.secretKey)),
    };
  }

  console.log("6. walking the claim ladder");
  const ladder: Array<[bigint, bigint]> = [
    [150_000n, 1n],
    [400_000n, 2n],
    [975_000n, 3n],
    [1_234_567n, 4n],
  ];
  for (const [cum, nonce] of ladder) {
    const r = await post("/v1/claim/verify", { claim: signClaim(cum, nonce) });
    if (r.status !== 200) fail(`claim ${cum} rejected: ${JSON.stringify(r.body)}`);
    console.log(`   ALLOW cumulative=${cum} delta=${r.body.delta}`);
  }
  const highest = ladder[ladder.length - 1][0];

  console.log("\n7. settling on chain via gateway");
  const settle = await post("/v1/session/settle", { session: session.toBase58() });
  if (settle.status !== 200) {
    fail(`settle returned ${settle.status}: ${JSON.stringify(settle.body, null, 2)}`);
  }
  const sig = settle.body.signature as string;
  console.log(`   signature ${sig}`);
  console.log(`   cumulative ${settle.body.cumulative_amount}`);

  // ---- verify on chain, not from the gateway's own claims ------------------
  console.log("\n8. verifying on chain");
  const tx = await withRpcRetry("getTransaction", () =>
    connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    })
  );
  if (!tx) fail(`transaction ${sig} not found on chain`);
  if (tx.meta?.err) fail(`transaction failed on chain: ${JSON.stringify(tx.meta.err)}`);
  console.log(`   confirmed in slot ${tx.slot}, fee ${tx.meta?.fee}`);

  const providerAfter = BigInt(
    (await connection.getTokenAccountBalance(providerAta)).value.amount
  );
  const vaultAfter = BigInt((await connection.getTokenAccountBalance(vault)).value.amount);
  const paid = providerAfter - providerBefore;

  console.log(`   provider received ${paid} micro-USDC (expected ${highest})`);
  console.log(`   vault remaining   ${vaultAfter} (expected ${DEPOSIT - highest})`);
  if (paid !== highest) fail(`provider received ${paid}, expected ${highest}`);
  if (vaultAfter !== DEPOSIT - highest) {
    fail(`vault holds ${vaultAfter}, expected ${DEPOSIT - highest}`);
  }

  const record = await (program.account as any).settlementRecord.fetch(settlementRecord);
  if (BigInt(record.settledAmount.toString()) !== highest) {
    fail(`settlement record says ${record.settledAmount}, expected ${highest}`);
  }
  console.log(`   settlement record on chain: settled_amount=${record.settledAmount}`);

  // Only the highest claim reached the chain; the other three never did.
  // That is the deferred scheme working.
  console.log(
    `\n   ${ladder.length} claims were authorised off-chain; 1 transaction settled them all`
  );

  console.log("\n9. settling again must be refused");
  const again = await post("/v1/session/settle", { session: session.toBase58() });
  if (again.status === 200) fail("second settle SUCCEEDED — double settlement is possible");
  console.log(`   ${again.status} ${again.body?.reason_code}`);

  console.log(
    `\nPASS  https://explorer.solana.com/tx/${sig}?cluster=devnet\n`
  );
})().catch((e) => {
  console.error("\nUNCAUGHT:", e?.message ?? e);
  process.exit(1);
});
