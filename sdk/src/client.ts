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
    const res = await f(`${opts.gateway.replace(/\/+$/, "")}/v1/sessions`);
    if (!res.ok) {
      throw errorFrom(res.status, await res.json().catch(() => null));
    }
    const body = (await res.json()) as {
      sessions: { session: string; cumulative_accepted: string; last_nonce: string | null }[];
    };
    const found = body.sessions.find((s) => s.session === opts.session);
    if (!found) {
      throw new AgentPayError(
        "ERR_SESSION_UNKNOWN",
        `The gateway has no record of session ${opts.session}. Register it with ` +
          `POST /v1/session/open before buying.`,
        404
      );
    }
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
