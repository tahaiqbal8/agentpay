/**
 * Values mirrored from the Rust side.
 *
 * These are not UI preferences — they are protocol constants. If any of these
 * drift from gateway/src/claim.rs or programs/agentpay/src/lib.rs, the console
 * will confidently show a status the chain disagrees with.
 */

/** `CLOCK_SKEW_TOLERANCE_SECS` in gateway/src/claim.rs and the program. */
export const CLOCK_SKEW_TOLERANCE_SECS = 30;

/** USDC decimals. Amounts are micro-USDC integers everywhere. */
export const USDC_DECIMALS = 6;

/** Decision strings frozen into the evidence hash preimage. */
export const DECISIONS = {
  ALLOWED: "ALLOWED",
  NOT_MONOTONIC: "ERR_CLAIM_NOT_MONOTONIC",
  NONCE_NOT_MONOTONIC: "ERR_NONCE_NOT_MONOTONIC",
  EXCEEDS_DEPOSIT: "ERR_CLAIM_EXCEEDS_DEPOSIT",
  SESSION_EXPIRED: "ERR_SESSION_EXPIRED",
} as const;

/** Short, human labels for the feed. Keys are the wire codes. */
export const DECISION_LABEL: Record<string, string> = {
  ALLOWED: "Allowed",
  ERR_CLAIM_NOT_MONOTONIC: "Replay / regression",
  ERR_NONCE_NOT_MONOTONIC: "Out of order",
  ERR_CLAIM_EXCEEDS_DEPOSIT: "Over deposit",
  ERR_SESSION_EXPIRED: "Session expired",
};

/** One-line explanation, shown on hover in the feed. */
export const DECISION_WHY: Record<string, string> = {
  ALLOWED: "Cumulative and nonce both increased, and the total stays inside the escrowed deposit.",
  ERR_CLAIM_NOT_MONOTONIC:
    "Cumulative did not increase over the high-water mark. Equal is a replay; lower is a regression.",
  ERR_NONCE_NOT_MONOTONIC:
    "The sequence number did not increase, so this claim arrived out of order.",
  ERR_CLAIM_EXCEEDS_DEPOSIT:
    "Cumulative is larger than what was escrowed on chain. Settlement would refuse it too.",
  ERR_SESSION_EXPIRED: "The session is past its expiry plus clock-skew tolerance.",
};
