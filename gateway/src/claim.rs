//! Canonical claim encoding.
//!
//! These bytes are what the agent signs and what the on-chain Ed25519
//! precompile verifies. This module must stay byte-identical to
//! `build_claim_message` in `programs/agentpay/src/lib.rs`; a divergence of even
//! one byte means every settlement fails at `ClaimMessageMismatch`, after the
//! gateway has already told the agent its claims were good.
//!
//! The unit tests at the bottom pin the exact layout and a known vector.

use serde::{Deserialize, Serialize};
use solana_pubkey::Pubkey;

/// Domain separation prefix. Without it, a signature produced for another
/// protocol over a 73-byte blob could be replayed here as a valid claim.
pub const CLAIM_DOMAIN: &[u8] = b"agentpay:claim:v1";

/// domain(17) + session(32) + cumulative(8) + nonce(8) + expiry(8)
pub const CLAIM_MESSAGE_LEN: usize = 17 + 32 + 8 + 8 + 8;

/// Mirrors `CLOCK_SKEW_TOLERANCE_SECS` in the program.
pub const CLOCK_SKEW_TOLERANCE_SECS: i64 = 30;

const OFF_DOMAIN: usize = 0;
const OFF_SESSION: usize = 17;
const OFF_CUMULATIVE: usize = 49;
const OFF_NONCE: usize = 57;
const OFF_EXPIRY: usize = 65;

/// A signed cumulative claim against one session.
///
/// `nonce` is the sequence number of the claim within the session. It is
/// monotonic alongside `cumulative_amount` and is bound into the signature, so
/// it cannot be edited without invalidating the claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Claim {
    pub session: Pubkey,
    pub cumulative_amount: u64,
    pub nonce: u64,
    pub expires_at: i64,
}

impl Claim {
    /// The exact bytes the agent signs.
    ///
    /// Every field is fixed-width, so plain concatenation is unambiguous: no
    /// two distinct claims can produce the same byte string, which is why no
    /// length prefixes or separators are needed.
    pub fn signing_bytes(&self) -> [u8; CLAIM_MESSAGE_LEN] {
        let mut buf = [0u8; CLAIM_MESSAGE_LEN];
        buf[OFF_DOMAIN..OFF_SESSION].copy_from_slice(CLAIM_DOMAIN);
        buf[OFF_SESSION..OFF_CUMULATIVE].copy_from_slice(self.session.as_ref());
        buf[OFF_CUMULATIVE..OFF_NONCE].copy_from_slice(&self.cumulative_amount.to_le_bytes());
        buf[OFF_NONCE..OFF_EXPIRY].copy_from_slice(&self.nonce.to_le_bytes());
        buf[OFF_EXPIRY..].copy_from_slice(&self.expires_at.to_le_bytes());
        buf
    }

    /// True when `now` is past the claim's expiry, allowing for validator clock
    /// skew in the same permissive direction the program uses.
    pub fn is_expired(&self, now: i64) -> bool {
        match self.expires_at.checked_add(CLOCK_SKEW_TOLERANCE_SECS) {
            Some(limit) => now > limit,
            // An expiry so large it overflows cannot be "past".
            None => false,
        }
    }
}

/// Wire representation of a claim.
///
/// Amounts are strings, not JSON numbers. JSON numbers are IEEE-754 doubles in
/// every JavaScript client, which silently corrupts u64 values above 2^53 —
/// rule 0.3 says money never touches a float, and that includes in transit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimWire {
    /// Base58 session PDA.
    pub session: String,
    /// Micro-USDC (6 decimals), decimal string.
    pub cumulative_amount: String,
    /// Sequence number within the session, decimal string.
    pub nonce: String,
    /// Unix seconds, decimal string.
    pub expires_at: String,
    /// Base58 Ed25519 signature over `signing_bytes()`.
    pub signature: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ClaimDecodeError {
    #[error("session is not a valid base58 pubkey")]
    Session,
    #[error("cumulative_amount is not a u64 decimal string")]
    CumulativeAmount,
    #[error("nonce is not a u64 decimal string")]
    Nonce,
    #[error("expires_at is not an i64 decimal string")]
    ExpiresAt,
    #[error("signature is not 64 base58-decoded bytes")]
    Signature,
}

