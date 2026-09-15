import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

/** Must byte-match `CLAIM_DOMAIN` in programs/agentpay/src/lib.rs. */
export const CLAIM_DOMAIN = Buffer.from("agentpay:claim:v1", "utf8");
/** Must match `CLAIM_MESSAGE_LEN` in the program. */
export const CLAIM_MESSAGE_LEN = 17 + 32 + 8 + 8 + 8;
/** Must match `CLOCK_SKEW_TOLERANCE_SECS` in the program. */
export const CLOCK_SKEW_TOLERANCE_SECS = 30;

export const SESSION_SEED = Buffer.from("session", "utf8");
export const VAULT_SEED = Buffer.from("vault", "utf8");
export const SETTLEMENT_SEED = Buffer.from("settlement", "utf8");

export const USDC_DECIMALS = 6;
/** 1 USDC in base units. All amounts are integers; never floats. */
export const ONE_USDC = 1_000_000n;

/**
 * Canonical claim encoding. Every field is fixed-width, so concatenation is
 * unambiguous — this mirrors `build_claim_message` on-chain byte for byte.
 */
export function buildClaimMessage(
  session: PublicKey,
  cumulativeAmount: bigint,
  nonce: bigint,
  claimExpiresAt: bigint
): Buffer {
  const buf = Buffer.alloc(CLAIM_MESSAGE_LEN);
  let o = 0;
  CLAIM_DOMAIN.copy(buf, o);
  o += CLAIM_DOMAIN.length;
  session.toBuffer().copy(buf, o);
  o += 32;
  buf.writeBigUInt64LE(cumulativeAmount, o);
  o += 8;
  buf.writeBigUInt64LE(nonce, o);
  o += 8;
  buf.writeBigInt64LE(claimExpiresAt, o);
  return buf;
}

export function deriveSession(
  programId: PublicKey,
  agent: PublicKey,
  provider: PublicKey,
  sessionId: Buffer
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SESSION_SEED, agent.toBuffer(), provider.toBuffer(), sessionId],
    programId
  )[0];
}

export function deriveVault(programId: PublicKey, session: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, session.toBuffer()],
    programId
  )[0];
}

export function deriveSettlementRecord(
  programId: PublicKey,
  session: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SETTLEMENT_SEED, session.toBuffer()],
    programId
  )[0];
}

export function randomSessionId(): Buffer {
  const b = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
}

/**
 * Hand-rolled Ed25519 precompile instruction, so tests can emit layouts the
 * canonical builder never would (e.g. cross-instruction references).
 *
 * Layout per the Agave precompile:
 *   [num_signatures u8][padding u8][7 x u16 little-endian offsets][payload...]
 */
export function buildRawEd25519Ix(opts: {
  numSignatures?: number;
  padding?: number;
  signatureOffset: number;
  signatureIxIndex: number;
  publicKeyOffset: number;
  publicKeyIxIndex: number;
  messageOffset: number;
  messageSize: number;
  messageIxIndex: number;
  payload: Buffer;
}): TransactionInstruction {
  const header = Buffer.alloc(16);
  header.writeUInt8(opts.numSignatures ?? 1, 0);
  header.writeUInt8(opts.padding ?? 0, 1);
  header.writeUInt16LE(opts.signatureOffset, 2);
  header.writeUInt16LE(opts.signatureIxIndex, 4);
  header.writeUInt16LE(opts.publicKeyOffset, 6);
  header.writeUInt16LE(opts.publicKeyIxIndex, 8);
  header.writeUInt16LE(opts.messageOffset, 10);
  header.writeUInt16LE(opts.messageSize, 12);
  header.writeUInt16LE(opts.messageIxIndex, 14);
  return new TransactionInstruction({
    keys: [],
    programId: Ed25519Program.programId,
    data: Buffer.concat([header, opts.payload]),
  });
}

