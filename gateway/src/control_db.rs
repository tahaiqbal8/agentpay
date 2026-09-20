//! Persistence for the control plane: agents, policies, providers, approvals.
//!
//! Kept out of `db.rs` deliberately. That module is the money path — sessions,
//! claim tickets, the evidence log — and its invariants (atomic high-water mark
//! advance, append-only evidence) are the ones an auditor reads first. Nothing
//! here holds custody or affects settlement, so mixing the two would make the
//! important file larger without making it more trustworthy.
//!
//! The spend figures are *derived*, never stored. `agent_spend` sums the
//! high-water marks the money path already records rather than keeping a second
//! counter that could drift from it. A second counter would eventually disagree
//! with `claim_tickets`, and the wrong one would be the one enforcing a budget.

use sqlx::Row;

use crate::db::{Database, DbError};
use crate::policy::{AgentMode, AgentPolicy, AgentStatus, Spend};
use crate::registry::ProviderRecord;

/// An agent record joined with its policy, as the API returns it.
#[derive(Debug, Clone)]
pub struct AgentRecord {
    pub agent_id: String,
    pub label: String,
    pub agent_pubkey: String,
    pub owner_pubkey: Option<String>,
    pub mode: AgentMode,
    pub status: AgentStatus,
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// `None` until a human authorizes the agent. Without it the policy layer
    /// does not apply and only the on-chain escrow bounds the agent.
    pub policy: Option<AgentPolicy>,
}

/// One proposed spend awaiting, or carrying, a human decision.
#[derive(Debug, Clone)]
pub struct ApprovalRecord {
    pub approval_id: String,
    pub agent_id: String,
    pub session: Option<String>,
    pub resource: String,
    pub price: u64,
    pub calls: i32,
    pub state: String,
    pub reason: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub decided_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Rejects a value that cannot be stored as a Postgres BIGINT.
///
/// Same reasoning as `db::to_i64`: silently storing a large u64 as a negative
/// BIGINT would corrupt a budget, and a corrupted budget is a spending control
/// that does not control spending.
fn to_i64(v: u64, field: &'static str) -> Result<i64, DbError> {
    i64::try_from(v).map_err(|_| DbError::OutOfRange { field, value: v })
}

fn from_i64(v: i64, field: &'static str) -> Result<u64, DbError> {
    u64::try_from(v).map_err(|_| DbError::NegativeAmount { field, value: v })
}

impl Database {
    // ---------------------------------------------------------------------
    // Providers
    // ---------------------------------------------------------------------

    pub async fn upsert_provider(&self, p: &ProviderRecord) -> Result<(), DbError> {
        sqlx::query(
            r#"
            INSERT INTO providers (provider_id, label, base_url, provider_pubkey, enabled)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (provider_id) DO UPDATE SET
                label           = EXCLUDED.label,
                base_url        = EXCLUDED.base_url,
                provider_pubkey = EXCLUDED.provider_pubkey,
                enabled         = EXCLUDED.enabled
            "#,
        )
        .bind(&p.provider_id)
        .bind(&p.label)
        .bind(&p.base_url)
        .bind(&p.provider_pubkey)
        .bind(p.enabled)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_providers(&self) -> Result<Vec<ProviderRecord>, DbError> {
        let rows = sqlx::query(
            "SELECT provider_id, label, base_url, provider_pubkey, enabled
             FROM providers ORDER BY provider_id",
        )
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|r| {
                Ok(ProviderRecord {
                    provider_id: r.try_get("provider_id")?,
                    label: r.try_get("label")?,
                    base_url: r.try_get("base_url")?,
                    provider_pubkey: r.try_get("provider_pubkey")?,
                    enabled: r.try_get("enabled")?,
                })
            })
            .collect()
    }

    pub async fn delete_provider(&self, provider_id: &str) -> Result<bool, DbError> {
        let done = sqlx::query("DELETE FROM providers WHERE provider_id = $1")
            .bind(provider_id)
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected() > 0)
    }

    // ---------------------------------------------------------------------
    // Agents
    // ---------------------------------------------------------------------

