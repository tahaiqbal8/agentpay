/**
 * Settlement custody invariants — program v2.
 *
 * These twenty tests are the security argument for removing `provider: Signer`
 * from `settle_session`. Each one is written to fail loudly if the property it
 * names ever stops holding, and several assert on token BALANCES rather than
 * on error codes, because an error code proves a transaction was rejected
 * while a balance proves no money moved.
 *
 * # What is being claimed
 *
 * A hosted AgentPay gateway holds its own settlement-authority key and never a
 * provider's private key. The properties that make that safe are:
 *
 *   - the DESTINATION is bound to `session.provider`, which is baked into the
 *     session PDA's own seeds and therefore cannot change;
 *   - the AMOUNT is bound by the agent's Ed25519 signature over the 73-byte
 *     claim, which the gateway cannot forge;
 *   - settlement is MONOTONIC and REPEATABLE, so the worst a compromised or
 *     broken settler can do is delay payment — anyone authorised can advance
 *     it afterwards.
 *
 * # Local is a gate, not a proof
 *
 * Passing here means the implementation is worth deploying. It does not mean
 * the protocol is verified: the acceptance criterion is the same invariants
 * re-run against the deployed devnet program. See docs/SETTLEMENT_CUSTODY.md.
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
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { assert } from "chai";
import {
  buildClaimMessage,
  chainTime,
  Env,
  expectAnchorError,
  Fixture,
  makeProvider,
  ONE_USDC,
  programFor,
  readSettlementRecord,
  throttle,
  withRpcRetry,
} from "./helpers";

const DEMO_ROOT = Array.from(Buffer.alloc(32, 0xab));
const SECOND_ROOT = Array.from(Buffer.alloc(32, 0xcd));

let env: Env;
let program: Program<any>;

interface SettleOpts {
  /** The cumulative total submitted to the program. */
  cumulative: bigint;
  /** What the agent actually SIGNED, when it must differ from the above. */
  signedCumulative?: bigint;
  nonce?: bigint;
  claimExpiresAt?: number;
  /** Whose key signs the claim. Defaults to the session's agent. */
  claimSigner?: Keypair;
  /** Whose key signs the transaction. Defaults to the session's provider. */
  settler?: Keypair;
  /** Where the money is asked to go. Defaults to the provider's own ATA. */
  providerTokenAccount?: PublicKey;
  merkleRoot?: number[];
  /**
   * Skips the public-RPC throttle before sending.
   *
   * Used by exactly one test: the concurrency case. `throttle` is a no-op on a
   * local validator but enforces a 400ms gap on devnet, which would serialise
   * two settlements that are supposed to race — the test would still pass and
   * would prove nothing, because it would have become a sequential
   * double-settle, which test 9 already covers.
   */
  skipThrottle?: boolean;
}

async function settle(f: Fixture, opts: SettleOpts): Promise<string> {
  const settler = opts.settler ?? f.provider;
  const claimSigner = opts.claimSigner ?? f.agent;
  const nonce = opts.nonce ?? 1n;
  const claimExpiresAt =
    opts.claimExpiresAt ?? (await chainTime(env.connection)) + 600;

  // The agent signs the amount. This is the only authorization for how much
  // moves, and no account in the instruction can override it.
  const signed = opts.signedCumulative ?? opts.cumulative;
  const message = buildClaimMessage(f.session, signed, nonce, BigInt(claimExpiresAt));

  const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: claimSigner.secretKey,
    message,
  });

  if (!opts.skipThrottle) await throttle(env.connection);
  return await program.methods
    .settleSession(
      new anchor.BN(opts.cumulative.toString()),
      new anchor.BN(nonce.toString()),
      new anchor.BN(claimExpiresAt),
      opts.merkleRoot ?? DEMO_ROOT
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
    .rpc({ commitment: "confirmed", skipPreflight: false });
}

/** An ATA for an arbitrary owner — used to try to redirect a payment. */
async function ataFor(owner: PublicKey): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(env.mint, owner, false, TOKEN_PROGRAM_ID);
  await withRpcRetry("create attacker ATA", async () => {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        env.payer.publicKey,
        ata,
        owner,
        env.mint,
        TOKEN_PROGRAM_ID
      )
    );
    return await sendAndConfirmTransaction(env.connection, tx, [env.payer], {
      commitment: "confirmed",
    });
  });
  return ata;
}

