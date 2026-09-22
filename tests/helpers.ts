import * as anchor from "@anchor-lang/core";
import * as fs from "fs";
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

/**
 * Reads a SettlementRecord straight off the account data.
 *
 * Not via the IDL, and that is a consequence of program v2 worth knowing:
 * `settlement_record` is an `UncheckedAccount` now, because the create-or-
 * advance lifecycle cannot be expressed with a typed `Account`. Anchor only
 * emits account types it sees used typed, so `SettlementRecord` no longer
 * appears in the IDL and `program.account.settlementRecord` does not exist.
 *
 * Nothing in the product depended on that: the gateway has always decoded this
 * account by offset. These are the same offsets `gateway/src/chain.rs` uses.
 */
export async function readSettlementRecord(
  connection: Connection,
  address: PublicKey
): Promise<{
  session: PublicKey;
  claimHash: Buffer;
  merkleRoot: number[];
  settledAt: bigint;
  settledAmount: bigint;
  bump: number;
}> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) throw new Error(`settlement record ${address.toBase58()} does not exist`);
  const d = info.data;
  const expected = 8 + 32 + 32 + 32 + 8 + 8 + 1;
  if (d.length !== expected) {
    throw new Error(`settlement record is ${d.length} bytes, expected ${expected}`);
  }
  return {
    session: new PublicKey(d.subarray(8, 40)),
    claimHash: Buffer.from(d.subarray(40, 72)),
    merkleRoot: Array.from(d.subarray(72, 104)),
    settledAt: d.readBigInt64LE(104),
    settledAmount: d.readBigUInt64LE(112),
    bump: d[120],
  };
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
        /429|Too Many Requests|rate limit|blockhash not found|block height exceeded|failed to get recent blockhash|socket hang up|ETIMEDOUT|ECONNRESET|fetch failed|Unknown action|node is behind|Transaction was not confirmed|timed out/i.test(
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
  return await withRpcRetry("chainTime", async () => {
    const slot = await connection.getSlot("confirmed");
    const t = await connection.getBlockTime(slot);
    // Devnet prunes block times for skipped slots; treat as transient so the
    // retry wrapper picks a newer slot rather than failing the test.
    if (t === null) throw new Error("getBlockTime returned null — node is behind");
    return t;
  });
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

/**
 * Minimum gap between transactions on a public cluster.
 *
 * api.devnet.solana.com rate-limits hard enough that an unthrottled run dies
 * with 429s and expired blockhashes partway through. Set PUBLIC_RPC_THROTTLE_MS
 * to tune for a less restrictive endpoint.
 */
export const PUBLIC_RPC_THROTTLE_MS = Number(
  process.env.PUBLIC_RPC_THROTTLE_MS ?? 400
);

let lastTxAt = 0;

/** Serializes outbound transactions so bursts do not trip the rate limiter. */
export async function throttle(connection: Connection): Promise<void> {
  if (isLocalCluster(connection)) return;
  const wait = lastTxAt + PUBLIC_RPC_THROTTLE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastTxAt = Date.now();
}

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

/**
 * Fills in the devnet defaults so the scripts run without a wall of inline env.
 *
 * Only fills what is MISSING — an explicitly set value always wins, so a run
 * against a different cluster or wallet is never silently redirected.
 */
/**
 * Variables that mean the same thing on the host as they do in a container,
 * and may therefore be read from `.env`.
 *
 * The allowlist is the point. `.env` is Docker Compose's file, so its paths are
 * CONTAINER paths: `AGENTPAY_PROVIDER_KEYPAIR=/secrets/provider.json` does not
 * exist on the host, and copying it here made every devnet script fail with
 * "No provider keypair at /secrets/provider.json". Anything filesystem-shaped
 * stays out.
 */
const DOTENV_SAFE_KEYS = [
  "AGENTPAY_ADMIN_TOKEN",
  "AGENTPAY_PROGRAM_ID",
  "AGENTPAY_RPC_URL",
] as const;

/**
 * Fills in those variables from `.env`, for anything not already set.
 *
 * Without it, running `npm run sdk-demo` after `docker compose up` fails with
 * ERR_UNAUTHORIZED purely because a shell was missing an `export` — a
 * confusing failure for a value sitting in a file in the project root.
 *
 * The shell always wins: a value set there is never overwritten, so pointing a
 * script at a different gateway or token stays possible.
 */
function loadDotEnv(): void {
  const path = `${__dirname}/../.env`;
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!(DOTENV_SAFE_KEYS as readonly string[]).includes(key)) continue;
    const value = trimmed.slice(eq + 1).trim();
    if (!value) continue;
    if (!process.env[key]?.trim()) process.env[key] = value;
  }
}

