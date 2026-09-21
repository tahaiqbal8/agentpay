/**
 * The AgentPay client.
 *
 * # What it exists to remove
 *
 * Integrating by hand means building a 73-byte message with the right field
 * order and endianness, signing it, base64-ing a JSON envelope into a header,
 * tracking a cumulative total and a nonce across every purchase, and reading
 * the 402 to learn the price first. `scripts/demo-buy.ts` is 194 lines of
 * exactly that.
 *
 * Getting any of it wrong fails at SETTLEMENT rather than at the request, so
 * an integrator can ship something that appears to work for an entire session
 * and then cannot be paid.
 *
 * # What it deliberately does not do
 *
 * It does not hold or generate keys beyond the signer you hand it, it does not
 * open escrows (that is a chain transaction the human signs), and it does not
 * decide what to buy. It turns an authorized session into purchases.
 */

import { claimMessage } from "./claim";
import { AgentPayError, errorFrom } from "./errors";

/** Anything that can sign 73 bytes. A `Keypair` from web3.js satisfies this. */
export interface Signer {
  /** Ed25519 public key, 32 raw bytes. */
  publicKey: { toBytes(): Uint8Array } | Uint8Array;
  /** Signs the message, returning 64 raw bytes. */
  sign(message: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export interface ClientOptions {
  /** Gateway base URL, e.g. `http://127.0.0.1:8080`. */
  gateway: string;
  /** The session PDA, base58. */
  session: string;
  /**
   * When claims expire, unix seconds. Use the session's own expiry unless you
   * want individual claims to die sooner.
   */
  expiresAt: number | bigint;
  /** Signs claims. Must be the agent key the session was opened with. */
  signer: Signer;
  /**
   * Cumulative total already accepted for this session.
   *
   * Pass it when resuming: claims are cumulative and strictly increasing, so a
   * client that restarts at zero has every claim refused as non-monotonic.
   * `AgentPayClient.resume()` reads it from the gateway for you.
   */
  startingCumulative?: bigint;
  /** Last nonce already used. Same reasoning as `startingCumulative`. */
  startingNonce?: bigint;
  /** Optional fetch implementation, for tests or a proxy. */
  fetch?: typeof globalThis.fetch;
  /** Retry behaviour for transient failures. Off by default. */
  retry?: RetryOptions;
}

export interface Quote {
  resource: string;
  /** Micro-USDC. */
  price: bigint;
  description: string;
}

export interface Purchase<T = unknown> {
  resource: string;
  /** What this purchase cost. */
  price: bigint;
  /** Total owed after it. */
  cumulative: bigint;
  data: T;
  /** Echoed by the provider, so you can confirm it really answered. */
  servedBy?: string;
  /**
   * The provider's own HTTP status.
   *
   * Check it. **A charge is per call, not per success**: the claim is admitted
   * before the request is forwarded, so a provider answering 404 or 500 has
   * still cost the agent money. `data` then holds the provider's error body,
   * not the thing you asked for.
   *
   * The purchase itself did not fail — payment and forwarding both worked —
   * which is why this is a field rather than a thrown error. Retrying would
   * cost again.
   */
  upstreamStatus: number;
  /** True when the provider actually served the request (2xx). */
  ok: boolean;
}

/** What one session looks like to the agent holding it. */
export interface SessionState {
  session: string;
  depositedTotal: bigint;
  cumulativeAccepted: bigint;
  /** Escrow left. The absolute bound — a policy can only narrow it further. */
  remaining: bigint;
  expiresAt: number;
  isSettled: boolean;
  /** False when the gateway never confirmed the escrow against the chain. */
  chainVerified: boolean;
  evidenceCount: number;
}

/** The result of settling: one transaction for the whole session. */
export interface Settlement {
  session: string;
  /** A real, confirmed devnet/mainnet signature. */
  signature: string;
  /** Hex. The evidence root the program stored — allowed AND refused claims. */
  merkleRoot: string;
  evidenceEntries: number;
  cumulativeAmount: bigint;
  settlementRecord: string;
}

/** One provider's offer, as the session planner reports it. */
export interface SessionPlanOption {
  provider_id: string;
  provider_label: string;
  resource: string;
  unit_price: string;
  affordable_calls: number;
  total_cost: string;
  sufficient: boolean;
  /** The policy rule that stops this option, if one does. */
  refused_by: string | null;
  needs_approval: boolean;
}

/** What the agent's own planner answers. */
export interface SessionPlan {
  session: string;
  resource: string;
  requested_calls: number;
  /** Cheapest first. An unaffordable option is still listed, with its reason. */
  options: SessionPlanOption[];
  recommended: string | null;
  spent: string;
  /** Envelope left, or null when the agent has no policy. */
  remaining: string | null;
  /** Escrow left on chain — the absolute bound. */
  escrow_remaining: string;
  unavailable: { provider_id: string; base_url: string; error: string }[];
}

export interface RetryOptions {
  /**
   * How many times to retry a TRANSIENT failure.
   *
   * Only transient ones: a policy refusal or a bad claim is a decision, and
   * retrying a decision is a busy loop that spends nothing and achieves
   * nothing. Default 0 — retries are opt-in, because a caller who did not ask
   * for them should not silently wait.
   */
  retries?: number;
  /** First backoff in ms; doubles each attempt. Default 250. */
  backoffMs?: number;
}

export interface BuyManyResult<T = unknown> {
  purchases: Purchase<T>[];
  /** Why the run stopped early, if it did. */
  stoppedBy?: AgentPayError;
  /** Total spent across this call. */
  spent: bigint;
}

function toBytes(pk: Signer["publicKey"]): Uint8Array {
  return pk instanceof Uint8Array ? pk : pk.toBytes();
}

/** Minimal base58 decode — avoids a runtime dependency for one conversion. */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error(`not base58: ${s}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // Leading '1's are leading zero bytes.
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

export class AgentPayClient {
  private readonly gateway: string;
  private readonly sessionB58: string;
  private readonly sessionBytes: Uint8Array;
  private readonly expiresAt: bigint;
  private readonly signer: Signer;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly retry: Required<RetryOptions>;

  /** The high-water mark this client believes it holds. */
  private cumulative: bigint;
  private nonce: bigint;

  constructor(opts: ClientOptions) {
    this.gateway = opts.gateway.replace(/\/+$/, "");
    this.sessionB58 = opts.session;
    this.sessionBytes = base58Decode(opts.session);
    this.expiresAt = BigInt(opts.expiresAt);
    this.signer = opts.signer;
    this.cumulative = opts.startingCumulative ?? 0n;
    this.nonce = opts.startingNonce ?? 0n;
    this.doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.retry = {
      retries: opts.retry?.retries ?? 0,
      backoffMs: opts.retry?.backoffMs ?? 250,
    };

    if (this.sessionBytes.length !== 32) {
      throw new Error(`session ${opts.session} does not decode to 32 bytes`);
    }
  }

  /**
   * Builds a client whose counters match the gateway's.
   *
   * Prefer this over the constructor whenever the process may have restarted.
   * Claims are cumulative and strictly increasing, so a client that starts at
   * zero against a session with history has every claim refused.
   */
  static async resume(opts: Omit<ClientOptions, "startingCumulative" | "startingNonce">) {
    const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
    // The single-session endpoint, not the listing: an agent reads the session
    // it already holds, and needs no operator credential to do it.
    const res = await f(
      `${opts.gateway.replace(/\/+$/, "")}/v1/session/${opts.session}`
    );
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw errorFrom(res.status, body);
    }
    const found = body as { cumulative_accepted: string; last_nonce: string | null };
    return new AgentPayClient({
      ...opts,
      startingCumulative: BigInt(found.cumulative_accepted),
      startingNonce: found.last_nonce ? BigInt(found.last_nonce) : 0n,
    });
  }

  /** What this client believes it has committed so far. */
  get spent(): bigint {
    return this.cumulative;
  }

  /**
   * Asks the gateway what this session could afford, bounded by the human's
   * policy envelope.
   *
   * # How this differs from `affordableCalls()`
   *
   * | | `affordableCalls()` | `plan()` |
   * | --- | --- | --- |
   * | Bound reported | The **escrow ceiling** — remaining deposit ÷ price | The **policy envelope** — allowlist, per-call cap, call count, budget |
   * | Needs a signature | No | Yes |
   * | Round trips | Two reads | One signed call |
   * | Can be wrong | Optimistic: the envelope may be narrower | Authoritative at the moment it was asked |
   *
   * Use `affordableCalls()` for a cheap upper bound, `plan()` when the answer
   * has to match what the gateway will actually admit.
   *
   * # What it does not do
   *
   * It reserves nothing. Another purchase can consume the budget a moment
   * later, and the plan says nothing about who gets there first — `buy()`
   * remains the authority, and re-checks every rule.
   *
   * # Authentication
   *
   * Signs a claim at the session's CURRENT cumulative and nonce. Such a claim
   * is **provably unspendable**: the gateway and the on-chain program both
   * admit a claim only when its cumulative is strictly greater than the
   * accepted total, so this one is refused `ERR_CLAIM_NOT_MONOTONIC`
   * everywhere payment happens.
   */
  async plan(resource: string, calls: number): Promise<SessionPlan> {
    const claimJson = Buffer.from(
      await this.encodeClaim(this.cumulative, this.nonce),
      "base64"
    ).toString("utf8");

    const res = await this.doFetch(`${this.gateway}/v1/session/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session: this.sessionB58,
        resource,
        calls,
        claim: JSON.parse(claimJson),
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw errorFrom(res.status, body);
    return body as SessionPlan;
  }

  /** Asks the price without paying. This is the 402 handshake. */
  async quote(resource: string): Promise<Quote> {
    const res = await this.doFetch(this.url(resource));
    const body = await res.json().catch(() => null);

    // 402 is the expected answer to an unpaid request, not an error.
    if (res.status === 402) {
      const b = body as { resource: string; price: string; description?: string };
      return {
        resource: b.resource,
        price: BigInt(b.price),
        description: b.description ?? "",
      };
    }
    if (res.status === 200) {
      // Only happens if a resource is free, which the catalogue can express.
      return { resource, price: 0n, description: "" };
    }
    throw errorFrom(res.status, body);
  }

  /**
   * Buys one resource.
   *
   * Quotes it, signs a cumulative claim for the new total, and retries with the
   * claim attached. The counters advance ONLY on success, which is what keeps a
   * refusal from bricking the session: a refused purchase must not consume a
   * nonce, or the next honest claim is rejected as non-monotonic.
   */
  async buy<T = unknown>(resource: string): Promise<Purchase<T>> {
    return this.withRetry(() => this.buyOnce<T>(resource));
  }

  private async buyOnce<T = unknown>(resource: string): Promise<Purchase<T>> {
    const { price } = await this.quote(resource);
    const next = this.cumulative + price;
    const nonce = this.nonce + 1n;

    const res = await this.doFetch(this.url(resource), {
      headers: { "x-agentpay-claim": await this.encodeClaim(next, nonce) },
    });
    const body = await res.json().catch(() => null);

    if (!res.ok) {
      // Counters untouched. See the doc comment above.
      throw errorFrom(res.status, body);
    }

    this.cumulative = next;
    this.nonce = nonce;

    const b = body as { data?: T; served_by?: string; upstream_status?: number };
    // Older gateways did not report it. Assume 200 rather than inventing a
    // failure, but `ok` then reflects that assumption honestly.
    const upstreamStatus = b?.upstream_status ?? 200;
    return {
      resource,
      price,
      cumulative: next,
      data: (b?.data ?? body) as T,
      servedBy: b?.served_by,
      upstreamStatus,
      ok: upstreamStatus >= 200 && upstreamStatus < 300,
    };
  }

  /**
   * Buys the same resource repeatedly, stopping at the first refusal.
   *
   * Stopping rather than continuing is deliberate: the refusals that arise in a
   * loop — budget, call limit, suspension — do not clear by themselves, so
   * carrying on would produce a burst of identical failures against the
   * gateway. The error that stopped it is returned rather than thrown, because
   * the purchases that DID succeed are real and the caller needs them.
   */
  async buyMany<T = unknown>(
    resource: string,
    count: number,
    query?: (i: number) => string
  ): Promise<BuyManyResult<T>> {
    const purchases: Purchase<T>[] = [];
    const before = this.cumulative;

    for (let i = 0; i < count; i++) {
      const target = query ? `${resource}${query(i)}` : resource;
      try {
        const p = await this.buy<T>(target);
        purchases.push(p);
        // Stop paying into a provider that is not serving. Continuing would
        // spend the whole budget on errors, one full price at a time, because
        // a charge is per call rather than per success.
        if (!p.ok) {
          return {
            purchases,
            spent: this.cumulative - before,
            stoppedBy: new AgentPayError(
              "ERR_UPSTREAM_UNAVAILABLE",
              `The provider answered ${p.upstreamStatus} for ${target}, and that call was ` +
                `still charged. Stopped rather than spending the budget on failures.`,
              p.upstreamStatus
            ),
          };
        }
      } catch (e) {
        if (e instanceof AgentPayError) {
          return { purchases, stoppedBy: e, spent: this.cumulative - before };
        }
        throw e;
      }
    }
    return { purchases, spent: this.cumulative - before };
  }

  /**
   * Reads the session's state from the gateway.
   *
   * Use it to check remaining escrow before a large run, or to confirm the
   * gateway's high-water mark still matches this client's after a network
   * wobble. `remaining` is the escrow left, which is the absolute bound — an
   * agent's policy envelope can only narrow it further.
   */
  async sessionState(): Promise<SessionState> {
    const res = await this.doFetch(`${this.gateway}/v1/session/${this.sessionB58}`);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw errorFrom(res.status, body);

    const found = body as {
      session: string;
      deposited_total: string;
      cumulative_accepted: string;
      remaining: string;
      expires_at: number;
      is_settled: boolean;
      chain_verified: boolean;
      evidence_count: number;
    };
    return {
      session: found.session,
      depositedTotal: BigInt(found.deposited_total),
      cumulativeAccepted: BigInt(found.cumulative_accepted),
      remaining: BigInt(found.remaining),
      expiresAt: found.expires_at,
      isSettled: found.is_settled,
      chainVerified: found.chain_verified,
      evidenceCount: found.evidence_count,
    };
  }

  /**
   * Settles the session on chain: one transaction for every purchase made.
   *
   * Submits the HIGHEST claim accepted. Because claims are cumulative, that one
   * claim settles everything — the intermediate ones never reach the chain,
   * which is the entire point of the deferred scheme.
   *
   * The transaction also commits the Merkle root of every decision, refusals
   * included. That is what makes a denial provable afterwards.
   *
   * Settlement is final and one-shot: the program's settlement PDA cannot be
   * created twice, so a second call is refused by the chain itself, not merely
   * by the gateway.
   */
  async settle(): Promise<Settlement> {
    const res = await this.doFetch(`${this.gateway}/v1/session/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: this.sessionB58 }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw errorFrom(res.status, body);

    const b = body as {
      session: string;
      signature: string;
      merkle_root: string;
      evidence_entries: number;
      cumulative_amount: string;
      settlement_record: string;
    };
    return {
      session: b.session,
      signature: b.signature,
      merkleRoot: b.merkle_root,
      evidenceEntries: b.evidence_entries,
      cumulativeAmount: BigInt(b.cumulative_amount),
      settlementRecord: b.settlement_record,
    };
  }

  /**
   * Buys, waiting for a human if the agent's mode requires one.
   *
   * In human-controlled mode the gateway refuses with `ERR_APPROVAL_REQUIRED`
   * and raises a proposal; this polls until somebody decides, then retries.
   *
   * Separate from `buy` on purpose. `buy` returning only after an unbounded
   * human delay would be a surprising thing for a method named `buy` to do,
   * and a caller with a request deadline needs the refusal, not the wait.
   *
   * Throws the original refusal once `timeoutMs` passes — a rejection and an
   * unattended queue are indistinguishable from here, and pretending otherwise
   * would have the agent wait forever on a spend a human already declined.
   */
  async buyWhenApproved<T = unknown>(
    resource: string,
    opts: { timeoutMs?: number; pollMs?: number } = {}
  ): Promise<Purchase<T>> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const pollMs = opts.pollMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await this.buy<T>(resource);
      } catch (e) {
        const waiting = e instanceof AgentPayError && e.needsApproval;
        if (!waiting || Date.now() + pollMs > deadline) throw e;
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
  }

  /** Sleeps, for backoff. */
  private static wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Runs an operation, retrying only TRANSIENT failures.
   *
   * A policy refusal, a bad claim or an expired session are decisions. Retrying
   * a decision burns time and, for anything that got as far as being charged,
   * money. Only the gateway failing to reach something it depends on is worth
   * another attempt.
   */
  private async withRetry<T>(op: () => Promise<T>): Promise<T> {
    let delay = this.retry.backoffMs;
    for (let attempt = 0; ; attempt++) {
      try {
        return await op();
      } catch (e) {
        const retryable = e instanceof AgentPayError && e.transient;
        if (!retryable || attempt >= this.retry.retries) throw e;
        await AgentPayClient.wait(delay);
        delay *= 2;
      }
    }
  }

  /**
   * How many of `resource` the remaining ESCROW can cover.
   *
   * This is the bound the chain enforces, and the only one an agent can
   * compute for itself. The human's policy envelope — allowlists, per-call
   * caps, call counts — may be narrower, and the agent is not told it: reading
   * another party's spending rules is an operator's business, not an agent's.
   *
   * So treat this as a ceiling, not a permission. For the policy-bounded
   * answer use `plan()`, which signs and asks the gateway. The definitive
   * answer still comes from actually buying, and a refusal names the exact
   * rule that stopped it — `buyMany` already stops there, which is why an
   * agent does not need to predict in advance.
   */
  async affordableCalls(resource: string): Promise<number> {
    const [{ price }, state] = await Promise.all([
      this.quote(resource),
      this.sessionState(),
    ]);
    if (price === 0n) return Number.MAX_SAFE_INTEGER;
    const n = state.remaining / price;
    return n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(n);
  }

  private url(resource: string): string {
    const path = resource.startsWith("/") ? resource.slice(1) : resource;
    return `${this.gateway}/v1/buy/${path}`;
  }

  /** base64 of the JSON envelope, the encoding the 402 advertises. */
  private async encodeClaim(cumulative: bigint, nonce: bigint): Promise<string> {
    const msg = claimMessage({
      session: this.sessionBytes,
      cumulativeAmount: cumulative,
      nonce,
      expiresAt: this.expiresAt,
    });
    const signature = await this.signer.sign(msg);
    if (signature.length !== 64) {
      throw new Error(`signer returned ${signature.length} bytes, expected 64`);
    }
    const wire = {
      session: this.sessionB58,
      cumulative_amount: cumulative.toString(),
      nonce: nonce.toString(),
      expires_at: this.expiresAt.toString(),
      signature: base58Encode(signature),
    };
    return Buffer.from(JSON.stringify(wire)).toString("base64");
  }

  /** Exposed for tests; the agent key this client signs with. */
  get agentPubkey(): string {
    return base58Encode(toBytes(this.signer.publicKey));
  }
}

export { base58Decode, base58Encode };
