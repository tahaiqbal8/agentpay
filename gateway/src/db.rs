//! PostgreSQL-backed session store.
//!
//! This replaces `InMemorySessionStore` and closes the hole documented there:
//! the claim high-water mark now survives a restart, so a gateway bounce is no
//! longer a security event. `load_active_sessions` rehydrates it on cold start.
//!
//! # Where the ordering rules live
//!
//! The monotonicity rules are NOT reimplemented in SQL. `admit_claim` opens a
//! transaction, takes a row lock on the session, and calls the same
//! [`evaluate_claim`] function the in-memory store uses. Duplicating those rules
//! in SQL would let the two copies drift, and the SQL copy is the one nobody
//! unit-tests. The conditional `WHERE` on the upsert is defence-in-depth, not
//! the primary check.
//!
//! # Why a row lock rather than a bare upsert
//!
//! Admitting a claim requires reading session state (settled? expired? deposit
//! ceiling?) and the current high-water mark, deciding, then writing. Those
//! reads and the write must see a consistent world, so the transaction opens
//! with `SELECT ... FOR UPDATE` on the session row. That serialises claims
//! *within* one session — which they already are logically — while leaving
//! different sessions fully concurrent.

use async_trait::async_trait;
use solana_pubkey::Pubkey;
use sqlx::postgres::{PgPoolOptions, PgRow};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::time::Duration;
use tracing::{info, warn};

use crate::claim::Claim;
use crate::evidence::{
    compute_entry_hash, Decision, EvidenceEntry, MerkleTree, GENESIS_PREV_HASH,
};
use crate::state::{
    evaluate_claim, ClaimAccepted, ClaimRejection, SessionRecord, SessionStore, SignedClaim,
    StoreError,
};

