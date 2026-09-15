-- Append-only evidence log.
--
-- 0001 gave us a high-water mark, which can prove what a session finally
-- settled at but nothing about how it got there, and nothing at all about
-- denials. This table is the record the product's audit claim rests on: one
-- row per authenticated decision, hash-linked to its predecessor, with the
-- Merkle root over all of them committed on-chain at settlement.
--
-- APPEND-ONLY BY CONVENTION, not by grant. Nothing here stops a role with
-- UPDATE or DELETE from rewriting history; what it does is make the rewrite
-- *detectable*, because every later entry's prev_hash would have to be
-- recomputed and the published root would no longer match. Revoking
-- UPDATE/DELETE from the application role is a deployment concern and is not
-- done here.

CREATE TABLE IF NOT EXISTS evidence_log (
    id                BIGSERIAL PRIMARY KEY,
    session_pubkey    VARCHAR(44) NOT NULL
                      REFERENCES sessions (session_pubkey) ON DELETE CASCADE,

    -- Per-session, starts at 0, increments by exactly 1. A gap is proof of a
    -- deleted entry, which is why verification checks it rather than relying
    -- on the hash links alone.
    sequence_id       BIGINT      NOT NULL CHECK (sequence_id >= 0),

    -- The claim as presented. Recorded even when refused, so the log shows what
    -- was attempted, not only what succeeded. Not constrained to be positive:
    -- a rejected claim may legitimately carry any value the agent signed.
    cumulative_amount BIGINT      NOT NULL,
    nonce             BIGINT      NOT NULL,

    -- 'ALLOWED' or an ERR_* reason code. Part of the entry hash preimage, so
    -- these strings are frozen: renaming one changes every historical root.
    decision          VARCHAR(32) NOT NULL,

    prev_hash         BYTEA       NOT NULL CHECK (octet_length(prev_hash) = 32),
    entry_hash        BYTEA       NOT NULL CHECK (octet_length(entry_hash) = 32),

    -- The agent's signature over the claim, when one was presented. Nullable
    -- because a future decision type may not carry one.
    signature         BYTEA       CHECK (signature IS NULL OR octet_length(signature) = 64),

    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Makes a duplicate sequence number impossible even if two writers race.
    -- The session row lock in admit_claim is the primary defence; this is the
    -- backstop that turns a lock failure into an error rather than a fork.
    CONSTRAINT uq_session_sequence UNIQUE (session_pubkey, sequence_id)
);

-- Serves both hot paths: appending (reads the latest sequence_id for a
-- session) and Merkle root construction (reads every leaf in order).
CREATE INDEX IF NOT EXISTS idx_evidence_session_seq
    ON evidence_log (session_pubkey, sequence_id ASC);