/** Decoded view of an Ed25519 precompile instruction's header. */
export function decodeEd25519Header(data: Buffer) {
  return {
    numSignatures: data.readUInt8(0),
    padding: data.readUInt8(1),
    signatureOffset: data.readUInt16LE(2),
    signatureIxIndex: data.readUInt16LE(4),
    publicKeyOffset: data.readUInt16LE(6),
    publicKeyIxIndex: data.readUInt16LE(8),
    messageOffset: data.readUInt16LE(10),
    messageSize: data.readUInt16LE(12),
    messageIxIndex: data.readUInt16LE(14),
  };
}

/**
 * Asserts a transaction failed with exactly `expectedCode`.
 *
 * Failing for the *wrong* reason is treated as a test failure: a test that
 * passes because of an unrelated error is not evidence of a working defence.
 */
export async function expectAnchorError(
  promise: Promise<any>,
  expectedCode: string
): Promise<void> {
  let result: any;
  try {
    result = await promise;
  } catch (e: any) {
    const code = e?.error?.errorCode?.code;
    if (code === undefined) {
      throw new Error(
        `Expected AgentPay error "${expectedCode}", but got a non-Anchor error:\n` +
          `${e?.message ?? e}\n` +
          `logs: ${JSON.stringify(e?.logs ?? [], null, 2)}`
      );
    }
    assert.strictEqual(
      code,
      expectedCode,
      `Transaction failed, but for the WRONG reason. ` +
        `Expected "${expectedCode}", got "${code}". A test that fails for an ` +
        `unrelated reason proves nothing about the defence it claims to test.`
    );
    return;
  }
  throw new Error(
    `Expected "${expectedCode}" but the transaction SUCCEEDED (sig ${result}). ` +
      `This is a live vulnerability, not a test bug.`
  );
}

/**
 * Asserts a transaction failed with a raw (non-Anchor) error whose logs or
 * message match `pattern`. Used where the defence is structural — e.g. account
 * `init` refusing to create an already-existing PDA.
 */
export async function expectRawError(
  promise: Promise<any>,
  pattern: RegExp
): Promise<void> {
  let result: any;
  try {
    result = await promise;
  } catch (e: any) {
    const haystack = [e?.message ?? "", ...(e?.logs ?? [])].join("\n");
    assert.match(
      haystack,
      pattern,
      `Transaction failed, but not with the expected signature ${pattern}.\n` +
        `Got:\n${haystack}`
    );
    return;
  }
  throw new Error(
    `Expected failure matching ${pattern} but the transaction SUCCEEDED (sig ${result}).`
  );
}

export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Public devnet RPC rate-limits aggressively (HTTP 429) and occasionally drops
 * a blockhash under load. Retry only on transport-level failures — never on a
 * program error, which must surface unchanged or the attack tests become
 * meaningless.
 */
export async function withRpcRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 5
): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const transient =
        /429|Too Many Requests|rate limit|blockhash not found|block height exceeded|failed to get recent blockhash|socket hang up|ETIMEDOUT|ECONNRESET|fetch failed/i.test(
          msg
        );
      // A program error is a result, not a failure to retry.
      if (!transient || e?.error?.errorCode) throw e;
      lastErr = e;
      const backoff = 1000 * Math.pow(2, i);
      console.log(`    [retry ${i + 1}/${attempts}] ${label}: ${msg.slice(0, 90)}`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/** On-chain clock, which is what the program actually compares against. */
export async function chainTime(connection: Connection): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  const t = await connection.getBlockTime(slot);
  if (t === null) throw new Error("getBlockTime returned null");
  return t;
}

/**
 * Rent + fees for one test keypair, sized from actual rent-exemption
 * ((128 + size) * 3480 * 2 lamports):
 *   agent    — session PDA 187B (0.00219) + vault token acct 165B (0.00204)
 *   provider — settlement record 121B (0.00173)
 * plus 5000-lamport fees. 0.012 SOL leaves ~3x headroom.
 */
export const LAMPORTS_PER_TEST_KEYPAIR = 12_000_000; // 0.012 SOL

/** Treasury floor for a public-cluster run; see the arithmetic above. */
export const MIN_TREASURY_LAMPORTS = 800_000_000; // 0.8 SOL

