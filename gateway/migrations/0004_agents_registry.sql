-- The control plane: agent identities, the provider registry, and the
-- permission envelope a human grants an agent.
--
-- None of this holds custody. The on-chain escrow remains the hard ceiling on
-- what an agent can spend; everything here is an ADDITIONAL, narrower bound
-- that an operator can change without touching the program. Losing this table
-- cannot cause overspend — it can only remove restrictions the human added on
-- top of the deposit.

-- Providers the registry knows about. The bootstrap provider from
-- AGENTPAY_UPSTREAM_URL is inserted at boot so single-provider deployments
-- behave exactly as before.
CREATE TABLE IF NOT EXISTS providers (
    provider_id     VARCHAR(64)  PRIMARY KEY,
    label           VARCHAR(128) NOT NULL,
    base_url        TEXT         NOT NULL,
    -- The key that settles sessions with this provider. Nullable because a
    -- catalogue can be read without knowing it; settlement cannot.
    provider_pubkey VARCHAR(44),
    enabled         BOOLEAN      NOT NULL DEFAULT true,
    registered_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Agent identities. The gateway previously knew agents only as Ed25519 public
-- keys appearing inside sessions; this gives them a record a human can hold.
CREATE TABLE IF NOT EXISTS agents (
    agent_id     VARCHAR(64)  PRIMARY KEY,
    label        VARCHAR(128) NOT NULL,
    -- The agent's wallet. Unique because two agent records sharing one key
    -- would make the policy applied to a claim ambiguous.
    agent_pubkey VARCHAR(44)  NOT NULL UNIQUE,
    -- The human who owns it. Informational: authority comes from the escrow,
    -- not from this column.
    owner_pubkey VARCHAR(44),
    -- 'human'      -> spends above the approval threshold need a decision
    -- 'autonomous' -> the agent acts alone inside its envelope
    mode         VARCHAR(16)  NOT NULL DEFAULT 'human'
                 CHECK (mode IN ('human', 'autonomous')),
    -- 'suspended' is the revocation the escrow cannot express: it stops an
    -- agent mid-session without settling or stopping the gateway.
    status       VARCHAR(16)  NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'suspended')),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agents_pubkey ON agents (agent_pubkey);

-- The permission envelope. Every amount is micro-USDC, mirroring the rest of
-- the schema; BIGINT for the same reason claim_tickets uses it.
CREATE TABLE IF NOT EXISTS agent_policies (
    agent_id           VARCHAR(64) PRIMARY KEY
                       REFERENCES agents(agent_id) ON DELETE CASCADE,
    -- Ceiling across everything this agent spends, independent of any single
    -- session's deposit. Narrower than the escrow, never wider.
    max_total          BIGINT      NOT NULL CHECK (max_total > 0),
    -- Ceiling on one purchase.
    max_per_call       BIGINT      NOT NULL CHECK (max_per_call > 0),
    -- Above this, a human decides. NULL means never ask.
    approval_threshold BIGINT      CHECK (approval_threshold IS NULL OR approval_threshold >= 0),
    -- NULL or empty means every resource the registry offers.
    allowed_resources  TEXT[],
    -- NULL means unlimited.
    max_calls          INTEGER     CHECK (max_calls IS NULL OR max_calls > 0),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Human-controlled mode: spends waiting for a decision.
CREATE TABLE IF NOT EXISTS approvals (
    approval_id    VARCHAR(64) PRIMARY KEY,
    agent_id       VARCHAR(64) NOT NULL
                   REFERENCES agents(agent_id) ON DELETE CASCADE,
    session_pubkey VARCHAR(44),
    resource       TEXT        NOT NULL,
    -- What one call costs, and how many were proposed.
    price          BIGINT      NOT NULL CHECK (price >= 0),
    calls          INTEGER     NOT NULL DEFAULT 1 CHECK (calls > 0),
    -- 'consumed' is set when the approved spend is actually made, so one
    -- approval cannot authorise an unbounded number of purchases.
    state          VARCHAR(16) NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending', 'approved', 'rejected', 'consumed')),
    reason         TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_approvals_pending
    ON approvals (agent_id, resource) WHERE state = 'approved';