export function ensureDevnetEnv(): void {
  loadDotEnv();
  const home = process.env.HOME ?? "";
  const defaults: Record<string, string> = {
    ANCHOR_PROVIDER_URL: "https://api.devnet.solana.com",
    ANCHOR_WALLET: `${home}/.config/solana/id.json`,
    AGENTPAY_PROVIDER_KEYPAIR: `${home}/.config/solana/agentpay-provider.json`,
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (!process.env[k]?.trim()) process.env[k] = v;
  }
}

/**
 * Provider pinned to `confirmed`.
 *
 * AnchorProvider.env() defaults to `processed`, which on a public cluster
 * produces spurious "Blockhash not found" failures — those would surface as
 * attack-test failures and obscure whether a defence actually held.
 */
/**
 * The two AgentPay programs, and how a caller says which one it means.
 *
 * During the migration BOTH are live: the original still holds every session
 * opened before the cutover, and v2 takes the new ones. They have different
 * addresses, different `open_session` signatures and a differently named
 * settle signer, so a script that guesses will fail in a confusing way — as
 * one did: pointing a devnet script at the v2 IDL made it try to talk to an
 * undeployed program and report `Account 'agent' not provided`.
 *
 * Both IDLs are committed under `idl/` rather than read from `target/`, which
 * is build output and holds only whichever version was last compiled.
 */
export type ProgramVersion = "v1" | "v2";

export function idlFor(version: ProgramVersion): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(`../idl/agentpay-${version}.json`);
}

/**
 * Builds a client for one specific program version.
 *
 * `v1` is the program deployed on devnet today. `v2` is the custody redesign,
 * which is only reachable on a local validator until it is deployed.
 */
export function programFor(
  version: ProgramVersion,
  provider: anchor.AnchorProvider
): Program<any> {
  return new anchor.Program(idlFor(version), provider) as Program<any>;
}

export function makeProvider(): anchor.AnchorProvider {
  ensureDevnetEnv();
  const base = anchor.AnchorProvider.env();
  const connection = new Connection(base.connection.rpcEndpoint, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 120_000,
  });
  return new anchor.AnchorProvider(connection, base.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
}

export interface Fixture {
  agent: Keypair;
  provider: Keypair;
  /** Recorded immutably on the session. See `newFixture`. */
  settlementAuthority: PublicKey;
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
    /**
     * Who — besides the provider — may trigger settlement for this session.
     *
     * Omitted means `PublicKey.default` (all zeros), which matches no keypair
     * and therefore makes the session provider-only. That is the program's
     * behaviour before the field existed, so an un-updated caller gets the
     * strictest option rather than a surprise.
     */
    settlementAuthority?: PublicKey;
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
      settlementAuthority: opts?.settlementAuthority ?? PublicKey.default,
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

  /**
   * A funded keypair for tests that need an extra actor (attacker, rescuer).
   *
   * `publicClusterLamports` overrides the default on a PUBLIC cluster only.
   * The default suits a keypair that signs once or twice; a keypair that pays
   * rent repeatedly needs more, and on devnet it will otherwise run dry
   * mid-suite. The failure is confusing when it happens — the program succeeds
   * and the transaction still fails, because the signer itself drops below
   * rent-exemption — so the amount is a parameter rather than something a
   * caller has to discover.
   *
   * On a local validator the default is already 2 SOL and costs nothing.
   */
  async newFundedKeypair(publicClusterLamports?: number): Promise<Keypair> {
    const kp = Keypair.generate();
    await fundSol(
      this.connection,
      kp.publicKey,
      isLocalCluster(this.connection)
        ? 2 * LAMPORTS_PER_SOL
        : publicClusterLamports ?? LAMPORTS_PER_TEST_KEYPAIR,
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
    return await withRpcRetry("openSession", async () => {
      await throttle(this.connection);
      return await this.openSessionOnce(f);
    });
  }

  private async openSessionOnce(f: Fixture): Promise<string> {
    return await this.program.methods
      .openSession(
        Array.from(f.sessionId),
        new anchor.BN(f.deposit.toString()),
        new anchor.BN(f.expiresAt),
        f.settlementAuthority
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
    return await withRpcRetry("tokenBalance", async () => {
      const bal = await this.connection.getTokenAccountBalance(ata, "confirmed");
      return BigInt(bal.value.amount);
    });
  }
}