impl ClaimWire {
    pub fn decode(&self) -> Result<(Claim, [u8; 64]), ClaimDecodeError> {
        let session = self
            .session
            .parse::<Pubkey>()
            .map_err(|_| ClaimDecodeError::Session)?;
        let cumulative_amount = self
            .cumulative_amount
            .parse::<u64>()
            .map_err(|_| ClaimDecodeError::CumulativeAmount)?;
        let nonce = self
            .nonce
            .parse::<u64>()
            .map_err(|_| ClaimDecodeError::Nonce)?;
        let expires_at = self
            .expires_at
            .parse::<i64>()
            .map_err(|_| ClaimDecodeError::ExpiresAt)?;

        let sig_bytes = bs58::decode(&self.signature)
            .into_vec()
            .map_err(|_| ClaimDecodeError::Signature)?;
        let signature: [u8; 64] = sig_bytes
            .try_into()
            .map_err(|_| ClaimDecodeError::Signature)?;

        Ok((
            Claim {
                session,
                cumulative_amount,
                nonce,
                expires_at,
            },
            signature,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_session() -> Pubkey {
        Pubkey::new_from_array([7u8; 32])
    }

    #[test]
    fn domain_is_seventeen_bytes() {
        // The offsets below are hardcoded against this length, and so is the
        // program's CLAIM_MESSAGE_LEN.
        assert_eq!(CLAIM_DOMAIN.len(), 17);
        assert_eq!(CLAIM_MESSAGE_LEN, 73);
    }

    #[test]
    fn layout_matches_the_program() {
        let claim = Claim {
            session: fixed_session(),
            cumulative_amount: 1_234_567,
            nonce: 42,
            expires_at: 1_800_000_000,
        };
        let bytes = claim.signing_bytes();

        assert_eq!(&bytes[0..17], CLAIM_DOMAIN);
        assert_eq!(&bytes[17..49], &[7u8; 32]);
        assert_eq!(&bytes[49..57], &1_234_567u64.to_le_bytes());
        assert_eq!(&bytes[57..65], &42u64.to_le_bytes());
        assert_eq!(&bytes[65..73], &1_800_000_000i64.to_le_bytes());
    }

    /// Cross-boundary parity vector.
    ///
    /// This exact byte string was produced by the TypeScript `buildClaimMessage`
    /// in `tests/helpers.ts`, which is what signs the claims the on-chain
    /// program verifies. If this assertion ever fails, the gateway and the chain
    /// disagree about what a claim *is*, and every settlement will fail with
    /// `ClaimMessageMismatch` — after the gateway has already told agents their
    /// claims were good. Regenerate deliberately, never "fix" by editing.
    #[test]
    fn matches_the_typescript_signer_byte_for_byte() {
        const EXPECTED_HEX: &str = concat!(
            "6167656e747061793a636c61696d3a7631", // "agentpay:claim:v1"
            "0707070707070707070707070707070707070707070707070707070707070707", // session
            "87d6120000000000", // cumulative 1_234_567 LE
            "2a00000000000000", // nonce 42 LE
            "00d2496b00000000", // expires_at 1_800_000_000 LE
        );

        let claim = Claim {
            session: fixed_session(),
            cumulative_amount: 1_234_567,
            nonce: 42,
            expires_at: 1_800_000_000,
        };

        let hex: String = claim
            .signing_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();

        assert_eq!(hex, EXPECTED_HEX);
        assert_eq!(claim.signing_bytes().len(), 73);
        // The same fixture rendered as base58, as the TS side reports it.
        assert_eq!(
            fixed_session().to_string(),
            "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx"
        );
    }

    #[test]
    fn distinct_claims_never_collide() {
        let base = Claim {
            session: fixed_session(),
            cumulative_amount: 1,
            nonce: 1,
            expires_at: 1,
        };
        // Moving a unit between adjacent fixed-width fields must change the
        // bytes. If encoding were length-prefixed or variable-width, these
        // could alias and one signature would cover two different claims.
        let shifted = Claim {
            cumulative_amount: 0,
            nonce: 257,
            ..base
        };
        assert_ne!(base.signing_bytes(), shifted.signing_bytes());
    }

    #[test]
    fn expiry_respects_skew_tolerance() {
        let claim = Claim {
            session: fixed_session(),
            cumulative_amount: 1,
            nonce: 1,
            expires_at: 1_000,
        };
        assert!(!claim.is_expired(1_000));
        assert!(!claim.is_expired(1_000 + CLOCK_SKEW_TOLERANCE_SECS));
        assert!(claim.is_expired(1_000 + CLOCK_SKEW_TOLERANCE_SECS + 1));
    }

    #[test]
    fn expiry_overflow_does_not_panic() {
        let claim = Claim {
            session: fixed_session(),
            cumulative_amount: 1,
            nonce: 1,
            expires_at: i64::MAX,
        };
        assert!(!claim.is_expired(i64::MAX));
    }

    #[test]
    fn wire_roundtrip() {
        let wire = ClaimWire {
            session: fixed_session().to_string(),
            cumulative_amount: "18446744073709551615".into(), // u64::MAX
            nonce: "7".into(),
            expires_at: "1800000000".into(),
            signature: bs58::encode([9u8; 64]).into_string(),
        };
        let (claim, sig) = wire.decode().expect("decodes");
        assert_eq!(claim.cumulative_amount, u64::MAX);
        assert_eq!(claim.nonce, 7);
        assert_eq!(sig, [9u8; 64]);
    }

    #[test]
    fn wire_rejects_float_amounts() {
        // A JS client that let a u64 become a double would send "1.0e21" or
        // similar. That must be a hard decode failure, never a rounded value.
        let wire = ClaimWire {
            session: fixed_session().to_string(),
            cumulative_amount: "1.0".into(),
            nonce: "1".into(),
            expires_at: "1".into(),
            signature: bs58::encode([0u8; 64]).into_string(),
        };
        assert!(matches!(
            wire.decode(),
            Err(ClaimDecodeError::CumulativeAmount)
        ));
    }

    #[test]
    fn wire_rejects_short_signature() {
        let wire = ClaimWire {
            session: fixed_session().to_string(),
            cumulative_amount: "1".into(),
            nonce: "1".into(),
            expires_at: "1".into(),
            signature: bs58::encode([0u8; 63]).into_string(),
        };
        assert!(matches!(wire.decode(), Err(ClaimDecodeError::Signature)));
    }
}
