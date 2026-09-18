/**
 * Derived session lifecycle.
 *
 * The status badge MUST agree with what the gateway would actually do with a
 * claim. `is_settled` alone is not enough: a session past its expiry is refused
 * with ERR_SESSION_EXPIRED, so labelling it "Active" tells an operator it can
 * still take traffic when it cannot.
 *
 * The order here mirrors `evaluate_claim` in gateway/src/state.rs — settled is
 * checked before expiry there, so it is checked first here too. If that order
 * ever changes, this must change with it.
 */
import { CLOCK_SKEW_TOLERANCE_SECS } from "./constants";

export type SessionStatus = "settled" | "expired" | "expiring" | "active";

/** Under five minutes left is worth flagging before it lapses. */
const EXPIRING_SOON_SECS = 300;

export interface StatusInfo {
  status: SessionStatus;
  label: string;
  /** What the gateway would return for a claim right now. */
  wouldAccept: boolean;
  reasonIfRefused: string | null;
  tone: "info" | "allowed" | "denied" | "neutral";
}

export function sessionStatus(
  s: { is_settled: boolean; expires_at: number },
  nowSecs: number = Math.floor(Date.now() / 1000)
): StatusInfo {
  if (s.is_settled) {
    return {
      status: "settled",
      label: "Settled",
      wouldAccept: false,
      reasonIfRefused: "ERR_SESSION_SETTLED",
      tone: "info",
    };
  }

  // Same permissive-direction skew the program and gateway apply.
  if (nowSecs > s.expires_at + CLOCK_SKEW_TOLERANCE_SECS) {
    return {
      status: "expired",
      label: "Expired",
      wouldAccept: false,
      reasonIfRefused: "ERR_SESSION_EXPIRED",
      tone: "denied",
    };
  }

  if (s.expires_at - nowSecs < EXPIRING_SOON_SECS) {
    return {
      status: "expiring",
      label: "Expiring",
      wouldAccept: true,
      reasonIfRefused: null,
      tone: "denied",
    };
  }

  return {
    status: "active",
    label: "Active",
    wouldAccept: true,
    reasonIfRefused: null,
    tone: "allowed",
  };
}

/**
 * An expired, unsettled session still holds escrow.
 *
 * That matters operationally: the money is recoverable by anyone via
 * `refund_session` once expiry passes, but until somebody calls it the funds
 * just sit there. Worth surfacing rather than leaving the row looking inert.
 */
export function isStrandedEscrow(s: {
  is_settled: boolean;
  expires_at: number;
  remaining: string;
}): boolean {
  const st = sessionStatus(s);
  if (st.status !== "expired") return false;
  try {
    return BigInt(s.remaining) > 0n;
  } catch {
    return false;
  }
}