const MAX_CONNECTIONS: u32 = 20;
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("migration failed: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error("{field} value {value} does not fit in a postgres BIGINT")]
    OutOfRange { field: &'static str, value: u64 },
    #[error("{field} read back as negative ({value}), which should be impossible")]
    NegativeAmount { field: &'static str, value: i64 },
    #[error("stored pubkey {0} is not valid base58")]
    BadPubkey(String),
    #[error("stored signature is {0} bytes, expected 64")]
    BadSignature(usize),
    #[error("stored hash is {0} bytes, expected 32")]
    BadHash(usize),
}

impl From<DbError> for StoreError {
    fn from(e: DbError) -> Self {
        // Fail closed. Every database problem becomes a denial, never a pass.
        warn!(error = %e, "database error -> denying request");
        StoreError::Unavailable
    }
}

/// Postgres `BIGINT` is a signed i64; our amounts are u64. Reject rather than
/// wrap — rule 0.3, a panic or error beats a silently corrupted balance.
fn to_i64(value: u64, field: &'static str) -> Result<i64, DbError> {
    i64::try_from(value).map_err(|_| DbError::OutOfRange { field, value })
}

fn to_u64(value: i64, field: &'static str) -> Result<u64, DbError> {
    u64::try_from(value).map_err(|_| DbError::NegativeAmount { field, value })
}

fn parse_pubkey(s: &str) -> Result<Pubkey, DbError> {
    s.parse::<Pubkey>()
        .map_err(|_| DbError::BadPubkey(s.to_string()))
}

/// One session as the dashboard needs it.
#[derive(Debug, Clone)]
pub struct SessionSummary {
    pub session: Pubkey,
    pub agent: Pubkey,
    pub provider: Pubkey,
    pub mint: Pubkey,
    pub deposited_total: u64,
    pub cumulative_accepted: u64,
    pub last_nonce: Option<u64>,
    pub expires_at: i64,
    pub is_settled: bool,
    pub chain_verified: bool,
    pub evidence_count: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// One decision for the live feed.
#[derive(Debug, Clone)]
pub struct RecentDecision {
    pub session: Pubkey,
    pub sequence_id: i64,
    pub decision: String,
    pub cumulative_amount: u64,
    pub nonce: u64,
    pub entry_hash: [u8; 32],
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Clone)]
pub struct Database {
    pool: PgPool,
}

impl Database {
    /// Connects, verifies the connection, and applies pending migrations.
    pub async fn connect(database_url: &str) -> Result<Self, DbError> {
        let pool = PgPoolOptions::new()
            .max_connections(MAX_CONNECTIONS)
            .acquire_timeout(ACQUIRE_TIMEOUT)
            .connect(database_url)
            .await?;

        // Embedded at compile time from ./migrations, so deployment needs no
        // separate migration step and the binary cannot drift from its schema.
        sqlx::migrate!("./migrations").run(&pool).await?;
        info!(
            max_connections = MAX_CONNECTIONS,
            "database connected, migrations applied"
        );

        Ok(Self { pool })
    }

    /// Inserts a newly opened session.
    ///
    /// `ON CONFLICT DO NOTHING` makes this idempotent; the caller learns whether
    /// it was a genuine insert from the returned bool, so a duplicate open can
    /// be reported as `ERR_SESSION_ALREADY_OPEN` rather than silently accepted.
    pub async fn save_session(&self, record: &SessionRecord) -> Result<bool, DbError> {
        let result = sqlx::query(
            r#"
            INSERT INTO sessions (
                session_pubkey, agent_pubkey, provider_pubkey, mint_pubkey,
                deposited_total, expires_at, chain_verified
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (session_pubkey) DO NOTHING
            "#,
        )
        .bind(record.session.to_string())
        .bind(record.agent.to_string())
        .bind(record.provider.to_string())
        .bind(record.mint.to_string())
        .bind(to_i64(record.deposited_total, "deposited_total")?)
        .bind(record.expires_at)
        .bind(record.chain_verified)
        .execute(&self.pool)
        .await?;

        Ok(result.rows_affected() == 1)
    }

    /// Reads one session plus its current high-water mark.
    pub async fn load_session(&self, session: &Pubkey) -> Result<Option<SessionRecord>, DbError> {
        let row = sqlx::query(
            r#"
            SELECT s.session_pubkey, s.agent_pubkey, s.provider_pubkey, s.mint_pubkey,
                   s.deposited_total, s.expires_at, s.settled_at, s.chain_verified,
                   c.cumulative_amount, c.nonce, c.expires_at AS claim_expires_at, c.signature
            FROM sessions s
            LEFT JOIN claim_tickets c ON c.session_pubkey = s.session_pubkey
            WHERE s.session_pubkey = $1
            "#,
        )
        .bind(session.to_string())
        .fetch_optional(&self.pool)
        .await?;

        row.map(row_to_record).transpose()
    }

    /// Rehydrates every unsettled session on cold start.
    ///
    /// This is what makes a restart survivable: without it the high-water marks
    /// are gone and every live session is open to claim replay.
    pub async fn load_active_sessions(&self) -> Result<Vec<SessionRecord>, DbError> {
        let rows = sqlx::query(
            r#"
            SELECT s.session_pubkey, s.agent_pubkey, s.provider_pubkey, s.mint_pubkey,
                   s.deposited_total, s.expires_at, s.settled_at, s.chain_verified,
                   c.cumulative_amount, c.nonce, c.expires_at AS claim_expires_at, c.signature
            FROM sessions s
            LEFT JOIN claim_tickets c ON c.session_pubkey = s.session_pubkey
            WHERE s.settled_at IS NULL
            ORDER BY s.created_at
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(row_to_record).collect()
    }

    /// Marks a session settled. Called only after the chain confirms.
    ///
    /// Returns false if the session was already settled, so a double settle is
    /// visible rather than silently idempotent.
    pub async fn mark_session_settled(&self, session: &Pubkey) -> Result<bool, DbError> {
        let result = sqlx::query(
            "UPDATE sessions SET settled_at = NOW() \
             WHERE session_pubkey = $1 AND settled_at IS NULL",
        )
        .bind(session.to_string())
        .execute(&self.pool)
        .await?;

        Ok(result.rows_affected() == 1)
    }

    /// Every entry hash for a session, ordered by `sequence_id ASC`.
    ///
    /// Order is the Merkle leaf order, so this query's `ORDER BY` is part of
    /// the commitment: returning rows in any other order yields a different
    /// root.
    pub async fn load_evidence_leaves(&self, session: &Pubkey) -> Result<Vec<[u8; 32]>, DbError> {
        let rows = sqlx::query(
            "SELECT entry_hash FROM evidence_log \
             WHERE session_pubkey = $1 ORDER BY sequence_id ASC",
        )
        .bind(session.to_string())
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                let raw: Vec<u8> = row.try_get("entry_hash")?;
                let len = raw.len();
                raw.try_into().map_err(|_| DbError::BadHash(len))
            })
            .collect()
    }

    /// One row per session for the dashboard, with its evidence count.
    ///
    /// `LEFT JOIN` plus `COUNT` rather than N+1 queries: the monitor polls this
    /// on an interval, so it must stay one round trip regardless of session count.
    pub async fn list_sessions(&self, limit: i64) -> Result<Vec<SessionSummary>, DbError> {
        let rows = sqlx::query(
            r#"
            SELECT s.session_pubkey, s.agent_pubkey, s.provider_pubkey, s.mint_pubkey,
                   s.deposited_total, s.expires_at, s.settled_at, s.created_at,
                   s.chain_verified,
                   COALESCE(c.cumulative_amount, 0) AS cumulative_accepted,
                   c.nonce AS last_nonce,
                   COALESCE(e.entry_count, 0)       AS evidence_count
            FROM sessions s
            LEFT JOIN claim_tickets c ON c.session_pubkey = s.session_pubkey
            LEFT JOIN (
                SELECT session_pubkey, COUNT(*) AS entry_count
                FROM evidence_log GROUP BY session_pubkey
            ) e ON e.session_pubkey = s.session_pubkey
            ORDER BY s.created_at DESC
            LIMIT $1
            "#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                let settled_at: Option<chrono::DateTime<chrono::Utc>> = row.try_get("settled_at")?;
                let last_nonce: Option<i64> = row.try_get("last_nonce")?;
                Ok(SessionSummary {
                    session: parse_pubkey(row.try_get("session_pubkey")?)?,
                    agent: parse_pubkey(row.try_get("agent_pubkey")?)?,
                    provider: parse_pubkey(row.try_get("provider_pubkey")?)?,
                    mint: parse_pubkey(row.try_get("mint_pubkey")?)?,
                    deposited_total: to_u64(row.try_get("deposited_total")?, "deposited_total")?,
                    cumulative_accepted: to_u64(
                        row.try_get("cumulative_accepted")?,
                        "cumulative_accepted",
                    )?,
                    last_nonce: last_nonce.map(|n| n.max(0) as u64),
                    expires_at: row.try_get("expires_at")?,
                    is_settled: settled_at.is_some(),
                    chain_verified: row.try_get("chain_verified").unwrap_or(false),
                    evidence_count: row.try_get("evidence_count")?,
                    created_at: row.try_get("created_at")?,
                })
            })
            .collect()
    }

    /// Most recent decisions across every session, for the live feed.
    pub async fn recent_decisions(&self, limit: i64) -> Result<Vec<RecentDecision>, DbError> {
        let rows = sqlx::query(
            r#"
            SELECT session_pubkey, sequence_id, decision, cumulative_amount,
                   nonce, entry_hash, created_at
            FROM evidence_log
            ORDER BY created_at DESC, id DESC
            LIMIT $1
            "#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                let raw: Vec<u8> = row.try_get("entry_hash")?;
                let len = raw.len();
                Ok(RecentDecision {
                    session: parse_pubkey(row.try_get("session_pubkey")?)?,
                    sequence_id: row.try_get("sequence_id")?,
                    decision: row.try_get("decision")?,
                    cumulative_amount: to_u64(
                        row.try_get("cumulative_amount")?,
                        "cumulative_amount",
                    )?,
                    nonce: to_u64(row.try_get("nonce")?, "nonce")?,
                    entry_hash: raw.try_into().map_err(|_| DbError::BadHash(len))?,
                    created_at: row.try_get("created_at")?,
                })
            })
            .collect()
    }

    /// The full chain, for verification and for the proof endpoint.
    pub async fn load_evidence_chain(
        &self,
        session: &Pubkey,
    ) -> Result<Vec<EvidenceEntry>, DbError> {
        let rows = sqlx::query(
            "SELECT sequence_id, cumulative_amount, nonce, decision, prev_hash, entry_hash \
             FROM evidence_log WHERE session_pubkey = $1 ORDER BY sequence_id ASC",
        )
        .bind(session.to_string())
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                let prev_raw: Vec<u8> = row.try_get("prev_hash")?;
                let prev_len = prev_raw.len();
                let entry_raw: Vec<u8> = row.try_get("entry_hash")?;
                let entry_len = entry_raw.len();
                Ok(EvidenceEntry {
                    sequence_id: row.try_get("sequence_id")?,
                    cumulative_amount: to_u64(
                        row.try_get("cumulative_amount")?,
                        "cumulative_amount",
                    )?,
                    nonce: to_u64(row.try_get("nonce")?, "nonce")?,
                    decision: row.try_get("decision")?,
                    prev_hash: prev_raw.try_into().map_err(|_| DbError::BadHash(prev_len))?,
                    entry_hash: entry_raw
                        .try_into()
                        .map_err(|_| DbError::BadHash(entry_len))?,
                })
            })
            .collect()
    }

    /// The 32-byte Merkle root over a session's evidence.
    ///
    /// All zeroes when the session has no evidence, which honestly means
    /// "nothing recorded" rather than pretending a commitment exists.
    pub async fn get_session_merkle_root(&self, session: &Pubkey) -> Result<[u8; 32], DbError> {
        let leaves = self.load_evidence_leaves(session).await?;
        Ok(MerkleTree::new(leaves).root())
    }

    /// Validates ordering and advances the high-water mark, atomically.
    ///
    /// The whole read-decide-write cycle runs inside one transaction holding a
    /// row lock on the session, so two concurrent requests carrying the same
    /// claim cannot both be admitted.
    pub async fn upsert_claim_high_water_mark(
        &self,
        claim: &Claim,
        signature: &[u8; 64],
        now: i64,
    ) -> Result<Result<ClaimAccepted, ClaimRejection>, DbError> {
        let mut tx: Transaction<'_, Postgres> = self.pool.begin().await?;
        let session_key = claim.session.to_string();

        // FOR UPDATE: the serialisation point. Everything below sees a world
        // no other claim for this session can change until we commit.
        let Some(session_row) = sqlx::query(
            r#"
            SELECT agent_pubkey, provider_pubkey, mint_pubkey,
                   deposited_total, expires_at, settled_at, chain_verified
            FROM sessions
            WHERE session_pubkey = $1
            FOR UPDATE
            "#,
        )
        .bind(&session_key)
        .fetch_optional(&mut *tx)
        .await?
        else {
            tx.rollback().await?;
            return Err(DbError::Sqlx(sqlx::Error::RowNotFound));
        };

        let settled_at: Option<chrono::DateTime<chrono::Utc>> = session_row.try_get("settled_at")?;
        let deposited_total = to_u64(session_row.try_get("deposited_total")?, "deposited_total")?;
        let expires_at: i64 = session_row.try_get("expires_at")?;

        let current = sqlx::query(
            "SELECT cumulative_amount, nonce FROM claim_tickets WHERE session_pubkey = $1",
        )
        .bind(&session_key)
        .fetch_optional(&mut *tx)
        .await?;

        let (cumulative_accepted, last_nonce) = match &current {
            Some(r) => (
                to_u64(r.try_get("cumulative_amount")?, "cumulative_amount")?,
                Some(to_u64(r.try_get("nonce")?, "nonce")?),
            ),
            None => (0, None),
        };

        // Rebuilt so the shared rule function can judge it. Only the fields
        // `evaluate_claim` reads need to be accurate.
        let record = SessionRecord {
            session: claim.session,
            agent: parse_pubkey(session_row.try_get("agent_pubkey")?)?,
            provider: parse_pubkey(session_row.try_get("provider_pubkey")?)?,
            mint: parse_pubkey(session_row.try_get("mint_pubkey")?)?,
            deposited_total,
            expires_at,
            cumulative_accepted,
            last_nonce,
            highest_claim: None,
            is_settled: settled_at.is_some(),
            chain_verified: session_row.try_get("chain_verified").unwrap_or(false),
        };

        let outcome = evaluate_claim(&record, claim, now);

        // Map the outcome to a recordable decision.
        //
        // `SessionSettled` is deliberately absent: the Merkle root over this
        // log is committed on-chain at settlement, so appending afterwards
        // would change a root that is already published and make the
        // commitment unverifiable. Post-settlement attempts are refused and
        // logged to the application log only.
        let decision = match &outcome {
            Ok(_) => Some(Decision::Allowed),
            Err(ClaimRejection::NotMonotonic) => Some(Decision::NotMonotonic),
            Err(ClaimRejection::NonceNotMonotonic) => Some(Decision::NonceNotMonotonic),
            Err(ClaimRejection::ExceedsDeposit) => Some(Decision::ExceedsDeposit),
            Err(ClaimRejection::SessionExpired) => Some(Decision::SessionExpired),
            Err(ClaimRejection::SessionSettled) => None,
        };

        // Denials are first-class evidence. A CFO's question is "was the agent
        // ever stopped?", and a log that only records successes cannot answer
        // it, so this runs before the early return below.
        if let Some(decision) = decision {
            append_evidence(&mut tx, claim, decision, signature).await?;
        }

        let accepted = match outcome {
            Ok(accepted) => accepted,
            Err(rejection) => {
                // The evidence entry must survive even though the claim did
                // not, so this commits rather than rolls back.
                tx.commit().await?;
                return Ok(Err(rejection));
            }
        };

        // The conditional WHERE duplicates what evaluate_claim just decided.
        // That is deliberate: if the row lock above were ever weakened or
        // removed, this still refuses to move the mark backwards.
        let written = sqlx::query(
            r#"
            INSERT INTO claim_tickets (
                session_pubkey, cumulative_amount, nonce, expires_at, signature
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (session_pubkey) DO UPDATE
            SET cumulative_amount = EXCLUDED.cumulative_amount,
                nonce             = EXCLUDED.nonce,
                expires_at        = EXCLUDED.expires_at,
                signature         = EXCLUDED.signature,
                received_at       = NOW()
            WHERE EXCLUDED.cumulative_amount > claim_tickets.cumulative_amount
              AND EXCLUDED.nonce             > claim_tickets.nonce
            "#,
        )
        .bind(&session_key)
        .bind(to_i64(accepted.cumulative_amount, "cumulative_amount")?)
        .bind(to_i64(accepted.nonce, "nonce")?)
        .bind(claim.expires_at)
        .bind(&signature[..])
        .execute(&mut *tx)
        .await?;

        if written.rows_affected() != 1 {
            // Unreachable while the row lock holds. If it ever fires, the lock
            // is not doing its job and the safe answer is to refuse.
            warn!(
                session = %claim.session,
                "conditional upsert wrote no row despite passing evaluation; refusing"
            );
            tx.rollback().await?;
            return Ok(Err(ClaimRejection::NotMonotonic));
        }

        tx.commit().await?;
        Ok(Ok(accepted))
    }
}

