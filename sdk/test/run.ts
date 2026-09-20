/**
 * SDK tests, run with `npm test` inside `sdk/`.
 *
 * No test framework: the package has no runtime dependencies and adding one
 * for eleven assertions would be a poor trade. Failures exit non-zero.
 *
 * The first suite is the one that matters. Everything else in this package
 * fails loudly at the request; a wrong claim encoding fails at SETTLEMENT,
 * after the agent has been told its purchases succeeded.
 */
import { claimMessage, CLAIM_MESSAGE_LEN } from "../src/claim";
import { AgentPayClient, base58Decode, base58Encode } from "../src/client";
import { AgentPayError, errorFrom } from "../src/errors";

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** BigInt is not JSON-serialisable, and these tests compare amounts. */
function show(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
}

function eq<T>(label: string, got: T, want: T) {
  const ok = show(got) === show(want);
  check(label, ok, ok ? "" : `got ${show(got)}, want ${show(want)}`);
}

// ---------------------------------------------------------------------------
// 1. Cross-boundary parity — the load-bearing suite
// ---------------------------------------------------------------------------

console.log("\n1. claim encoding parity with the gateway and the program");

/**
 * The exact hex `gateway/src/claim.rs` asserts in its own test.
 *
 * Copied deliberately rather than derived: if either side's encoding changes,
 * both tests fail, and they fail with the same vector so the divergence is
 * obvious. Deriving it here from this code would only prove this code agrees
 * with itself.
 */
const EXPECTED_HEX =
  "6167656e747061793a636c61696d3a7631" + // "agentpay:claim:v1"
  "0707070707070707070707070707070707070707070707070707070707070707" + // session
  "87d6120000000000" + // cumulative 1_234_567 LE
  "2a00000000000000" + // nonce 42 LE
  "00d2496b00000000"; // expires_at 1_800_000_000 LE

const fixedSession = new Uint8Array(32).fill(7);
const msg = claimMessage({
  session: fixedSession,
  cumulativeAmount: 1_234_567n,
  nonce: 42n,
  expiresAt: 1_800_000_000n,
});

eq("message is exactly 73 bytes", msg.length, CLAIM_MESSAGE_LEN);
eq("message is 73", CLAIM_MESSAGE_LEN, 73);
eq("bytes match the Rust vector", msg.toString("hex"), EXPECTED_HEX);

// The same fixture rendered as base58, as the Rust test also asserts.
eq(
  "the fixture session encodes as the Rust side reports it",
  base58Encode(fixedSession),
  "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx"
);

// Endianness is the failure nobody notices until settlement: big-endian here
// would still produce 73 bytes and a valid signature over the wrong message.
const one = claimMessage({
  session: fixedSession,
  cumulativeAmount: 1n,
  nonce: 0n,
  expiresAt: 0n,
});
eq("integers are little-endian", one.subarray(49, 57).toString("hex"), "0100000000000000");

// expires_at is SIGNED: the program reads i64. An unsigned write would throw
// here rather than silently encode a negative as a huge positive.
const negative = claimMessage({
  session: fixedSession,
  cumulativeAmount: 0n,
  nonce: 0n,
  expiresAt: -1n,
});
eq("expires_at is signed", negative.subarray(65, 73).toString("hex"), "ffffffffffffffff");

// ---------------------------------------------------------------------------
// 2. Input validation
// ---------------------------------------------------------------------------

console.log("\n2. inputs that would fail silently are refused early");

function throws(label: string, fn: () => unknown) {
  try {
    fn();
    check(label, false, "did not throw");
  } catch {
    check(label, true);
  }
}

throws("a session that is not 32 bytes", () =>
  claimMessage({
    session: new Uint8Array(31),
    cumulativeAmount: 1n,
    nonce: 1n,
    expiresAt: 1n,
  })
);
throws("a negative cumulative amount", () =>
  claimMessage({
    session: fixedSession,
    cumulativeAmount: -1n,
    nonce: 1n,
    expiresAt: 1n,
  })
);

// ---------------------------------------------------------------------------
// 3. base58 round trip
// ---------------------------------------------------------------------------

console.log("\n3. base58");

const roundTrip = base58Decode(base58Encode(fixedSession));
eq("round trips", Array.from(roundTrip), Array.from(fixedSession));

// Leading zero bytes are encoded as leading '1's; dropping them would shift
// every subsequent byte and produce a different pubkey.
const leadingZeros = new Uint8Array(32);
leadingZeros[31] = 9;
eq(
  "leading zero bytes survive",
  Array.from(base58Decode(base58Encode(leadingZeros))),
  Array.from(leadingZeros)
);

// ---------------------------------------------------------------------------
// 4. Typed errors
// ---------------------------------------------------------------------------

console.log("\n4. refusals are classified so an integrator can branch");

const approval = errorFrom(403, { reason_code: "ERR_APPROVAL_REQUIRED", message: "wait" });
check("approval is recognised", approval.needsApproval);
check("approval is not 'out of authority'", !approval.outOfAuthority, "it clears when a human acts");
check("approval is not transient", !approval.transient, "retrying in a loop would not help");

const budget = errorFrom(403, { reason_code: "ERR_POLICY_BUDGET", message: "no" });
check("a budget refusal is out of authority", budget.outOfAuthority);
check("a budget refusal is not transient", !budget.transient, "retrying a decision is a busy loop");