export function isLocalCluster(connection: Connection): boolean {
  return /127\.0\.0\.1|localhost/.test(connection.rpcEndpoint);
}

/**
 * Airdrops on a local validator; transfers from the treasury everywhere else.
 *
 * Public faucets rate-limit per IP, so a suite that airdrops once per keypair
 * cannot run against devnet at all. One funded treasury, many transfers.
 */
export async function fundSol(
  connection: Connection,
  to: PublicKey,
  lamports: number,
  treasury?: Keypair
): Promise<void> {
  if (isLocalCluster(connection)) {
    const sig = await connection.requestAirdrop(to, lamports);
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    return;
  }
  if (!treasury) {
    throw new Error("fundSol on a public cluster requires a treasury keypair");
  }
  await withRpcRetry(`fund ${to.toBase58().slice(0, 8)}`, async () => {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: treasury.publicKey,
        toPubkey: to,
        lamports,
      })
    );
    return await sendAndConfirmTransaction(connection, tx, [treasury], {
      commitment: "confirmed",
    });
  });
}

export interface Fixture {
  agent: Keypair;
  provider: Keypair;
  sessionId: Buffer;
  session: PublicKey;
  vault: PublicKey;
  settlementRecord: PublicKey;
  agentAta: PublicKey;
  providerAta: PublicKey;
  deposit: bigint;
  expiresAt: number;
}

/** Shared environment: one mint, reused across every test. */
export class Env {
  constructor(
    public program: Program<any>,
    public provider: anchor.AnchorProvider,
    public payer: Keypair,
    public mint: PublicKey
  ) {}

  get connection(): Connection {
    return this.provider.connection;
  }

  get programId(): PublicKey {
    return this.program.programId;
  }

  static async create(
    program: Program<any>,
    anchorProvider: anchor.AnchorProvider
  ): Promise<Env> {
    const connection = anchorProvider.connection;
    let payer: Keypair;

    if (isLocalCluster(connection)) {
      payer = Keypair.generate();
      await fundSol(connection, payer.publicKey, 50 * LAMPORTS_PER_SOL);
    } else {
      // On a public cluster the funded deployer wallet *is* the treasury;
      // there is no faucet budget for a second funded account.
      payer = (anchorProvider.wallet as any).payer as Keypair;
      if (!payer?.secretKey) {
        throw new Error(
          "Could not read the treasury keypair from ANCHOR_WALLET. " +
            "A public-cluster run needs a funded local wallet."
        );
      }
      const bal = await connection.getBalance(payer.publicKey, "confirmed");
      console.log(
        `    treasury ${payer.publicKey.toBase58()} balance ` +
          `${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`
      );
      if (bal < MIN_TREASURY_LAMPORTS) {
        throw new Error(
          `Treasury has ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL; the suite ` +
            `needs at least ${(MIN_TREASURY_LAMPORTS / LAMPORTS_PER_SOL).toFixed(2)} ` +
            `SOL beyond deployment costs. Fund ${payer.publicKey.toBase58()} ` +
            `via https://faucet.solana.com and re-run.`
        );
      }
    }

    const mint = await withRpcRetry("createMint", () =>
      createMint(
        connection,
        payer,
        payer.publicKey,
        null,
        USDC_DECIMALS,
        undefined,
        { commitment: "confirmed" },
        TOKEN_PROGRAM_ID
      )
    );
    return new Env(program, anchorProvider, payer, mint);
  }

