/**
 * The canonical claim encoding.
 *
 * This is the one file in the SDK that must be byte-for-byte identical to the
 * gateway (`gateway/src/claim.rs`) and the on-chain program
 * (`programs/agentpay/src/lib.rs`). Every other mistake in this package
 * surfaces as an HTTP error the caller can read; a mistake here produces a
 * signature that verifies nowhere, and the failure lands at SETTLEMENT — long
 * after the agent was told its purchases succeeded, and against a claim the
 * program will refuse.
 *
 * That is why `test/parity.test.ts` pins the output against the same hex
 * vector the Rust side asserts. If anyone changes this encoding, both sides
 * fail together instead of drifting apart quietly.
 */

/** Domain separator. 17 bytes. Part of the signed message, not a header. */
export const CLAIM_DOMAIN = Buffer.from("agentpay:claim:v1", "utf8");

/** 17 domain + 32 session + 8 cumulative + 8 nonce + 8 expiry. */
export const CLAIM_MESSAGE_LEN = 17 + 32 + 8 + 8 + 8;

export interface ClaimFields {
  /** The session PDA, 32 raw bytes. */
  session: Uint8Array;
  /** Total owed after this purchase — cumulative, not incremental. */
  cumulativeAmount: bigint;
  /** Strictly increasing per session. */
  nonce: bigint;
  /** Unix seconds. Signed, because the program reads it as i64. */
  expiresAt: bigint;
}

/**
 * Builds the exact 73 bytes an agent signs.
 *
 * Integers are little-endian, matching Rust's `to_le_bytes`. `cumulative` and
 * `nonce` are unsigned; `expires_at` is SIGNED, because the program stores it
 * as `i64` and a mismatch there would encode a far-future timestamp as a
 * negative one.
 */
export function claimMessage(fields: ClaimFields): Buffer {
  if (fields.session.length !== 32) {
    throw new Error(
      `session must be 32 bytes, got ${fields.session.length}. ` +
        `Pass the session PDA's raw bytes, not its base58 string.`
    );
  }
  // Caught here rather than by the signature failing later: a negative amount
  // silently becomes a huge one under an unsigned write.
  if (fields.cumulativeAmount < 0n || fields.nonce < 0n) {
    throw new Error("cumulativeAmount and nonce must not be negative");
  }

  const buf = Buffer.alloc(CLAIM_MESSAGE_LEN);
  let o = 0;
  CLAIM_DOMAIN.copy(buf, o);
  o += CLAIM_DOMAIN.length;
  Buffer.from(fields.session).copy(buf, o);
  o += 32;
  buf.writeBigUInt64LE(fields.cumulativeAmount, o);
  o += 8;
  buf.writeBigUInt64LE(fields.nonce, o);
  o += 8;
  buf.writeBigInt64LE(fields.expiresAt, o);
  return buf;
}
