//! PostgreSQL implementation of the `Store` trait (P5.1) — the multi-node
//! backend. Same semantics as SQLite, with the distributed parts done the
//! boring, proven way:
//!
//! - job claims:        `FOR UPDATE SKIP LOCKED`
//! - scheduler election: CAS tick claims (see Store::schedule_claim_tick)
//! - cross-node wakeups: `pg_notify('zenzip_wake', queue)` inside the same
//!   transaction as the job insert (delivered on commit, P5.3)
//! - dead workers:      the existing lease-expiry sweep — leases ARE the
//!   worker registry
//!
//! All tables live in a dedicated `zenzip` schema. Blocking trait methods
//! bridge via `Handle::block_on` — they are only ever called from the JS
//! thread (never from engine runtime workers, which would panic).

use std::sync::Arc;

use async_trait::async_trait;
use sqlx::postgres::{PgPool, PgPoolOptions};
use sqlx::{Executor, Postgres, Row, Transaction};
use tokio::runtime::Handle;

use crate::crypto::Crypto;
use crate::store::{
    workflow_execution_job, ClaimedJob, DeadJob, EmitOutcome, EventRow, GcStats, MachineHistoryRow,
    NewRun, PushJob, QueueStat, RunRow, ScheduleRow, StepEntry, StepRow, Store, StoreError,
    StoreResult, TriggerTarget, TriggeredRun, Waiter,
};
use crate::time::now_ms;

pub const WAKE_CHANNEL: &str = "zenzip_wake";

/// Postgres server time in epoch-ms. Used for lease set/expiry decisions so a
/// skewed worker/node wall clock can't mis-set or prematurely expire a lease —
/// every node reads the same authority, the database (P7.12).
const DB_NOW: &str = "(EXTRACT(EPOCH FROM now()) * 1000)::BIGINT";

const MIGRATIONS: &[&str] = &[
    // v1 — full schema (no legacy to migrate from)
    "CREATE TABLE jobs (
        id            TEXT PRIMARY KEY,
        queue         TEXT NOT NULL,
        payload       TEXT NOT NULL,
        status        INT NOT NULL DEFAULT 0,
        priority      INT NOT NULL DEFAULT 0,
        attempt       INT NOT NULL DEFAULT 0,
        max_attempts  INT NOT NULL DEFAULT 3,
        available_at  BIGINT NOT NULL,
        lease_until   BIGINT,
        last_error    TEXT,
        created_at    BIGINT NOT NULL,
        updated_at    BIGINT NOT NULL
    );
    CREATE INDEX idx_jobs_claim ON jobs (queue, status, available_at);
    CREATE INDEX idx_jobs_lease ON jobs (status, lease_until);
    CREATE TABLE schedules (
        name         TEXT PRIMARY KEY,
        spec         TEXT NOT NULL,
        overlap      TEXT NOT NULL DEFAULT 'skip',
        catchup      TEXT NOT NULL DEFAULT 'skip',
        next_run_at  BIGINT NOT NULL,
        last_run_at  BIGINT,
        enabled      INT NOT NULL DEFAULT 1
    );
    CREATE TABLE runs (
        id              TEXT PRIMARY KEY,
        workflow        TEXT NOT NULL,
        status          INT NOT NULL DEFAULT 0,
        input           TEXT NOT NULL,
        output          TEXT,
        error           TEXT,
        version         TEXT,
        idempotency_key TEXT,
        parent_run_id   TEXT,
        parent_step_id  TEXT,
        wait_event      TEXT,
        wait_step_id    TEXT,
        wait_match      TEXT,
        wake_at         BIGINT,
        created_at      BIGINT NOT NULL,
        updated_at      BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX idx_runs_idem ON runs (workflow, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    CREATE INDEX idx_runs_wait_event ON runs (status, wait_event);
    CREATE INDEX idx_runs_wake ON runs (status, wake_at);
    CREATE INDEX idx_runs_parent ON runs (parent_run_id);
    CREATE TABLE steps (
        run_id      TEXT NOT NULL,
        step_id     TEXT NOT NULL,
        kind        TEXT NOT NULL,
        status      INT NOT NULL DEFAULT 0,
        result      TEXT,
        error       TEXT,
        attempts    INT NOT NULL DEFAULT 0,
        updated_at  BIGINT NOT NULL,
        PRIMARY KEY (run_id, step_id)
    );
    CREATE TABLE events (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        emitted_at  BIGINT NOT NULL
    );
    CREATE INDEX idx_events_time ON events (emitted_at DESC);
    CREATE TABLE machine_instances (
        machine     TEXT NOT NULL,
        id          TEXT NOT NULL,
        state       TEXT NOT NULL,
        created_at  BIGINT NOT NULL,
        updated_at  BIGINT NOT NULL,
        PRIMARY KEY (machine, id)
    );
    CREATE TABLE machine_history (
        seq         BIGSERIAL PRIMARY KEY,
        machine     TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        from_state  TEXT NOT NULL,
        event       TEXT NOT NULL,
        to_state    TEXT NOT NULL,
        at          BIGINT NOT NULL
    );
    CREATE INDEX idx_machine_history ON machine_history (machine, instance_id, at);
    CREATE TABLE agent_sessions (
        agent       TEXT NOT NULL,
        id          TEXT NOT NULL,
        messages    TEXT NOT NULL,
        created_at  BIGINT NOT NULL,
        updated_at  BIGINT NOT NULL,
        PRIMARY KEY (agent, id)
    );",
    // v2 — retention GC (P7.6): index terminal runs by recency so the sweep
    // ranges over an index instead of scanning the whole runs table.
    "CREATE INDEX idx_runs_gc ON runs (status, updated_at);",
    // v3 — fencing tokens (P7.11): monotonic per-job counter bumped on claim;
    // ack/fail/renew are guarded by it so a zombie worker's late write fails.
    "ALTER TABLE jobs ADD COLUMN fence BIGINT NOT NULL DEFAULT 0;",
    // v4 — per-key concurrency (P10.1): bucket key + index for keyed claims.
    "ALTER TABLE jobs ADD COLUMN concurrency_key TEXT;
     CREATE INDEX idx_jobs_ckey ON jobs (queue, concurrency_key, status);",
    // v5 — debounce (P10.2): bucket key + index for collapse-on-push.
    "ALTER TABLE jobs ADD COLUMN debounce_key TEXT;
     CREATE INDEX idx_jobs_debounce ON jobs (queue, debounce_key, status);",
    // v6 — throttle (P10.2): per-key cursor of the next allowed start time.
    "CREATE TABLE throttle_cursors (
        queue    TEXT NOT NULL,
        tkey     TEXT NOT NULL,
        next_at  BIGINT NOT NULL,
        PRIMARY KEY (queue, tkey)
    );",
    // v7 — event outbox partitioning (P10.4): RANGE-partition events by
    // emitted_at into fixed-width (EVENT_PARTITION_MS) buckets so retention GC
    // can DROP whole aged partitions (instant) instead of a row-by-row DELETE
    // at scale, and per-partition indexes stay small. The PK must include the
    // partition key, so it becomes (emitted_at, id). A DEFAULT partition
    // catches any row whose time bucket was not pre-created (correctness floor;
    // such rows are GC'd by DELETE, just not droppable). Index recreated after
    // the legacy table is dropped so the name is free.
    "ALTER TABLE events RENAME TO events_legacy;
     CREATE TABLE events (
        id          TEXT NOT NULL,
        name        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        emitted_at  BIGINT NOT NULL,
        PRIMARY KEY (emitted_at, id)
     ) PARTITION BY RANGE (emitted_at);
     CREATE TABLE events_default PARTITION OF events DEFAULT;
     INSERT INTO events (id, name, payload, emitted_at)
        SELECT id, name, payload, emitted_at FROM events_legacy;
     DROP TABLE events_legacy;
     CREATE INDEX idx_events_time ON events (emitted_at DESC);",
    // v8 — ready-jobs index (P10.4): priority-ordered partial index over
    // claimable rows lets the non-windowed claim walk jobs in dispatch order
    // (queue + priority) and stop at LIMIT without a Sort node.
    "CREATE INDEX idx_jobs_ready ON jobs (queue, priority DESC, id) WHERE status = 0;",
    // v9 — data-subject tag for PII purge (P14.6): index by subject so erasure
    // is an index lookup, not a table scan.
    "ALTER TABLE runs ADD COLUMN subject TEXT;
     CREATE INDEX idx_runs_subject ON runs (subject);",
];

