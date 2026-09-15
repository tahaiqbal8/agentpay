//! Append-only evidence log: hash chain and Merkle tree.
//!
//! Every authenticated decision the gateway makes about a claim becomes one
//! entry, linked to its predecessor by hash. At settlement the entry hashes
//! become the leaves of a Merkle tree whose root is committed on-chain, so
//! "the agent stayed inside its budget" becomes a checkable statement rather
//! than an assertion.
//!
//! # The two structures do different jobs
//!
//! The **hash chain** (`prev_hash` -> `entry_hash`) makes the log
//! tamper-evident *in order*: changing, reordering, or removing any entry
//! breaks every link after it. The **Merkle tree** makes individual entries
//! provable against a single 32-byte root without publishing the whole log.
//!
//! The chain also closes a known Merkle weakness. Duplicating the last node on
//! an odd level (CVE-2012-2459) normally lets two distinct leaf sets produce the
//! same root. Here each leaf commits to its predecessor and to its own
//! sequence position, so a leaf set that differs at all breaks the chain and is
//! detectable independently of the root.
//!
//! This module is pure: no database, no I/O, fully unit-testable.

use sha2::{Digest, Sha256};
use solana_pubkey::Pubkey;

/// `prev_hash` for the first entry in a session's chain.
pub const GENESIS_PREV_HASH: [u8; 32] = [0u8; 32];

/// Root reported for a session with no evidence at all.
///
/// Distinguishable from a real root only by the fact that no valid chain
/// produces it; settlement of an empty log commits all zeroes, which honestly
/// means "nothing was recorded".
pub const EMPTY_ROOT: [u8; 32] = [0u8; 32];

/// The decision recorded for one claim attempt.
///
/// Only outcomes reached *after* the claim's signature was verified appear
/// here. See the module note in `db.rs` on why unauthenticated failures are
/// deliberately excluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allowed,
    NotMonotonic,
    NonceNotMonotonic,
    ExceedsDeposit,
    SessionExpired,
}

impl Decision {
    /// Stored verbatim in `evidence_log.decision` and hashed into the entry.
    /// These strings are part of the hash preimage, so renaming one changes
    /// every historical root: treat them as frozen.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Allowed => "ALLOWED",
            Self::NotMonotonic => "ERR_CLAIM_NOT_MONOTONIC",
            Self::NonceNotMonotonic => "ERR_NONCE_NOT_MONOTONIC",
            Self::ExceedsDeposit => "ERR_CLAIM_EXCEEDS_DEPOSIT",
            Self::SessionExpired => "ERR_SESSION_EXPIRED",
        }
    }

    #[allow(dead_code)] // used by tests and by external log verifiers
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "ALLOWED" => Self::Allowed,
            "ERR_CLAIM_NOT_MONOTONIC" => Self::NotMonotonic,
            "ERR_NONCE_NOT_MONOTONIC" => Self::NonceNotMonotonic,
            "ERR_CLAIM_EXCEEDS_DEPOSIT" => Self::ExceedsDeposit,
            "ERR_SESSION_EXPIRED" => Self::SessionExpired,
            _ => return None,
        })
    }

    #[allow(dead_code)]
    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Allowed)
    }
}

/// Computes one entry's hash.
///
/// ```text
/// SHA256(prev_hash || session(32) || cumulative_le(8) || nonce_le(8) || decision)
/// ```
///
/// The session is hashed as its 32 raw bytes rather than its base58 text, so
/// the preimage is fixed-width up to `decision`. `decision` is variable-length
/// and last, so no field boundary is ambiguous and no two distinct entries can
/// share a preimage.
pub fn compute_entry_hash(
    prev_hash: &[u8; 32],
    session: &Pubkey,
    cumulative_amount: u64,
    nonce: u64,
    decision: &str,
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(prev_hash);
    hasher.update(session.as_ref());
    hasher.update(cumulative_amount.to_le_bytes());
    hasher.update(nonce.to_le_bytes());
    hasher.update(decision.as_bytes());
    hasher.finalize().into()
}

/// One decision as stored, enough to re-derive its hash.
#[derive(Debug, Clone)]
pub struct EvidenceEntry {
    pub sequence_id: i64,
    pub cumulative_amount: u64,
    pub nonce: u64,
    pub decision: String,
    pub prev_hash: [u8; 32],
    pub entry_hash: [u8; 32],
}

