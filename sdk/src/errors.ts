/**
 * Typed refusals.
 *
 * The gateway answers every denial with a stable `reason_code`. Surfacing it
 * as a typed error rather than a status code matters because the codes carry
 * information the status cannot: a 403 might be a budget, an allowlist, a
 * suspension or a waiting human, and an integrator handles each differently —
 * retry later, ask a person, give up, or tell the operator.
 */

/** Reason codes an integrator is most likely to branch on. */
export type ReasonCode =
  // the claim itself
  | "ERR_MALFORMED_CLAIM"
  | "ERR_CLAIM_EXPIRED"
  | "ERR_CLAIM_NOT_MONOTONIC"
  | "ERR_NONCE_NOT_MONOTONIC"
  | "ERR_CLAIM_EXCEEDS_DEPOSIT"
  | "ERR_INVALID_SIGNATURE"
  | "ERR_PRICE_MISMATCH"
  // the session
  | "ERR_SESSION_UNKNOWN"
  | "ERR_SESSION_EXPIRED"
  | "ERR_SESSION_SETTLED"
  // the human's envelope
  | "ERR_AGENT_SUSPENDED"
  | "ERR_AGENT_POLICY_REQUIRED"
  | "ERR_POLICY_RESOURCE_NOT_ALLOWED"
  | "ERR_POLICY_PRICE_CAP"
  | "ERR_POLICY_BUDGET"
  | "ERR_POLICY_CALL_LIMIT"
  | "ERR_APPROVAL_REQUIRED"
  // the provider
  | "ERR_UNKNOWN_RESOURCE"
  | "ERR_UPSTREAM_UNAVAILABLE"
  | "ERR_UPSTREAM_NOT_CONFIGURED"
  // infrastructure
  | "ERR_STORE_UNAVAILABLE"
  | "ERR_CHAIN_UNAVAILABLE"
  | "ERR_UNAUTHORIZED"
  | (string & {});

export class AgentPayError extends Error {
  readonly reasonCode: ReasonCode;
  readonly status: number;
  readonly requestId?: string;

  constructor(reasonCode: ReasonCode, message: string, status: number, requestId?: string) {
    super(`${reasonCode}: ${message}`);
    this.name = "AgentPayError";
    this.reasonCode = reasonCode;
    this.status = status;
    this.requestId = requestId;
  }

  /**
   * True when a human decision is the only thing standing in the way.
   *
   * Separated from the other refusals because the correct response is
   * different: wait and retry, rather than change the request or give up. The
   * gateway raises the proposal on the first refusal, so the retry needs no
   * extra call.
   */
  get needsApproval(): boolean {
    return this.reasonCode === "ERR_APPROVAL_REQUIRED";
  }

  /**
   * True when the agent has run out of authority — budget, call count, price
   * cap, allowlist, suspension, or the escrow itself.
   *
   * Retrying will not help. Someone has to widen the envelope or open a new
   * session.
   */
  get outOfAuthority(): boolean {
    return [
      "ERR_POLICY_BUDGET",
      "ERR_POLICY_CALL_LIMIT",
      "ERR_POLICY_PRICE_CAP",
      "ERR_POLICY_RESOURCE_NOT_ALLOWED",
      "ERR_AGENT_SUSPENDED",
      "ERR_CLAIM_EXCEEDS_DEPOSIT",
      "ERR_SESSION_EXPIRED",
      "ERR_SESSION_SETTLED",
    ].includes(this.reasonCode);
  }

  /**
   * True when the gateway could not reach something it depends on.
   *
   * Worth retrying with backoff. Deliberately does NOT include policy or claim
   * refusals: those are decisions, and retrying a decision is a busy loop.
   */
  get transient(): boolean {
    return [
      "ERR_STORE_UNAVAILABLE",
      "ERR_CHAIN_UNAVAILABLE",
      "ERR_UPSTREAM_UNAVAILABLE",
    ].includes(this.reasonCode);
  }
}

/** Shape of the gateway's error body. */
export interface ErrorBody {
  reason_code?: string;
  message?: string;
  request_id?: string;
}

export function errorFrom(status: number, body: unknown): AgentPayError {
  const b = (body ?? {}) as ErrorBody;
  return new AgentPayError(
    b.reason_code ?? "ERR_UNKNOWN",
    b.message ?? `The gateway returned ${status} with no reason code.`,
    status,
    b.request_id
  );
}
