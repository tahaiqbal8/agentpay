/**
 * Captures on-chain evidence for the custody invariants, on REAL devnet.
 *
 * The custody suite proves the invariants hold. This proves they held *here*,
 * on the deployed program, with transaction signatures and account state
 * anybody can check independently — which is the difference between a passing
 * test and evidence.
 *
 * Every number printed is read back from the chain after the fact, not from
 * the value the test submitted. A test that asserts against its own inputs
 * proves only that it can remember them.
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  buildClaimMessage,
  chainTime,
  Env,
  Fixture,
  makeProvider,
  programFor,
  readSettlementRecord,
  throttle,
} from "./helpers";

const ROOT_A = Array.from(Buffer.alloc(32, 0xa1));
const ROOT_B = Array.from(Buffer.alloc(32, 0xb2));

let env: Env;
let program: Program<any>;

function line(label: string, value: string | number | bigint) {
  console.log(`  ${label.padEnd(30)} ${value}`);
}

async function settle(
  f: Fixture,
  opts: {
    cumulative: bigint;
    signedCumulative?: bigint;
    nonce?: bigint;
    settler?: Keypair;
    claimSigner?: Keypair;
    providerTokenAccount?: PublicKey;
    merkleRoot?: number[];
  }
): Promise<string> {
  const settler = opts.settler ?? f.provider;
  const claimSigner = opts.claimSigner ?? f.agent;
  const nonce = opts.nonce ?? 1n;
  const claimExpiresAt = (await chainTime(env.connection)) + 600;
  const signed = opts.signedCumulative ?? opts.cumulative;

  const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: claimSigner.secretKey,
    message: buildClaimMessage(f.session, signed, nonce, BigInt(claimExpiresAt)),
  });

  await throttle(env.connection);
  return await program.methods
    .settleSession(
      new anchor.BN(opts.cumulative.toString()),
      new anchor.BN(nonce.toString()),
      new anchor.BN(claimExpiresAt),
      opts.merkleRoot ?? ROOT_A
    )
    .accountsPartial({
      settler: settler.publicKey,
      session: f.session,
      settlementRecord: f.settlementRecord,
      vault: f.vault,
      providerTokenAccount: opts.providerTokenAccount ?? f.providerAta,
      mint: env.mint,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([ed25519Ix])
    .signers([settler])
    .rpc({ commitment: "confirmed" });
}

/** Runs a transaction expected to fail, and reports the reason the chain gave. */
async function expectRejected(what: string, p: Promise<string>): Promise<void> {
  try {
    const sig = await p;
    console.log(`  ${what.padEnd(30)} *** SUCCEEDED (sig ${sig}) — THIS IS A HOLE ***`);
    process.exitCode = 1;
  } catch (e: any) {
    const code = e?.error?.errorCode?.code ?? "(non-anchor)";
    line(what, `REJECTED · ${code}`);
  }
}

