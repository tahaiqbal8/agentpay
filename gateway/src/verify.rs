//! Off-chain Ed25519 claim verification.

use ed25519_dalek::{Signature, VerifyingKey};
use solana_pubkey::Pubkey;

use crate::claim::Claim;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignatureVerdict {
    Valid,
    Invalid,
}

/// Verifies `signature` over the claim's canonical bytes under `agent`.
///
/// The key comes from the *session record*, never from the request. A claim
/// that carried its own public key would let anyone mint valid claims by
/// signing with a key they control and attaching it.
///
/// Uses `verify_strict`, which rejects small-order and non-canonical points as
/// well as scalar malleability. This matters beyond general hygiene: Solana's
/// Ed25519 precompile applies strict checks, so a laxer off-chain check would
/// let the gateway authorise a claim that then fails at settlement — the
/// provider would have delivered the resource for a claim that can never be
/// redeemed.
pub fn verify_claim_signature(
    agent: &Pubkey,
    claim: &Claim,
    signature: &[u8; 64],
) -> SignatureVerdict {
    let key_bytes: [u8; 32] = agent.to_bytes();

    // A pubkey that is not a valid curve point cannot have signed anything.
    let Ok(verifying_key) = VerifyingKey::from_bytes(&key_bytes) else {
        return SignatureVerdict::Invalid;
    };

    let signature = Signature::from_bytes(signature);
    let message = claim.signing_bytes();

    match verifying_key.verify_strict(&message, &signature) {
        Ok(()) => SignatureVerdict::Valid,
        Err(_) => SignatureVerdict::Invalid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn agent_keypair(seed: u8) -> (SigningKey, Pubkey) {
        let signing = SigningKey::from_bytes(&[seed; 32]);
        let pubkey = Pubkey::new_from_array(signing.verifying_key().to_bytes());
        (signing, pubkey)
    }

    fn sample_claim(session: Pubkey) -> Claim {
        Claim {
            session,
            cumulative_amount: 1_000_000,
            nonce: 1,
            expires_at: 1_800_000_000,
        }
    }

    #[test]
    fn accepts_a_genuine_signature() {
        let (signing, agent) = agent_keypair(1);
        let claim = sample_claim(Pubkey::new_from_array([3u8; 32]));
        let sig = signing.sign(&claim.signing_bytes()).to_bytes();
        assert_eq!(
            verify_claim_signature(&agent, &claim, &sig),
            SignatureVerdict::Valid
        );
    }

    #[test]
    fn rejects_a_signature_from_another_key() {
        let (attacker_signing, _) = agent_keypair(2);
        let (_, real_agent) = agent_keypair(1);
        let claim = sample_claim(Pubkey::new_from_array([3u8; 32]));
        let sig = attacker_signing.sign(&claim.signing_bytes()).to_bytes();
        assert_eq!(
            verify_claim_signature(&real_agent, &claim, &sig),
            SignatureVerdict::Invalid
        );
    }

    #[test]
    fn rejects_a_tampered_amount() {
        let (signing, agent) = agent_keypair(1);
        let claim = sample_claim(Pubkey::new_from_array([3u8; 32]));
        let sig = signing.sign(&claim.signing_bytes()).to_bytes();

        let inflated = Claim {
            cumulative_amount: claim.cumulative_amount + 1,
            ..claim
        };
        assert_eq!(
            verify_claim_signature(&agent, &inflated, &sig),
            SignatureVerdict::Invalid
        );
    }

    #[test]
    fn rejects_a_claim_replayed_onto_another_session() {
        let (signing, agent) = agent_keypair(1);
        let claim = sample_claim(Pubkey::new_from_array([3u8; 32]));
        let sig = signing.sign(&claim.signing_bytes()).to_bytes();

        // The session is inside the signed bytes, so the same signature cannot
        // be moved to a different session.
        let moved = Claim {
            session: Pubkey::new_from_array([4u8; 32]),
            ..claim
        };
        assert_eq!(
            verify_claim_signature(&agent, &moved, &sig),
            SignatureVerdict::Invalid
        );
    }

    #[test]
    fn rejects_a_tampered_nonce_and_expiry() {
        let (signing, agent) = agent_keypair(1);
        let claim = sample_claim(Pubkey::new_from_array([3u8; 32]));
        let sig = signing.sign(&claim.signing_bytes()).to_bytes();

        for mutated in [
            Claim { nonce: claim.nonce + 1, ..claim },
            Claim { expires_at: claim.expires_at + 1, ..claim },
        ] {
            assert_eq!(
                verify_claim_signature(&agent, &mutated, &sig),
                SignatureVerdict::Invalid
            );
        }
    }

    #[test]
    fn rejects_garbage_and_zero_signatures() {
        let (_, agent) = agent_keypair(1);
        let claim = sample_claim(Pubkey::new_from_array([3u8; 32]));
        assert_eq!(
            verify_claim_signature(&agent, &claim, &[0u8; 64]),
            SignatureVerdict::Invalid
        );
        assert_eq!(
            verify_claim_signature(&agent, &claim, &[0xff; 64]),
            SignatureVerdict::Invalid
        );
    }

    #[test]
    fn rejects_a_pubkey_that_is_not_a_curve_point() {
        // Session records are populated from chain data, but a malformed or
        // hostile one must not panic the gateway.
        let not_a_point = Pubkey::new_from_array([0xff; 32]);
        let claim = sample_claim(Pubkey::new_from_array([3u8; 32]));
        assert_eq!(
            verify_claim_signature(&not_a_point, &claim, &[0u8; 64]),
            SignatureVerdict::Invalid
        );
    }
}