/**
 * Waits until the session is genuinely past `expires_at` plus the program's
 * clock-skew tolerance, judged by CHAIN time rather than wall time.
 *
 * A fixed `setTimeout` was wrong in two ways. It raced at the other end — a
 * one-second expiry can already be in the past by the time `open_session`
 * lands, which fails with ExpiryInPast and looks like a program bug — and it
 * assumes the validator's clock tracks the test runner's, which on devnet it
 * need not.
 */
async function waitUntilExpired(expiresAt: number): Promise<void> {
  const deadline = expiresAt + 30 /* CLOCK_SKEW_TOLERANCE_SECS */ + 2;
  for (;;) {
    const t = await chainTime(env.connection);
    if (t > deadline) return;
    await new Promise((r) => setTimeout(r, Math.min(5000, (deadline - t) * 1000)));
  }
}

describe("settlement custody (program v2)", function () {
  this.timeout(300_000);

  /** Stands in for the hosted AgentPay gateway's own key. */
  let gateway: Keypair;

  before(async () => {
    const provider = makeProvider();
    anchor.setProvider(provider);
    // v2 explicitly. These invariants describe the custody redesign and are
    // meaningless against the original program.
    program = programFor("v2", provider);
    env = await Env.create(program, provider);
    gateway = await env.newFundedKeypair();
    console.log(`    settlement authority (gateway): ${gateway.publicKey.toBase58()}`);
    console.log(`    program: ${program.programId.toBase58()}`);
  });

  // =========================================================================
  // 1-3 · who may trigger a settlement
  // =========================================================================

  it("1. the settlement authority can settle — no provider key involved", async () => {
    const f = await env.newFixture({ settlementAuthority: gateway.publicKey });
    await env.openSession(f);

    // Signed by the gateway. The provider's secret key is never used.
    await settle(f, { cumulative: ONE_USDC, settler: gateway });

    assert.strictEqual(
      await env.tokenBalance(f.providerAta),
      ONE_USDC,
      "the provider was not paid by a gateway-triggered settlement"
    );
  });

  it("2. the provider can still settle itself — the fallback path", async () => {
    const f = await env.newFixture({ settlementAuthority: gateway.publicKey });
    await env.openSession(f);

    // The escape hatch: if AgentPay is compromised, unavailable, or fired, the
    // provider collects with the wallet it already controls.
    await settle(f, { cumulative: ONE_USDC, settler: f.provider });

    assert.strictEqual(await env.tokenBalance(f.providerAta), ONE_USDC);
  });

  it("3. an unrelated signer cannot settle", async () => {
    const f = await env.newFixture({ settlementAuthority: gateway.publicKey });
    await env.openSession(f);
    const stranger = await env.newFundedKeypair();

    await expectAnchorError(
      settle(f, { cumulative: ONE_USDC, settler: stranger }),
      "UnauthorizedSettler"
    );
    assert.strictEqual(
      await env.tokenBalance(f.providerAta),
      0n,
      "a stranger moved money"
    );
  });

  // =========================================================================
  // 4-5 · the destination cannot be chosen
  // =========================================================================

  it("4. the gateway cannot direct funds to an arbitrary wallet", async () => {
    const f = await env.newFixture({ settlementAuthority: gateway.publicKey });
    await env.openSession(f);

    const attacker = Keypair.generate();
    const attackerAta = await ataFor(attacker.publicKey);

    // The gateway is a legitimate settler here. It still cannot redirect: the
    // destination is constrained against `session.provider`, a field inside
    // the session PDA's own seeds.
    await expectAnchorError(
      settle(f, {
        cumulative: ONE_USDC,
        settler: gateway,
        providerTokenAccount: attackerAta,
      }),
      "TokenAccountOwnerMismatch"
    );

    assert.strictEqual(await env.tokenBalance(attackerAta), 0n);
    assert.strictEqual(await env.tokenBalance(f.vault), f.deposit);
  });

  it("5. the destination must be owned by session.provider, even for the provider", async () => {
    const f = await env.newFixture({ settlementAuthority: gateway.publicKey });
    await env.openSession(f);

    // A second provider's ATA: a real token account, wrong owner.
    const other = Keypair.generate();
    const otherAta = await ataFor(other.publicKey);

    await expectAnchorError(
      settle(f, {
        cumulative: ONE_USDC,
        settler: f.provider,
        providerTokenAccount: otherAta,
      }),
      "TokenAccountOwnerMismatch"
    );
    assert.strictEqual(await env.tokenBalance(otherAta), 0n);
  });

  // =========================================================================
  // 6-8 · the amount cannot be invented
  // =========================================================================

  it("6. an agent signature is required", async () => {
    const f = await env.newFixture({ settlementAuthority: gateway.publicKey });
    await env.openSession(f);

    // Signed by somebody who is not this session's agent.
    const impostor = Keypair.generate();
    await expectAnchorError(
      settle(f, { cumulative: ONE_USDC, settler: gateway, claimSigner: impostor }),
      "ClaimSignerMismatch"
    );
    assert.strictEqual(await env.tokenBalance(f.providerAta), 0n);
  });

  it("7. the gateway cannot manufacture an amount the agent never signed", async () => {
    const f = await env.newFixture({ settlementAuthority: gateway.publicKey });
    await env.openSession(f);

    // The agent signed for 1 USDC. The gateway submits 4.
    await expectAnchorError(
      settle(f, {
        cumulative: 4n * ONE_USDC,
        signedCumulative: ONE_USDC,
        settler: gateway,
      }),
      "ClaimMessageMismatch"
    );
    assert.strictEqual(await env.tokenBalance(f.providerAta), 0n);
    assert.strictEqual(await env.tokenBalance(f.vault), f.deposit);
  });

  it("8. an amount above the deposit fails even when correctly signed", async () => {
    const f = await env.newFixture({ deposit: 2n * ONE_USDC, settlementAuthority: gateway.publicKey });
    await env.openSession(f);

    // Properly signed by the agent for more than was ever escrowed. The escrow
    // ceiling is independent of any signature.
    await expectAnchorError(
      settle(f, { cumulative: 99n * ONE_USDC, settler: gateway }),
      "ClaimExceedsDeposit"
    );
    assert.strictEqual(await env.tokenBalance(f.vault), 2n * ONE_USDC);
  });

  // =========================================================================
  // 9-13 · monotonic, repeatable settlement
  // =========================================================================

  it("9. settling the same cumulative twice is refused", async () => {
    const f = await env.newFixture({ settlementAuthority: gateway.publicKey });
    await env.openSession(f);
    await settle(f, { cumulative: ONE_USDC, settler: gateway, nonce: 1n });

    await expectAnchorError(
      settle(f, { cumulative: ONE_USDC, settler: gateway, nonce: 2n }),
      "ClaimNotMonotonic"
    );
    assert.strictEqual(await env.tokenBalance(f.providerAta), ONE_USDC);
  });

  it("10. settling backwards is refused", async () => {
    const f = await env.newFixture({ settlementAuthority: gateway.publicKey });
    await env.openSession(f);
    await settle(f, { cumulative: 2n * ONE_USDC, settler: gateway, nonce: 1n });

    await expectAnchorError(
      settle(f, { cumulative: ONE_USDC, settler: gateway, nonce: 2n }),
      "ClaimNotMonotonic"
    );
    assert.strictEqual(await env.tokenBalance(f.providerAta), 2n * ONE_USDC);
  });

  it("11. 100 then 750 transfers 100, then 650 — total 750", async () => {
    // The case the whole redesign turns on. Under the old create-once receipt,
    // the first settlement locked the session and the provider lost the rest.
    const f = await env.newFixture({ deposit: 1000n, agentBalance: 1000n, settlementAuthority: gateway.publicKey });
    await env.openSession(f);

    await settle(f, { cumulative: 100n, settler: gateway, nonce: 1n });
    assert.strictEqual(await env.tokenBalance(f.providerAta), 100n, "first settlement");

    await settle(f, {
      cumulative: 750n,
      settler: gateway,
      nonce: 2n,
      merkleRoot: SECOND_ROOT,
    });
    assert.strictEqual(
      await env.tokenBalance(f.providerAta),
      750n,
      "second settlement must transfer the 650 delta, not 750 again"
    );
    assert.strictEqual(await env.tokenBalance(f.vault), 250n);

    const sess = await (program.account as any).session.fetch(f.session);
    assert.strictEqual(BigInt(sess.cumulativeSettled.toString()), 750n);

    const rec = await readSettlementRecord(env.connection, f.settlementRecord);
    assert.strictEqual(
      rec.settledAmount,
      750n,
      "settled_amount must be the CUMULATIVE total, not this transaction's delta"
    );
    assert.deepStrictEqual(
      rec.merkleRoot,
      SECOND_ROOT,
      "the receipt must carry the LATEST committed root"
    );
    assert.strictEqual(
      rec.session.toBase58(),
      f.session.toBase58(),
      "the advanced receipt must still name its own session"
    );
  });

  it("12. 750 then 750 fails and moves nothing", async () => {
    const f = await env.newFixture({ deposit: 1000n, agentBalance: 1000n, settlementAuthority: gateway.publicKey });
    await env.openSession(f);
    await settle(f, { cumulative: 750n, settler: gateway, nonce: 1n });

    const before = await env.tokenBalance(f.providerAta);
    await expectAnchorError(
      settle(f, { cumulative: 750n, settler: gateway, nonce: 2n }),
      "ClaimNotMonotonic"
    );
    assert.strictEqual(await env.tokenBalance(f.providerAta), before, "a double-pay occurred");
  });

  it("13. 750 then 100 fails", async () => {
    const f = await env.newFixture({ deposit: 1000n, agentBalance: 1000n, settlementAuthority: gateway.publicKey });
    await env.openSession(f);
    await settle(f, { cumulative: 750n, settler: gateway, nonce: 1n });

    await expectAnchorError(
      settle(f, { cumulative: 100n, settler: gateway, nonce: 2n }),
      "ClaimNotMonotonic"
    );
    assert.strictEqual(await env.tokenBalance(f.providerAta), 750n);
  });

  // =========================================================================
  // 14-16 · concurrency, expiry, refund
  // =========================================================================

  it("14. concurrent settlements cannot double-pay", async () => {
    const f = await env.newFixture({ deposit: 1000n, agentBalance: 1000n, settlementAuthority: gateway.publicKey });
    await env.openSession(f);

    // Two settlements for the same cumulative, fired together. Solana
    // serialises writes to the session account, so exactly one can advance the
    // high-water mark; the other must find it already moved.
    //
    // The expiry is read ONCE and handed to both, and the throttle is skipped,
    // so that nothing inside `settle` does an RPC round trip between them. On
    // devnet the throttle would otherwise put 400ms between the two sends and
    // this would quietly stop being a concurrency test.
    const sharedExpiry = (await chainTime(env.connection)) + 600;
    const race = {
      cumulative: 500n,
      nonce: 1n,
      claimExpiresAt: sharedExpiry,
      skipThrottle: true,
    };
    const results = await Promise.allSettled([
      settle(f, { ...race, settler: gateway }),
      settle(f, { ...race, settler: f.provider }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;

    assert.strictEqual(ok, 1, `expected exactly one settlement to land, got ${ok}`);
    assert.strictEqual(
      await env.tokenBalance(f.providerAta),
      500n,
      "concurrent settlement paid twice"
    );
  });

  it("15. settlement after expiry is refused, for every settler", async () => {
    const f = await env.newFixture({
      // Enough headroom that `open_session` cannot land after its own expiry.
      expiresInSecs: 20,
      settlementAuthority: gateway.publicKey,
    });
    await env.openSession(f);
    await waitUntilExpired(f.expiresAt);

    await expectAnchorError(
      settle(f, { cumulative: ONE_USDC, settler: gateway }),
      "SessionExpired"
    );
    await expectAnchorError(
      settle(f, { cumulative: ONE_USDC, settler: f.provider }),
      "SessionExpired"
    );
    assert.strictEqual(await env.tokenBalance(f.providerAta), 0n);
  });

  it("16. refund after a partial settlement returns exactly the remainder", async () => {
    const f = await env.newFixture({
      deposit: 1000n,
      agentBalance: 1000n,
      expiresInSecs: 20,
      settlementAuthority: gateway.publicKey,
    });
    await env.openSession(f);
    await settle(f, { cumulative: 300n, settler: gateway, nonce: 1n });

    await waitUntilExpired(f.expiresAt);

    // Permissionless after expiry, and funds can only reach the agent.
    const rescuer = await env.newFundedKeypair();
    await throttle(env.connection);
    await program.methods
      .refundSession()
      .accountsPartial({
        caller: rescuer.publicKey,
        session: f.session,
        vault: f.vault,
        agentTokenAccount: f.agentAta,
        mint: env.mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([rescuer])
      .rpc({ commitment: "confirmed" });

    assert.strictEqual(
      await env.tokenBalance(f.agentAta),
      700n,
      "the refund must return deposit - settled, exactly"
    );
    assert.strictEqual(await env.tokenBalance(f.vault), 0n);
    assert.strictEqual(await env.tokenBalance(f.providerAta), 300n);
  });

  // =========================================================================
  // 17 · provider wallet rotation
  // =========================================================================

  it("17. rotation binds new sessions only; old sessions keep paying the old wallet", async () => {
    const oldWallet = await env.newFixture({ settlementAuthority: gateway.publicKey });
    await env.openSession(oldWallet);

    // The provider "rotates": a new session is opened against a different
    // wallet. Nothing about the first session changes, because its provider is
    // a PDA seed and there is no instruction that rewrites it.
    const newWallet = await env.newFixture({ settlementAuthority: gateway.publicKey });
    await env.openSession(newWallet);

    await settle(oldWallet, { cumulative: ONE_USDC, settler: gateway });
    await settle(newWallet, { cumulative: 2n * ONE_USDC, settler: gateway });

    assert.strictEqual(
      await env.tokenBalance(oldWallet.providerAta),
      ONE_USDC,
      "the pre-rotation session must still pay the wallet it was opened with"
    );
    assert.strictEqual(await env.tokenBalance(newWallet.providerAta), 2n * ONE_USDC);

    // And the old session cannot be made to pay the new wallet.
    await expectAnchorError(
      settle(oldWallet, {
        cumulative: 2n * ONE_USDC,
        settler: gateway,
        nonce: 2n,
        providerTokenAccount: newWallet.providerAta,
      }),
      "TokenAccountOwnerMismatch"
    );
  });

  // =========================================================================
  // 18-20 · what a compromised gateway can and cannot do
  // =========================================================================

  it("18. a compromised gateway cannot redirect funds", async () => {
    const f = await env.newFixture({ settlementAuthority: gateway.publicKey });
    await env.openSession(f);

    // Assume the gateway's key is stolen outright. The attacker holds a
    // legitimate settlement authority and still cannot move a single token
    // anywhere except the provider's own account.
    const thief = Keypair.generate();
    const thiefAta = await ataFor(thief.publicKey);

    await expectAnchorError(
      settle(f, {
        cumulative: ONE_USDC,
        settler: gateway,
        providerTokenAccount: thiefAta,
      }),
      "TokenAccountOwnerMismatch"
    );
    assert.strictEqual(await env.tokenBalance(thiefAta), 0n);
  });

  it("19. a compromised gateway cannot settle an amount the agent never signed", async () => {
    const f = await env.newFixture({ deposit: 5n * ONE_USDC, settlementAuthority: gateway.publicKey });
    await env.openSession(f);

    // The agent signed 1. A stolen gateway key tries to drain the escrow.
    await expectAnchorError(
      settle(f, {
        cumulative: 5n * ONE_USDC,
        signedCumulative: ONE_USDC,
        settler: gateway,
      }),
      "ClaimMessageMismatch"
    );
    assert.strictEqual(await env.tokenBalance(f.vault), 5n * ONE_USDC);
  });

  it("20. a gateway may delay settlement, but another settler can advance it", async () => {
    const f = await env.newFixture({ deposit: 1000n, agentBalance: 1000n, settlementAuthority: gateway.publicKey });
    await env.openSession(f);

    // A broken or hostile gateway settles low and stops. Under the old
    // create-once receipt this was terminal: the provider lost the difference
    // permanently. Now it is only a delay.
    await settle(f, { cumulative: 100n, settler: gateway, nonce: 1n });
    assert.strictEqual(await env.tokenBalance(f.providerAta), 100n);

    // The provider collects the rest itself, with no gateway involvement.
    await settle(f, { cumulative: 900n, settler: f.provider, nonce: 2n });
    assert.strictEqual(
      await env.tokenBalance(f.providerAta),
      900n,
      "the provider could not recover from a stale gateway settlement"
    );

    const rec = await readSettlementRecord(env.connection, f.settlementRecord);
    assert.strictEqual(rec.settledAmount, 900n);
  });
});