/// Why a chain failed verification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainError {
    /// Sequence numbers must start at 0 and increase by exactly 1.
    SequenceGap { expected: i64, found: i64 },
    /// An entry's `prev_hash` does not match its predecessor's `entry_hash`.
    BrokenLink { sequence_id: i64 },
    /// An entry's stored hash is not the hash of its own contents: the row was
    /// edited in place.
    HashMismatch { sequence_id: i64 },
}

/// Walks a session's chain and reports the first inconsistency.
///
/// This is what makes the log *tamper-evident*: a database writer can change a
/// row, but cannot make the change consistent without recomputing every later
/// entry, and the published root pins the whole set.
pub fn verify_chain(session: &Pubkey, entries: &[EvidenceEntry]) -> Result<(), ChainError> {
    let mut expected_prev = GENESIS_PREV_HASH;

    for (i, entry) in entries.iter().enumerate() {
        let expected_seq = i as i64;
        if entry.sequence_id != expected_seq {
            return Err(ChainError::SequenceGap {
                expected: expected_seq,
                found: entry.sequence_id,
            });
        }
        if entry.prev_hash != expected_prev {
            return Err(ChainError::BrokenLink {
                sequence_id: entry.sequence_id,
            });
        }
        let recomputed = compute_entry_hash(
            &entry.prev_hash,
            session,
            entry.cumulative_amount,
            entry.nonce,
            &entry.decision,
        );
        if recomputed != entry.entry_hash {
            return Err(ChainError::HashMismatch {
                sequence_id: entry.sequence_id,
            });
        }
        expected_prev = entry.entry_hash;
    }

    Ok(())
}

/// Which side a sibling sits on, needed to recompute the parent in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProofNode {
    pub hash: [u8; 32],
    /// Side the *sibling* sits on relative to the running hash.
    pub side: Side,
}

/// Binary SHA-256 Merkle tree over evidence entry hashes.
///
/// Odd levels duplicate their last node, matching the convention the spec asks
/// for. See the module docs on why the hash chain neutralises the usual
/// duplicate-node malleability.
#[derive(Debug, Clone)]
pub struct MerkleTree {
    /// `levels[0]` is the leaves; the last level is the single root.
    levels: Vec<Vec<[u8; 32]>>,
}

fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(left);
    hasher.update(right);
    hasher.finalize().into()
}

impl MerkleTree {
    pub fn new(leaves: Vec<[u8; 32]>) -> Self {
        if leaves.is_empty() {
            return Self { levels: Vec::new() };
        }

        let mut levels = vec![leaves];
        while levels.last().map(|l| l.len()).unwrap_or(0) > 1 {
            let current = levels.last().expect("non-empty");
            let mut next = Vec::with_capacity(current.len().div_ceil(2));
            let mut i = 0;
            while i < current.len() {
                let left = &current[i];
                // Odd node out is paired with itself.
                let right = current.get(i + 1).unwrap_or(left);
                next.push(hash_pair(left, right));
                i += 2;
            }
            levels.push(next);
        }

        Self { levels }
    }

    /// All-zero for an empty log, otherwise the single root.
    pub fn root(&self) -> [u8; 32] {
        match self.levels.last() {
            Some(top) if top.len() == 1 => top[0],
            // A single leaf is its own root; `new` stops before building a level.
            Some(top) if !top.is_empty() => top[0],
            _ => EMPTY_ROOT,
        }
    }

    pub fn leaf_count(&self) -> usize {
        self.levels.first().map(|l| l.len()).unwrap_or(0)
    }

    #[allow(dead_code)]
    pub fn leaves(&self) -> &[[u8; 32]] {
        self.levels.first().map(|l| l.as_slice()).unwrap_or(&[])
    }

    /// Sibling hashes needed to recompute the root from leaf `index`.
    ///
    /// `None` when the index is out of range. A single-leaf tree yields an
    /// empty proof, which is correct: the leaf already *is* the root.
    pub fn proof(&self, index: usize) -> Option<Vec<ProofNode>> {
        if index >= self.leaf_count() {
            return None;
        }

        let mut proof = Vec::new();
        let mut idx = index;

        for level in &self.levels[..self.levels.len().saturating_sub(1)] {
            let sibling_idx = if idx % 2 == 0 { idx + 1 } else { idx - 1 };
            // A right sibling past the end means this node was duplicated.
            let sibling = *level.get(sibling_idx).unwrap_or(&level[idx]);
            proof.push(ProofNode {
                hash: sibling,
                side: if idx % 2 == 0 { Side::Right } else { Side::Left },
            });
            idx /= 2;
        }

        Some(proof)
    }
}