  /** Creates a funded agent, a provider, ATAs, and derives all PDAs. */
  async newFixture(opts?: {
    deposit?: bigint;
    agentBalance?: bigint;
    expiresInSecs?: number;
  }): Promise<Fixture> {
    const deposit = opts?.deposit ?? 5n * ONE_USDC;
    const agentBalance = opts?.agentBalance ?? deposit;
    const agent = Keypair.generate();
    const provider = Keypair.generate();
    const local = isLocalCluster(this.connection);

    if (local) {
      await Promise.all([
        fundSol(this.connection, agent.publicKey, 5 * LAMPORTS_PER_SOL),
        fundSol(this.connection, provider.publicKey, 5 * LAMPORTS_PER_SOL),
      ]);
    } else {
      // One transaction funds both keypairs, to halve the round trips.
      await withRpcRetry("fund fixture", async () => {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: this.payer.publicKey,
            toPubkey: agent.publicKey,
            lamports: LAMPORTS_PER_TEST_KEYPAIR,
          }),
          SystemProgram.transfer({
            fromPubkey: this.payer.publicKey,
            toPubkey: provider.publicKey,
            lamports: LAMPORTS_PER_TEST_KEYPAIR,
          })
        );
        return await sendAndConfirmTransaction(this.connection, tx, [this.payer], {
          commitment: "confirmed",
        });
      });
    }

    const agentAta = getAssociatedTokenAddressSync(
      this.mint,
      agent.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );
    const providerAta = getAssociatedTokenAddressSync(
      this.mint,
      provider.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );

    // Both ATAs and the initial mint in a single transaction.
    await withRpcRetry("create ATAs + mint", async () => {
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          this.payer.publicKey,
          agentAta,
          agent.publicKey,
          this.mint,
          TOKEN_PROGRAM_ID
        ),
        createAssociatedTokenAccountInstruction(
          this.payer.publicKey,
          providerAta,
          provider.publicKey,
          this.mint,
          TOKEN_PROGRAM_ID
        )
      );
      if (agentBalance > 0n) {
        tx.add(
          createMintToInstruction(
            this.mint,
            agentAta,
            this.payer.publicKey,
            agentBalance,
            [],
            TOKEN_PROGRAM_ID
          )
        );
      }
      return await sendAndConfirmTransaction(this.connection, tx, [this.payer], {
        commitment: "confirmed",
      });
    });

    const sessionId = randomSessionId();
    const session = deriveSession(
      this.programId,
      agent.publicKey,
      provider.publicKey,
      sessionId
    );

    const expiresAt =
      (await chainTime(this.connection)) + (opts?.expiresInSecs ?? 3600);

    return {
      agent,
      provider,
      sessionId,
      session,
      vault: deriveVault(this.programId, session),
      settlementRecord: deriveSettlementRecord(this.programId, session),
      agentAta,
      providerAta,
      deposit,
      expiresAt,
    };
  }

  /** A funded keypair for tests that need an extra actor (attacker, rescuer). */
  async newFundedKeypair(): Promise<Keypair> {
    const kp = Keypair.generate();
    await fundSol(
      this.connection,
      kp.publicKey,
      isLocalCluster(this.connection)
        ? 2 * LAMPORTS_PER_SOL
        : LAMPORTS_PER_TEST_KEYPAIR,
      this.payer
    );
    return kp;
  }

  /** Creates an ATA for `owner`, paid for by the treasury. */
  async createAta(owner: PublicKey, mint?: PublicKey): Promise<PublicKey> {
    const m = mint ?? this.mint;
    const ata = getAssociatedTokenAddressSync(m, owner, false, TOKEN_PROGRAM_ID);
    await withRpcRetry(`createAta ${owner.toBase58().slice(0, 8)}`, async () => {
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          this.payer.publicKey,
          ata,
          owner,
          m,
          TOKEN_PROGRAM_ID
        )
      );
      return await sendAndConfirmTransaction(this.connection, tx, [this.payer], {
        commitment: "confirmed",
      });
    });
    return ata;
  }

  async openSession(f: Fixture): Promise<string> {
    return await this.program.methods
      .openSession(
        Array.from(f.sessionId),
        new anchor.BN(f.deposit.toString()),
        new anchor.BN(f.expiresAt)
      )
      .accountsPartial({
        agent: f.agent.publicKey,
        provider: f.provider.publicKey,
        mint: this.mint,
        session: f.session,
        vault: f.vault,
        agentTokenAccount: f.agentAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([f.agent])
      .rpc({ commitment: "confirmed" });
  }

  async tokenBalance(ata: PublicKey): Promise<bigint> {
    const bal = await this.connection.getTokenAccountBalance(ata, "confirmed");
    return BigInt(bal.value.amount);
  }
}