/// Width of an event-outbox time partition, in ms (P10.4). One day: large
/// enough that partition churn is trivial, small enough that retention drops
/// reclaim space promptly. Arithmetic buckets (floor(emitted_at / W)) avoid any
/// calendar math.
const EVENT_PARTITION_MS: i64 = 86_400_000;

fn pg_err(e: sqlx::Error) -> StoreError {
    StoreError::Other(format!("postgres: {e}"))
}

/// Drive a future to completion on the engine runtime from ANY thread.
/// Plain threads (the JS thread in production) block directly; threads
/// already inside a tokio context (tests) hop through a scoped OS thread —
/// block_on would panic there.
fn block_anywhere<T: Send>(handle: &Handle, fut: impl std::future::Future<Output = T> + Send) -> T {
    if Handle::try_current().is_err() {
        return handle.block_on(fut);
    }
    std::thread::scope(|scope| {
        scope
            .spawn(|| handle.block_on(fut))
            .join()
            .expect("block_anywhere thread panicked")
    })
}

pub struct PgStore {
    pool: PgPool,
    /// Engine runtime handle — bridges *_blocking calls (JS thread only).
    handle: Handle,
    /// Payload-at-rest cipher (P7.15). Passthrough unless a key is configured.
    crypto: Crypto,
}

impl PgStore {
    /// Connect + migrate. Blocks the calling (JS) thread on the handshake.
    pub fn open(handle: Handle, url: &str) -> StoreResult<Self> {
        Self::open_with(handle, url, Crypto::disabled())
    }

    /// Connect + migrate with payload encryption (P7.15). Passthrough when the
    /// cipher carries no key, so this is also the plain path.
    pub fn open_with(handle: Handle, url: &str, crypto: Crypto) -> StoreResult<Self> {
        let url = url.to_string();
        let pool = block_anywhere(&handle, async {
            let pool = PgPoolOptions::new()
                .max_connections(8)
                // Resilience (P15.4): fail fast when the pool is exhausted or
                // PG is unreachable instead of hanging the caller; recycle
                // connections so a post-failover stale socket is replaced.
                .acquire_timeout(std::time::Duration::from_secs(10))
                .idle_timeout(Some(std::time::Duration::from_secs(300)))
                .max_lifetime(Some(std::time::Duration::from_secs(1800)))
                .test_before_acquire(true)
                .after_connect(|conn, _meta| {
                    Box::pin(async move {
                        conn.execute("SET search_path TO zenzip, public").await?;
                        // Bound runaway queries so one can't pin a connection
                        // forever (generous — well above normal claim/GC ops).
                        conn.execute("SET statement_timeout = '120s'").await?;
                        conn.execute("SET idle_in_transaction_session_timeout = '60s'")
                            .await?;
                        Ok(())
                    })
                })
                .connect(&url)
                .await?;
            migrate(&pool).await?;
            Ok::<_, sqlx::Error>(pool)
        })
        .map_err(pg_err)?;
        let store = Self {
            pool,
            handle,
            crypto,
        };
        // Create the current/next event partitions before any emit (P10.4), so
        // they land in droppable partitions instead of the DEFAULT catch-all.
        let _ = store.block(store.ensure_event_partitions(now_ms()));
        Ok(store)
    }

    fn block<T: Send>(
        &self,
        fut: impl std::future::Future<Output = StoreResult<T>> + Send,
    ) -> StoreResult<T> {
        block_anywhere(&self.handle, fut)
    }

    /// Ensure the current and next event time-partitions exist (P10.4).
    /// Best-effort and idempotent: called at open and before each GC sweep so
    /// live emits land in droppable partitions. Any failure (a concurrent
    /// creator, or pre-existing rows in the default partition for this range)
    /// is non-fatal — the row simply falls back to the DEFAULT partition.
    async fn ensure_event_partitions(&self, now: i64) -> StoreResult<()> {
        let w = EVENT_PARTITION_MS;
        let k0 = now.div_euclid(w);
        for k in [k0, k0 + 1] {
            let lo = k * w;
            let hi = (k + 1) * w;
            let sql = format!(
                "CREATE TABLE IF NOT EXISTS zenzip.events_p{k} \
                 PARTITION OF zenzip.events FOR VALUES FROM ({lo}) TO ({hi})"
            );
            // Swallow errors: partitioning is an optimization, not a correctness
            // requirement — the DEFAULT partition always accepts the row.
            let _ = sqlx::query(&sql).execute(&self.pool).await;
        }
        Ok(())
    }

    /// Drop every event partition that lies entirely below `before` (P10.4) —
    /// the fast path for retention GC. Returns the row count removed (counted
    /// before the drop, so GcStats stays accurate). Rows in the boundary
    /// partition and the DEFAULT partition are left for the caller's DELETE.
    async fn drop_aged_event_partitions(
        tx: &mut Transaction<'_, Postgres>,
        before: i64,
    ) -> StoreResult<u64> {
        let w = EVENT_PARTITION_MS;
        let rows = sqlx::query(
            "SELECT c.relname FROM pg_inherits i
             JOIN pg_class c ON c.oid = i.inhrelid
             JOIN pg_class p ON p.oid = i.inhparent
             JOIN pg_namespace n ON n.oid = p.relnamespace
             WHERE p.relname = 'events' AND n.nspname = 'zenzip'
               AND c.relname LIKE 'events\\_p%'",
        )
        .fetch_all(&mut **tx)
        .await
        .map_err(pg_err)?;
        let mut dropped = 0u64;
        for r in rows {
            let name: String = r.get(0);
            let Some(kstr) = name.strip_prefix("events_p") else {
                continue;
            };
            let Ok(k) = kstr.parse::<i64>() else { continue };
            if (k + 1) * w <= before {
                let n: i64 =
                    sqlx::query_scalar(&format!("SELECT count(*) FROM zenzip.events_p{k}"))
                        .fetch_one(&mut **tx)
                        .await
                        .map_err(pg_err)?;
                sqlx::query(&format!("DROP TABLE zenzip.events_p{k}"))
                    .execute(&mut **tx)
                    .await
                    .map_err(pg_err)?;
                dropped += n as u64;
            }
        }
        Ok(dropped)
    }

