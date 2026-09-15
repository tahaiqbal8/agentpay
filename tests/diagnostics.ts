/**
 * Not an attack suite. This prints the *actual* on-chain failure for the cases
 * where the defence is structural rather than an Anchor error code, so the
 * loose regexes in attacks.ts can be checked against reality instead of trusted.
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  Ed25519Program,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  buildClaimMessage,
  buildRawEd25519Ix,
  chainTime,
  decodeEd25519Header,
  Env,
  ONE_USDC,
} from "./helpers";

let env: Env;
let program: Program<any>;

async function rawSettle(f: any, cumulative: bigint, nonce: bigint) {
  const claimExpiresAt = (await chainTime(env.connection)) + 600;
  const message = buildClaimMessage(
    f.session,
    cumulative,
    nonce,
    BigInt(claimExpiresAt)
  );
  return await program.methods
    .settleSession(
      new anchor.BN(cumulative.toString()),
      new anchor.BN(nonce.toString()),
      new anchor.BN(claimExpiresAt),
      Array.from(Buffer.alloc(32, 0xab))
    )
    .accountsPartial({
      provider: f.provider.publicKey,
      session: f.session,
      settlementRecord: f.settlementRecord,
      vault: f.vault,
      providerTokenAccount: f.providerAta,
      mint: env.mint,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([
      Ed25519Program.createInstructionWithPrivateKey({
        privateKey: f.agent.secretKey,
        message,
      }),
    ])
    .signers([f.provider])
    .rpc({ commitment: "confirmed" });
}

function dump(label: string, e: any) {
  console.log(`\n===== ${label} =====`);
  console.log("message:", e?.message);
  console.log("anchor errorCode:", JSON.stringify(e?.error?.errorCode ?? null));
  const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
  console.log("logs:");
  logs.forEach((l) => console.log("   ", l));
}

before(async function () {
  this.timeout(120_000);
  const anchorProvider = anchor.AnchorProvider.env();
  anchor.setProvider(anchorProvider);
  program = new anchor.Program(require("../target/idl/agentpay.json"), anchorProvider);
  env = await Env.create(program, anchorProvider);
});

describe("diagnostics", () => {
  it("prints the real error for a replayed settle", async function () {
    this.timeout(90_000);
    const f = await env.newFixture();
    await env.openSession(f);
    const sig = await rawSettle(f, ONE_USDC, 1n);
    console.log("\nfirst settle succeeded:", sig);
    try {
      await rawSettle(f, ONE_USDC, 1n);
      console.log("\n!!! SECOND SETTLE SUCCEEDED — VULNERABILITY !!!");
    } catch (e: any) {
      dump("replayed settle (identical claim)", e);
    }
    try {
      await rawSettle(f, 2n * ONE_USDC, 2n);
      console.log("\n!!! HIGHER-CLAIM SECOND SETTLE SUCCEEDED — VULNERABILITY !!!");
    } catch (e: any) {
      dump("second settle at higher cumulative", e);
    }
    console.log(
      "\nprovider balance after all attempts:",
      (await env.tokenBalance(f.providerAta)).toString(),
      "(expected 1000000)"
    );
  });

  it("confirms the precompile ACCEPTS the indirect-reference ix (so our check is what rejects)", async function () {
    this.timeout(90_000);
    const f = await env.newFixture();
    await env.openSession(f);

    const claimExpiresAt = (await chainTime(env.connection)) + 600;
    const message = buildClaimMessage(f.session, ONE_USDC, 1n, BigInt(claimExpiresAt));
    const canonical = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: f.agent.secretKey,
      message,
    });
    const data = Buffer.from(canonical.data);
    const h = decodeEd25519Header(data);
    console.log("\ncanonical ed25519 header:", JSON.stringify(h, null, 2));

    const raw = buildRawEd25519Ix({
      signatureOffset: h.signatureOffset,
      signatureIxIndex: 0,
      publicKeyOffset: h.publicKeyOffset,
      publicKeyIxIndex: 0,
      messageOffset: h.messageOffset,
      messageSize: h.messageSize,
      messageIxIndex: 0,
      payload: data.subarray(16),
    });

    // Submit the tampered precompile ix ALONE. If it lands, the precompile
    // accepted it, which means in the attack test our program is the only thing
    // standing between that instruction and a settled claim.
    try {
      const tx = new anchor.web3.Transaction().add(raw);
      const sig = await anchor.web3.sendAndConfirmTransaction(
        env.connection,
        tx,
        [env.payer],
        { commitment: "confirmed" }
      );
      console.log(
        "\nprecompile ACCEPTED the indirect-reference instruction, sig:",
        sig
      );
      console.log(
        "=> the Ed25519IndirectReference rejection in attacks.ts is OUR check firing."
      );
    } catch (e: any) {
      console.log(
        "\nprecompile REJECTED the indirect-reference instruction:",
        e?.message
      );
      console.log(
        "=> the attack test's rejection may come from the precompile, not our code."
      );
      dump("standalone indirect-reference ix", e);
    }
  });
});
