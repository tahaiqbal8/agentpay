-- AgentPay gateway: durable session and claim state.
--
-- Replaces the in-memory store. The high-water mark held here is the only thing
-- stopping an agent from replaying an old claim to obtain a second resource for
-- the same money, so this table IS the security boundary -- losing it reopens
-- claim replay for every live session.

CREATE TABLE IF NOT EXISTS sessions (
    session_pubkey   VARCHAR(44) PRIMARY KEY,
    agent_pubkey     VARCHAR(44) NOT NULL,
    provider_pubkey  VARCHAR(44) NOT NULL,
    mint_pubkey      VARCHAR(44) NOT NULL,

    -- Micro-USDC. BIGINT is signed i64 while the domain type is u64, so the
    -- application converts with a checked cast and rejects anything that will
    -- not fit rather than wrapping. A negative value here would mean that
    -- check was bypassed.
    deposited_total  BIGINT      NOT NULL CHECK (deposited_total > 0),

    -- Unix seconds, matching the on-chain Session.expires_at. Stored as BIGINT
    -- rather than TIMESTAMPTZ so it compares bit-for-bit with the value the
    -- program enforces; a timezone conversion here could drift from the chain.
    expires_at       BIGINT      NOT NULL,

    settled_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cold-start hydration reads exactly this set, and it is the hot path for
-- every claim lookup. Partial, because settled sessions are never queried here.
CREATE INDEX IF NOT EXISTS idx_sessions_unsettled
    ON sessions (session_pubkey)
    WHERE settled_at IS NULL;

-- One row per session: the highest claim accepted so far, plus the signature
-- that authorised it.
--
-- NOTE: this is a high-water mark, NOT an append-only log. Intermediate claims
-- are overwritten and are not recoverable from this table. The evidence log
-- that the product's audit claim depends on needs its own append-only table;
-- see docs/decisions.md D9.
CREATE TABLE IF NOT EXISTS claim_tickets (
    session_pubkey    VARCHAR(44) PRIMARY KEY
                      REFERENCES sessions (session_pubkey) ON DELETE CASCADE,

    cumulative_amount BIGINT      NOT NULL CHECK (cumulative_amount > 0),
    nonce             BIGINT      NOT NULL CHECK (nonce >= 0),

    -- Unix seconds, from the signed claim. Same reasoning as sessions.expires_at.
    expires_at        BIGINT      NOT NULL,

    -- The raw 64-byte Ed25519 signature. Settlement replays these exact bytes
    -- for the precompile to re-verify, so it cannot be reconstructed if lost.
    signature         BYTEA       NOT NULL CHECK (octet_length(signature) = 64),

    received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
