/**
 * The complete AgentPay lifecycle, on real Solana devnet, under program v2.
 *
 * Human → agent → authorization → funding → discovery → planning → policy →
 * signed claim → gateway verification → enforcement → provider → evidence →
 * settlement by AgentPay's SETTLEMENT AUTHORITY → on-chain record → proof →
 * refund.
 *
 * The property this exists to demonstrate, end to end and on a public chain:
 *
 *   AgentPay never touches the provider's private key. The settlement is
 *   signed by AgentPay's own authority, and the money still lands in the
 *   provider's account, because the program binds it there.
 *
 * Every figure printed is read BACK from the chain or from the gateway after
 * the fact. A script that asserts against the values it submitted proves only
 * that it can remember them.
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
import { createHash } from "crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  buildClaimMessage,
  chainTime,
  deriveSession,
  deriveSettlementRecord,
  deriveVault,
  ensureDevnetEnv,
  makeProvider,
  programFor,
  randomSessionId,
  readSettlementRecord,
  throttle,
  withRpcRetry,
} from "./helpers";

// Before anything reads `process.env`. `ADMIN` below is a module-level
// constant, so it is evaluated at import time — earlier than any call inside
// `main()`. Loading `.env` from there left `ADMIN` undefined and the run died
// at step 2 with ERR_UNAUTHORIZED, for a token sitting in a file in the
// project root. `scripts/sdk-demo.ts` and `tests/policy-devnet.ts` already
// call it at module scope for the same reason.
ensureDevnetEnv();

const BASE = process.env.GATEWAY ?? "http://127.0.0.1:8080";
const DEPOSIT = 3_000_000n; // 3 USDC
const ADMIN = process.env.AGENTPAY_ADMIN_TOKEN?.trim();

let step = 0;
function head(t: string) {
  console.log(`\n${++step}. ${t}`);
}
function line(k: string, v: string | number | bigint) {
  console.log(`   ${k.padEnd(28)} ${v}`);
}
function pass(k: string, v = "") {
  console.log(`   \x1b[32mPASS\x1b[0m  ${k.padEnd(44)} \x1b[2m${v}\x1b[0m`);
}
function fail(k: string, v = ""): never {
  console.log(`   \x1b[31mFAIL\x1b[0m  ${k}  ${v}`);
  process.exit(1);
}

async function api(method: string, path: string, body?: any) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(ADMIN ? { authorization: `Bearer ${ADMIN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Read as text first. A 4xx from the framework is plain text, and parsing it
  // as JSON yields `null` — which is how a deserialization complaint turns
  // into a debugging session.
  const raw = await r.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { non_json_body: raw.slice(0, 300) };
  }
  return { status: r.status, body: parsed };
}

async function main() {
  const provider = makeProvider();
  anchor.setProvider(provider);
  const program = programFor("v2", provider);
  const connection = provider.connection;
  const payer = (provider.wallet as any).payer as Keypair;

  const balance = async (ata: PublicKey) =>
    BigInt((await connection.getTokenAccountBalance(ata, "confirmed")).value.amount);

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  AgentPay end-to-end — program v2, real Solana devnet        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  // ── 1 ────────────────────────────────────────────────────────────────────
  head("the gateway says which program and which authority it uses");
  const health = await api("GET", "/health");
  const programId = health.body.program_id as string;
  const authority = health.body.settlement_authority as string | undefined;
  line("program_id", programId);
  line("settlement_authority", authority ?? "(none)");
  line("state_backend", health.body.state_backend);

  if (programId !== program.programId.toBase58()) {
    fail("gateway is on a different program", `${programId} vs ${program.programId.toBase58()}`);
  }
  if (!authority) fail("gateway advertises no settlement authority");
  pass("gateway is on program v2", programId);
  pass("it publishes an authority to bind", authority);

  // ── 2 ────────────────────────────────────────────────────────────────────
  head("a human creates an agent and binds its wallet");
  const agentKp = Keypair.generate();
  const created = await api("POST", "/v1/agents", {
    label: "e2e v2 agent",
    agent_pubkey: agentKp.publicKey.toBase58(),
  });
  if (created.status !== 200) fail("agent not created", JSON.stringify(created.body));
  const agentId = created.body.agent_id as string;
  line("agent_id", agentId);
  line("agent wallet", agentKp.publicKey.toBase58());
  pass("agent created", agentId);
  if (created.body.mode !== "human") fail("default mode is not human", created.body.mode);
  pass("defaults to human mode", "omission must not grant autonomy");

  // ── 3 ────────────────────────────────────────────────────────────────────
  head("the human sets the spending envelope");
  const authz = await api("POST", `/v1/agents/${agentId}/authorize`, {
    max_total: "1000000",
    max_per_call: "2000",
    allowed_resources: ["/weather", "/quote"],
    max_calls: 10,
    mode: "autonomous",
  });
  if (authz.status !== 200) fail("authorize failed", JSON.stringify(authz.body));
  line("max_total", authz.body.policy.max_total);
  line("max_per_call", authz.body.policy.max_per_call);
  line("allowed_resources", authz.body.policy.allowed_resources.join(", "));
  pass("envelope stored", "narrows the escrow, never widens it");

  // ── 4 ────────────────────────────────────────────────────────────────────
  head("funding: a test mint, an escrow, and the agent's wallet");
  await withRpcRetry("fund agent", async () => {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: agentKp.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL,
      })
    );
    return sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  });

  const providerKp = Keypair.generate();
  const mint = await withRpcRetry("createMint", () =>
    createMint(connection, payer, payer.publicKey, null, 6, undefined, { commitment: "confirmed" }, TOKEN_PROGRAM_ID)
  );
  const agentAta = getAssociatedTokenAddressSync(mint, agentKp.publicKey, false, TOKEN_PROGRAM_ID);
  const providerAta = getAssociatedTokenAddressSync(mint, providerKp.publicKey, false, TOKEN_PROGRAM_ID);

  await withRpcRetry("atas + mint", async () => {
    const tx = new Transaction()
      .add(createAssociatedTokenAccountInstruction(payer.publicKey, agentAta, agentKp.publicKey, mint, TOKEN_PROGRAM_ID))
      .add(createAssociatedTokenAccountInstruction(payer.publicKey, providerAta, providerKp.publicKey, mint, TOKEN_PROGRAM_ID))
      .add(createMintToInstruction(mint, agentAta, payer.publicKey, DEPOSIT, [], TOKEN_PROGRAM_ID));
    return sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  });
  line("mint", mint.toBase58());
  line("provider destination", providerAta.toBase58());
  pass("agent funded", `${DEPOSIT} micro-USDC`);

  // ── 5 ────────────────────────────────────────────────────────────────────
  head("the agent opens an escrow, binding AgentPay as settlement authority");
  const sessionId = randomSessionId();
  const session = deriveSession(program.programId, agentKp.publicKey, providerKp.publicKey, sessionId);
  const vault = deriveVault(program.programId, session);
  const settlementRecord = deriveSettlementRecord(program.programId, session);
  const expiresAt = (await chainTime(connection)) + 1800;

  const openSig = await withRpcRetry("openSession", async () => {
    await throttle(connection);
    return program.methods
      .openSession(
        Array.from(sessionId),
        new anchor.BN(DEPOSIT.toString()),
        new anchor.BN(expiresAt),
        new PublicKey(authority!)
      )
      .accountsPartial({
        agent: agentKp.publicKey,
        provider: providerKp.publicKey,
        mint,
        session,
        vault,
        agentTokenAccount: agentAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([agentKp])
      .rpc({ commitment: "confirmed" });
  });

  const onChainSession = await (program.account as any).session.fetch(session);
  line("open tx", openSig);
  line("session PDA", session.toBase58());
  line("vault", vault.toBase58());
  line("settlement_authority (chain)", new PublicKey(onChainSession.settlementAuthority).toBase58());
  line("provider (chain)", new PublicKey(onChainSession.provider).toBase58());

  if (new PublicKey(onChainSession.settlementAuthority).toBase58() !== authority) {
    fail("the bound authority is not the gateway's");
  }
  pass("authority bound on chain", "immutable for this session");
  if (BigInt((await connection.getAccountInfo(session))!.data.length) !== 219n) {
    fail("session is not the v2 layout");
  }
  pass("session account is 219 bytes", "the v2 layout");

  // ── 6 ────────────────────────────────────────────────────────────────────
  head("the gateway reconciles the escrow against the chain");
  const reg = await api("POST", "/v1/session/open", {
    session: session.toBase58(),
    agent: agentKp.publicKey.toBase58(),
    provider: providerKp.publicKey.toBase58(),
    mint: mint.toBase58(),
    deposited_total: DEPOSIT.toString(),
    // A string, like every amount and timestamp on this API. JSON numbers lose
    // precision above 2^53 and the gateway refuses them for that reason.
    expires_at: expiresAt.toString(),
  });
  if (reg.status !== 200) fail("session not tracked", JSON.stringify(reg.body));
  pass("gateway tracks the session", "verified against chain, not trusted");

  // ── 7 ────────────────────────────────────────────────────────────────────
  head("the agent discovers what is on offer, and plans");
  const cat = await api("GET", "/v1/catalogue");
  for (const e of cat.body.entries) line(e.resource, `${e.price} micro-USDC`);
  const plan = await api("POST", "/v1/agent/plan", {
    agent_id: agentId,
    resource: "/weather",
    calls: 3,
  });
  if (plan.status !== 200) fail("plan failed", JSON.stringify(plan.body));
  line("affordable calls", plan.body.options[0].affordable_calls);
  line("total cost", plan.body.options[0].total_cost);
  pass("planner answered", "advice only — nothing reserved");

  // ── 8 ────────────────────────────────────────────────────────────────────
  head("the agent buys, signing a cumulative claim each time");
  const claimExpiry = BigInt((await chainTime(connection)) + 1200);
  let cumulative = 0n;
  let nonce = 0n;

  function signFor(next: bigint, n: bigint): string {
    const msg = buildClaimMessage(session, next, n, claimExpiry);
    return Buffer.from(
      JSON.stringify({
        session: session.toBase58(),
        cumulative_amount: next.toString(),
        nonce: n.toString(),
        expires_at: claimExpiry.toString(),
        signature: bs58.encode(nacl.sign.detached(msg, agentKp.secretKey)),
      })
    ).toString("base64");
  }

  async function buy(resource: string, price: bigint) {
    const next = cumulative + price;
    const n = nonce + 1n;
    await throttle(connection);
    const r = await fetch(`${BASE}/v1/buy/${resource}`, {
      headers: { "x-agentpay-claim": signFor(next, n) },
    });
    const body = (await r.json().catch(() => null)) as any;
    if (r.status === 200) {
      cumulative = next;
      nonce = n;
    }
    return { status: r.status, body };
  }

  const b1 = await buy("weather?city=Lahore", 1000n);
  if (b1.status !== 200) fail("first buy refused", JSON.stringify(b1.body));
  pass("bought /weather", `cumulative ${cumulative}`);

  const b2 = await buy("quote", 500n);
  if (b2.status !== 200) fail("second buy refused", JSON.stringify(b2.body));
  pass("bought /quote", `cumulative ${cumulative}`);

  // ── 9 ────────────────────────────────────────────────────────────────────
  head("enforcement: the gateway refuses what the human did not allow");
  const denied = await buy("analyse?subject=x", 25_000n);
  if (denied.status === 200) fail("/analyse was ALLOWED — the envelope did not hold");
  line("policy refusal", denied.body.reason_code);
  pass("/analyse refused", denied.body.reason_code);
  if (cumulative !== 1500n) fail("a refusal moved the high-water mark", `${cumulative}`);
  pass("the mark did not move", `still ${cumulative}`);

  // A PROTOCOL refusal, which is a different thing and lands in a different
  // place. Policy runs BEFORE admit_claim — deliberately, so a refusal cannot
  // consume a nonce — so a policy refusal never reaches the evidence log. It
  // is metered for billing and nothing more.
  //
  // A claim that gets past policy and is then refused by the protocol DOES
  // reach admit_claim, and is hash-chained. That is the refusal a third party
  // can later be shown a proof of.
  // Getting a refusal INTO the evidence log takes some care, and the reason is
  // the ordering itself.
  //
  // The price gate sits before admit_claim, so a stale cumulative is refused
  // as ERR_PRICE_MISMATCH and never reaches the chain of evidence. The claim
  // has to pay exactly the asking price to get past that gate, and then break
  // a PROTOCOL rule to be refused by admit_claim — here by reusing a nonce
  // that has already been spent.
  await throttle(connection);
  const staleNonce = signFor(cumulative + 1000n, nonce); // right price, spent nonce
  const replay = await fetch(`${BASE}/v1/buy/weather?city=Lahore`, {
    headers: { "x-agentpay-claim": staleNonce },
  });
  const replayJson = (await replay.json().catch(() => null)) as any;
  if (replay.status === 200) fail("a reused nonce was ACCEPTED");
  line("protocol refusal", replayJson?.reason_code);
  pass("a reused nonce refused", replayJson?.reason_code);

  // ── 10 ───────────────────────────────────────────────────────────────────
  head("evidence: every decision, refusals included");
  const ev = await api("GET", `/v1/session/${session.toBase58()}/evidence`);
  line("entries", ev.body.entry_count);
  const decisions = (ev.body.entries as any[]).map((e) => e.decision);
  line("decisions", decisions.join(", "));
  line("chain_valid", ev.body.chain_valid);
  line("merkle_root", ev.body.merkle_root);
  if (!ev.body.chain_valid) fail("the evidence chain does not verify");
  pass("hash chain intact", `${ev.body.entry_count} entries`);

  // ── 11 ───────────────────────────────────────────────────────────────────
  head("settlement — signed by AgentPay's authority, NOT a provider key");
  const provBefore = await balance(providerAta);
  const vaultBefore = await balance(vault);
  line("provider balance before", provBefore);
  line("vault balance before", vaultBefore);

  const settled = await api("POST", "/v1/session/settle", { session: session.toBase58() });
  if (settled.status !== 200) fail("settlement failed", JSON.stringify(settled.body));

  const provAfter = await balance(providerAta);
  const vaultAfter = await balance(vault);
  const rec = await readSettlementRecord(connection, settlementRecord);

  line("settlement tx", settled.body.signature);
  line("provider balance after", `${provBefore} -> ${provAfter}  (+${provAfter - provBefore})`);
  line("vault balance after", `${vaultBefore} -> ${vaultAfter}  (-${vaultBefore - vaultAfter})`);
  line("record settled_amount", `${rec.settledAmount}  (cumulative)`);
  line("record merkle_root", Buffer.from(rec.merkleRoot).toString("hex"));

  if (provAfter - provBefore !== cumulative) {
    fail("the provider was not paid the cumulative", `${provAfter - provBefore} vs ${cumulative}`);
  }
  pass("provider received the funds", `${provAfter - provBefore} micro-USDC`);
  if (rec.settledAmount !== cumulative) fail("settled_amount is not cumulative");
  pass("settled_amount is cumulative", `${rec.settledAmount}`);

  // The claim at the heart of the redesign.
  const tx = await connection.getTransaction(settled.body.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const signers = tx!.transaction.message
    .getAccountKeys()
    .staticAccountKeys.slice(0, tx!.transaction.message.header.numRequiredSignatures)
    .map((k) => k.toBase58());
  line("transaction signers", signers.join(", "));
  if (!signers.includes(authority!)) fail("the authority did not sign the settlement");
  if (signers.includes(providerKp.publicKey.toBase58())) {
    fail("THE PROVIDER SIGNED — AgentPay used a provider key");
  }
  pass("signed by AgentPay's authority", authority!);
  pass("the provider key never signed", "AgentPay holds no provider key here");

  // ── 12 ───────────────────────────────────────────────────────────────────
  head("the root the program stored, checked independently");
  const onChain = await api("GET", `/v1/session/${session.toBase58()}/settlement`);
  line("on-chain root", onChain.body.merkle_root);
  line("root_may_advance", String(onChain.body.root_may_advance));

  // Recompute from the published log with our own SHA-256.
  const entries = ev.body.entries as any[];
  const leaves = entries.map((e) => Buffer.from(e.entry_hash, "hex"));
  let level: Buffer[] = leaves;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i];
      const r = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(Buffer.from(createHash("sha256").update(Buffer.concat([l, r])).digest()));
    }
    level = next;
  }
  const recomputed = level[0].toString("hex");
  line("recomputed here", recomputed);
  if (recomputed !== onChain.body.merkle_root) {
    fail("recomputed root does not match the chain", `${recomputed} vs ${onChain.body.merkle_root}`);
  }
  pass("independently recomputed root MATCHES", recomputed.slice(0, 24) + "…");
  if (onChain.body.root_may_advance !== true) {
    fail("a v2 session must report that its root can advance");
  }
  pass("reported as the LATEST root", "not final — settlement is repeatable");

  // ── 13 ───────────────────────────────────────────────────────────────────
  head("a refusal is provable to somebody with no account");
  const refused = entries.find((e: any) => e.decision !== "ALLOWED");
  if (!refused) {
    fail(
      "no refusal in the evidence log",
      "a POLICY refusal is metered but never hash-chained — it returns before " +
        "admit_claim so it cannot consume a nonce. Only a PROTOCOL refusal is " +
        "recorded here."
    );
  }
  const proof = await api("POST", "/v1/evidence/proof", {
    session: session.toBase58(),
    sequence_id: refused.sequence_id,
  });
  if (proof.status !== 200) fail("proof unavailable", JSON.stringify(proof.body));
  line("proving", `seq ${refused.sequence_id} · ${refused.decision}`);
  line("proof hops", proof.body.proof.length);
  if (proof.body.merkle_root !== onChain.body.merkle_root) {
    fail("the proof is against a different root");
  }
  pass("the refusal is covered by the committed root", refused.decision);

  // ── 14 ───────────────────────────────────────────────────────────────────
  head("what remains is still the agent's");
  const remaining = DEPOSIT - cumulative;
  line("deposit", DEPOSIT);
  line("settled to provider", cumulative);
  line("still in the vault", vaultAfter);
  if (vaultAfter !== remaining) fail("vault does not hold the remainder", `${vaultAfter} vs ${remaining}`);
  pass("conservation holds", `${cumulative} + ${vaultAfter} = ${DEPOSIT}`);
  console.log(
    "\n   \x1b[2mRecoverable by anyone after expiry via refund_session, and only\n" +
      "   ever to the agent's own token account.\x1b[0m"
  );

  // ── done ─────────────────────────────────────────────────────────────────
  console.log("\n\x1b[32mPASS\x1b[0m  the full lifecycle ran on devnet under program v2,");
  console.log("      and AgentPay settled without ever holding a provider key.\n");
  console.log(`      https://explorer.solana.com/tx/${settled.body.signature}?cluster=devnet\n`);
}

main().catch((e) => {
  console.error("\nUNCAUGHT:", e?.message ?? e);
  process.exit(1);
});