const down = errorFrom(503, { reason_code: "ERR_CHAIN_UNAVAILABLE", message: "rpc" });
check("an infrastructure failure is transient", down.transient);
check("an infrastructure failure is not out of authority", !down.outOfAuthority);

// ---------------------------------------------------------------------------
// 5. The counter discipline that keeps a session usable
// ---------------------------------------------------------------------------

console.log("\n5. a refusal must not advance the counters");

(async () => {
  let call = 0;
  const fakeFetch = (async (url: string) => {
    call++;
    // First: the 402 quote. Second: the paid attempt, refused by policy.
    if (call % 2 === 1) {
      return new Response(JSON.stringify({ resource: "/weather", price: "1000" }), {
        status: 402,
      });
    }
    return new Response(
      JSON.stringify({ reason_code: "ERR_POLICY_BUDGET", message: "no", request_id: "r" }),
      { status: 403 }
    );
  }) as unknown as typeof globalThis.fetch;

  const client = new AgentPayClient({
    gateway: "http://example.invalid",
    session: base58Encode(fixedSession),
    expiresAt: 1_800_000_000,
    signer: {
      publicKey: new Uint8Array(32),
      sign: () => new Uint8Array(64),
    },
    fetch: fakeFetch,
  });

  const before = client.spent;
  try {
    await client.buy("/weather");
    check("a refused purchase throws", false, "it returned");
  } catch (e) {
    check("a refused purchase throws", e instanceof AgentPayError);
  }
  eq("spent is unchanged after a refusal", client.spent, before);

  // The point of the above: if the client advanced its own counter on a
  // refusal, its next claim would be one step ahead of the gateway's
  // high-water mark and would be refused as non-monotonic forever.

  // -------------------------------------------------------------------------
  // 6. Retry discipline
  // -------------------------------------------------------------------------

  console.log("\n6. retries happen for outages, never for decisions");

  /** A gateway that quotes fine, then fails `failures` times before serving. */
  function flaky(failures: number, reason: string, status: number) {
    let quotes = 0;
    let attempts = 0;
    const f = (async () => {
      // Quote and paid attempt alternate.
      if (quotes === attempts) {
        quotes++;
        return new Response(JSON.stringify({ resource: "/weather", price: "1000" }), {
          status: 402,
        });
      }
      attempts++;
      if (attempts <= failures) {
        return new Response(JSON.stringify({ reason_code: reason, message: "x" }), { status });
      }
      return new Response(
        JSON.stringify({ data: { ok: true }, upstream_status: 200, served_by: "p" }),
        { status: 200 }
      );
    }) as unknown as typeof globalThis.fetch;
    return { fetch: f, attempts: () => attempts };
  }

  function clientWith(fetchImpl: typeof globalThis.fetch, retries: number) {
    return new AgentPayClient({
      gateway: "http://example.invalid",
      session: base58Encode(fixedSession),
      expiresAt: 1_800_000_000,
      signer: { publicKey: new Uint8Array(32), sign: () => new Uint8Array(64) },
      fetch: fetchImpl,
      retry: { retries, backoffMs: 1 },
    });
  }

  const outage = flaky(2, "ERR_CHAIN_UNAVAILABLE", 503);
  const recovered = await clientWith(outage.fetch, 3).buy<{ ok: boolean }>("/weather");
  check("a transient failure is retried until it works", recovered.ok);
  eq("it took three attempts", outage.attempts(), 3);

  // The one that matters: a policy refusal must NOT be retried. Retrying a
  // decision cannot change it, and for anything already charged it costs.
  const refused = flaky(2, "ERR_POLICY_BUDGET", 403);
  try {
    await clientWith(refused.fetch, 3).buy("/weather");
    check("a decision is not retried", false, "it returned");
  } catch (e) {
    check("a decision is not retried", e instanceof AgentPayError);
  }
  eq("it gave up after one attempt", refused.attempts(), 1);

  // -------------------------------------------------------------------------
  // 7. A paid failure is visible, not hidden
  // -------------------------------------------------------------------------

  console.log("\n7. a charge is per call, not per success");

  let n = 0;
  const provider404 = (async () => {
    n++;
    if (n % 2 === 1) {
      return new Response(JSON.stringify({ resource: "/weather", price: "1000" }), {
        status: 402,
      });
    }
    // The gateway's envelope is 200: payment and forwarding both worked.
    return new Response(
      JSON.stringify({
        data: { error: "unknown city" },
        upstream_status: 404,
        served_by: "p",
      }),
      { status: 200 }
    );
  }) as unknown as typeof globalThis.fetch;

  const paid = await clientWith(provider404, 0).buy("/weather?city=Atlantis");
  check("the purchase does not throw", true, "payment and forwarding worked");
  eq("but ok is false", paid.ok, false);
  eq("and the provider's status is reported", paid.upstreamStatus, 404);
  eq("and the agent was still charged", paid.price, 1000n);

  console.log(
    failures === 0
      ? `\nPASS  ${"all SDK checks"}\n`
      : `\nFAILED: ${failures} check(s)\n`
  );
  process.exit(failures === 0 ? 0 : 1);
})();