/// Recomputes a root from a leaf and its proof.
///
/// Deliberately standalone and dependency-free so an auditor can reimplement it
/// from the published root without trusting this codebase.
pub fn verify_proof(leaf: &[u8; 32], proof: &[ProofNode], expected_root: &[u8; 32]) -> bool {
    let mut current = *leaf;
    for node in proof {
        current = match node.side {
            Side::Right => hash_pair(&current, &node.hash),
            Side::Left => hash_pair(&node.hash, &current),
        };
    }
    current == *expected_root
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    fn session() -> Pubkey {
        Pubkey::new_from_array([7u8; 32])
    }

    // ---- entry hashing ----------------------------------------------------

    #[test]
    fn entry_hash_is_deterministic() {
        let a = compute_entry_hash(&GENESIS_PREV_HASH, &session(), 100, 1, "ALLOWED");
        let b = compute_entry_hash(&GENESIS_PREV_HASH, &session(), 100, 1, "ALLOWED");
        assert_eq!(a, b);
        assert_ne!(a, [0u8; 32]);
    }

    #[test]
    fn every_field_changes_the_entry_hash() {
        let base = compute_entry_hash(&GENESIS_PREV_HASH, &session(), 100, 1, "ALLOWED");
        assert_ne!(base, compute_entry_hash(&[1u8; 32], &session(), 100, 1, "ALLOWED"));
        assert_ne!(
            base,
            compute_entry_hash(
                &GENESIS_PREV_HASH,
                &Pubkey::new_from_array([8u8; 32]),
                100,
                1,
                "ALLOWED"
            )
        );
        assert_ne!(base, compute_entry_hash(&GENESIS_PREV_HASH, &session(), 101, 1, "ALLOWED"));
        assert_ne!(base, compute_entry_hash(&GENESIS_PREV_HASH, &session(), 100, 2, "ALLOWED"));
        assert_ne!(
            base,
            compute_entry_hash(&GENESIS_PREV_HASH, &session(), 100, 1, "ERR_SESSION_EXPIRED")
        );
    }

    #[test]
    fn amount_and_nonce_cannot_be_confused() {
        // Both are 8 bytes at fixed offsets, so swapping them must not alias.
        let a = compute_entry_hash(&GENESIS_PREV_HASH, &session(), 1, 2, "ALLOWED");
        let b = compute_entry_hash(&GENESIS_PREV_HASH, &session(), 2, 1, "ALLOWED");
        assert_ne!(a, b);
    }

    #[test]
    fn decision_strings_round_trip() {
        for d in [
            Decision::Allowed,
            Decision::NotMonotonic,
            Decision::NonceNotMonotonic,
            Decision::ExceedsDeposit,
            Decision::SessionExpired,
        ] {
            assert_eq!(Decision::parse(d.as_str()), Some(d));
            // VARCHAR(32) in the schema.
            assert!(d.as_str().len() <= 32, "{} exceeds VARCHAR(32)", d.as_str());
        }
        assert_eq!(Decision::parse("NOT_A_DECISION"), None);
    }

    // ---- chain verification ----------------------------------------------

    fn build_chain(session: &Pubkey, decisions: &[(u64, u64, &str)]) -> Vec<EvidenceEntry> {
        let mut prev = GENESIS_PREV_HASH;
        let mut out = Vec::new();
        for (i, (cum, nonce, decision)) in decisions.iter().enumerate() {
            let entry_hash = compute_entry_hash(&prev, session, *cum, *nonce, decision);
            out.push(EvidenceEntry {
                sequence_id: i as i64,
                cumulative_amount: *cum,
                nonce: *nonce,
                decision: decision.to_string(),
                prev_hash: prev,
                entry_hash,
            });
            prev = entry_hash;
        }
        out
    }

    #[test]
    fn a_well_formed_chain_verifies() {
        let s = session();
        let chain = build_chain(
            &s,
            &[
                (100, 1, "ALLOWED"),
                (250, 2, "ALLOWED"),
                (250, 3, "ERR_CLAIM_NOT_MONOTONIC"),
                (400, 4, "ALLOWED"),
            ],
        );
        assert_eq!(verify_chain(&s, &chain), Ok(()));
        assert_eq!(chain[0].prev_hash, GENESIS_PREV_HASH);
    }

    #[test]
    fn empty_chain_verifies() {
        assert_eq!(verify_chain(&session(), &[]), Ok(()));
    }

    #[test]
    fn editing_an_entry_in_place_is_detected() {
        let s = session();
        let mut chain = build_chain(&s, &[(100, 1, "ALLOWED"), (250, 2, "ALLOWED")]);
        // The classic attack: quietly raise a recorded amount.
        chain[0].cumulative_amount = 999_999;
        assert_eq!(
            verify_chain(&s, &chain),
            Err(ChainError::HashMismatch { sequence_id: 0 })
        );
    }

    #[test]
    fn rewriting_an_entry_and_its_hash_breaks_the_next_link() {
        let s = session();
        let mut chain = build_chain(&s, &[(100, 1, "ALLOWED"), (250, 2, "ALLOWED")]);
        // Attacker recomputes entry 0 consistently, but cannot reach forward.
        chain[0].cumulative_amount = 999_999;
        chain[0].entry_hash =
            compute_entry_hash(&chain[0].prev_hash, &s, 999_999, 1, "ALLOWED");
        assert_eq!(
            verify_chain(&s, &chain),
            Err(ChainError::BrokenLink { sequence_id: 1 })
        );
    }

    #[test]
    fn deleting_an_entry_is_detected() {
        let s = session();
        let mut chain = build_chain(
            &s,
            &[(100, 1, "ALLOWED"), (250, 2, "ALLOWED"), (400, 3, "ALLOWED")],
        );
        // Removing a denial to make an agent look compliant.
        chain.remove(1);
        assert!(matches!(
            verify_chain(&s, &chain),
            Err(ChainError::SequenceGap { .. })
        ));
    }

    #[test]
    fn a_chain_for_another_session_does_not_verify() {
        let s = session();
        let chain = build_chain(&s, &[(100, 1, "ALLOWED")]);
        let other = Pubkey::new_from_array([9u8; 32]);
        assert_eq!(
            verify_chain(&other, &chain),
            Err(ChainError::HashMismatch { sequence_id: 0 })
        );
    }

    // ---- merkle tree ------------------------------------------------------

    #[test]
    fn empty_tree_has_zero_root() {
        let tree = MerkleTree::new(vec![]);
        assert_eq!(tree.root(), EMPTY_ROOT);
        assert_eq!(tree.leaf_count(), 0);
        assert!(tree.proof(0).is_none());
    }

    #[test]
    fn single_leaf_is_its_own_root() {
        let tree = MerkleTree::new(vec![leaf(1)]);
        assert_eq!(tree.root(), leaf(1));
        assert_eq!(tree.leaf_count(), 1);
        assert_eq!(tree.proof(0), Some(vec![]));
        assert!(verify_proof(&leaf(1), &[], &tree.root()));
    }

    #[test]
    fn two_leaves_hash_pairwise() {
        let tree = MerkleTree::new(vec![leaf(1), leaf(2)]);
        assert_eq!(tree.root(), hash_pair(&leaf(1), &leaf(2)));
    }

    #[test]
    fn odd_level_duplicates_the_last_node() {
        let tree = MerkleTree::new(vec![leaf(1), leaf(2), leaf(3)]);
        let left = hash_pair(&leaf(1), &leaf(2));
        // Leaf 3 has no sibling, so it is paired with itself.
        let right = hash_pair(&leaf(3), &leaf(3));
        assert_eq!(tree.root(), hash_pair(&left, &right));
    }

    #[test]
    fn root_is_order_dependent() {
        // Evidence order is the decision order; a tree that ignored it could
        // not prove when something happened.
        let a = MerkleTree::new(vec![leaf(1), leaf(2)]).root();
        let b = MerkleTree::new(vec![leaf(2), leaf(1)]).root();
        assert_ne!(a, b);
    }

    #[test]
    fn root_is_deterministic() {
        let leaves: Vec<[u8; 32]> = (0..9).map(leaf).collect();
        assert_eq!(
            MerkleTree::new(leaves.clone()).root(),
            MerkleTree::new(leaves).root()
        );
    }

    #[test]
    fn changing_any_leaf_changes_the_root() {
        let leaves: Vec<[u8; 32]> = (0..7).map(leaf).collect();
        let base = MerkleTree::new(leaves.clone()).root();
        for i in 0..leaves.len() {
            let mut mutated = leaves.clone();
            mutated[i] = leaf(200 + i as u8);
            assert_ne!(
                MerkleTree::new(mutated).root(),
                base,
                "mutating leaf {i} left the root unchanged"
            );
        }
    }

    // ---- inclusion proofs -------------------------------------------------

    #[test]
    fn every_leaf_proves_against_the_root() {
        // Sizes chosen to exercise even, odd, and power-of-two levels.
        for count in [1usize, 2, 3, 4, 5, 7, 8, 9, 16, 17, 33] {
            let leaves: Vec<[u8; 32]> = (0..count).map(|i| leaf(i as u8)).collect();
            let tree = MerkleTree::new(leaves.clone());
            let root = tree.root();
            for (i, l) in leaves.iter().enumerate() {
                let proof = tree.proof(i).expect("proof exists");
                assert!(
                    verify_proof(l, &proof, &root),
                    "leaf {i} of {count} failed to verify"
                );
            }
        }
    }

    #[test]
    fn a_proof_does_not_verify_a_different_leaf() {
        let leaves: Vec<[u8; 32]> = (0..8).map(leaf).collect();
        let tree = MerkleTree::new(leaves.clone());
        let proof = tree.proof(3).unwrap();
        assert!(verify_proof(&leaves[3], &proof, &tree.root()));
        // Same proof, wrong leaf.
        assert!(!verify_proof(&leaves[4], &proof, &tree.root()));
        assert!(!verify_proof(&leaf(99), &proof, &tree.root()));
    }

    #[test]
    fn a_tampered_proof_does_not_verify() {
        let leaves: Vec<[u8; 32]> = (0..8).map(leaf).collect();
        let tree = MerkleTree::new(leaves.clone());
        let mut proof = tree.proof(2).unwrap();
        proof[0].hash = leaf(200);
        assert!(!verify_proof(&leaves[2], &proof, &tree.root()));

        // Flipping a sibling's side changes the concatenation order.
        let mut flipped = tree.proof(2).unwrap();
        flipped[0].side = match flipped[0].side {
            Side::Left => Side::Right,
            Side::Right => Side::Left,
        };
        assert!(!verify_proof(&leaves[2], &flipped, &tree.root()));
    }

    #[test]
    fn proof_index_out_of_range_is_none() {
        let tree = MerkleTree::new(vec![leaf(1), leaf(2), leaf(3)]);
        assert!(tree.proof(3).is_none());
        assert!(tree.proof(99).is_none());
    }

    #[test]
    fn proof_length_is_logarithmic() {
        let leaves: Vec<[u8; 32]> = (0..16).map(leaf).collect();
        let tree = MerkleTree::new(leaves);
        assert_eq!(tree.proof(0).unwrap().len(), 4); // log2(16)
    }

    #[test]
    fn end_to_end_chain_then_root() {
        // What settlement actually does: build the chain, take its entry
        // hashes in order, commit the root.
        let s = session();
        let chain = build_chain(
            &s,
            &[
                (100, 1, "ALLOWED"),
                (100, 2, "ERR_CLAIM_NOT_MONOTONIC"),
                (500, 3, "ALLOWED"),
                (9_999_999, 4, "ERR_CLAIM_EXCEEDS_DEPOSIT"),
                (750, 5, "ALLOWED"),
            ],
        );
        assert_eq!(verify_chain(&s, &chain), Ok(()));

        let tree = MerkleTree::new(chain.iter().map(|e| e.entry_hash).collect());
        let root = tree.root();
        assert_ne!(root, EMPTY_ROOT);
        assert_eq!(tree.leaf_count(), 5);

        // The denials are provably in the committed root, which is the point:
        // a CFO can verify the agent was stopped, not just that it paid.
        for (i, entry) in chain.iter().enumerate() {
            let proof = tree.proof(i).unwrap();
            assert!(verify_proof(&entry.entry_hash, &proof, &root));
        }
    }
}