async function main() {
  const provider = makeProvider();
  anchor.setProvider(provider);
  program = programFor("v2", provider);
  env = await Env.create(program, provider);

  const gateway = await env.newFundedKeypair(0.1 * 1_000_000_000);

  console.log("\n=== DEVNET EVIDENCE — program v2 custody ===\n");
  line("cluster", env.connection.rpcEndpoint);
  line("program id", program.programId.toBase58());
  line("settlement authority", gateway.publicKey.toBase58());
  line("test mint", env.mint.toBase58());

  // -------------------------------------------------------------------------
  console.log("\n--- A. 100 -> 750: the delta, not the total ---\n");
  const f = await env.newFixture({
    deposit: 1000n,
    agentBalance: 1000n,
    settlementAuthority: gateway.publicKey,
  });
  await env.openSession(f);

  line("session PDA", f.session.toBase58());
  line("agent", f.agent.publicKey.toBase58());
  line("provider destination", f.providerAta.toBase58());
  line("vault", f.vault.toBase58());
  line("settlement record PDA", f.settlementRecord.toBase58());

  const s0 = await (program.account as any).session.fetch(f.session);
  line("settlement_authority (chain)", new PublicKey(s0.settlementAuthority).toBase58());
  line("provider (chain)", new PublicKey(s0.provider).toBase58());

  const p0 = await env.tokenBalance(f.providerAta);
  const v0 = await env.tokenBalance(f.vault);
  line("provider balance before", p0);
  line("vault balance before", v0);

  const sig1 = await settle(f, { cumulative: 100n, settler: gateway, nonce: 1n });
  const p1 = await env.tokenBalance(f.providerAta);
  const v1 = await env.tokenBalance(f.vault);
  const r1 = await readSettlementRecord(env.connection, f.settlementRecord);
  console.log();
  line("settlement 1 tx", sig1);
  line("  claim cumulative", 100n);
  line("  provider balance", `${p0} -> ${p1}   (+${p1 - p0})`);
  line("  vault balance", `${v0} -> ${v1}   (-${v0 - v1})`);
  line("  record settled_amount", r1.settledAmount);

  const sig2 = await settle(f, {
    cumulative: 750n,
    settler: gateway,
    nonce: 2n,
    merkleRoot: ROOT_B,
  });
  const p2 = await env.tokenBalance(f.providerAta);
  const v2 = await env.tokenBalance(f.vault);
  const r2 = await readSettlementRecord(env.connection, f.settlementRecord);
  const s2 = await (program.account as any).session.fetch(f.session);
  console.log();
  line("settlement 2 tx", sig2);
  line("  claim cumulative", 750n);
  line("  previous cumulative", 100n);
  line("  provider balance", `${p1} -> ${p2}   (+${p2 - p1})`);
  line("  vault balance", `${v1} -> ${v2}   (-${v1 - v2})`);
  line("  record settled_amount", `${r2.settledAmount}   (CUMULATIVE)`);
  line("  session.cumulative_settled", BigInt(s2.cumulativeSettled.toString()));
  line("  record merkle_root", Buffer.from(r2.merkleRoot).toString("hex").slice(0, 32) + "…");
  console.log(
    `\n  delta moved by settlement 2: ${p2 - p1}  ` +
      `(750 - 100 = 650 ${p2 - p1 === 650n ? "✓" : "✗ MISMATCH"})`
  );

  // -------------------------------------------------------------------------
  console.log("\n--- B. rejections, on the deployed program ---\n");

  await expectRejected("750 -> 100 (backwards)", settle(f, { cumulative: 100n, settler: gateway, nonce: 3n }));
  await expectRejected("750 -> 750 (duplicate)", settle(f, { cumulative: 750n, settler: gateway, nonce: 4n }));

  const stranger = await env.newFundedKeypair(0.02 * 1_000_000_000);
  const g = await env.newFixture({ settlementAuthority: gateway.publicKey });
  await env.openSession(g);
  await expectRejected("unauthorized settler", settle(g, { cumulative: 1000n, settler: stranger }));

  const attacker = Keypair.generate();
  const attackerAta = await env.createAta(attacker.publicKey);
  await expectRejected(
    "arbitrary destination",
    settle(g, { cumulative: 1000n, settler: gateway, providerTokenAccount: attackerAta })
  );

  await expectRejected(
    "forged amount",
    settle(g, { cumulative: 900_000n, signedCumulative: 1000n, settler: gateway })
  );

  // -------------------------------------------------------------------------
  console.log("\n--- C. provider fallback, with no gateway involvement ---\n");
  const sig3 = await settle(g, { cumulative: 2000n, settler: g.provider, nonce: 1n });
  line("provider-signed tx", sig3);
  line("  settler", g.provider.publicKey.toBase58());
  line("  provider balance", await env.tokenBalance(g.providerAta));

  console.log("\n=== every figure above was read back from devnet ===\n");
}

main().catch((e) => {
  console.error("\nFAILED:", e?.message ?? e);
  process.exit(1);
});
