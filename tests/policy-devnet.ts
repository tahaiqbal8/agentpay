/**
 * The control plane, end to end, against a real devnet escrow.
 *
 * Walks the whole documented flow: create an agent, bind it to a wallet, fund
 * and authorize it, plan a purchase against the registry, buy inside the
 * envelope, then try to buy outside it in five different ways.
 *
 * The load-bearing assertion is not that refusals happen — it is that a policy
 * refusal leaves the HIGH-WATER MARK UNTOUCHED. The policy check sits between
 * price matching and `admit_claim` precisely so that a refused purchase does
 * not consume a nonce and a cumulative step. If it did, the agent's next
 * honest claim would be rejected as non-monotonic and the session would be
 * bricked by its own policy.
 *
 * Nothing here is mocked. The escrow is real, the claims are signed, and the
 * money that does move is devnet USDC.
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
} from "./helpers";

const BASE = process.env.GATEWAY ?? "http://127.0.0.1:8080";
const KEYPAIR_PATH =
  process.env.AGENTPAY_PROVIDER_KEYPAIR?.trim() ||
  `${process.env.HOME}/.config/solana/agentpay-provider.json`;
const DEPOSIT = 3_000_000n;

const C = {
  green: "\x1b[32m",
  amber: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(
    `   ${ok ? C.green + "PASS" : C.red + "FAIL"}${C.reset}  ${label.padEnd(46)} ${C.dim}${detail}${C.reset}`
  );
  if (!ok) failures++;
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  const r = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

function fail(msg: string): never {
  console.error(`\n${C.red}FAILED: ${msg}${C.reset}\n`);
  process.exit(1);
}

(async () => {
  if (!fs.existsSync(KEYPAIR_PATH)) {
    fail(`No provider keypair at ${KEYPAIR_PATH}`);
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
  console.log(`gateway  ${BASE}\n`);

  // ---- stages 1-3: create the agent and bind it to a wallet ---------------
  console.log("1. creating the agent and binding its wallet");
  const agentKp = Keypair.generate();

  const created = await api("POST", "/v1/agents", {
    label: "Policy test agent",
    agent_pubkey: agentKp.publicKey.toBase58(),
    owner_pubkey: treasury.publicKey.toBase58(),
    mode: "autonomous",
  });
  if (created.status !== 200) fail(`agent creation returned ${created.status}: ${JSON.stringify(created.body)}`);
  const agentId: string = created.body.agent_id;
  check("agent created", true, agentId);
  check("starts unauthorized", created.body.policy === null, "no envelope until a human sets one");

  const dup = await api("POST", "/v1/agents", {
    label: "Impostor",
    agent_pubkey: agentKp.publicKey.toBase58(),
  });
  check(
    "a second agent on the same wallet is refused",
    dup.status === 409 && dup.body?.reason_code === "ERR_AGENT_EXISTS",
    dup.body?.reason_code ?? String(dup.status)
  );

  // ---- stage 4: fund on chain, then authorize off chain -------------------
  console.log("\n2. funding the escrow on chain (the hard ceiling)");
  await withRpcRetry("fund", async () => {
    await throttle(connection);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: treasury.publicKey,
        toPubkey: agentKp.publicKey,
        lamports: 15_000_000,
      })
    );
    return sendAndConfirmTransaction(connection, tx, [treasury], { commitment: "confirmed" });
  });

  const mint = await withRpcRetry("createMint", () =>
    createMint(connection, treasury, treasury.publicKey, null, 6, undefined,
      { commitment: "confirmed" }, TOKEN_PROGRAM_ID)
  );
  const agentAta = getAssociatedTokenAddressSync(mint, agentKp.publicKey, false, TOKEN_PROGRAM_ID);
  const providerAta = getAssociatedTokenAddressSync(mint, providerKp.publicKey, false, TOKEN_PROGRAM_ID);
  await withRpcRetry("atas", async () => {
    await throttle(connection);
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(treasury.publicKey, agentAta, agentKp.publicKey, mint, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountInstruction(treasury.publicKey, providerAta, providerKp.publicKey, mint, TOKEN_PROGRAM_ID),
      createMintToInstruction(mint, agentAta, treasury.publicKey, DEPOSIT, [], TOKEN_PROGRAM_ID)
    );
    return sendAndConfirmTransaction(connection, tx, [treasury], { commitment: "confirmed" });
  });

  const sessionId = randomSessionId();
  const session = deriveSession(program.programId, agentKp.publicKey, providerKp.publicKey, sessionId);
  const vault = deriveVault(program.programId, session);
  const expiresAt = (await chainTime(connection)) + 3600;

  await withRpcRetry("openSession", async () => {
    await throttle(connection);
    return program.methods
      .openSession(Array.from(sessionId), new anchor.BN(DEPOSIT.toString()), new anchor.BN(expiresAt))
      .accountsPartial({
        agent: agentKp.publicKey, provider: providerKp.publicKey, mint, session, vault,
        agentTokenAccount: agentAta, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([agentKp])
      .rpc({ commitment: "confirmed" });
  });
  console.log(`   escrow ${session.toBase58()}  ${DEPOSIT} micro-USDC`);

  const opened = await api("POST", "/v1/session/open", {
    session: session.toBase58(),
    agent: agentKp.publicKey.toBase58(),
    provider: providerKp.publicKey.toBase58(),
    mint: mint.toBase58(),
    deposited_total: DEPOSIT.toString(),
    expires_at: expiresAt.toString(),
  });
  if (opened.status !== 200) fail(`session open returned ${opened.status}: ${JSON.stringify(opened.body)}`);

  console.log("\n3. authorizing the agent (the narrower, off-chain bound)");
  // Deliberately much tighter than the 3 USDC escrow, so every refusal below
  // is the POLICY talking and not the deposit.
  const authorized = await api("POST", `/v1/agents/${agentId}/authorize`, {
    max_total: "4000",
    max_per_call: "1000",
    allowed_resources: ["/weather", "/quote"],
    max_calls: 3,
    mode: "autonomous",
  });
  if (authorized.status !== 200) fail(`authorize returned ${authorized.status}: ${JSON.stringify(authorized.body)}`);
  check("envelope stored", authorized.body.policy?.max_total === "4000", "max_total 4000");
  check(
    "policy is narrower than the escrow",
    BigInt(authorized.body.policy.max_total) < DEPOSIT,
    `4000 < ${DEPOSIT}`
  );

  const badEnvelope = await api("POST", `/v1/agents/${agentId}/authorize`, {
    max_total: "1000",
    max_per_call: "5000",
  });
  check(
    "per-call cap above the total is refused",
    badEnvelope.status === 400,
    badEnvelope.body?.reason_code ?? String(badEnvelope.status)
  );

  // ---- stages 5-7: registry, selection, decision --------------------------
  console.log("\n4. planning against the registry");
  const plan = await api("POST", "/v1/agent/plan", {
    agent_id: agentId,
    resource: "/weather",
    calls: 10,
  });
  if (plan.status !== 200) fail(`plan returned ${plan.status}: ${JSON.stringify(plan.body)}`);
  const weatherOpt = plan.body.options?.[0];
  check("a provider was found for /weather", !!weatherOpt, weatherOpt?.provider_id ?? "none");
  check(
    "the plan is bounded by the envelope, not the request",
    weatherOpt?.affordable_calls === 3 && plan.body.requested_calls === 10,
    `asked 10, affordable ${weatherOpt?.affordable_calls} (max_calls 3)`
  );
  check("not marked sufficient", weatherOpt?.sufficient === false, "correctly reports it cannot do 10");

  const planExpensive = await api("POST", "/v1/agent/plan", {
    agent_id: agentId,
    resource: "/analyse",
    calls: 1,
  });
  const analyseOpt = planExpensive.body?.options?.[0];
  check(
    "a forbidden resource is listed with its reason, not hidden",
    analyseOpt?.affordable_calls === 0 &&
      analyseOpt?.refused_by === "ERR_POLICY_RESOURCE_NOT_ALLOWED",
    analyseOpt?.refused_by ?? "no option returned"
  );

  // ---- stages 8-10: buying, inside and outside the envelope ---------------
  const claimExpiry = BigInt(expiresAt);
  let cumulative = 0n;
  let nonce = 0n;

  /** base64 of the JSON claim, the encoding the 402 advertises. */
  function signFor(next: bigint, n: bigint): string {
    const msg = buildClaimMessage(session, next, n, claimExpiry);
    const wire = {
      session: session.toBase58(),
      cumulative_amount: next.toString(),
      nonce: n.toString(),
      expires_at: claimExpiry.toString(),
      signature: bs58.encode(nacl.sign.detached(msg, agentKp.secretKey)),
    };
    return Buffer.from(JSON.stringify(wire)).toString("base64");
  }

  async function buy(resource: string, price: bigint) {
    const next = cumulative + price;
    const n = nonce + 1n;
    const claim = signFor(next, n);
    const r = await fetch(`${BASE}/v1/buy/${resource}`, {
      headers: { "x-agentpay-claim": claim },
    });
    const body = (await r.json().catch(() => null)) as any;
    if (r.status === 200) {
      cumulative = next;
      nonce = n;
    }
    return { status: r.status, body };
  }

  async function highWaterMark(): Promise<bigint> {
    const r = await api("GET", "/v1/sessions");
    const s = r.body.sessions.find((x: any) => x.session === session.toBase58());
    return BigInt(s.cumulative_accepted);
  }

  console.log("\n5. buying inside the envelope");
  const ok1 = await buy("weather?city=Lahore", 1000n);
  check("first purchase allowed", ok1.status === 200, `cumulative now ${cumulative}`);
  check("the provider actually served it", ok1.body?.data?.city === "Lahore", JSON.stringify(ok1.body?.data ?? {}));

  const ok2 = await buy("quote", 500n);
  check("second purchase allowed", ok2.status === 200, `cumulative now ${cumulative}`);

  console.log("\n6. the refusals, and what they must NOT do");
  const hwmBefore = await highWaterMark();

  const overCap = await buy("analyse?subject=x", 25_000n);
  check(
    "a resource outside the allowlist is refused",
    overCap.status === 403 &&
      ["ERR_POLICY_RESOURCE_NOT_ALLOWED", "ERR_POLICY_PRICE_CAP"].includes(overCap.body?.reason_code),
    overCap.body?.reason_code
  );

  const hwmAfter = await highWaterMark();
  check(
    "a policy refusal did NOT move the high-water mark",
    hwmAfter === hwmBefore,
    `${hwmBefore} -> ${hwmAfter}`
  );

  // The proof that the session is not bricked: the very next honest claim,
  // reusing the nonce the refused purchase would have consumed, still works.
  const stillWorks = await buy("weather?city=Karachi", 1000n);
  check(
    "the next honest purchase still succeeds",
    stillWorks.status === 200,
    `cumulative ${cumulative} — the refusal consumed no nonce`
  );

  const callLimit = await buy("quote", 500n);
  check(
    "the call limit is enforced",
    callLimit.status === 403 && callLimit.body?.reason_code === "ERR_POLICY_CALL_LIMIT",
    callLimit.body?.reason_code
  );

  console.log("\n7. revocation");
  const suspended = await api("POST", `/v1/agents/${agentId}/status`, { status: "suspended" });
  check("agent suspended", suspended.status === 200, suspended.body?.status);

  const afterSuspend = await buy("weather?city=Multan", 1000n);
  check(
    "a suspended agent cannot spend, escrow notwithstanding",
    afterSuspend.status === 403 && afterSuspend.body?.reason_code === "ERR_AGENT_SUSPENDED",
    afterSuspend.body?.reason_code
  );

  await api("POST", `/v1/agents/${agentId}/status`, { status: "active" });

  console.log("\n8. human-controlled mode");
  // Widen the envelope so the only thing left standing between the agent and
  // the purchase is the human.
  await api("POST", `/v1/agents/${agentId}/authorize`, {
    max_total: "50000",
    max_per_call: "25000",
    allowed_resources: ["/weather", "/quote"],
    max_calls: 50,
    mode: "human",
  });

  const needsHuman = await buy("weather?city=Quetta", 1000n);
  check(
    "human mode refuses until a person decides",
    needsHuman.status === 403 && needsHuman.body?.reason_code === "ERR_APPROVAL_REQUIRED",
    needsHuman.body?.reason_code
  );

  const queue = await api("GET", "/v1/approvals");
  const pending = queue.body?.approvals?.find(
    (a: any) => a.agent_id === agentId && a.state === "pending"
  );
  check("a proposal was raised for the human", !!pending, pending?.approval_id ?? "none");

  // A retry must not flood the queue with identical proposals.
  await buy("weather?city=Quetta", 1000n);
  const queue2 = await api("GET", "/v1/approvals");
  const pendingCount = queue2.body.approvals.filter(
    (a: any) => a.agent_id === agentId && a.state === "pending"
  ).length;
  check("a retry does not duplicate the proposal", pendingCount === 1, `${pendingCount} pending`);

  await api("POST", `/v1/approvals/${pending.approval_id}/decide`, { approved: true });
  const afterApproval = await buy("weather?city=Quetta", 1000n);
  check(
    "the approved purchase goes through",
    afterApproval.status === 200,
    `cumulative ${cumulative}`
  );

  const secondUse = await buy("weather?city=Sukkur", 1000n);
  check(
    "one approval authorises exactly one purchase",
    secondUse.status === 403 && secondUse.body?.reason_code === "ERR_APPROVAL_REQUIRED",
    secondUse.body?.reason_code
  );

  // ---- the escrow is still the outer bound -------------------------------
  console.log("\n9. the chain still has the last word");
  const onChain = await api("GET", "/v1/sessions");
  const summary = onChain.body.sessions.find((x: any) => x.session === session.toBase58());
  check(
    "everything spent stayed inside the escrow",
    BigInt(summary.cumulative_accepted) <= DEPOSIT,
    `${summary.cumulative_accepted} <= ${DEPOSIT}`
  );
  check("the session reconciled against the chain", summary.chain_verified === true, "chain_verified");

  if (failures > 0) {
    console.error(`\n${C.red}FAILED: ${failures} check(s)${C.reset}\n`);
    process.exit(1);
  }
  console.log(
    `\n${C.green}PASS${C.reset}  the human authorized, the agent chose, the gateway enforced,\n` +
      `      and a policy refusal never touched the high-water mark.\n`
  );
})().catch((e) => {
  console.error("\nUNCAUGHT:", e?.message ?? e);
  process.exit(1);
});
