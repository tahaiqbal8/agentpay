import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { createMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";
import {
  buildClaimMessage,
  buildRawEd25519Ix,
  chainTime,
  CLAIM_MESSAGE_LEN,
  CLOCK_SKEW_TOLERANCE_SECS,
  decodeEd25519Header,
  Env,
  expectAnchorError,
  expectRawError,
  Fixture,
  ONE_USDC,
  sleep,
  USDC_DECIMALS,
  withRpcRetry,
} from "./helpers";

const ZERO_ROOT = Array.from(Buffer.alloc(32));
const DEMO_ROOT = Array.from(Buffer.alloc(32, 0xab));

let env: Env;
let program: Program<any>;

interface SettleOpts {
  cumulative: bigint;
  /** What gets signed, when it must differ from what is submitted. */
  signedCumulative?: bigint;
  nonce?: bigint;
  claimExpiresAt?: number;
  /** Keypair that signs the claim. Defaults to the session agent. */
  claimSigner?: Keypair;
  /** Keypair that signs the transaction. Defaults to the session provider. */
  settler?: Keypair;
  providerTokenAccount?: PublicKey;
  mint?: PublicKey;
  vault?: PublicKey;
  settlementRecord?: PublicKey;
  omitEd25519?: boolean;
  /** Inserts a filler instruction between the Ed25519 ix and settle. */
  displaceEd25519?: boolean;
  /** Replaces the canonical Ed25519 instruction entirely. */
  rawEd25519?: TransactionInstruction;
  merkleRoot?: number[];
}

async function settle(f: Fixture, opts: SettleOpts): Promise<string> {
  const nonce = opts.nonce ?? 1n;
  const claimExpiresAt =
    opts.claimExpiresAt ?? (await chainTime(env.connection)) + 600;
  const signedCumulative = opts.signedCumulative ?? opts.cumulative;
  const claimSigner = opts.claimSigner ?? f.agent;
  const settler = opts.settler ?? f.provider;

  const message = buildClaimMessage(
    f.session,
    signedCumulative,
    nonce,
    BigInt(claimExpiresAt)
  );

  const preIxs: TransactionInstruction[] = [];
  if (opts.rawEd25519) {
    preIxs.push(opts.rawEd25519);
  } else if (!opts.omitEd25519) {
    preIxs.push(
      Ed25519Program.createInstructionWithPrivateKey({
        privateKey: claimSigner.secretKey,
        message,
      })
    );
  }
  if (opts.displaceEd25519) {
    // A harmless self-transfer, purely to push the Ed25519 ix away from the
    // slot immediately preceding `settle_session`.
    preIxs.push(
      SystemProgram.transfer({
        fromPubkey: settler.publicKey,
        toPubkey: settler.publicKey,
        lamports: 1,
      })
    );
  }

  return await program.methods
    .settleSession(
      new anchor.BN(opts.cumulative.toString()),
      new anchor.BN(nonce.toString()),
      new anchor.BN(claimExpiresAt),
      opts.merkleRoot ?? DEMO_ROOT
    )
    .accountsPartial({
      provider: settler.publicKey,
      session: f.session,
      settlementRecord: opts.settlementRecord ?? f.settlementRecord,
      vault: opts.vault ?? f.vault,
      providerTokenAccount: opts.providerTokenAccount ?? f.providerAta,
      mint: opts.mint ?? env.mint,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions(preIxs)
    .signers([settler])
    .rpc({ commitment: "confirmed", skipPreflight: false });
}

async function refund(
  f: Fixture,
  opts?: { caller?: Keypair; agentTokenAccount?: PublicKey; mint?: PublicKey }
): Promise<string> {
  const caller = opts?.caller ?? f.agent;
  return await program.methods
    .refundSession()
    .accountsPartial({
      caller: caller.publicKey,
      session: f.session,
      vault: f.vault,
      agentTokenAccount: opts?.agentTokenAccount ?? f.agentAta,
      mint: opts?.mint ?? env.mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([caller])
    .rpc({ commitment: "confirmed" });
}

before(async function () {
  this.timeout(120_000);
  const anchorProvider = anchor.AnchorProvider.env();
  anchor.setProvider(anchorProvider);
  const idl = require("../target/idl/agentpay.json");
  program = new anchor.Program(idl, anchorProvider);
  env = await Env.create(program, anchorProvider);
});

// ---------------------------------------------------------------------------
// The two assumptions flagged "High" risk in docs/decisions.md. If either of
// these is wrong, claim verification is either forgeable or permanently broken.
// ---------------------------------------------------------------------------
describe("Ed25519 precompile layout assumptions", () => {
  it("canonical builder emits the layout the program parses", async () => {
    const agent = Keypair.generate();
    const message = buildClaimMessage(
      agent.publicKey,
      123_456n,
      7n,
      1_800_000_000n
    );
    const ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: agent.secretKey,
      message,
    });
    const data = Buffer.from(ix.data);
    const h = decodeEd25519Header(data);

    assert.strictEqual(h.numSignatures, 1, "program requires data[0] == 1");
    assert.strictEqual(h.padding, 0, "program requires data[1] == 0");
    assert.isAtLeast(data.length, 16, "program requires len >= 16");

    // The whole `verify_ed25519_claim` defence rests on this: all three regions
    // must be self-referential, or an attacker can point the precompile at one
    // message while the program reads another.
    assert.strictEqual(h.signatureIxIndex, 0xffff, "signature ix index sentinel");
    assert.strictEqual(h.publicKeyIxIndex, 0xffff, "public key ix index sentinel");
    assert.strictEqual(h.messageIxIndex, 0xffff, "message ix index sentinel");

    assert.strictEqual(h.messageSize, CLAIM_MESSAGE_LEN);
    assert.deepStrictEqual(
      data.subarray(h.publicKeyOffset, h.publicKeyOffset + 32),
      agent.publicKey.toBuffer(),
      "pubkey must be readable at publicKeyOffset"
    );
    assert.deepStrictEqual(
      data.subarray(h.messageOffset, h.messageOffset + h.messageSize),
      message,
      "message must be readable at messageOffset"
    );
    assert.isAtMost(h.signatureOffset + 64, data.length);
  });
});

describe("happy path", () => {
  it("opens, settles the used amount, and refunds the remainder", async function () {
    this.timeout(60_000);
    const f = await env.newFixture({ deposit: 5n * ONE_USDC });
    await env.openSession(f);

    assert.strictEqual(await env.tokenBalance(f.vault), 5n * ONE_USDC);
    assert.strictEqual(await env.tokenBalance(f.agentAta), 0n);

    const used = 1_234_567n;
    await settle(f, { cumulative: used });

    assert.strictEqual(await env.tokenBalance(f.providerAta), used);
    assert.strictEqual(await env.tokenBalance(f.vault), 5n * ONE_USDC - used);

    const acct = program.account as any;
    const sess = await acct.session.fetch(f.session);
    assert.strictEqual(BigInt(sess.cumulativeSettled.toString()), used);
    assert.isTrue(sess.isSettled);

    const rec = await acct.settlementRecord.fetch(f.settlementRecord);
    assert.strictEqual(BigInt(rec.settledAmount.toString()), used);
    assert.deepStrictEqual(Array.from(rec.merkleRoot), DEMO_ROOT);

    await refund(f);
    assert.strictEqual(await env.tokenBalance(f.agentAta), 5n * ONE_USDC - used);
    assert.strictEqual(await env.tokenBalance(f.vault), 0n);

    // The core conservation invariant: settled + refunded == deposited.
    const after = await acct.session.fetch(f.session);
    assert.strictEqual(
      BigInt(after.cumulativeSettled.toString()) +
        BigInt(after.refundedTotal.toString()),
      5n * ONE_USDC
    );
  });
});

describe("open_session attacks", () => {
  it("rejects a zero deposit", async function () {
    this.timeout(60_000);
    const f = await env.newFixture({ deposit: 0n, agentBalance: ONE_USDC });
    await expectAnchorError(env.openSession(f), "ZeroDeposit");
  });

  it("rejects an expiry already in the past", async function () {
    this.timeout(60_000);
    const f = await env.newFixture();
    f.expiresAt = (await chainTime(env.connection)) - 60;
    await expectAnchorError(env.openSession(f), "ExpiryInPast");
  });

  it("rejects an expiry beyond the maximum session duration", async function () {
    this.timeout(60_000);
    const f = await env.newFixture();
    f.expiresAt = (await chainTime(env.connection)) + 31 * 24 * 60 * 60;
    await expectAnchorError(env.openSession(f), "ExpiryTooDistant");
  });

  it("rejects a deposit exceeding the agent's balance", async function () {
    this.timeout(60_000);
    const f = await env.newFixture({
      deposit: 10n * ONE_USDC,
      agentBalance: ONE_USDC,
    });
    await expectRawError(env.openSession(f), /insufficient funds|0x1$/im);
  });
});

describe("settle_session attacks", () => {
  it("rejects a replayed claim (double settle)", async function () {
    this.timeout(60_000);
    const f = await env.newFixture();
    await env.openSession(f);
    await settle(f, { cumulative: ONE_USDC });

    // Byte-identical resubmission of a claim that already settled.
    await expectRawError(
      settle(f, { cumulative: ONE_USDC }),
      /already in use|custom program error: 0x0/i
    );
    assert.strictEqual(await env.tokenBalance(f.providerAta), ONE_USDC);
  });

  it("rejects a second settle at a higher cumulative", async function () {
    this.timeout(60_000);
    const f = await env.newFixture();
    await env.openSession(f);
    await settle(f, { cumulative: ONE_USDC });
    await expectRawError(
      settle(f, { cumulative: 2n * ONE_USDC, nonce: 2n }),
      /already in use|custom program error: 0x0/i
    );
    assert.strictEqual(await env.tokenBalance(f.providerAta), ONE_USDC);
  });

  it("rejects a non-monotonic (zero) cumulative", async function () {
    this.timeout(60_000);
    const f = await env.newFixture();
    await env.openSession(f);
    await expectAnchorError(settle(f, { cumulative: 0n }), "ClaimNotMonotonic");
  });

  it("rejects a claim exceeding the deposit", async function () {
    this.timeout(60_000);
    const f = await env.newFixture({ deposit: ONE_USDC });
    await env.openSession(f);
    await expectAnchorError(
      settle(f, { cumulative: ONE_USDC + 1n }),
      "ClaimExceedsDeposit"
    );
  });

  it("rejects an expired claim", async function () {
    this.timeout(60_000);
    const f = await env.newFixture();
    await env.openSession(f);
    const past = (await chainTime(env.connection)) - CLOCK_SKEW_TOLERANCE_SECS - 60;
    await expectAnchorError(
      settle(f, { cumulative: ONE_USDC, claimExpiresAt: past }),
      "ClaimExpired"
    );
  });

  it("rejects a claim signed by a key that is not the session agent", async function () {
    this.timeout(60_000);
    const f = await env.newFixture();
    await env.openSession(f);
    const impostor = Keypair.generate();
    await expectAnchorError(
      settle(f, { cumulative: ONE_USDC, claimSigner: impostor }),
      "ClaimSignerMismatch"
    );
  });

  it("rejects a tampered amount (signs 1 USDC, submits 4 USDC)", async function () {
    this.timeout(60_000);
    const f = await env.newFixture({ deposit: 5n * ONE_USDC });
    await env.openSession(f);
    await expectAnchorError(
      settle(f, { cumulative: 4n * ONE_USDC, signedCumulative: ONE_USDC }),
      "ClaimMessageMismatch"
    );
    assert.strictEqual(await env.tokenBalance(f.providerAta), 0n);
  });

  it("rejects settlement with no Ed25519 instruction at all", async function () {
    this.timeout(60_000);
    const f = await env.newFixture();
    await env.openSession(f);
    await expectAnchorError(
      settle(f, { cumulative: ONE_USDC, omitEd25519: true }),
      "MissingEd25519Instruction"
    );
  });

  it("rejects an Ed25519 instruction that is not immediately preceding", async function () {
    this.timeout(60_000);
    const f = await env.newFixture();
    await env.openSession(f);
    await expectAnchorError(
      settle(f, { cumulative: ONE_USDC, displaceEd25519: true }),
      "MissingEd25519Instruction"
    );
  });

  it("rejects an Ed25519 instruction referencing another instruction's data", async function () {
    this.timeout(60_000);
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

    // Same payload and offsets, but the indices name instruction 0 explicitly
    // instead of using the self-reference sentinel. The precompile still
    // verifies a valid signature; the program must refuse to trust it.
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

    await expectAnchorError(
      settle(f, { cumulative: ONE_USDC, claimExpiresAt, rawEd25519: raw }),
      "Ed25519IndirectReference"
    );
  });

  it("rejects settlement by a wallet that is not the designated provider", async function () {
    this.timeout(60_000);
    const f = await env.newFixture();
    await env.openSession(f);
    const attacker = await env.newFundedKeypair();
    const attackerAta = await env.createAta(attacker.publicKey);
    await expectAnchorError(
      settle(f, {
        cumulative: ONE_USDC,
        settler: attacker,
        providerTokenAccount: attackerAta,
      }),
      "UnauthorizedSettler"
    );
  });

  it("rejects a substituted provider token account", async function () {
    this.timeout(60_000);
    const f = await env.newFixture();
    await env.openSession(f);
    const outsider = Keypair.generate();
    const outsiderAta = await env.createAta(outsider.publicKey);
    await expectAnchorError(
      settle(f, { cumulative: ONE_USDC, providerTokenAccount: outsiderAta }),
      "TokenAccountOwnerMismatch"
    );
  });

  it("rejects a wrong mint at settlement", async function () {
    this.timeout(60_000);
    const f = await env.newFixture();
    await env.openSession(f);
    const otherMint = await withRpcRetry("createMint(other)", () =>
      createMint(
        env.connection,
        env.payer,
        env.payer.publicKey,
        null,
        USDC_DECIMALS,
        undefined,
        { commitment: "confirmed" },
        TOKEN_PROGRAM_ID
      )
    );
    await expectAnchorError(
      settle(f, { cumulative: ONE_USDC, mint: otherMint }),
      "MintMismatch"
    );
  });
});

describe("refund_session attacks", () => {
  it("rejects a pre-expiry refund while the session is unsettled", async function () {
    this.timeout(60_000);
    const f = await env.newFixture();
    await env.openSession(f);
    await expectAnchorError(refund(f), "SessionStillActive");
  });

  it("rejects a pre-expiry refund by someone other than the agent", async function () {
    this.timeout(60_000);
    const f = await env.newFixture();
    await env.openSession(f);
    await settle(f, { cumulative: ONE_USDC });
    const stranger = await env.newFundedKeypair();
    await expectAnchorError(
      refund(f, { caller: stranger }),
      "UnauthorizedRefund"
    );
  });

  it("rejects a double refund", async function () {
    this.timeout(60_000);
    const f = await env.newFixture();
    await env.openSession(f);
    await settle(f, { cumulative: ONE_USDC });
    await refund(f);
    await expectAnchorError(refund(f), "NothingToRefund");
  });
});

// ---------------------------------------------------------------------------
// Real time must pass for these. They are grouped so the suite waits once.
// ---------------------------------------------------------------------------
describe("expiry behaviour", () => {
  let expiredForSettle: Fixture;
  let expiredForRecovery: Fixture;

  before(async function () {
    this.timeout(180_000);
    expiredForSettle = await env.newFixture();
    expiredForSettle.expiresAt = (await chainTime(env.connection)) + 3;
    await env.openSession(expiredForSettle);

    expiredForRecovery = await env.newFixture({ deposit: 3n * ONE_USDC });
    expiredForRecovery.expiresAt = (await chainTime(env.connection)) + 3;
    await env.openSession(expiredForRecovery);

    // Must exceed expires_at + CLOCK_SKEW_TOLERANCE_SECS on the chain clock.
    while (
      (await chainTime(env.connection)) <=
      expiredForRecovery.expiresAt + CLOCK_SKEW_TOLERANCE_SECS + 2
    ) {
      await sleep(2000);
    }
  });

  it("rejects settlement after expiry", async function () {
    this.timeout(60_000);
    await expectAnchorError(
      settle(expiredForSettle, { cumulative: ONE_USDC }),
      "SessionExpired"
    );
    assert.strictEqual(await env.tokenBalance(expiredForSettle.providerAta), 0n);
  });

  it("allows permissionless recovery by a third party with no agent signature", async function () {
    this.timeout(60_000);
    const f = expiredForRecovery;
    const rescuer = await env.newFundedKeypair();

    assert.strictEqual(await env.tokenBalance(f.agentAta), 0n);

    // The agent never signs. This is the trust claim: funds are recoverable
    // with no gateway and no provider cooperation.
    await refund(f, { caller: rescuer });

    assert.strictEqual(await env.tokenBalance(f.agentAta), 3n * ONE_USDC);
    assert.strictEqual(await env.tokenBalance(f.vault), 0n);
  });
});
