-- Evidence is append-only, enforced by the database.
--
-- # Why this is not just a REVOKE
--
-- The runtime role owns these tables, because it created them. An owner can
-- re-GRANT anything it revokes from itself, so `REVOKE UPDATE, DELETE` alone
-- documents an intention rather than enforcing one. A trigger fires regardless
-- of who the caller is and regardless of what privileges they hold, including
-- the owner and including a superuser.
--
-- Both are applied. The REVOKE makes the intention explicit and stops a
-- non-owner role from mutating; the trigger is what actually holds.
--
-- # Why the cascade mattered
--
-- `evidence_log.session_pubkey` is declared `REFERENCES sessions (...) ON
-- DELETE CASCADE`. Deleting one session row therefore deleted its entire
-- evidence chain, silently and without touching `evidence_log` directly.
--
-- `usage_records` was deliberately NOT given that foreign key, with a comment
-- saying a deleted session "must not silently erase the record that the
-- customer was billed for those calls". The billing table was protected from
-- exactly this and the cryptographic record was not. The trigger below closes
-- that: the cascade now raises instead of deleting, so a session cannot be
-- removed while it still has evidence.
--
-- Nothing in the gateway deletes sessions — `grep -rn "DELETE FROM sessions"`
-- finds nothing — so this changes no code path that exists today. It closes the
-- one that would.
--
-- # Break-glass
--
-- Genuinely removing evidence (a legal erasure request, say) means dropping
-- these triggers, doing the work, and putting them back. That requires table
-- ownership and leaves a trail in the migration history, which is the point:
-- erasure should be a deliberate, visible act rather than a side effect of a
-- cascade.
--
--   ALTER TABLE evidence_log DISABLE TRIGGER evidence_log_no_mutate;
--   ALTER TABLE evidence_log DISABLE TRIGGER evidence_log_no_truncate;

CREATE OR REPLACE FUNCTION evidence_log_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'evidence_log is append-only: % is not permitted', TG_OP
        USING ERRCODE = 'restrict_violation',
              HINT = 'Every published Merkle root depends on these rows. '
                     'See migration 0007_evidence_append_only.sql.';
END;
$$;

-- Row-level: blocks UPDATE and DELETE, including a DELETE arriving through the
-- ON DELETE CASCADE from `sessions`.
DROP TRIGGER IF EXISTS evidence_log_no_mutate ON evidence_log;
CREATE TRIGGER evidence_log_no_mutate
    BEFORE UPDATE OR DELETE ON evidence_log
    FOR EACH ROW
    EXECUTE FUNCTION evidence_log_append_only();

-- Statement-level: TRUNCATE does not fire row triggers, so it needs its own.
DROP TRIGGER IF EXISTS evidence_log_no_truncate ON evidence_log;
CREATE TRIGGER evidence_log_no_truncate
    BEFORE TRUNCATE ON evidence_log
    FOR EACH STATEMENT
    EXECUTE FUNCTION evidence_log_append_only();

-- Defence in depth, and a readable statement of intent. INSERT and SELECT are
-- untouched: the gateway only ever does those two things to this table.
REVOKE UPDATE, DELETE, TRUNCATE ON evidence_log FROM PUBLIC;
