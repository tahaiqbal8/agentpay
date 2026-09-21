-- Per-operator credentials, and the approval trail they make possible.
--
-- Before this, the control plane had ONE shared token. It could say that a
-- spend was approved; it could never say by whom. An approval queue that
-- cannot name the approver is a workflow, not an audit trail.
--
-- It also had no revocation: removing one person's access meant changing the
-- token for everybody, so in practice nobody did it.

CREATE TABLE IF NOT EXISTS operators (
    operator_id  VARCHAR(64)  PRIMARY KEY,
    label        VARCHAR(128) NOT NULL,

    -- SHA-256 hex of the token. The token itself is NEVER stored: it is shown
    -- once at creation and cannot be recovered afterwards, only replaced.
    --
    -- A plain digest rather than bcrypt/argon2 because tokens are generated
    -- here from 32 CSPRNG bytes, not chosen by a person. There is no low
    -- entropy to protect against, and a slow hash on every request would only
    -- buy latency. Caller-supplied tokens are refused for exactly this reason.
    token_hash   CHAR(64)     NOT NULL UNIQUE,

    -- Room to grow. Every operator can do everything today; the column exists
    -- so a later read-only role does not need a migration during an incident.
    role         VARCHAR(16)  NOT NULL DEFAULT 'operator'
                 CHECK (role IN ('operator')),

    -- Revocation. Disabling one operator leaves everybody else working, which
    -- is the whole point of moving off a shared secret.
    enabled      BOOLEAN      NOT NULL DEFAULT true,

    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Informational, for spotting credentials nobody uses any more.
    last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_operators_token ON operators (token_hash);

-- Who decided an approval.
--
-- Two columns rather than a foreign key, on purpose. `decided_by` joins to the
-- operator while it exists; `decided_by_label` is a SNAPSHOT taken at the
-- moment of the decision.
--
-- An audit record that changes when a row elsewhere changes is not an audit
-- record. Deleting an operator must not rewrite history into "unknown", and
-- renaming one must not rewrite who approved what last year.
ALTER TABLE approvals
    ADD COLUMN IF NOT EXISTS decided_by       VARCHAR(64),
    ADD COLUMN IF NOT EXISTS decided_by_label VARCHAR(128);