/// Appends one entry to a session's chain, inside the caller's transaction.
///
/// The caller MUST already hold the session row lock. That lock is what makes
/// "read the latest sequence, add one, insert" safe; without it two writers
/// could compute the same sequence number and one would lose to the unique
/// constraint. The constraint is the backstop, not the mechanism.
async fn append_evidence(
    tx: &mut Transaction<'_, Postgres>,
    claim: &Claim,
    decision: Decision,
    signature: &[u8; 64],
) -> Result<(), DbError> {
    let session_key = claim.session.to_string();

    let last = sqlx::query(
        "SELECT sequence_id, entry_hash FROM evidence_log \
         WHERE session_pubkey = $1 ORDER BY sequence_id DESC LIMIT 1",
    )
    .bind(&session_key)
    .fetch_optional(&mut **tx)
    .await?;

    let (sequence_id, prev_hash) = match last {
        Some(row) => {
            let seq: i64 = row.try_get("sequence_id")?;
            let raw: Vec<u8> = row.try_get("entry_hash")?;
            let len = raw.len();
            let prev: [u8; 32] = raw.try_into().map_err(|_| DbError::BadHash(len))?;
            (
                seq.checked_add(1).ok_or(DbError::OutOfRange {
                    field: "sequence_id",
                    value: u64::MAX,
                })?,
                prev,
            )
        }
        None => (0, GENESIS_PREV_HASH),
    };

    // A refused claim may carry any value the agent signed, including one past
    // i64::MAX that a BIGINT cannot hold. The hash MUST cover exactly what the
    // column stores, or re-verifying the chain from the database would report
    // tampering that never happened. So clamp once, then both hash and store
    // the clamped value.
    //
    // Cost of the clamp: two absurd claims (u64::MAX and i64::MAX) collapse to
    // one entry. Both are refused as ExceedsDeposit, which the decision column
    // records, so nothing an auditor needs is lost.
    let stored_cumulative = claim.cumulative_amount.min(i64::MAX as u64);
    let stored_nonce = claim.nonce.min(i64::MAX as u64);

    let entry_hash = compute_entry_hash(
        &prev_hash,
        &claim.session,
        stored_cumulative,
        stored_nonce,
        decision.as_str(),
    );

    sqlx::query(
        r#"
        INSERT INTO evidence_log (
            session_pubkey, sequence_id, cumulative_amount, nonce,
            decision, prev_hash, entry_hash, signature
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        "#,
    )
    .bind(&session_key)
    .bind(sequence_id)
    .bind(stored_cumulative as i64)
    .bind(stored_nonce as i64)
    .bind(decision.as_str())
    .bind(&prev_hash[..])
    .bind(&entry_hash[..])
    .bind(&signature[..])
    .execute(&mut **tx)
    .await?;

    Ok(())
}

fn row_to_record(row: PgRow) -> Result<SessionRecord, DbError> {
    let session = parse_pubkey(row.try_get("session_pubkey")?)?;
    let settled_at: Option<chrono::DateTime<chrono::Utc>> = row.try_get("settled_at")?;

    // LEFT JOIN: a session with no claims yet has NULL on every claim column.
    let cumulative: Option<i64> = row.try_get("cumulative_amount")?;
    let (cumulative_accepted, last_nonce, highest_claim) = match cumulative {
        Some(cumulative) => {
            let cumulative_amount = to_u64(cumulative, "cumulative_amount")?;
            let nonce = to_u64(row.try_get("nonce")?, "nonce")?;
            let claim_expires_at: i64 = row.try_get("claim_expires_at")?;
            let sig_bytes: Vec<u8> = row.try_get("signature")?;
            let len = sig_bytes.len();
            let signature: [u8; 64] = sig_bytes
                .try_into()
                .map_err(|_| DbError::BadSignature(len))?;

            (
                cumulative_amount,
                Some(nonce),
                Some(SignedClaim {
                    claim: Claim {
                        session,
                        cumulative_amount,
                        nonce,
                        expires_at: claim_expires_at,
                    },
                    signature,
                }),
            )
        }
        None => (0, None, None),
    };

    Ok(SessionRecord {
        session,
        agent: parse_pubkey(row.try_get("agent_pubkey")?)?,
        provider: parse_pubkey(row.try_get("provider_pubkey")?)?,
        mint: parse_pubkey(row.try_get("mint_pubkey")?)?,
        deposited_total: to_u64(row.try_get("deposited_total")?, "deposited_total")?,
        expires_at: row.try_get("expires_at")?,
        cumulative_accepted,
        last_nonce,
        highest_claim,
        is_settled: settled_at.is_some(),
        chain_verified: row.try_get("chain_verified").unwrap_or(false),
    })
}

#[async_trait]
impl SessionStore for Database {
    async fn open(&self, record: SessionRecord) -> Result<(), StoreError> {
        let inserted = self.save_session(&record).await?;
        if inserted {
            Ok(())
        } else {
            Err(StoreError::AlreadyOpen)
        }
    }

    async fn get(&self, session: &Pubkey) -> Result<SessionRecord, StoreError> {
        self.load_session(session).await?.ok_or(StoreError::Unknown)
    }

    async fn admit_claim(
        &self,
        claim: &Claim,
        signature: &[u8; 64],
        now: i64,
    ) -> Result<Result<ClaimAccepted, ClaimRejection>, StoreError> {
        match self
            .upsert_claim_high_water_mark(claim, signature, now)
            .await
        {
            Ok(outcome) => Ok(outcome),
            Err(DbError::Sqlx(sqlx::Error::RowNotFound)) => Err(StoreError::Unknown),
            Err(e) => Err(e.into()),
        }
    }

    async fn mark_settled(&self, session: &Pubkey) -> Result<(), StoreError> {
        // False means it was already settled, which is not an error here: the
        // caller only reaches this after the chain confirmed a transfer.
        self.mark_session_settled(session).await?;
        Ok(())
    }

    async fn mark_chain_verified(&self, session: &Pubkey) -> Result<(), StoreError> {
        // Never clears the flag: the column only travels false -> true, so a
        // transient RPC failure can't un-verify a session that was checked.
        let done = sqlx::query(
            "UPDATE sessions SET chain_verified = true WHERE session_pubkey = $1",
        )
        .bind(session.to_string())
        .execute(&self.pool)
        .await
        .map_err(DbError::from)?;

        // No row means no such session. Reporting success here would tell the
        // console a session is settleable when the gateway has never heard of
        // it, so this matches the in-memory store and refuses.
        if done.rows_affected() == 0 {
            return Err(StoreError::Unknown);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn u64_to_i64_rejects_values_that_would_wrap() {
        assert_eq!(to_i64(0, "x").unwrap(), 0);
        assert_eq!(to_i64(5_000_000, "x").unwrap(), 5_000_000);
        assert_eq!(to_i64(i64::MAX as u64, "x").unwrap(), i64::MAX);

        // The case that matters: silently storing this as a negative BIGINT
        // would corrupt a balance.
        let err = to_i64(i64::MAX as u64 + 1, "deposited_total").unwrap_err();
        assert!(matches!(err, DbError::OutOfRange { .. }));
        assert!(to_i64(u64::MAX, "x").is_err());
    }

    #[test]
    fn i64_to_u64_rejects_negatives() {
        assert_eq!(to_u64(42, "x").unwrap(), 42);
        let err = to_u64(-1, "cumulative_amount").unwrap_err();
        assert!(matches!(err, DbError::NegativeAmount { .. }));
    }

    #[test]
    fn database_errors_fail_closed() {
        // Any DbError must become Unavailable, which the route layer turns into
        // a denial. Nothing here may produce a pass.
        let cases = [
            DbError::OutOfRange { field: "x", value: 1 },
            DbError::NegativeAmount { field: "x", value: -1 },
            DbError::BadPubkey("nope".into()),
            DbError::BadSignature(10),
            DbError::Sqlx(sqlx::Error::PoolTimedOut),
        ];
        for case in cases {
            assert!(matches!(StoreError::from(case), StoreError::Unavailable));
        }
    }

    #[test]
    fn bad_pubkey_is_rejected() {
        assert!(parse_pubkey("not-base58!!").is_err());
        assert!(parse_pubkey("11111111111111111111111111111111").is_ok());
    }
}

/// Integration tests against a real PostgreSQL instance.
///
/// These WRITE rows and do not roll them back, so they need a database of
/// their own. They read `TEST_DATABASE_URL`, deliberately not `DATABASE_URL`:
/// that variable names the database a running gateway is serving from, and
/// pointing the suite at it fills the operator console with sessions that look
/// real. It happened — 70 test rows showed up as 263 USDC of escrow that never
/// existed. A separate variable makes the mistake impossible to make by
/// accident.
///
/// ```text
/// docker exec agentpay-postgres-1 createdb -U agentpay agentpay_test
/// TEST_DATABASE_URL=postgres://agentpay:agentpay@127.0.0.1:5434/agentpay_test \
///   cargo test -- --ignored
/// ```
#[cfg(test)]
mod pg_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    const NOW: i64 = 1_000_000;

    /// Genuinely random, NOT `Pubkey::new_unique()`.
    ///
    /// `new_unique` increments a process-static counter, so it yields the same
    /// sequence on every `cargo test` invocation. Against a persistent database
    /// that means each run collides with the previous run's rows — which made
    /// an earlier version of the concurrency test below pass spuriously.
    fn random_pubkey() -> Pubkey {
        let mut bytes = [0u8; 32];
        bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        Pubkey::new_from_array(bytes)
    }

    async fn connect_db() -> Database {
        let url = std::env::var("TEST_DATABASE_URL")
            .expect("TEST_DATABASE_URL must be set for pg_tests (NOT DATABASE_URL)");

        // Second line of defence, in case someone copies the gateway's URL into
        // the test variable. A database whose name gives no hint that it is
        // disposable is treated as one that is not.
        let name = url.rsplit('/').next().unwrap_or("");
        let name = name.split('?').next().unwrap_or("");
        assert!(
            name.contains("test"),
            "refusing to run write tests against database {name:?}: \
             the name must contain \"test\", because these tests leave rows behind"
        );

        Database::connect(&url).await.expect("connects")
    }

    fn record(deposit: u64) -> SessionRecord {
        SessionRecord::new(
            random_pubkey(),
            random_pubkey(),
            random_pubkey(),
            random_pubkey(),
            deposit,
            NOW + 3600,
        )
    }

    fn claim_for(session: Pubkey, cumulative: u64, nonce: u64) -> Claim {
        Claim {
            session,
            cumulative_amount: cumulative,
            nonce,
            expires_at: NOW + 600,
        }
    }

    fn sig(byte: u8) -> [u8; 64] {
        [byte; 64]
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn session_roundtrips_and_duplicate_open_is_refused() {
        let db = connect_db().await;
        let rec = record(5_000_000);

        assert!(db.save_session(&rec).await.unwrap(), "first insert");
        assert!(
            !db.save_session(&rec).await.unwrap(),
            "ON CONFLICT DO NOTHING must report no insert"
        );

        let loaded = db.load_session(&rec.session).await.unwrap().expect("present");
        assert_eq!(loaded.agent, rec.agent);
        assert_eq!(loaded.provider, rec.provider);
        assert_eq!(loaded.mint, rec.mint);
        assert_eq!(loaded.deposited_total, 5_000_000);
        assert_eq!(loaded.expires_at, rec.expires_at);
        assert_eq!(loaded.cumulative_accepted, 0);
        assert_eq!(loaded.last_nonce, None);
        assert!(loaded.highest_claim.is_none());
        assert!(!loaded.is_settled);
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn reconciling_persists_and_refuses_unknown_sessions() {
        let db = connect_db().await;
        let rec = record(5_000_000);
        assert!(db.save_session(&rec).await.unwrap());
        assert!(
            !db.load_session(&rec.session).await.unwrap().unwrap().chain_verified,
            "a session starts unverified"
        );

        db.mark_chain_verified(&rec.session).await.unwrap();

        // Read back through load_session, not the UPDATE's own report: the
        // first version of this named a column that does not exist, and only
        // a round trip through the real schema catches that.
        let loaded = db.load_session(&rec.session).await.unwrap().unwrap();
        assert!(loaded.chain_verified);
        assert_eq!(loaded.deposited_total, 5_000_000, "reconciling moved the money");
        assert_eq!(loaded.cumulative_accepted, 0);
        assert!(!loaded.is_settled);

        // A session the gateway has never seen must not come back verified;
        // saying otherwise would offer the console a settlement that cannot exist.
        let err = db.mark_chain_verified(&random_pubkey()).await.unwrap_err();
        assert!(matches!(err, StoreError::Unknown));
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn unknown_session_is_none() {
        let db = connect_db().await;
        assert!(db.load_session(&random_pubkey()).await.unwrap().is_none());
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn ladder_advances_and_reports_deltas() {
        let db = connect_db().await;
        let rec = record(5_000_000);
        db.save_session(&rec).await.unwrap();

        for (i, (cum, expected_delta)) in
            [(100u64, 100u64), (250, 150), (251, 1)].into_iter().enumerate()
        {
            let accepted = db
                .upsert_claim_high_water_mark(
                    &claim_for(rec.session, cum, i as u64 + 1),
                    &sig(i as u8),
                    NOW,
                )
                .await
                .unwrap()
                .expect("accepted");
            assert_eq!(accepted.delta, expected_delta);
        }

        let loaded = db.load_session(&rec.session).await.unwrap().unwrap();
        assert_eq!(loaded.cumulative_accepted, 251);
        assert_eq!(loaded.last_nonce, Some(3));
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn replay_regression_and_nonce_reuse_are_refused() {
        let db = connect_db().await;
        let rec = record(5_000_000);
        db.save_session(&rec).await.unwrap();
        db.upsert_claim_high_water_mark(&claim_for(rec.session, 500, 5), &sig(1), NOW)
            .await
            .unwrap()
            .unwrap();

        // Exact replay.
        assert_eq!(
            db.upsert_claim_high_water_mark(&claim_for(rec.session, 500, 6), &sig(2), NOW)
                .await
                .unwrap(),
            Err(ClaimRejection::NotMonotonic)
        );
        // Regression.
        assert_eq!(
            db.upsert_claim_high_water_mark(&claim_for(rec.session, 499, 6), &sig(2), NOW)
                .await
                .unwrap(),
            Err(ClaimRejection::NotMonotonic)
        );
        // Cumulative rises but nonce does not.
        assert_eq!(
            db.upsert_claim_high_water_mark(&claim_for(rec.session, 600, 5), &sig(2), NOW)
                .await
                .unwrap(),
            Err(ClaimRejection::NonceNotMonotonic)
        );

        // None of the refusals moved the mark.
        let loaded = db.load_session(&rec.session).await.unwrap().unwrap();
        assert_eq!(loaded.cumulative_accepted, 500);
        assert_eq!(loaded.last_nonce, Some(5));
        assert_eq!(loaded.highest_claim.unwrap().signature, sig(1));
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn claim_above_deposit_is_refused() {
        let db = connect_db().await;
        let rec = record(1_000);
        db.save_session(&rec).await.unwrap();
        assert_eq!(
            db.upsert_claim_high_water_mark(&claim_for(rec.session, 1_001, 1), &sig(1), NOW)
                .await
                .unwrap(),
            Err(ClaimRejection::ExceedsDeposit)
        );
        assert!(db
            .upsert_claim_high_water_mark(&claim_for(rec.session, 1_000, 1), &sig(1), NOW)
            .await
            .unwrap()
            .is_ok());
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn expired_session_refuses_claims() {
        let db = connect_db().await;
        let rec = record(5_000_000);
        db.save_session(&rec).await.unwrap();
        let past = rec.expires_at + crate::claim::CLOCK_SKEW_TOLERANCE_SECS + 1;
        assert_eq!(
            db.upsert_claim_high_water_mark(&claim_for(rec.session, 100, 1), &sig(1), past)
                .await
                .unwrap(),
            Err(ClaimRejection::SessionExpired)
        );
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn settled_session_refuses_claims_and_double_settle_is_visible() {
        let db = connect_db().await;
        let rec = record(5_000_000);
        db.save_session(&rec).await.unwrap();
        db.upsert_claim_high_water_mark(&claim_for(rec.session, 100, 1), &sig(1), NOW)
            .await
            .unwrap()
            .unwrap();

        assert!(db.mark_session_settled(&rec.session).await.unwrap());
        assert!(
            !db.mark_session_settled(&rec.session).await.unwrap(),
            "second settle must report that nothing changed"
        );

        assert_eq!(
            db.upsert_claim_high_water_mark(&claim_for(rec.session, 200, 2), &sig(2), NOW)
                .await
                .unwrap(),
            Err(ClaimRejection::SessionSettled)
        );
    }

    /// The reason the durable store exists.
    ///
    /// A fresh `Database` handle stands in for a restarted process: it shares no
    /// memory with the one that admitted the claims.
    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn high_water_mark_and_signature_survive_a_restart() {
        let db = connect_db().await;
        let rec = record(5_000_000);
        db.save_session(&rec).await.unwrap();
        db.upsert_claim_high_water_mark(&claim_for(rec.session, 1_234_567, 9), &sig(0xAB), NOW)
            .await
            .unwrap()
            .unwrap();
        drop(db);

        let reborn = connect_db().await;
        let active = reborn.load_active_sessions().await.unwrap();
        let restored = active
            .iter()
            .find(|s| s.session == rec.session)
            .expect("unsettled session must be rehydrated");

        assert_eq!(restored.cumulative_accepted, 1_234_567);
        assert_eq!(restored.last_nonce, Some(9));

        // Settlement replays these exact bytes; a lost signature cannot be
        // reconstructed, so this is the field that matters most.
        let highest = restored.highest_claim.expect("claim restored");
        assert_eq!(highest.signature, sig(0xAB));
        assert_eq!(highest.claim.cumulative_amount, 1_234_567);
        assert_eq!(highest.claim.nonce, 9);

        // And the restored mark actually blocks a replay.
        assert_eq!(
            reborn
                .upsert_claim_high_water_mark(
                    &claim_for(rec.session, 1_234_567, 10),
                    &sig(1),
                    NOW
                )
                .await
                .unwrap(),
            Err(ClaimRejection::NotMonotonic)
        );
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn settled_sessions_are_excluded_from_hydration() {
        let db = connect_db().await;
        let rec = record(5_000_000);
        db.save_session(&rec).await.unwrap();
        db.mark_session_settled(&rec.session).await.unwrap();

        let active = db.load_active_sessions().await.unwrap();
        assert!(
            !active.iter().any(|s| s.session == rec.session),
            "settled sessions must not be rehydrated"
        );
    }

    /// The concurrency guarantee, through a real database.
    ///
    /// The in-memory store gets this from holding a write lock across
    /// read-decide-write. Here it comes from `SELECT ... FOR UPDATE` inside the
    /// transaction. If it were wrong, an agent could fire N identical claims in
    /// parallel and have several admitted — N resources for one payment.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    #[ignore = "requires DATABASE_URL"]
    async fn concurrent_duplicate_claims_admit_exactly_one() {
        let db = Arc::new(connect_db().await);
        let rec = record(5_000_000);
        db.save_session(&rec).await.unwrap();

        let admitted = Arc::new(AtomicUsize::new(0));
        let rejected = Arc::new(AtomicUsize::new(0));
        let errored = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();

        for _ in 0..16 {
            let db = Arc::clone(&db);
            let (admitted, rejected, errored) = (
                Arc::clone(&admitted),
                Arc::clone(&rejected),
                Arc::clone(&errored),
            );
            let session = rec.session;
            handles.push(tokio::spawn(async move {
                // Outcomes are counted separately. Collapsing "rejected" and
                // "errored" into "not admitted" is what let a broken version of
                // this test report success.
                match db
                    .upsert_claim_high_water_mark(&claim_for(session, 1_000, 1), &sig(1), NOW)
                    .await
                {
                    Ok(Ok(_)) => admitted.fetch_add(1, Ordering::SeqCst),
                    Ok(Err(_)) => rejected.fetch_add(1, Ordering::SeqCst),
                    Err(e) => {
                        eprintln!("unexpected db error: {e}");
                        errored.fetch_add(1, Ordering::SeqCst)
                    }
                };
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        let (a, r, e) = (
            admitted.load(Ordering::SeqCst),
            rejected.load(Ordering::SeqCst),
            errored.load(Ordering::SeqCst),
        );

        assert_eq!(e, 0, "no request should error; got {e}");
        assert_eq!(a, 1, "expected exactly one admission, got {a} (rejected {r})");
        assert_eq!(r, 15, "the other 15 must be refused, not lost; got {r}");

        let loaded = db.load_session(&rec.session).await.unwrap().unwrap();
        assert_eq!(loaded.cumulative_accepted, 1_000);
    }

    /// Different sessions must not block each other; only same-session claims
    /// serialise.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    #[ignore = "requires DATABASE_URL"]
    async fn concurrent_distinct_sessions_all_succeed() {
        let db = Arc::new(connect_db().await);
        let mut sessions = Vec::new();
        for _ in 0..8 {
            let rec = record(5_000_000);
            db.save_session(&rec).await.unwrap();
            sessions.push(rec.session);
        }

        let mut handles = Vec::new();
        for session in sessions.clone() {
            let db = Arc::clone(&db);
            handles.push(tokio::spawn(async move {
                db.upsert_claim_high_water_mark(&claim_for(session, 777, 1), &sig(1), NOW)
                    .await
                    .unwrap()
                    .is_ok()
            }));
        }

        let mut ok = 0;
        for h in handles {
            if h.await.unwrap() {
                ok += 1;
            }
        }
        assert_eq!(ok, 8, "claims on distinct sessions must not contend");
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn claim_for_unknown_session_is_reported_as_unknown() {
        let db = connect_db().await;
        let err = db
            .upsert_claim_high_water_mark(&claim_for(random_pubkey(), 100, 1), &sig(1), NOW)
            .await;
        assert!(matches!(err, Err(DbError::Sqlx(sqlx::Error::RowNotFound))));

        // And through the trait it surfaces as Unknown, not Unavailable, so the
        // caller gets 404 rather than a misleading 503.
        let store: &dyn SessionStore = &db;
        let via_trait = store
            .admit_claim(&claim_for(random_pubkey(), 100, 1), &sig(1), NOW)
            .await;
        assert!(matches!(via_trait, Err(StoreError::Unknown)));
    }

    /// The spec's core requirement: every claim attempt, allowed or refused,
    /// appends exactly one entry and advances sequence_id by one.
    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn every_authenticated_attempt_appends_one_entry() {
        use crate::evidence::{verify_chain, Decision};

        let db = connect_db().await;
        let rec = record(1_000_000);
        db.save_session(&rec).await.unwrap();

        // A deliberate mix: allowed, replay, regression, nonce reuse, over-cap.
        let attempts: Vec<(u64, u64, &str)> = vec![
            (100, 1, "ALLOWED"),
            (250, 2, "ALLOWED"),
            (250, 3, "ERR_CLAIM_NOT_MONOTONIC"),
            (100, 4, "ERR_CLAIM_NOT_MONOTONIC"),
            (500, 2, "ERR_NONCE_NOT_MONOTONIC"),
            (9_999_999, 9, "ERR_CLAIM_EXCEEDS_DEPOSIT"),
            (500, 5, "ALLOWED"),
        ];
        for (cum, nonce, _) in &attempts {
            let _ = db
                .upsert_claim_high_water_mark(&claim_for(rec.session, *cum, *nonce), &sig(7), NOW)
                .await
                .unwrap();
        }

        let chain = db.load_evidence_chain(&rec.session).await.unwrap();
        assert_eq!(
            chain.len(),
            attempts.len(),
            "every attempt must appear, denials included"
        );

        for (i, (expected, entry)) in attempts.iter().zip(chain.iter()).enumerate() {
            assert_eq!(entry.sequence_id, i as i64, "sequence must be contiguous");
            assert_eq!(entry.cumulative_amount, expected.0);
            assert_eq!(entry.nonce, expected.1);
            assert_eq!(entry.decision, expected.2, "decision at seq {i}");
        }

        // Four of the seven were refused. A log recording only successes could
        // not answer "was this agent ever stopped?".
        let denials = chain.iter().filter(|e| e.decision != "ALLOWED").count();
        assert_eq!(denials, 4);
        assert!(Decision::parse(&chain[0].decision).unwrap().is_allowed());

        assert_eq!(chain[0].prev_hash, GENESIS_PREV_HASH);
        assert_eq!(verify_chain(&rec.session, &chain), Ok(()));
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn merkle_root_is_deterministic_and_grows_with_the_log() {
        use crate::evidence::{verify_proof, MerkleTree};

        let db = connect_db().await;
        let rec = record(1_000_000);
        db.save_session(&rec).await.unwrap();

        assert_eq!(
            db.get_session_merkle_root(&rec.session).await.unwrap(),
            crate::evidence::EMPTY_ROOT,
            "a session with no evidence commits all zeroes"
        );

        let mut roots = Vec::new();
        for (cum, nonce) in [(100u64, 1u64), (200, 2), (200, 3), (300, 4), (400, 5)] {
            let _ = db
                .upsert_claim_high_water_mark(&claim_for(rec.session, cum, nonce), &sig(3), NOW)
                .await
                .unwrap();
            let root = db.get_session_merkle_root(&rec.session).await.unwrap();
            assert!(!roots.contains(&root), "each new entry must change the root");
            roots.push(root);
        }

        // Deterministic: recomputing from the same log yields the same root.
        let again = db.get_session_merkle_root(&rec.session).await.unwrap();
        assert_eq!(again, *roots.last().unwrap());

        // And every entry, including the refused one at index 2, proves against it.
        let chain = db.load_evidence_chain(&rec.session).await.unwrap();
        let tree = MerkleTree::new(chain.iter().map(|e| e.entry_hash).collect());
        assert_eq!(tree.root(), again);
        assert_eq!(chain[2].decision, "ERR_CLAIM_NOT_MONOTONIC");
        for (i, entry) in chain.iter().enumerate() {
            let proof = tree.proof(i).expect("proof");
            assert!(
                verify_proof(&entry.entry_hash, &proof, &again),
                "entry {i} did not prove against the root"
            );
        }
    }

    /// Appending after settlement would change a root that is already committed
    /// on-chain, making the commitment unverifiable.
    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn settled_sessions_stop_accruing_evidence() {
        let db = connect_db().await;
        let rec = record(1_000_000);
        db.save_session(&rec).await.unwrap();
        db.upsert_claim_high_water_mark(&claim_for(rec.session, 100, 1), &sig(1), NOW)
            .await
            .unwrap()
            .unwrap();

        let root_at_settlement = db.get_session_merkle_root(&rec.session).await.unwrap();
        let count_at_settlement = db.load_evidence_chain(&rec.session).await.unwrap().len();
        db.mark_session_settled(&rec.session).await.unwrap();

        // A late claim is refused...
        assert_eq!(
            db.upsert_claim_high_water_mark(&claim_for(rec.session, 900, 2), &sig(2), NOW)
                .await
                .unwrap(),
            Err(ClaimRejection::SessionSettled)
        );

        // ...and leaves the committed root untouched.
        assert_eq!(
            db.load_evidence_chain(&rec.session).await.unwrap().len(),
            count_at_settlement
        );
        assert_eq!(
            db.get_session_merkle_root(&rec.session).await.unwrap(),
            root_at_settlement,
            "the root committed on-chain must not move after settlement"
        );
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn evidence_is_isolated_per_session() {
        let a = record(1_000_000);
        let b = record(1_000_000);
        let db = connect_db().await;
        db.save_session(&a).await.unwrap();
        db.save_session(&b).await.unwrap();

        db.upsert_claim_high_water_mark(&claim_for(a.session, 100, 1), &sig(1), NOW)
            .await
            .unwrap()
            .unwrap();

        // Identical claim values on a different session must still produce a
        // different entry hash, because the session is in the preimage.
        db.upsert_claim_high_water_mark(&claim_for(b.session, 100, 1), &sig(1), NOW)
            .await
            .unwrap()
            .unwrap();

        let ca = db.load_evidence_chain(&a.session).await.unwrap();
        let cb = db.load_evidence_chain(&b.session).await.unwrap();
        assert_eq!(ca.len(), 1);
        assert_eq!(cb.len(), 1);
        assert_ne!(ca[0].entry_hash, cb[0].entry_hash);
        assert_ne!(
            db.get_session_merkle_root(&a.session).await.unwrap(),
            db.get_session_merkle_root(&b.session).await.unwrap()
        );
    }

    /// Concurrent claims must not fork the sequence. The unique constraint is
    /// the backstop; the session row lock is what should actually prevent it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    #[ignore = "requires DATABASE_URL"]
    async fn concurrent_attempts_produce_a_contiguous_chain() {
        use crate::evidence::verify_chain;
        use std::sync::Arc;

        let db = Arc::new(connect_db().await);
        let rec = record(1_000_000);
        db.save_session(&rec).await.unwrap();

        let mut handles = Vec::new();
        for i in 0..12u64 {
            let db = Arc::clone(&db);
            let session = rec.session;
            handles.push(tokio::spawn(async move {
                db.upsert_claim_high_water_mark(
                    &claim_for(session, 1_000 + i, i + 1),
                    &sig(1),
                    NOW,
                )
                .await
                .map(|_| ())
            }));
        }
        for h in handles {
            h.await.unwrap().expect("no db errors");
        }

        let chain = db.load_evidence_chain(&rec.session).await.unwrap();
        assert_eq!(chain.len(), 12, "every attempt recorded exactly once");
        // Contiguous sequence and intact links prove the writes serialised.
        assert_eq!(verify_chain(&rec.session, &chain), Ok(()));
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn deposit_beyond_i64_is_refused_not_wrapped() {
        let db = connect_db().await;
        let mut rec = record(1);
        rec.deposited_total = i64::MAX as u64 + 1;
        let err = db.save_session(&rec).await.unwrap_err();
        assert!(matches!(err, DbError::OutOfRange { .. }));
        assert!(
            db.load_session(&rec.session).await.unwrap().is_none(),
            "nothing may be written when the amount does not fit"
        );
    }
}