    /// Creates an agent. Returns false when the id or pubkey is already taken.
    ///
    /// The pubkey uniqueness matters: two agent records sharing one key would
    /// make the policy applied to a claim ambiguous, and the gateway would have
    /// to pick one arbitrarily.
    pub async fn create_agent(
        &self,
        agent_id: &str,
        label: &str,
        agent_pubkey: &str,
        owner_pubkey: Option<&str>,
        mode: AgentMode,
    ) -> Result<bool, DbError> {
        let done = sqlx::query(
            r#"
            INSERT INTO agents (agent_id, label, agent_pubkey, owner_pubkey, mode)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(agent_id)
        .bind(label)
        .bind(agent_pubkey)
        .bind(owner_pubkey)
        .bind(mode.as_str())
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    fn agent_from_row(r: &sqlx::postgres::PgRow) -> Result<AgentRecord, DbError> {
        let max_total: Option<i64> = r.try_get("max_total")?;
        let policy = match max_total {
            Some(total) => {
                let per_call: i64 = r.try_get("max_per_call")?;
                let threshold: Option<i64> = r.try_get("approval_threshold")?;
                let allowed: Option<Vec<String>> = r.try_get("allowed_resources")?;
                let max_calls: Option<i32> = r.try_get("max_calls")?;
                Some(AgentPolicy {
                    max_total: from_i64(total, "max_total")?,
                    max_per_call: from_i64(per_call, "max_per_call")?,
                    approval_threshold: threshold
                        .map(|t| from_i64(t, "approval_threshold"))
                        .transpose()?,
                    allowed_resources: allowed,
                    max_calls: max_calls.map(|c| c.max(0) as u32),
                })
            }
            None => None,
        };

        let mode: String = r.try_get("mode")?;
        let status: String = r.try_get("status")?;

        Ok(AgentRecord {
            agent_id: r.try_get("agent_id")?,
            label: r.try_get("label")?,
            agent_pubkey: r.try_get("agent_pubkey")?,
            owner_pubkey: r.try_get("owner_pubkey")?,
            // Both parse fail-closed: an unreadable mode reads as `human` and
            // an unreadable status as `suspended`.
            mode: AgentMode::from_str_or_human(&mode),
            status: AgentStatus::from_str_or_suspended(&status),
            created_at: r.try_get("created_at")?,
            policy,
        })
    }

    const AGENT_SELECT: &'static str = r#"
        SELECT a.agent_id, a.label, a.agent_pubkey, a.owner_pubkey, a.mode,
               a.status, a.created_at,
               p.max_total, p.max_per_call, p.approval_threshold,
               p.allowed_resources, p.max_calls
        FROM agents a
        LEFT JOIN agent_policies p ON p.agent_id = a.agent_id
    "#;

    pub async fn list_agents(&self) -> Result<Vec<AgentRecord>, DbError> {
        let sql = format!("{} ORDER BY a.created_at DESC", Self::AGENT_SELECT);
        let rows = sqlx::query(&sql).fetch_all(&self.pool).await?;
        rows.iter().map(Self::agent_from_row).collect()
    }

    pub async fn get_agent(&self, agent_id: &str) -> Result<Option<AgentRecord>, DbError> {
        let sql = format!("{} WHERE a.agent_id = $1", Self::AGENT_SELECT);
        let row = sqlx::query(&sql)
            .bind(agent_id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(Self::agent_from_row).transpose()
    }

    /// The lookup the buy path uses: a claim carries a session, the session
    /// carries an agent pubkey, and the policy hangs off that.
    pub async fn get_agent_by_pubkey(
        &self,
        agent_pubkey: &str,
    ) -> Result<Option<AgentRecord>, DbError> {
        let sql = format!("{} WHERE a.agent_pubkey = $1", Self::AGENT_SELECT);
        let row = sqlx::query(&sql)
            .bind(agent_pubkey)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(Self::agent_from_row).transpose()
    }

    pub async fn set_agent_status(
        &self,
        agent_id: &str,
        status: AgentStatus,
    ) -> Result<bool, DbError> {
        let done = sqlx::query("UPDATE agents SET status = $2 WHERE agent_id = $1")
            .bind(agent_id)
            .bind(status.as_str())
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected() > 0)
    }

    // ---------------------------------------------------------------------
    // Policies
    // ---------------------------------------------------------------------

    /// Writes the permission envelope. Replaces any previous one.
    pub async fn set_policy(
        &self,
        agent_id: &str,
        mode: AgentMode,
        p: &AgentPolicy,
    ) -> Result<bool, DbError> {
        let mut tx = self.pool.begin().await?;

        // Mode lives on the agent, the envelope on the policy, but a human sets
        // both in one action — so they move together or not at all.
        let touched = sqlx::query("UPDATE agents SET mode = $2 WHERE agent_id = $1")
            .bind(agent_id)
            .bind(mode.as_str())
            .execute(&mut *tx)
            .await?;
        if touched.rows_affected() == 0 {
            tx.rollback().await?;
            return Ok(false);
        }

        sqlx::query(
            r#"
            INSERT INTO agent_policies
                (agent_id, max_total, max_per_call, approval_threshold,
                 allowed_resources, max_calls, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, now())
            ON CONFLICT (agent_id) DO UPDATE SET
                max_total          = EXCLUDED.max_total,
                max_per_call       = EXCLUDED.max_per_call,
                approval_threshold = EXCLUDED.approval_threshold,
                allowed_resources  = EXCLUDED.allowed_resources,
                max_calls          = EXCLUDED.max_calls,
                updated_at         = now()
            "#,
        )
        .bind(agent_id)
        .bind(to_i64(p.max_total, "max_total")?)
        .bind(to_i64(p.max_per_call, "max_per_call")?)
        .bind(
            p.approval_threshold
                .map(|t| to_i64(t, "approval_threshold"))
                .transpose()?,
        )
        .bind(p.allowed_resources.as_deref())
        .bind(p.max_calls.map(|c| c as i32))
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(true)
    }

    // ---------------------------------------------------------------------
    // Derived spend
    // ---------------------------------------------------------------------

    /// What this agent has actually committed, read from the money path.
    ///
    /// `spent` sums the high-water marks of the agent's sessions — the same
    /// numbers the claim path enforces — rather than a counter maintained here.
    /// `calls` counts admitted decisions in the evidence log.
    ///
    /// Deriving both means the budget is measured against what the gateway
    /// actually authorised. A separate counter would eventually disagree with
    /// `claim_tickets`, and the disagreement would be invisible until it
    /// mattered.
    pub async fn agent_spend(&self, agent_pubkey: &str) -> Result<Spend, DbError> {
        let row = sqlx::query(
            r#"
            SELECT
              -- SUM over BIGINT returns NUMERIC in Postgres, so the cast is
              -- required, not cosmetic: without it this decodes as a type
              -- mismatch at runtime. An overflowing cast raises instead of
              -- wrapping, which fails closed — a budget that cannot be
              -- computed must deny, never guess.
              COALESCE((
                SELECT SUM(c.cumulative_amount)
                FROM claim_tickets c
                JOIN sessions s ON s.session_pubkey = c.session_pubkey
                WHERE s.agent_pubkey = $1
              ), 0)::BIGINT AS spent,
              COALESCE((
                SELECT COUNT(*)
                FROM evidence_log e
                JOIN sessions s ON s.session_pubkey = e.session_pubkey
                WHERE s.agent_pubkey = $1 AND e.decision = 'ALLOWED'
              ), 0) AS calls
            "#,
        )
        .bind(agent_pubkey)
        .fetch_one(&self.pool)
        .await?;

        // Cast to BIGINT in SQL above; a negative here should be impossible
        // and is refused rather than trusted.
        let spent: i64 = row.try_get::<Option<i64>, _>("spent")?.unwrap_or(0);
        let calls: i64 = row.try_get("calls")?;

        Ok(Spend {
            spent: from_i64(spent, "agent_spend")?,
            calls: u32::try_from(calls.max(0)).unwrap_or(u32::MAX),
        })
    }

    // ---------------------------------------------------------------------
    // Approvals
    // ---------------------------------------------------------------------

    pub async fn create_approval(
        &self,
        approval_id: &str,
        agent_id: &str,
        session: Option<&str>,
        resource: &str,
        price: u64,
        calls: i32,
    ) -> Result<(), DbError> {
        sqlx::query(
            r#"
            INSERT INTO approvals
                (approval_id, agent_id, session_pubkey, resource, price, calls)
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(approval_id)
        .bind(agent_id)
        .bind(session)
        .bind(resource)
        .bind(to_i64(price, "approval price")?)
        .bind(calls)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    fn approval_from_row(r: &sqlx::postgres::PgRow) -> Result<ApprovalRecord, DbError> {
        let price: i64 = r.try_get("price")?;
        Ok(ApprovalRecord {
            approval_id: r.try_get("approval_id")?,
            agent_id: r.try_get("agent_id")?,
            session: r.try_get("session_pubkey")?,
            resource: r.try_get("resource")?,
            price: from_i64(price, "approval price")?,
            calls: r.try_get("calls")?,
            state: r.try_get("state")?,
            reason: r.try_get("reason")?,
            created_at: r.try_get("created_at")?,
            decided_at: r.try_get("decided_at")?,
        })
    }

    pub async fn list_approvals(&self, limit: i64) -> Result<Vec<ApprovalRecord>, DbError> {
        let rows = sqlx::query(
            "SELECT approval_id, agent_id, session_pubkey, resource, price, calls,
                    state, reason, created_at, decided_at
             FROM approvals ORDER BY created_at DESC LIMIT $1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(Self::approval_from_row).collect()
    }

    /// Records a human decision. Only a pending approval can be decided, so a
    /// second click cannot flip an already-rejected spend into an approved one.
    pub async fn decide_approval(
        &self,
        approval_id: &str,
        approved: bool,
        reason: Option<&str>,
    ) -> Result<bool, DbError> {
        let done = sqlx::query(
            r#"
            UPDATE approvals
            SET state = $2, reason = $3, decided_at = now()
            WHERE approval_id = $1 AND state = 'pending'
            "#,
        )
        .bind(approval_id)
        .bind(if approved { "approved" } else { "rejected" })
        .bind(reason)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    /// Spends one approval for this agent and resource, if one is granted.
    ///
    /// Atomic and single-use: the UPDATE moves exactly one row from `approved`
    /// to `consumed` and returns whether it moved. Two concurrent purchases
    /// cannot both claim the same approval, and an approval cannot authorise an
    /// unbounded number of calls.
    ///
    /// Price is matched too, so an approval granted for a cheap resource cannot
    /// be spent on an expensive one after a provider changes its catalogue.
    pub async fn consume_approval(
        &self,
        agent_id: &str,
        resource: &str,
        price: u64,
    ) -> Result<bool, DbError> {
        let done = sqlx::query(
            r#"
            UPDATE approvals SET state = 'consumed'
            WHERE approval_id = (
                SELECT approval_id FROM approvals
                WHERE agent_id = $1 AND resource = $2 AND price = $3
                  AND state = 'approved'
                ORDER BY created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            "#,
        )
        .bind(agent_id)
        .bind(resource)
        .bind(to_i64(price, "approval price")?)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    /// True when this agent already has a pending proposal for this exact
    /// resource and price, so a retrying agent does not flood the queue.
    pub async fn has_pending_approval(
        &self,
        agent_id: &str,
        resource: &str,
        price: u64,
    ) -> Result<bool, DbError> {
        let row = sqlx::query(
            "SELECT 1 AS hit FROM approvals
             WHERE agent_id = $1 AND resource = $2 AND price = $3 AND state = 'pending'
             LIMIT 1",
        )
        .bind(agent_id)
        .bind(resource)
        .bind(to_i64(price, "approval price")?)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.is_some())
    }
}

/// Control-plane integration tests.
///
/// Same rule as `db::pg_tests`: these WRITE and do not roll back, so they read
/// `TEST_DATABASE_URL` and refuse a database whose name does not contain
/// `test`. See that module for what happened the one time this was pointed at
/// a live database.
#[cfg(test)]
mod pg_tests {
    use super::*;
    use crate::policy::{AgentMode, AgentPolicy, AgentStatus};

    /// Genuinely random, NOT `Pubkey::new_unique()` — see `db::pg_tests`.
    fn random_key() -> String {
        let mut bytes = [0u8; 32];
        bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        solana_pubkey::Pubkey::new_from_array(bytes).to_string()
    }

    fn random_id(prefix: &str) -> String {
        format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
    }

    async fn connect() -> Database {
        let url = std::env::var("TEST_DATABASE_URL")
            .expect("TEST_DATABASE_URL must be set for pg_tests (NOT DATABASE_URL)");
        let name = url.rsplit('/').next().unwrap_or("");
        let name = name.split('?').next().unwrap_or("");
        assert!(
            name.contains("test"),
            "refusing to run write tests against database {name:?}"
        );
        Database::connect(&url).await.expect("connects")
    }

    fn policy() -> AgentPolicy {
        AgentPolicy {
            max_total: 1_000_000,
            max_per_call: 25_000,
            approval_threshold: Some(10_000),
            allowed_resources: Some(vec!["/weather".into()]),
            max_calls: Some(50),
        }
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL"]
    async fn an_agent_round_trips_with_its_policy() {
        let db = connect().await;
        let id = random_id("agt");
        let key = random_key();

        assert!(db
            .create_agent(&id, "Research bot", &key, None, AgentMode::Human)
            .await
            .unwrap());

        let before = db.get_agent(&id).await.unwrap().unwrap();
        assert!(before.policy.is_none(), "an agent starts unauthorized");
        assert_eq!(before.mode, AgentMode::Human);
        assert_eq!(before.status, AgentStatus::Active);

        assert!(db
            .set_policy(&id, AgentMode::Autonomous, &policy())
            .await
            .unwrap());

        let after = db.get_agent(&id).await.unwrap().unwrap();
        let p = after.policy.expect("policy present");
        assert_eq!(p.max_total, 1_000_000);
        assert_eq!(p.max_per_call, 25_000);
        assert_eq!(p.approval_threshold, Some(10_000));
        assert_eq!(p.allowed_resources.as_deref(), Some(&["/weather".to_string()][..]));
        assert_eq!(p.max_calls, Some(50));
        // Mode and envelope are set in one action, so they must move together.
        assert_eq!(after.mode, AgentMode::Autonomous);

        // The pubkey lookup is what the buy path uses.
        let by_key = db.get_agent_by_pubkey(&key).await.unwrap().unwrap();
        assert_eq!(by_key.agent_id, id);
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL"]
    async fn two_agents_cannot_share_one_wallet() {
        // Two records for one key would make the policy applied to a claim
        // ambiguous, and the gateway would have to pick one arbitrarily.
        let db = connect().await;
        let key = random_key();

        assert!(db
            .create_agent(&random_id("agt"), "first", &key, None, AgentMode::Human)
            .await
            .unwrap());
        assert!(
            !db.create_agent(&random_id("agt"), "second", &key, None, AgentMode::Human)
                .await
                .unwrap(),
            "the second agent on the same pubkey must be refused"
        );
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL"]
    async fn suspending_an_agent_persists() {
        let db = connect().await;
        let id = random_id("agt");
        db.create_agent(&id, "bot", &random_key(), None, AgentMode::Autonomous)
            .await
            .unwrap();

        assert!(db.set_agent_status(&id, AgentStatus::Suspended).await.unwrap());
        assert_eq!(
            db.get_agent(&id).await.unwrap().unwrap().status,
            AgentStatus::Suspended
        );

        assert!(db.set_agent_status(&id, AgentStatus::Active).await.unwrap());
        assert_eq!(
            db.get_agent(&id).await.unwrap().unwrap().status,
            AgentStatus::Active
        );

        // An agent that does not exist cannot be suspended, and saying it was
        // would tell an operator they had revoked something they had not.
        assert!(!db
            .set_agent_status("agt_nope", AgentStatus::Suspended)
            .await
            .unwrap());
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL"]
    async fn an_approval_can_be_spent_exactly_once() {
        // The property the whole human-controlled mode rests on. If one
        // approval could be consumed twice, a single human click would
        // authorise an unbounded number of purchases.
        let db = connect().await;
        let id = random_id("agt");
        db.create_agent(&id, "bot", &random_key(), None, AgentMode::Human)
            .await
            .unwrap();

        let approval = random_id("apr");
        db.create_approval(&approval, &id, None, "/weather", 1_000, 1)
            .await
            .unwrap();

        // Pending is not spendable: only a human decision makes it so.
        assert!(!db.consume_approval(&id, "/weather", 1_000).await.unwrap());
        assert!(db.has_pending_approval(&id, "/weather", 1_000).await.unwrap());

        assert!(db.decide_approval(&approval, true, None).await.unwrap());
        assert!(
            !db.has_pending_approval(&id, "/weather", 1_000).await.unwrap(),
            "a decided approval is no longer pending"
        );

        assert!(db.consume_approval(&id, "/weather", 1_000).await.unwrap());
        assert!(
            !db.consume_approval(&id, "/weather", 1_000).await.unwrap(),
            "the same approval must not be spendable twice"
        );
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL"]
    async fn an_approval_is_bound_to_its_resource_and_price() {
        // An approval granted for a cheap resource must not be spendable on an
        // expensive one, including after a provider changes its catalogue.
        let db = connect().await;
        let id = random_id("agt");
        db.create_agent(&id, "bot", &random_key(), None, AgentMode::Human)
            .await
            .unwrap();

        let approval = random_id("apr");
        db.create_approval(&approval, &id, None, "/weather", 1_000, 1)
            .await
            .unwrap();
        db.decide_approval(&approval, true, None).await.unwrap();

        assert!(
            !db.consume_approval(&id, "/analyse", 1_000).await.unwrap(),
            "a different resource must not spend it"
        );
        assert!(
            !db.consume_approval(&id, "/weather", 25_000).await.unwrap(),
            "a different price must not spend it"
        );
        assert!(db.consume_approval(&id, "/weather", 1_000).await.unwrap());
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL"]
    async fn a_rejected_approval_cannot_be_flipped_or_spent() {
        let db = connect().await;
        let id = random_id("agt");
        db.create_agent(&id, "bot", &random_key(), None, AgentMode::Human)
            .await
            .unwrap();

        let approval = random_id("apr");
        db.create_approval(&approval, &id, None, "/analyse", 25_000, 1)
            .await
            .unwrap();
        assert!(db
            .decide_approval(&approval, false, Some("too expensive"))
            .await
            .unwrap());

        // A second click must not turn the refusal into permission.
        assert!(
            !db.decide_approval(&approval, true, None).await.unwrap(),
            "only a pending approval can be decided"
        );
        assert!(!db.consume_approval(&id, "/analyse", 25_000).await.unwrap());

        let listed = db.list_approvals(50).await.unwrap();
        let mine = listed
            .iter()
            .find(|a| a.approval_id == approval)
            .expect("listed");
        assert_eq!(mine.state, "rejected");
        assert_eq!(mine.reason.as_deref(), Some("too expensive"));
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL"]
    async fn spend_is_zero_for_an_agent_that_has_never_transacted() {
        // Derived, not stored: an agent with no sessions reads zero rather
        // than failing or returning a stale counter.
        let db = connect().await;
        let spend = db.agent_spend(&random_key()).await.unwrap();
        assert_eq!(spend.spent, 0);
        assert_eq!(spend.calls, 0);
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL"]
    async fn a_provider_round_trips_and_can_be_removed() {
        let db = connect().await;
        let id = random_id("prv");
        let rec = ProviderRecord {
            provider_id: id.clone(),
            label: "Weather Co".into(),
            base_url: "http://example.invalid:4021".into(),
            provider_pubkey: None,
            enabled: true,
        };
        db.upsert_provider(&rec).await.unwrap();

        let found = db
            .list_providers()
            .await
            .unwrap()
            .into_iter()
            .find(|p| p.provider_id == id)
            .expect("registered");
        assert_eq!(found.label, "Weather Co");
        assert!(found.enabled);

        // Upsert replaces rather than duplicating.
        let mut updated = rec.clone();
        updated.label = "Weather Co (EU)".into();
        updated.enabled = false;
        db.upsert_provider(&updated).await.unwrap();
        let again = db
            .list_providers()
            .await
            .unwrap()
            .into_iter()
            .filter(|p| p.provider_id == id)
            .collect::<Vec<_>>();
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].label, "Weather Co (EU)");
        assert!(!again[0].enabled);

        assert!(db.delete_provider(&id).await.unwrap());
        assert!(!db.delete_provider(&id).await.unwrap());
    }
}
