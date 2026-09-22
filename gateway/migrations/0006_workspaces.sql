-- Workspaces, SaaS usage metering, and subscriptions.
--
-- This migration is the foundation of the commercial layer. It is deliberately
-- and entirely ADDITIVE: every new column is nullable, no existing column
-- changes type, and no existing row is rewritten except by the explicit
-- backfill at the end.
--
-- # What a workspace is
--
-- The paying customer. One workspace is one provider company. It owns its
-- providers, its agents, and — transitively, through those agents — its
-- sessions and evidence.
--
-- # What this migration must NOT do, and does not
--
-- It does not touch `evidence_log`'s hash preimage. The entry hash is
-- SHA256(prev ‖ session ‖ cumulative_le ‖ nonce_le ‖ decision), and every
-- historical Merkle root in existence depends on those bytes and only those
-- bytes. The `resource` and `price` columns added below are SIDECAR data: read
-- by billing, never hashed, never part of a proof. A root computed before this
-- migration recomputes to the same value after it.
--
-- It does not touch claim format, high-water marks, settlement, or refunds.

-- ---------------------------------------------------------------------------
-- The tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id VARCHAR(64)  PRIMARY KEY,
    name         VARCHAR(128) NOT NULL,

    -- Plan is metadata, not enforcement. Nothing in the payment path reads it.
    -- Deliberately a free string rather than an enum: pricing tiers are a
    -- commercial hypothesis that will change several times before a customer
    -- exists, and a CHECK constraint would turn each of those changes into a
    -- migration during business hours.
    plan         VARCHAR(32)  NOT NULL DEFAULT 'starter',

    status       VARCHAR(16)  NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'suspended')),

    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- SaaS usage.
--
-- Separate from `evidence_log` on purpose, and the separation is a security
-- boundary rather than a schema preference.
--
-- Evidence is a cryptographic record whose shape is frozen by the hash
-- preimage. If billing read from it, then one day a billing requirement would
-- argue for adding a field to it — and that argument must be impossible to
-- make. Two tables means a billing need can never become a reason to change a
-- historical Merkle root.
--
-- A settlement is NOT a usage event. Seven API calls settle in one Solana
-- transaction; the customer is billed for seven, not for one.
--
-- Refusals ARE usage events. Refusing a purchase is the work the provider is
-- paying for. Metering only successful calls would charge nothing for the
-- feature that is the entire product.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_records (
    id             BIGSERIAL   PRIMARY KEY,

    -- Nullable during migration: a legacy single-tenant deployment has no
    -- workspace until it is backfilled, and metering must not start failing
    -- because of that.
    workspace_id   VARCHAR(64) REFERENCES workspaces (workspace_id),

    provider_id    VARCHAR(64),
    agent_id       VARCHAR(64),

    -- NOT a foreign key to `sessions`. Sessions cascade-delete, and a deleted
    -- session must not silently erase the record that the customer was billed
    -- for those calls. Billing history outlives operational state.
    session_pubkey VARCHAR(44),

    resource       TEXT        NOT NULL,
    price          BIGINT      NOT NULL CHECK (price >= 0),

    -- 'ALLOWED' or an ERR_* code, mirroring evidence_log.decision. Copied
    -- rather than joined so a billing query never has to touch the evidence
    -- table.
    decision       VARCHAR(32) NOT NULL,

    occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The query billing actually runs: one workspace, one period.
CREATE INDEX IF NOT EXISTS idx_usage_workspace_time
    ON usage_records (workspace_id, occurred_at DESC);

-- The query the provider dashboard runs: which resources, how often.
CREATE INDEX IF NOT EXISTS idx_usage_provider_resource
    ON usage_records (provider_id, resource, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Subscriptions.
--
-- `external_ref` is nullable and stays nullable. It holds a billing provider's
-- customer id if one is ever wired up. There is no Stripe integration and none
-- is planned until somebody is actually being charged; this column exists so
-- that adding one later is not a migration.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
    workspace_id   VARCHAR(64)  PRIMARY KEY
                   REFERENCES workspaces (workspace_id) ON DELETE CASCADE,
    plan           VARCHAR(32)  NOT NULL,

    -- Calls included before overage. 0 means unmetered, which is what every
    -- pre-revenue deployment should be.
    included_calls BIGINT       NOT NULL DEFAULT 0 CHECK (included_calls >= 0),

    period_start   TIMESTAMPTZ  NOT NULL,
    period_end     TIMESTAMPTZ  NOT NULL,
    external_ref   TEXT,
    status         VARCHAR(16)  NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'past_due', 'cancelled')),

    CONSTRAINT period_is_ordered CHECK (period_end > period_start)
);

-- ---------------------------------------------------------------------------
-- Tenant columns on the existing tables.
--
-- All nullable. NULL means "belongs to the legacy single-tenant deployment",
-- and the auth layer treats a NULL-workspace operator as an unscoped legacy
-- admin. That is what keeps every existing deployment working through this
-- change rather than locking its operator out of its own data.
-- ---------------------------------------------------------------------------
ALTER TABLE providers ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(64)
    REFERENCES workspaces (workspace_id);
ALTER TABLE agents    ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(64)
    REFERENCES workspaces (workspace_id);
ALTER TABLE operators ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(64)
    REFERENCES workspaces (workspace_id);

CREATE INDEX IF NOT EXISTS idx_providers_workspace ON providers (workspace_id);
CREATE INDEX IF NOT EXISTS idx_agents_workspace    ON agents (workspace_id);
CREATE INDEX IF NOT EXISTS idx_operators_workspace ON operators (workspace_id);

-- ---------------------------------------------------------------------------
-- Roles.
--
-- 0005 created `role` with CHECK (role IN ('operator')) and a comment saying
-- the column existed so a later role would not need a migration during an
-- incident. The column did its job; the constraint still has to be widened.
--
-- Two roles, and only two. `owner` may invite members and change the plan;
-- `member` does everything else. A full RBAC system before a paying customer
-- would be a guess with a permissions matrix attached.
--
-- 'operator' is kept as an accepted value so existing rows stay valid. It is
-- treated as equivalent to 'owner' for legacy single-tenant deployments.
-- ---------------------------------------------------------------------------
ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_role_check;
ALTER TABLE operators ADD CONSTRAINT operators_role_check
    CHECK (role IN ('operator', 'owner', 'member'));

-- ---------------------------------------------------------------------------
-- Evidence sidecars.
--
-- READ THIS BEFORE TOUCHING EITHER COLUMN.
--
-- `resource` and `price` are recorded here so a decision can be attributed to
-- an API resource for billing and for the provider dashboard. Today the
-- evidence log knows an amount and a verdict but not WHAT was bought, which
-- makes "how many calls to /weather did we serve" unanswerable.
--
-- They are NOT part of the entry hash. The preimage is and remains:
--
--     SHA256(prev_hash ‖ session ‖ cumulative_le ‖ nonce_le ‖ decision)
--
-- Adding either of these to that preimage would change every entry hash, and
-- therefore every Merkle root, and therefore invalidate every inclusion proof
-- ever published — including any a third party has already verified and kept.
-- There is no migration that fixes that. Do not do it.
--
-- Nullable because every row written before this migration has no resource,
-- and inventing one would be fabricating billing data.
-- ---------------------------------------------------------------------------
ALTER TABLE evidence_log ADD COLUMN IF NOT EXISTS resource TEXT;
ALTER TABLE evidence_log ADD COLUMN IF NOT EXISTS price    BIGINT;