    async fn insert_job(
        tx: &mut Transaction<'_, Postgres>,
        job: &PushJob,
        now: i64,
        crypto: &Crypto,
    ) -> StoreResult<String> {
        // Debounce (P10.2): collapse — drop any pending same-key job first.
        if let Some(dk) = &job.debounce_key {
            sqlx::query("DELETE FROM jobs WHERE queue = $1 AND status = 0 AND debounce_key = $2")
                .bind(&job.queue)
                .bind(dk)
                .execute(&mut **tx)
                .await
                .map_err(pg_err)?;
        }
        // Throttle (P10.2): atomically advance the per-key cursor and take its
        // start slot — GREATEST(existing, now) + spacing; start = next_at - spacing.
        let mut available_at = now + job.delay_ms.max(0);
        if let (Some(tk), Some(spacing)) = (&job.throttle_key, job.throttle_spacing_ms) {
            let next_at: i64 = sqlx::query_scalar(
                "INSERT INTO throttle_cursors (queue, tkey, next_at) VALUES ($1, $2, $3 + $4)
                 ON CONFLICT (queue, tkey)
                 DO UPDATE SET next_at = GREATEST(throttle_cursors.next_at, $3) + $4
                 RETURNING next_at",
            )
            .bind(&job.queue)
            .bind(tk)
            .bind(now)
            .bind(spacing.max(0))
            .fetch_one(&mut **tx)
            .await
            .map_err(pg_err)?;
            available_at = next_at - spacing.max(0);
        }
        let id = uuid::Uuid::now_v7().to_string();
        let enc_payload = crypto.enc(&job.payload); // P7.15
        sqlx::query(
            "INSERT INTO jobs (id, queue, payload, status, priority, attempt, max_attempts,
                               available_at, created_at, updated_at, concurrency_key, debounce_key)
             VALUES ($1, $2, $3, 0, $4, 0, $5, $6, $7, $7, $8, $9)",
        )
        .bind(&id)
        .bind(&job.queue)
        .bind(&enc_payload)
        .bind(job.priority)
        .bind(job.max_attempts.max(1) as i32)
        .bind(available_at)
        .bind(now)
        .bind(&job.concurrency_key)
        .bind(&job.debounce_key)
        .execute(&mut **tx)
        .await
        .map_err(pg_err)?;
        // Cross-node wakeup, delivered on commit (P5.3).
        sqlx::query("SELECT pg_notify($1, $2)")
            .bind(WAKE_CHANNEL)
            .bind(&job.queue)
            .execute(&mut **tx)
            .await
            .map_err(pg_err)?;
        Ok(id)
    }

    async fn push_async(&self, jobs: Vec<PushJob>) -> StoreResult<Vec<String>> {
        let now = now_ms();
        let mut tx = self.pool.begin().await.map_err(pg_err)?;
        let mut ids = Vec::with_capacity(jobs.len());
        for job in &jobs {
            ids.push(Self::insert_job(&mut tx, job, now, &self.crypto).await?);
        }
        tx.commit().await.map_err(pg_err)?;
        Ok(ids)
    }

    async fn create_run_in_tx(
        tx: &mut Transaction<'_, Postgres>,
        run: &NewRun,
        now: i64,
        crypto: &Crypto,
    ) -> StoreResult<(String, bool)> {
        if let Some(key) = &run.idempotency_key {
            let existing: Option<String> = sqlx::query_scalar(
                "SELECT id FROM runs WHERE workflow = $1 AND idempotency_key = $2",
            )
            .bind(&run.workflow)
            .bind(key)
            .fetch_optional(&mut **tx)
            .await
            .map_err(pg_err)?;
            if let Some(id) = existing {
                return Ok((id, false));
            }
        }
        let id = uuid::Uuid::now_v7().to_string();
        let enc_input = crypto.enc(&run.input); // P7.15
        let inserted = sqlx::query(
            "INSERT INTO runs (id, workflow, status, input, version, idempotency_key,
                               parent_run_id, parent_step_id, subject, created_at, updated_at)
             VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $9, $8, $8)
             ON CONFLICT DO NOTHING",
        )
        .bind(&id)
        .bind(&run.workflow)
        .bind(&enc_input)
        .bind(&run.version)
        .bind(&run.idempotency_key)
        .bind(&run.parent_run_id)
        .bind(&run.parent_step_id)
        .bind(now)
        .bind(&run.subject)
        .execute(&mut **tx)
        .await
        .map_err(pg_err)?
        .rows_affected();
        if inserted == 0 {
            let existing: String = sqlx::query_scalar(
                "SELECT id FROM runs WHERE workflow = $1 AND idempotency_key = $2",
            )
            .bind(&run.workflow)
            .bind(&run.idempotency_key)
            .fetch_one(&mut **tx)
            .await
            .map_err(pg_err)?;
            return Ok((existing, false));
        }
        Ok((id, true))
    }

    async fn record_step_in_tx(
        tx: &mut Transaction<'_, Postgres>,
        run_id: &str,
        step_id: &str,
        kind: &str,
        result: Option<&str>,
        now: i64,
        crypto: &Crypto,
    ) -> StoreResult<()> {
        let enc_result = result.map(|r| crypto.enc(r)); // P7.15
        sqlx::query(
            "INSERT INTO steps (run_id, step_id, kind, status, result, updated_at)
             VALUES ($1, $2, $3, 1, $4, $5)
             ON CONFLICT (run_id, step_id) DO UPDATE
                 SET status = 1, result = EXCLUDED.result, kind = EXCLUDED.kind,
                     updated_at = EXCLUDED.updated_at
                 WHERE steps.status <> 1",
        )
        .bind(run_id)
        .bind(step_id)
        .bind(kind)
        .bind(enc_result.as_deref())
        .bind(now)
        .execute(&mut **tx)
        .await
        .map_err(pg_err)?;
        Ok(())
    }

    /// Outbox core in the caller's transaction — mirrors sqlite emit_in_tx.
    async fn emit_in_tx(
        tx: &mut Transaction<'_, Postgres>,
        name: &str,
        payload: &str,
        targets: Vec<TriggerTarget>,
        now: i64,
        crypto: &Crypto,
    ) -> StoreResult<EmitOutcome> {
        let event_id = uuid::Uuid::now_v7().to_string();
        // Match predicates run against the in-memory plaintext; only the stored
        // copy is encrypted (P7.15).
        let payload_value: serde_json::Value =
            serde_json::from_str(payload).unwrap_or(serde_json::Value::Null);
        let enc_payload = crypto.enc(payload);

        sqlx::query("INSERT INTO events (id, name, payload, emitted_at) VALUES ($1, $2, $3, $4)")
            .bind(&event_id)
            .bind(name)
            .bind(&enc_payload)
            .bind(now)
            .execute(&mut **tx)
            .await
            .map_err(pg_err)?;

        // Lock waiting rows so concurrent emits on the same event can't
        // double-wake a run.
        let candidates: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT id, workflow, wait_step_id, wait_match
             FROM runs WHERE status = 2 AND wait_event = $1
             FOR UPDATE SKIP LOCKED",
        )
        .bind(name)
        .fetch_all(&mut **tx)
        .await
        .map_err(pg_err)?;

        let mut waiters = Vec::new();
        for (run_id, workflow, step_id, wait_match) in candidates {
            if !crate::sqlite::match_subset(wait_match.as_deref(), &payload_value) {
                continue;
            }
            sqlx::query(
                "UPDATE runs SET status = 0, wait_event = NULL, wait_step_id = NULL,
                                 wait_match = NULL, wake_at = NULL, updated_at = $1
                 WHERE id = $2",
            )
            .bind(now)
            .bind(&run_id)
            .execute(&mut **tx)
            .await
            .map_err(pg_err)?;
            let step_id = step_id.unwrap_or_default();
            Self::record_step_in_tx(
                tx,
                &run_id,
                &step_id,
                "waitForEvent",
                Some(&format!(r#"{{"event":{payload}}}"#)),
                now,
                crypto,
            )
            .await?;
            Self::insert_job(
                tx,
                &workflow_execution_job(&workflow, &run_id, 0),
                now,
                crypto,
            )
            .await?;
            waiters.push(Waiter {
                run_id,
                workflow,
                step_id,
            });
        }

        let mut triggered = Vec::new();
        let trigger_input = serde_json::to_string(&serde_json::json!({
            "event": name,
            "payload": payload_value,
            "emittedAt": now,
        }))
        .map_err(|e| StoreError::Other(e.to_string()))?;
        for target in targets {
            let (run_id, created) = Self::create_run_in_tx(
                tx,
                &NewRun {
                    workflow: target.workflow.clone(),
                    input: trigger_input.clone(),
                    version: target.version.clone(),
                    idempotency_key: None,
                    parent_run_id: None,
                    parent_step_id: None,
                    subject: None,
                },
                now,
                crypto,
            )
            .await?;
            if created {
                Self::insert_job(
                    tx,
                    &workflow_execution_job(&target.workflow, &run_id, 0),
                    now,
                    crypto,
                )
                .await?;
                triggered.push(TriggeredRun {
                    workflow: target.workflow,
                    run_id,
                });
            }
        }

        Ok(EmitOutcome {
            event_id,
            waiters,
            triggered,
        })
    }

    async fn get_run_async(&self, id: &str) -> StoreResult<Option<RunRow>> {
        let row = sqlx::query(
            "SELECT id, workflow, status, input, output, error, version,
                    parent_run_id, parent_step_id, wait_step_id, created_at, updated_at
             FROM runs WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(pg_err)?;
        Ok(row.map(|r| RunRow {
            id: r.get(0),
            workflow: r.get(1),
            status: r.get::<i32, _>(2) as i64,
            input: self.crypto.dec(&r.get::<String, _>(3)), // P7.15
            output: r.get::<Option<String>, _>(4).map(|o| self.crypto.dec(&o)),
            error: r.get(5),
            version: r.get(6),
            parent_run_id: r.get(7),
            parent_step_id: r.get(8),
            wait_step_id: r.get(9),
            created_at: r.get(10),
            updated_at: r.get(11),
        }))
    }
}

async fn migrate(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query("CREATE SCHEMA IF NOT EXISTS zenzip")
        .execute(pool)
        .await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS zenzip.migrations (version INT PRIMARY KEY)")
        .execute(pool)
        .await?;
    let mut tx = pool.begin().await?;
    // Serialize concurrent boots (multiple nodes starting together).
    sqlx::query("SELECT pg_advisory_xact_lock(823014)")
        .execute(&mut *tx)
        .await?;
    let version: Option<i32> = sqlx::query_scalar("SELECT MAX(version) FROM zenzip.migrations")
        .fetch_one(&mut *tx)
        .await?;
    let from = version.unwrap_or(0) as usize;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(from) {
        for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
            sqlx::query(statement).execute(&mut *tx).await?;
        }
        sqlx::query("INSERT INTO zenzip.migrations (version) VALUES ($1)")
            .bind((i + 1) as i32)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}

#[async_trait]
impl Store for PgStore {
    async fn push(&self, jobs: Vec<PushJob>) -> StoreResult<Vec<String>> {
        self.push_async(jobs).await
    }

    fn push_blocking(&self, jobs: Vec<PushJob>) -> StoreResult<Vec<String>> {
        self.block(self.push_async(jobs))
    }

    async fn claim(
        &self,
        queue: &str,
        limit: u32,
        lease_ms: i64,
        key_limit: Option<u32>,
        fair: bool,
    ) -> StoreResult<Vec<ClaimedJob>> {
        let now = now_ms();
        let rows = if fair || key_limit.is_some() {
            // Windowed claim (P10.1 key limit and/or P10.3 fairness). SKIP
            // LOCKED can't combine with the window function, so serialize claims
            // on this queue with a transaction advisory lock — these queues are
            // lower-throughput, and this keeps the count/fair-spread exact
            // across nodes. Non-windowed queues keep the SKIP-LOCKED fast path.
            let cap = key_limit.map(|k| k as i64).unwrap_or(i64::MAX);
            // Fairness orders by rank-within-key so the LIMIT round-robins
            // across groups; otherwise order by id (selection is what matters,
            // dispatch order is re-sorted below).
            let order = if fair {
                "ORDER BY rn ASC, pr DESC, id ASC"
            } else {
                "ORDER BY id ASC"
            };
            // lease_until from DB server time + duration (P7.12).
            let sql = format!(
                "UPDATE jobs SET status = 1, attempt = attempt + 1,
                                 lease_until = {DB_NOW} + {lease_ms},
                                 updated_at = $1, fence = fence + 1
                 WHERE id IN (
                     SELECT id FROM (
                         SELECT j.id AS id, j.concurrency_key AS ck, j.priority AS pr,
                             (SELECT COUNT(*) FROM jobs r
                              WHERE r.queue = j.queue AND r.status = 1
                                AND r.concurrency_key = j.concurrency_key)
                             + ROW_NUMBER() OVER (
                                 PARTITION BY j.concurrency_key
                                 ORDER BY j.priority DESC, j.id ASC) AS keyrank,
                             ROW_NUMBER() OVER (
                                 PARTITION BY j.concurrency_key
                                 ORDER BY j.priority DESC, j.id ASC) AS rn
                         FROM jobs j
                         WHERE j.queue = $2 AND j.status = 0 AND j.available_at <= $1
                     ) ranked
                     WHERE ck IS NULL OR keyrank <= $4
                     {order}
                     LIMIT $3
                 )
                 RETURNING id, queue, payload, attempt, max_attempts, priority, fence"
            );
            let mut tx = self.pool.begin().await.map_err(pg_err)?;
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::int8)")
                .bind(queue)
                .execute(&mut *tx)
                .await
                .map_err(pg_err)?;
            let rows = sqlx::query(&sql)
                .bind(now)
                .bind(queue)
                .bind(limit as i64)
                .bind(cap)
                .fetch_all(&mut *tx)
                .await
                .map_err(pg_err)?;
            tx.commit().await.map_err(pg_err)?;
            rows
        } else {
            sqlx::query(&format!(
                "UPDATE jobs SET status = 1, attempt = attempt + 1,
                                 lease_until = {DB_NOW} + {lease_ms}, updated_at = $1,
                                 fence = fence + 1
                 WHERE id IN (
                     SELECT id FROM jobs
                     WHERE queue = $2 AND status = 0 AND available_at <= $1
                     ORDER BY priority DESC, id ASC
                     LIMIT $3
                     FOR UPDATE SKIP LOCKED
                 )
                 RETURNING id, queue, payload, attempt, max_attempts, priority, fence"
            ))
            .bind(now)
            .bind(queue)
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(pg_err)?
        };
        let mut jobs: Vec<(ClaimedJob, i32)> = rows
            .into_iter()
            .map(|r| {
                (
                    ClaimedJob {
                        id: r.get(0),
                        queue: r.get(1),
                        payload: self.crypto.dec(&r.get::<String, _>(2)), // P7.15
                        attempt: r.get::<i32, _>(3) as u32,
                        max_attempts: r.get::<i32, _>(4) as u32,
                        fence: r.get::<i64, _>(6),
                    },
                    r.get::<i32, _>(5),
                )
            })
            .collect();
        jobs.sort_by(|(a, pa), (b, pb)| pb.cmp(pa).then(a.id.cmp(&b.id)));
        Ok(jobs.into_iter().map(|(job, _)| job).collect())
    }

    async fn ack(&self, id: &str, fence: i64) -> StoreResult<()> {
        sqlx::query("DELETE FROM jobs WHERE id = $1 AND fence = $2")
            .bind(id)
            .bind(fence)
            .execute(&self.pool)
            .await
            .map_err(pg_err)?;
        Ok(())
    }

    async fn fail_retry(
        &self,
        id: &str,
        error: &str,
        available_at: i64,
        fence: i64,
    ) -> StoreResult<()> {
        sqlx::query(
            "UPDATE jobs SET status = 0, available_at = $1, last_error = $2,
                             lease_until = NULL, updated_at = $3
             WHERE id = $4 AND fence = $5",
        )
        .bind(available_at)
        .bind(error)
        .bind(now_ms())
        .bind(id)
        .bind(fence)
        .execute(&self.pool)
        .await
        .map_err(pg_err)?;
        Ok(())
    }

    async fn fail_dead(&self, id: &str, error: &str, fence: i64) -> StoreResult<()> {
        sqlx::query(
            "UPDATE jobs SET status = 3, last_error = $1, lease_until = NULL, updated_at = $2
             WHERE id = $3 AND fence = $4",
        )
        .bind(error)
        .bind(now_ms())
        .bind(id)
        .bind(fence)
        .execute(&self.pool)
        .await
        .map_err(pg_err)?;
        Ok(())
    }

    async fn renew_leases(&self, leases: Vec<(String, i64)>, lease_ms: i64) -> StoreResult<()> {
        let (ids, fences): (Vec<String>, Vec<i64>) = leases.into_iter().unzip();
        // lease_until from DB server time + duration (P7.12).
        let sql = format!(
            "UPDATE jobs SET lease_until = {DB_NOW} + $1, updated_at = {DB_NOW}
             WHERE status = 1 AND (id, fence) IN (
                 SELECT u.id, u.fence FROM unnest($2::text[], $3::bigint[]) AS u(id, fence)
             )"
        );
        sqlx::query(&sql)
            .bind(lease_ms)
            .bind(&ids)
            .bind(&fences)
            .execute(&self.pool)
            .await
            .map_err(pg_err)?;
        Ok(())
    }

    async fn ping(&self) -> StoreResult<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map_err(pg_err)?;
        Ok(())
    }

    async fn sweep_expired(&self, now: i64) -> StoreResult<u64> {
        // Expire by DB server time, not the sweeper's wall clock (P7.12) — a
        // skewed sweeper node can't prematurely expire another node's leases.
        let dead = sqlx::query(&format!(
            "UPDATE jobs SET status = 3, lease_until = NULL,
                             last_error = COALESCE(last_error, 'lease expired'),
                             updated_at = $1
             WHERE status = 1 AND lease_until < {DB_NOW} AND attempt >= max_attempts"
        ))
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(pg_err)?
        .rows_affected();
        let retried = sqlx::query(&format!(
            "UPDATE jobs SET status = 0, lease_until = NULL, available_at = $1, updated_at = $1
             WHERE status = 1 AND lease_until < {DB_NOW}"
        ))
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(pg_err)?
        .rows_affected();
        Ok(dead + retried)
    }

    async fn gc(&self, run_before: Option<i64>, event_before: Option<i64>) -> StoreResult<GcStats> {
        // Keep the upcoming event time-partitions present (P10.4) so live emits
        // land in droppable partitions rather than the catch-all DEFAULT.
        let _ = self.ensure_event_partitions(now_ms()).await;
        let mut tx = self.pool.begin().await.map_err(pg_err)?;
        let mut stats = GcStats::default();
        if let Some(before) = run_before {
            stats.steps = sqlx::query(
                "DELETE FROM steps WHERE run_id IN (
                    SELECT id FROM runs WHERE status IN (4, 5, 6) AND updated_at < $1)",
            )
            .bind(before)
            .execute(&mut *tx)
            .await
            .map_err(pg_err)?
            .rows_affected();
            stats.runs =
                sqlx::query("DELETE FROM runs WHERE status IN (4, 5, 6) AND updated_at < $1")
                    .bind(before)
                    .execute(&mut *tx)
                    .await
                    .map_err(pg_err)?
                    .rows_affected();
        }
        if let Some(before) = event_before {
            // Drop fully-aged partitions wholesale (instant), then mop up the
            // boundary partition + DEFAULT with a bounded row delete (P10.4).
            let dropped = Self::drop_aged_event_partitions(&mut tx, before).await?;
            let deleted = sqlx::query("DELETE FROM events WHERE emitted_at < $1")
                .bind(before)
                .execute(&mut *tx)
                .await
                .map_err(pg_err)?
                .rows_affected();
            stats.events = dropped + deleted;
        }
        tx.commit().await.map_err(pg_err)?;
        Ok(stats)
    }

    async fn pending_count(&self, queue: &str) -> StoreResult<u64> {
        let n: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE queue = $1 AND status = 0")
                .bind(queue)
                .fetch_one(&self.pool)
                .await
                .map_err(pg_err)?;
        Ok(n as u64)
    }

    async fn active_count(&self, queue: &str) -> StoreResult<u64> {
        let n: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE queue = $1 AND status IN (0, 1)")
                .bind(queue)
                .fetch_one(&self.pool)
                .await
                .map_err(pg_err)?;
        Ok(n as u64)
    }

    async fn dead_jobs(&self, queue: &str, limit: u32) -> StoreResult<Vec<DeadJob>> {
        let rows = sqlx::query(
            "SELECT id, queue, payload, attempt, last_error, created_at
             FROM jobs WHERE queue = $1 AND status = 3 ORDER BY updated_at DESC LIMIT $2",
        )
        .bind(queue)
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(pg_err)?;
        Ok(rows
            .into_iter()
            .map(|r| DeadJob {
                id: r.get(0),
                queue: r.get(1),
                payload: self.crypto.dec(&r.get::<String, _>(2)), // P7.15
                attempt: r.get::<i32, _>(3) as u32,
                last_error: r.get(4),
                created_at: r.get(5),
            })
            .collect())
    }

    async fn requeue_dead(&self, ids: Vec<String>) -> StoreResult<u64> {
        let now = now_ms();
        let changed = sqlx::query(
            "UPDATE jobs SET status = 0, attempt = 0, last_error = NULL,
                             available_at = $1, updated_at = $1
             WHERE id = ANY($2) AND status = 3",
        )
        .bind(now)
        .bind(&ids)
        .execute(&self.pool)
        .await
        .map_err(pg_err)?
        .rows_affected();
        Ok(changed)
    }

    async fn purge_dead(&self, queue: &str) -> StoreResult<u64> {
        Ok(
            sqlx::query("DELETE FROM jobs WHERE queue = $1 AND status = 3")
                .bind(queue)
                .execute(&self.pool)
                .await
                .map_err(pg_err)?
                .rows_affected(),
        )
    }

    async fn create_run(&self, run: NewRun) -> StoreResult<(String, bool)> {
        let now = now_ms();
        let mut tx = self.pool.begin().await.map_err(pg_err)?;
        let result = Self::create_run_in_tx(&mut tx, &run, now, &self.crypto).await?;
        tx.commit().await.map_err(pg_err)?;
        Ok(result)
    }

    fn create_run_blocking(&self, run: NewRun) -> StoreResult<(String, bool)> {
        self.block(self.create_run(run))
    }

    async fn purge_subject(&self, subject: &str) -> StoreResult<u64> {
        let mut tx = self.pool.begin().await.map_err(pg_err)?;
        sqlx::query("DELETE FROM steps WHERE run_id IN (SELECT id FROM runs WHERE subject = $1)")
            .bind(subject)
            .execute(&mut *tx)
            .await
            .map_err(pg_err)?;
        let runs = sqlx::query("DELETE FROM runs WHERE subject = $1")
            .bind(subject)
            .execute(&mut *tx)
            .await
            .map_err(pg_err)?
            .rows_affected();
        tx.commit().await.map_err(pg_err)?;
        Ok(runs)
    }

    async fn get_run(&self, id: &str) -> StoreResult<Option<RunRow>> {
        self.get_run_async(id).await
    }

    fn get_run_blocking(&self, id: &str) -> StoreResult<Option<RunRow>> {
        self.block(self.get_run_async(id))
    }

    async fn load_journal(&self, run_id: &str) -> StoreResult<Vec<StepEntry>> {
        let rows =
            sqlx::query("SELECT step_id, kind, result FROM steps WHERE run_id = $1 AND status = 1")
                .bind(run_id)
                .fetch_all(&self.pool)
                .await
                .map_err(pg_err)?;
        Ok(rows
            .into_iter()
            .map(|r| StepEntry {
                id: r.get(0),
                kind: r.get(1),
                result: r.get::<Option<String>, _>(2).map(|v| self.crypto.dec(&v)), // P7.15
            })
            .collect())
    }

    async fn record_step(
        &self,
        run_id: &str,
        step_id: &str,
        kind: &str,
        result: Option<String>,
    ) -> StoreResult<()> {
        let mut tx = self.pool.begin().await.map_err(pg_err)?;
        Self::record_step_in_tx(
            &mut tx,
            run_id,
            step_id,
            kind,
            result.as_deref(),
            now_ms(),
            &self.crypto,
        )
        .await?;
        tx.commit().await.map_err(pg_err)
    }

    fn record_step_blocking(
        &self,
        run_id: &str,
        step_id: &str,
        kind: &str,
        result: Option<String>,
    ) -> StoreResult<()> {
        self.block(self.record_step(run_id, step_id, kind, result))
    }

    async fn step_failed_attempt(
        &self,
        run_id: &str,
        step_id: &str,
        error: &str,
    ) -> StoreResult<u32> {
        let attempts: i32 = sqlx::query_scalar(
            "INSERT INTO steps (run_id, step_id, kind, status, error, attempts, updated_at)
             VALUES ($1, $2, 'run', 0, $3, 1, $4)
             ON CONFLICT (run_id, step_id) DO UPDATE
                 SET attempts = steps.attempts + 1, error = EXCLUDED.error,
                     updated_at = EXCLUDED.updated_at
             RETURNING attempts",
        )
        .bind(run_id)
        .bind(step_id)
        .bind(error)
        .bind(now_ms())
        .fetch_one(&self.pool)
        .await
        .map_err(pg_err)?;
        Ok(attempts as u32)
    }

    async fn run_completed(&self, id: &str, output: Option<String>) -> StoreResult<()> {
        let output = output.map(|o| self.crypto.enc(&o)); // P7.15
        sqlx::query(
            "UPDATE runs SET status = 4, output = $1, wait_event = NULL,
                             wait_step_id = NULL, wait_match = NULL, wake_at = NULL,
                             updated_at = $2
             WHERE id = $3",
        )
        .bind(output)
        .bind(now_ms())
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(pg_err)?;
        Ok(())
    }

    async fn run_failed(&self, id: &str, error: &str) -> StoreResult<()> {
        sqlx::query(
            "UPDATE runs SET status = 5, error = $1, wait_event = NULL,
                             wait_step_id = NULL, wait_match = NULL, wake_at = NULL,
                             updated_at = $2
             WHERE id = $3",
        )
        .bind(error)
        .bind(now_ms())
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(pg_err)?;
        Ok(())
    }

    async fn run_sleeping(&self, id: &str, wake_at: i64) -> StoreResult<()> {
        sqlx::query("UPDATE runs SET status = 1, wake_at = $1, updated_at = $2 WHERE id = $3")
            .bind(wake_at)
            .bind(now_ms())
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(pg_err)?;
        Ok(())
    }

    async fn run_waiting_event(
        &self,
        id: &str,
        event: &str,
        step_id: &str,
        timeout_at: Option<i64>,
        match_json: Option<String>,
    ) -> StoreResult<()> {
        sqlx::query(
            "UPDATE runs SET status = 2, wait_event = $1, wait_step_id = $2,
                             wake_at = $3, wait_match = $4, updated_at = $5
             WHERE id = $6",
        )
        .bind(event)
        .bind(step_id)
        .bind(timeout_at)
        .bind(match_json)
        .bind(now_ms())
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(pg_err)?;
        Ok(())
    }

    async fn run_waiting_child(&self, id: &str) -> StoreResult<()> {
        sqlx::query("UPDATE runs SET status = 3, updated_at = $1 WHERE id = $2")
            .bind(now_ms())
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(pg_err)?;
        Ok(())
    }

    async fn wake_parent(&self, parent_run_id: &str) -> StoreResult<bool> {
        let changed =
            sqlx::query("UPDATE runs SET status = 0, updated_at = $1 WHERE id = $2 AND status = 3")
                .bind(now_ms())
                .bind(parent_run_id)
                .execute(&self.pool)
                .await
                .map_err(pg_err)?
                .rows_affected();
        Ok(changed > 0)
    }

    fn emit_event_blocking(
        &self,
        name: &str,
        payload: &str,
        targets: Vec<TriggerTarget>,
    ) -> StoreResult<EmitOutcome> {
        self.block(async {
            let mut tx = self.pool.begin().await.map_err(pg_err)?;
            let outcome =
                Self::emit_in_tx(&mut tx, name, payload, targets, now_ms(), &self.crypto).await?;
            tx.commit().await.map_err(pg_err)?;
            Ok(outcome)
        })
    }

    async fn sweep_event_timeouts(&self, now: i64) -> StoreResult<Vec<Waiter>> {
        let rows = sqlx::query(
            "UPDATE runs SET status = 0, wait_event = NULL, wait_match = NULL,
                             wake_at = NULL, updated_at = $1
             WHERE id IN (
                 SELECT id FROM runs
                 WHERE status = 2 AND wake_at IS NOT NULL AND wake_at <= $1
                 FOR UPDATE SKIP LOCKED
             )
             RETURNING id, workflow, wait_step_id",
        )
        .bind(now)
        .fetch_all(&self.pool)
        .await
        .map_err(pg_err)?;
        Ok(rows
            .into_iter()
            .map(|r| Waiter {
                run_id: r.get(0),
                workflow: r.get(1),
                step_id: r.get::<Option<String>, _>(2).unwrap_or_default(),
            })
            .collect())
    }

    fn cancel_run_tree_blocking(&self, root_run_id: &str) -> StoreResult<u32> {
        self.block(async {
            let now = now_ms();
            let n: i64 = sqlx::query_scalar(
                "WITH RECURSIVE tree AS (
                     SELECT id FROM runs WHERE id = $1
                     UNION ALL
                     SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id = t.id
                 ),
                 cancelled AS (
                     UPDATE runs SET status = 6, wait_event = NULL, wait_step_id = NULL,
                                     wait_match = NULL, wake_at = NULL, updated_at = $2
                     WHERE id IN (SELECT id FROM tree) AND status NOT IN (4, 5, 6)
                     RETURNING 1
                 )
                 SELECT COUNT(*) FROM cancelled",
            )
            .bind(root_run_id)
            .bind(now)
            .fetch_one(&self.pool)
            .await
            .map_err(pg_err)?;
            Ok(n as u32)
        })
    }

    fn machine_create_blocking(&self, machine: &str, id: &str, initial: &str) -> StoreResult<bool> {
        self.block(async {
            let inserted = sqlx::query(
                "INSERT INTO machine_instances (machine, id, state, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $4) ON CONFLICT DO NOTHING",
            )
            .bind(machine)
            .bind(id)
            .bind(initial)
            .bind(now_ms())
            .execute(&self.pool)
            .await
            .map_err(pg_err)?
            .rows_affected();
            Ok(inserted > 0)
        })
    }

    fn machine_state_blocking(&self, machine: &str, id: &str) -> StoreResult<Option<String>> {
        self.block(async {
            sqlx::query_scalar("SELECT state FROM machine_instances WHERE machine = $1 AND id = $2")
                .bind(machine)
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(pg_err)
        })
    }

    fn machine_send_blocking(
        &self,
        machine: &str,
        id: &str,
        from: &str,
        event: &str,
        to: &str,
        event_name: &str,
        payload: &str,
        targets: Vec<TriggerTarget>,
    ) -> StoreResult<Option<EmitOutcome>> {
        self.block(async {
            let now = now_ms();
            let mut tx = self.pool.begin().await.map_err(pg_err)?;
            let changed = sqlx::query(
                "UPDATE machine_instances SET state = $1, updated_at = $2
                 WHERE machine = $3 AND id = $4 AND state = $5",
            )
            .bind(to)
            .bind(now)
            .bind(machine)
            .bind(id)
            .bind(from)
            .execute(&mut *tx)
            .await
            .map_err(pg_err)?
            .rows_affected();
            if changed == 0 {
                return Ok(None);
            }
            sqlx::query(
                "INSERT INTO machine_history (machine, instance_id, from_state, event, to_state, at)
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(machine)
            .bind(id)
            .bind(from)
            .bind(event)
            .bind(to)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(pg_err)?;
            let outcome =
                Self::emit_in_tx(&mut tx, event_name, payload, targets, now, &self.crypto).await?;
            tx.commit().await.map_err(pg_err)?;
            Ok(Some(outcome))
        })
    }

    fn machine_history_blocking(
        &self,
        machine: &str,
        id: &str,
        limit: u32,
    ) -> StoreResult<Vec<MachineHistoryRow>> {
        self.block(async {
            let rows = sqlx::query(
                "SELECT from_state, event, to_state, at FROM machine_history
                 WHERE machine = $1 AND instance_id = $2 ORDER BY at DESC, seq DESC LIMIT $3",
            )
            .bind(machine)
            .bind(id)
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(pg_err)?;
            Ok(rows
                .into_iter()
                .map(|r| MachineHistoryRow {
                    from_state: r.get(0),
                    event: r.get(1),
                    to_state: r.get(2),
                    at: r.get(3),
                })
                .collect())
        })
    }

    fn agent_session_get_blocking(&self, agent: &str, id: &str) -> StoreResult<Option<String>> {
        self.block(async {
            sqlx::query_scalar("SELECT messages FROM agent_sessions WHERE agent = $1 AND id = $2")
                .bind(agent)
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(pg_err)
        })
    }

    fn agent_session_put_blocking(&self, agent: &str, id: &str, messages: &str) -> StoreResult<()> {
        self.block(async {
            sqlx::query(
                "INSERT INTO agent_sessions (agent, id, messages, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $4)
                 ON CONFLICT (agent, id) DO UPDATE
                     SET messages = EXCLUDED.messages, updated_at = EXCLUDED.updated_at",
            )
            .bind(agent)
            .bind(id)
            .bind(messages)
            .bind(now_ms())
            .execute(&self.pool)
            .await
            .map_err(pg_err)?;
            Ok(())
        })
    }

    async fn runs_list(
        &self,
        workflow: Option<String>,
        status: Option<i64>,
        limit: u32,
    ) -> StoreResult<Vec<RunRow>> {
        let rows = sqlx::query(
            "SELECT id, workflow, status, input, output, error, version,
                    parent_run_id, parent_step_id, wait_step_id, created_at, updated_at
             FROM runs
             WHERE ($1::text IS NULL OR workflow = $1) AND ($2::int IS NULL OR status = $2)
             ORDER BY created_at DESC LIMIT $3",
        )
        .bind(workflow)
        .bind(status.map(|s| s as i32))
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(pg_err)?;
        Ok(rows
            .into_iter()
            .map(|r| RunRow {
                id: r.get(0),
                workflow: r.get(1),
                status: r.get::<i32, _>(2) as i64,
                input: self.crypto.dec(&r.get::<String, _>(3)), // P7.15
                output: r.get::<Option<String>, _>(4).map(|o| self.crypto.dec(&o)),
                error: r.get(5),
                version: r.get(6),
                parent_run_id: r.get(7),
                parent_step_id: r.get(8),
                wait_step_id: r.get(9),
                created_at: r.get(10),
                updated_at: r.get(11),
            })
            .collect())
    }

    async fn steps_for_run(&self, run_id: &str) -> StoreResult<Vec<StepRow>> {
        let rows = sqlx::query(
            "SELECT step_id, kind, status, result, error, attempts, updated_at
             FROM steps WHERE run_id = $1 ORDER BY updated_at ASC",
        )
        .bind(run_id)
        .fetch_all(&self.pool)
        .await
        .map_err(pg_err)?;
        Ok(rows
            .into_iter()
            .map(|r| StepRow {
                step_id: r.get(0),
                kind: r.get(1),
                status: r.get::<i32, _>(2) as i64,
                result: r.get::<Option<String>, _>(3).map(|v| self.crypto.dec(&v)), // P7.15
                error: r.get(4),
                attempts: r.get::<i32, _>(5) as u32,
                updated_at: r.get(6),
            })
            .collect())
    }

    async fn queue_stats(&self) -> StoreResult<Vec<QueueStat>> {
        let rows = sqlx::query(
            "SELECT queue,
                    COUNT(*) FILTER (WHERE status = 0),
                    COUNT(*) FILTER (WHERE status = 1),
                    COUNT(*) FILTER (WHERE status = 3)
             FROM jobs GROUP BY queue ORDER BY queue",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(pg_err)?;
        Ok(rows
            .into_iter()
            .map(|r| QueueStat {
                queue: r.get(0),
                pending: r.get::<i64, _>(1) as u64,
                running: r.get::<i64, _>(2) as u64,
                dead: r.get::<i64, _>(3) as u64,
            })
            .collect())
    }

    async fn all_schedules(&self) -> StoreResult<Vec<ScheduleRow>> {
        let rows = sqlx::query(
            "SELECT name, spec, overlap, catchup, next_run_at, last_run_at
             FROM schedules ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(pg_err)?;
        Ok(rows
            .into_iter()
            .map(|r| ScheduleRow {
                name: r.get(0),
                spec: r.get(1),
                overlap: r.get(2),
                catchup: r.get(3),
                next_run_at: r.get(4),
                last_run_at: r.get(5),
            })
            .collect())
    }

    async fn recent_events(&self, limit: u32) -> StoreResult<Vec<EventRow>> {
        let rows = sqlx::query(
            "SELECT id, name, payload, emitted_at FROM events
             ORDER BY emitted_at DESC, id DESC LIMIT $1",
        )
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(pg_err)?;
        Ok(rows
            .into_iter()
            .map(|r| EventRow {
                id: r.get(0),
                name: r.get(1),
                payload: self.crypto.dec(&r.get::<String, _>(2)), // P7.15
                emitted_at: r.get(3),
            })
            .collect())
    }

    async fn upsert_schedule(&self, row: ScheduleRow) -> StoreResult<ScheduleRow> {
        let mut tx = self.pool.begin().await.map_err(pg_err)?;
        let existing: Option<(String, i64, Option<i64>)> = sqlx::query_as(
            "SELECT spec, next_run_at, last_run_at FROM schedules WHERE name = $1 FOR UPDATE",
        )
        .bind(&row.name)
        .fetch_optional(&mut *tx)
        .await
        .map_err(pg_err)?;
        let (next_run_at, last_run_at) = match &existing {
            Some((spec, next, last)) if *spec == row.spec => (*next, *last),
            _ => (row.next_run_at, None),
        };
        sqlx::query(
            "INSERT INTO schedules (name, spec, overlap, catchup, next_run_at, last_run_at, enabled)
             VALUES ($1, $2, $3, $4, $5, $6, 1)
             ON CONFLICT (name) DO UPDATE SET
                 spec = EXCLUDED.spec, overlap = EXCLUDED.overlap,
                 catchup = EXCLUDED.catchup, next_run_at = EXCLUDED.next_run_at,
                 last_run_at = EXCLUDED.last_run_at, enabled = 1",
        )
        .bind(&row.name)
        .bind(&row.spec)
        .bind(&row.overlap)
        .bind(&row.catchup)
        .bind(next_run_at)
        .bind(last_run_at)
        .execute(&mut *tx)
        .await
        .map_err(pg_err)?;
        tx.commit().await.map_err(pg_err)?;
        Ok(ScheduleRow {
            next_run_at,
            last_run_at,
            ..row
        })
    }

    async fn due_schedules(&self, now: i64) -> StoreResult<Vec<ScheduleRow>> {
        let rows = sqlx::query(
            "SELECT name, spec, overlap, catchup, next_run_at, last_run_at
             FROM schedules WHERE enabled = 1 AND next_run_at <= $1",
        )
        .bind(now)
        .fetch_all(&self.pool)
        .await
        .map_err(pg_err)?;
        Ok(rows
            .into_iter()
            .map(|r| ScheduleRow {
                name: r.get(0),
                spec: r.get(1),
                overlap: r.get(2),
                catchup: r.get(3),
                next_run_at: r.get(4),
                last_run_at: r.get(5),
            })
            .collect())
    }

    async fn set_schedule_next(
        &self,
        name: &str,
        next_run_at: i64,
        last_run_at: Option<i64>,
    ) -> StoreResult<()> {
        sqlx::query(
            "UPDATE schedules SET next_run_at = $1, last_run_at = COALESCE($2, last_run_at)
             WHERE name = $3",
        )
        .bind(next_run_at)
        .bind(last_run_at)
        .bind(name)
        .execute(&self.pool)
        .await
        .map_err(pg_err)?;
        Ok(())
    }

    async fn schedule_claim_tick(
        &self,
        name: &str,
        observed_next: i64,
        new_next: i64,
        fired_at: i64,
    ) -> StoreResult<bool> {
        let changed = sqlx::query(
            "UPDATE schedules SET next_run_at = $1, last_run_at = $2
             WHERE name = $3 AND next_run_at = $4",
        )
        .bind(new_next)
        .bind(fired_at)
        .bind(name)
        .bind(observed_next)
        .execute(&self.pool)
        .await
        .map_err(pg_err)?
        .rows_affected();
        Ok(changed > 0)
    }

    fn close_blocking(&self) {
        let pool = self.pool.clone();
        block_anywhere(&self.handle, async move {
            pool.close().await;
        });
    }
}

/// Spawn the cross-node wake listener (P5.3): LISTEN zenzip_wake, payload =
/// queue name -> local dispatcher notify. Reconnects on error.
pub fn spawn_wake_listener(
    handle: &Handle,
    url: String,
    notifier: Arc<dyn Fn(&str) + Send + Sync>,
    token: tokio_util::sync::CancellationToken,
) {
    handle.spawn(async move {
        loop {
            if token.is_cancelled() {
                return;
            }
            match sqlx::postgres::PgListener::connect(&url).await {
                Ok(mut listener) => {
                    if listener.listen(WAKE_CHANNEL).await.is_err() {
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        continue;
                    }
                    loop {
                        tokio::select! {
                            _ = token.cancelled() => return,
                            msg = listener.recv() => match msg {
                                Ok(notification) => notifier(notification.payload()),
                                Err(e) => {
                                    tracing::warn!(error = %e, "wake listener dropped; reconnecting");
                                    break;
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "wake listener connect failed; retrying");
                    tokio::select! {
                        _ = token.cancelled() => return,
                        _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
                    }
                }
            }
        }
    });
}
