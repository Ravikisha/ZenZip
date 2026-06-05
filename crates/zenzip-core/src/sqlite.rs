//! SQLite implementation of the `Store` trait (P1.2, P1.3).
//!
//! Single shared connection behind a mutex: WAL mode tolerates one writer,
//! and every operation here is microseconds-short. Async trait methods hop
//! through `spawn_blocking`; `push_blocking` runs directly on the caller's
//! thread for the sync NAPI fast path.

use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rusqlite::{params, Connection};

use crate::store::{
    status, workflow_execution_job, ClaimedJob, DeadJob, EmitOutcome, EventRow, MachineHistoryRow,
    NewRun, PushJob, QueueStat, RunRow, ScheduleRow, StepEntry, StepRow, Store, StoreError,
    StoreResult, TriggerTarget, TriggeredRun, Waiter,
};
use crate::time::now_ms;

/// True when every key in the (optional) match object equals the same key in
/// the event payload — the waitForEvent match predicate (P3.3). Shared with
/// the Postgres store.
pub fn match_subset(match_json: Option<&str>, payload: &serde_json::Value) -> bool {
    let Some(raw) = match_json else { return true };
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Object(map)) => map.iter().all(|(k, v)| payload.get(k) == Some(v)),
        // Malformed / non-object predicates never block a wake.
        _ => true,
    }
}

const MIGRATIONS: &[&str] = &[
    // v1
    "CREATE TABLE jobs (
        id            TEXT PRIMARY KEY,
        queue         TEXT NOT NULL,
        payload       TEXT NOT NULL,
        status        INTEGER NOT NULL DEFAULT 0,
        priority      INTEGER NOT NULL DEFAULT 0,
        attempt       INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 3,
        available_at  INTEGER NOT NULL,
        lease_until   INTEGER,
        last_error    TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
    );
    CREATE INDEX idx_jobs_claim ON jobs (queue, status, available_at);
    CREATE INDEX idx_jobs_lease ON jobs (status, lease_until);
    CREATE TABLE schedules (
        name         TEXT PRIMARY KEY,
        spec         TEXT NOT NULL,
        overlap      TEXT NOT NULL DEFAULT 'skip',
        catchup      TEXT NOT NULL DEFAULT 'skip',
        next_run_at  INTEGER NOT NULL,
        last_run_at  INTEGER,
        enabled      INTEGER NOT NULL DEFAULT 1
    );",
    // v2 — workflow runs + step journal (P2.1)
    "CREATE TABLE runs (
        id              TEXT PRIMARY KEY,
        workflow        TEXT NOT NULL,
        status          INTEGER NOT NULL DEFAULT 0,
        input           TEXT NOT NULL,
        output          TEXT,
        error           TEXT,
        version         TEXT,
        idempotency_key TEXT,
        parent_run_id   TEXT,
        parent_step_id  TEXT,
        wait_event      TEXT,
        wait_step_id    TEXT,
        wake_at         INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
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
        status      INTEGER NOT NULL DEFAULT 0,
        result      TEXT,
        error       TEXT,
        attempts    INTEGER NOT NULL DEFAULT 0,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (run_id, step_id)
    );",
    // v3 — event bus outbox + state machines (P3.1, P3.2, P3.5)
    "ALTER TABLE runs ADD COLUMN wait_match TEXT;
    CREATE TABLE events (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        emitted_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_events_time ON events (emitted_at DESC);
    CREATE TABLE machine_instances (
        machine     TEXT NOT NULL,
        id          TEXT NOT NULL,
        state       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (machine, id)
    );
    CREATE TABLE machine_history (
        machine     TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        from_state  TEXT NOT NULL,
        event       TEXT NOT NULL,
        to_state    TEXT NOT NULL,
        at          INTEGER NOT NULL
    );
    CREATE INDEX idx_machine_history ON machine_history (machine, instance_id, at);",
    // v4 — agent session memory (P4.7)
    "CREATE TABLE agent_sessions (
        agent       TEXT NOT NULL,
        id          TEXT NOT NULL,
        messages    TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (agent, id)
    );",
];

fn none_on_no_rows<T>(e: rusqlite::Error) -> StoreResult<Option<T>> {
    match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other.into()),
    }
}

pub struct SqliteStore {
    /// `None` after `close()` — releases the file handle so data dirs can be
    /// removed promptly (Windows holds locks on open db files).
    conn: Arc<Mutex<Option<Connection>>>,
}

impl SqliteStore {
    pub fn open(path: &Path) -> StoreResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| StoreError::Other(format!("create data dir: {e}")))?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Self::migrate(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(Some(conn))),
        })
    }

    /// Close the underlying connection. Subsequent operations fail with
    /// "store closed". Safe to call more than once.
    pub fn close(&self) {
        if let Ok(mut guard) = self.conn.lock() {
            if let Some(conn) = guard.take() {
                let _ = conn.close();
            }
        }
    }

    fn migrate(conn: &Connection) -> StoreResult<()> {
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            conn.execute_batch(sql)?;
            conn.pragma_update(None, "user_version", (i + 1) as i64)?;
        }
        Ok(())
    }

    async fn with_conn<T, F>(&self, f: F) -> StoreResult<T>
    where
        F: FnOnce(&mut Connection) -> StoreResult<T> + Send + 'static,
        T: Send + 'static,
    {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = conn.lock().expect("store mutex poisoned");
            let conn = guard
                .as_mut()
                .ok_or_else(|| StoreError::Other("store closed".into()))?;
            f(conn)
        })
        .await?
    }

    /// Run a closure on the connection synchronously (JS-thread fast path).
    fn blocking<T>(&self, f: impl FnOnce(&mut Connection) -> StoreResult<T>) -> StoreResult<T> {
        let mut guard = self.conn.lock().expect("store mutex poisoned");
        let conn = guard
            .as_mut()
            .ok_or_else(|| StoreError::Other("store closed".into()))?;
        f(conn)
    }

    fn create_run_inner(conn: &Connection, run: NewRun) -> StoreResult<(String, bool)> {
        let now = now_ms();
        if let Some(key) = &run.idempotency_key {
            let existing: Option<String> = conn
                .query_row(
                    "SELECT id FROM runs WHERE workflow = ?1 AND idempotency_key = ?2",
                    params![run.workflow, key],
                    |r| r.get(0),
                )
                .map(Some)
                .or_else(none_on_no_rows)?;
            if let Some(id) = existing {
                return Ok((id, false));
            }
        }
        let id = uuid::Uuid::now_v7().to_string();
        let inserted = conn
            .prepare_cached(
                "INSERT INTO runs (id, workflow, status, input, version, idempotency_key,
                               parent_run_id, parent_step_id, created_at, updated_at)
             VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
             ON CONFLICT DO NOTHING",
            )?
            .execute(params![
                id,
                run.workflow,
                run.input,
                run.version,
                run.idempotency_key,
                run.parent_run_id,
                run.parent_step_id,
                now,
            ])?;
        if inserted == 0 {
            // Lost an idempotency race: fetch the winner.
            let existing: String = conn.query_row(
                "SELECT id FROM runs WHERE workflow = ?1 AND idempotency_key = ?2",
                params![run.workflow, run.idempotency_key],
                |r| r.get(0),
            )?;
            return Ok((existing, false));
        }
        Ok((id, true))
    }

    fn get_run_inner(conn: &Connection, id: &str) -> StoreResult<Option<RunRow>> {
        conn.query_row(
            "SELECT id, workflow, status, input, output, error, version,
                    parent_run_id, parent_step_id, wait_step_id, created_at, updated_at
             FROM runs WHERE id = ?1",
            params![id],
            |r| {
                Ok(RunRow {
                    id: r.get(0)?,
                    workflow: r.get(1)?,
                    status: r.get(2)?,
                    input: r.get(3)?,
                    output: r.get(4)?,
                    error: r.get(5)?,
                    version: r.get(6)?,
                    parent_run_id: r.get(7)?,
                    parent_step_id: r.get(8)?,
                    wait_step_id: r.get(9)?,
                    created_at: r.get(10)?,
                    updated_at: r.get(11)?,
                })
            },
        )
        .map(Some)
        .or_else(none_on_no_rows)
    }

    fn record_step_inner(
        conn: &Connection,
        run_id: &str,
        step_id: &str,
        kind: &str,
        result: Option<String>,
    ) -> StoreResult<()> {
        // Never overwrite a completed entry: effectively-once recording.
        conn.prepare_cached(
            "INSERT INTO steps (run_id, step_id, kind, status, result, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?5)
             ON CONFLICT(run_id, step_id) DO UPDATE
                 SET status = 1, result = excluded.result, kind = excluded.kind,
                     updated_at = excluded.updated_at
                 WHERE steps.status <> 1",
        )?
        .execute(params![run_id, step_id, kind, result, now_ms()])?;
        Ok(())
    }

    fn insert_job_row(conn: &Connection, job: &PushJob, now: i64) -> StoreResult<String> {
        let id = uuid::Uuid::now_v7().to_string();
        conn.prepare_cached(
            "INSERT INTO jobs (id, queue, payload, status, priority, attempt, max_attempts,
                               available_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, 0, ?4, 0, ?5, ?6, ?7, ?7)",
        )?
        .execute(params![
            id,
            job.queue,
            job.payload,
            job.priority,
            job.max_attempts.max(1),
            now + job.delay_ms.max(0),
            now,
        ])?;
        Ok(id)
    }

    /// The outbox core (P3.2), shared by emit_event_blocking and
    /// machine_send_blocking: inside the caller's transaction, persist the
    /// event, wake matching waiters, create `on:`-triggered runs + jobs.
    fn emit_in_tx(
        tx: &rusqlite::Transaction<'_>,
        name: &str,
        payload: &str,
        targets: Vec<TriggerTarget>,
        now: i64,
    ) -> StoreResult<EmitOutcome> {
        let event_id = uuid::Uuid::now_v7().to_string();
        let payload_value: serde_json::Value =
            serde_json::from_str(payload).unwrap_or(serde_json::Value::Null);

        tx.prepare_cached(
            "INSERT INTO events (id, name, payload, emitted_at) VALUES (?1, ?2, ?3, ?4)",
        )?
        .execute(params![event_id, name, payload, now])?;

        let candidates: Vec<(String, String, Option<String>, Option<String>)> = {
            let mut stmt = tx.prepare_cached(
                "SELECT id, workflow, wait_step_id, wait_match
                 FROM runs WHERE status = 2 AND wait_event = ?1",
            )?;
            let rows = stmt.query_map(params![name], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            out
        };
        let mut waiters = Vec::new();
        for (run_id, workflow, step_id, wait_match) in candidates {
            if !match_subset(wait_match.as_deref(), &payload_value) {
                continue;
            }
            tx.prepare_cached(
                "UPDATE runs SET status = 0, wait_event = NULL, wait_step_id = NULL,
                                 wait_match = NULL, wake_at = NULL, updated_at = ?1
                 WHERE id = ?2",
            )?
            .execute(params![now, run_id])?;
            let step_id = step_id.unwrap_or_default();
            Self::record_step_inner(
                tx,
                &run_id,
                &step_id,
                "waitForEvent",
                Some(format!(r#"{{"event":{payload}}}"#)),
            )?;
            Self::insert_job_row(tx, &workflow_execution_job(&workflow, &run_id, 0), now)?;
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
            let (run_id, created) = Self::create_run_inner(
                tx,
                NewRun {
                    workflow: target.workflow.clone(),
                    input: trigger_input.clone(),
                    version: target.version,
                    idempotency_key: None,
                    parent_run_id: None,
                    parent_step_id: None,
                },
            )?;
            if created {
                Self::insert_job_row(
                    tx,
                    &workflow_execution_job(&target.workflow, &run_id, 0),
                    now,
                )?;
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

    fn push_inner(conn: &mut Connection, jobs: Vec<PushJob>) -> StoreResult<Vec<String>> {
        let now = now_ms();
        let tx = conn.transaction()?;
        let mut ids = Vec::with_capacity(jobs.len());
        for job in &jobs {
            ids.push(Self::insert_job_row(&tx, job, now)?);
        }
        tx.commit()?;
        Ok(ids)
    }
}

#[async_trait]
impl Store for SqliteStore {
    async fn push(&self, jobs: Vec<PushJob>) -> StoreResult<Vec<String>> {
        self.with_conn(move |conn| Self::push_inner(conn, jobs))
            .await
    }

    fn push_blocking(&self, jobs: Vec<PushJob>) -> StoreResult<Vec<String>> {
        let mut guard = self.conn.lock().expect("store mutex poisoned");
        let conn = guard
            .as_mut()
            .ok_or_else(|| StoreError::Other("store closed".into()))?;
        Self::push_inner(conn, jobs)
    }

    async fn claim(&self, queue: &str, limit: u32, lease_ms: i64) -> StoreResult<Vec<ClaimedJob>> {
        let queue = queue.to_string();
        self.with_conn(move |conn| {
            let now = now_ms();
            let mut stmt = conn.prepare_cached(
                "UPDATE jobs
                 SET status = 1, attempt = attempt + 1, lease_until = ?1, updated_at = ?2
                 WHERE id IN (
                     SELECT id FROM jobs
                     WHERE queue = ?3 AND status = 0 AND available_at <= ?2
                     ORDER BY priority DESC, id ASC
                     LIMIT ?4
                 )
                 RETURNING id, queue, payload, attempt, max_attempts, priority",
            )?;
            let rows = stmt.query_map(params![now + lease_ms, now, queue, limit], |r| {
                Ok((
                    ClaimedJob {
                        id: r.get(0)?,
                        queue: r.get(1)?,
                        payload: r.get(2)?,
                        attempt: r.get::<_, i64>(3)? as u32,
                        max_attempts: r.get::<_, i64>(4)? as u32,
                    },
                    r.get::<_, i64>(5)?,
                ))
            })?;
            let mut jobs = Vec::new();
            for row in rows {
                jobs.push(row?);
            }
            // RETURNING does not preserve the subquery's ORDER BY — restore
            // dispatch order (priority DESC, id ASC) here.
            jobs.sort_by(|(a, pa), (b, pb)| pb.cmp(pa).then(a.id.cmp(&b.id)));
            Ok(jobs.into_iter().map(|(job, _)| job).collect())
        })
        .await
    }

    async fn ack(&self, id: &str) -> StoreResult<()> {
        let id = id.to_string();
        self.with_conn(move |conn| {
            conn.prepare_cached("DELETE FROM jobs WHERE id = ?1")?
                .execute(params![id])?;
            Ok(())
        })
        .await
    }

    async fn fail_retry(&self, id: &str, error: &str, available_at: i64) -> StoreResult<()> {
        let (id, error) = (id.to_string(), error.to_string());
        self.with_conn(move |conn| {
            conn.prepare_cached(
                "UPDATE jobs SET status = 0, available_at = ?1, last_error = ?2,
                                 lease_until = NULL, updated_at = ?3
                 WHERE id = ?4",
            )?
            .execute(params![available_at, error, now_ms(), id])?;
            Ok(())
        })
        .await
    }

    async fn fail_dead(&self, id: &str, error: &str) -> StoreResult<()> {
        let (id, error) = (id.to_string(), error.to_string());
        self.with_conn(move |conn| {
            conn.prepare_cached(
                "UPDATE jobs SET status = 3, last_error = ?1, lease_until = NULL, updated_at = ?2
                 WHERE id = ?3",
            )?
            .execute(params![error, now_ms(), id])?;
            Ok(())
        })
        .await
    }

    async fn renew_leases(&self, ids: Vec<String>, lease_until: i64) -> StoreResult<()> {
        self.with_conn(move |conn| {
            let tx = conn.transaction()?;
            {
                let mut stmt = tx.prepare_cached(
                    "UPDATE jobs SET lease_until = ?1, updated_at = ?2 WHERE id = ?3 AND status = 1",
                )?;
                let now = now_ms();
                for id in &ids {
                    stmt.execute(params![lease_until, now, id])?;
                }
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }

    async fn sweep_expired(&self, now: i64) -> StoreResult<u64> {
        self.with_conn(move |conn| {
            // Exhausted attempts -> dead.
            let dead = conn
                .prepare_cached(
                    "UPDATE jobs SET status = 3, lease_until = NULL,
                                     last_error = COALESCE(last_error, 'lease expired'),
                                     updated_at = ?1
                     WHERE status = 1 AND lease_until < ?1 AND attempt >= max_attempts",
                )?
                .execute(params![now])?;
            // Budget left -> immediately re-deliverable.
            let retried = conn
                .prepare_cached(
                    "UPDATE jobs SET status = 0, lease_until = NULL, available_at = ?1,
                                     updated_at = ?1
                     WHERE status = 1 AND lease_until < ?1",
                )?
                .execute(params![now])?;
            Ok((dead + retried) as u64)
        })
        .await
    }

    async fn pending_count(&self, queue: &str) -> StoreResult<u64> {
        let queue = queue.to_string();
        self.with_conn(move |conn| {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM jobs WHERE queue = ?1 AND status = 0",
                params![queue],
                |r| r.get(0),
            )?;
            Ok(n as u64)
        })
        .await
    }

    async fn active_count(&self, queue: &str) -> StoreResult<u64> {
        let queue = queue.to_string();
        self.with_conn(move |conn| {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM jobs WHERE queue = ?1 AND status IN (0, 1)",
                params![queue],
                |r| r.get(0),
            )?;
            Ok(n as u64)
        })
        .await
    }

    async fn dead_jobs(&self, queue: &str, limit: u32) -> StoreResult<Vec<DeadJob>> {
        let queue = queue.to_string();
        self.with_conn(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, queue, payload, attempt, last_error, created_at
                 FROM jobs WHERE queue = ?1 AND status = 3 ORDER BY updated_at DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![queue, limit], |r| {
                Ok(DeadJob {
                    id: r.get(0)?,
                    queue: r.get(1)?,
                    payload: r.get(2)?,
                    attempt: r.get::<_, i64>(3)? as u32,
                    last_error: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })?;
            let mut jobs = Vec::new();
            for row in rows {
                jobs.push(row?);
            }
            Ok(jobs)
        })
        .await
    }

    async fn requeue_dead(&self, ids: Vec<String>) -> StoreResult<u64> {
        self.with_conn(move |conn| {
            let now = now_ms();
            let mut changed = 0u64;
            let tx = conn.transaction()?;
            {
                let mut stmt = tx.prepare_cached(
                    "UPDATE jobs SET status = 0, attempt = 0, last_error = NULL,
                                     available_at = ?1, updated_at = ?1
                     WHERE id = ?2 AND status = 3",
                )?;
                for id in ids {
                    changed += stmt.execute(params![now, id])? as u64;
                }
            }
            tx.commit()?;
            Ok(changed)
        })
        .await
    }

    // -- Workflow runs + step journal (P2) ---------------------------------

    async fn create_run(&self, run: NewRun) -> StoreResult<(String, bool)> {
        self.with_conn(move |conn| Self::create_run_inner(conn, run))
            .await
    }

    fn create_run_blocking(&self, run: NewRun) -> StoreResult<(String, bool)> {
        self.blocking(|conn| Self::create_run_inner(conn, run))
    }

    async fn get_run(&self, id: &str) -> StoreResult<Option<RunRow>> {
        let id = id.to_string();
        self.with_conn(move |conn| Self::get_run_inner(conn, &id))
            .await
    }

    fn get_run_blocking(&self, id: &str) -> StoreResult<Option<RunRow>> {
        self.blocking(|conn| Self::get_run_inner(conn, id))
    }

    async fn load_journal(&self, run_id: &str) -> StoreResult<Vec<StepEntry>> {
        let run_id = run_id.to_string();
        self.with_conn(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT step_id, kind, result FROM steps WHERE run_id = ?1 AND status = 1",
            )?;
            let rows = stmt.query_map(params![run_id], |r| {
                Ok(StepEntry {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    result: r.get(2)?,
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
        .await
    }

    async fn record_step(
        &self,
        run_id: &str,
        step_id: &str,
        kind: &str,
        result: Option<String>,
    ) -> StoreResult<()> {
        let (run_id, step_id, kind) = (run_id.to_string(), step_id.to_string(), kind.to_string());
        self.with_conn(move |conn| Self::record_step_inner(conn, &run_id, &step_id, &kind, result))
            .await
    }

    fn record_step_blocking(
        &self,
        run_id: &str,
        step_id: &str,
        kind: &str,
        result: Option<String>,
    ) -> StoreResult<()> {
        self.blocking(|conn| Self::record_step_inner(conn, run_id, step_id, kind, result))
    }

    async fn step_failed_attempt(
        &self,
        run_id: &str,
        step_id: &str,
        error: &str,
    ) -> StoreResult<u32> {
        let (run_id, step_id, error) = (run_id.to_string(), step_id.to_string(), error.to_string());
        self.with_conn(move |conn| {
            let attempts: i64 = conn.query_row(
                "INSERT INTO steps (run_id, step_id, kind, status, error, attempts, updated_at)
                 VALUES (?1, ?2, 'run', 0, ?3, 1, ?4)
                 ON CONFLICT(run_id, step_id) DO UPDATE
                     SET attempts = steps.attempts + 1, error = excluded.error,
                         updated_at = excluded.updated_at
                 RETURNING attempts",
                params![run_id, step_id, error, now_ms()],
                |r| r.get(0),
            )?;
            Ok(attempts as u32)
        })
        .await
    }

    async fn run_completed(&self, id: &str, output: Option<String>) -> StoreResult<()> {
        let id = id.to_string();
        self.with_conn(move |conn| {
            conn.prepare_cached(
                "UPDATE runs SET status = 4, output = ?1, wait_event = NULL,
                                 wait_step_id = NULL, wake_at = NULL, updated_at = ?2
                 WHERE id = ?3",
            )?
            .execute(params![output, now_ms(), id])?;
            Ok(())
        })
        .await
    }

    async fn run_failed(&self, id: &str, error: &str) -> StoreResult<()> {
        let (id, error) = (id.to_string(), error.to_string());
        self.with_conn(move |conn| {
            conn.prepare_cached(
                "UPDATE runs SET status = 5, error = ?1, wait_event = NULL,
                                 wait_step_id = NULL, wake_at = NULL, updated_at = ?2
                 WHERE id = ?3",
            )?
            .execute(params![error, now_ms(), id])?;
            Ok(())
        })
        .await
    }

    async fn run_sleeping(&self, id: &str, wake_at: i64) -> StoreResult<()> {
        let id = id.to_string();
        self.with_conn(move |conn| {
            conn.prepare_cached(
                "UPDATE runs SET status = 1, wake_at = ?1, updated_at = ?2 WHERE id = ?3",
            )?
            .execute(params![wake_at, now_ms(), id])?;
            Ok(())
        })
        .await
    }

    async fn run_waiting_event(
        &self,
        id: &str,
        event: &str,
        step_id: &str,
        timeout_at: Option<i64>,
        match_json: Option<String>,
    ) -> StoreResult<()> {
        let (id, event, step_id) = (id.to_string(), event.to_string(), step_id.to_string());
        self.with_conn(move |conn| {
            conn.prepare_cached(
                "UPDATE runs SET status = 2, wait_event = ?1, wait_step_id = ?2,
                                 wake_at = ?3, wait_match = ?4, updated_at = ?5
                 WHERE id = ?6",
            )?
            .execute(params![
                event,
                step_id,
                timeout_at,
                match_json,
                now_ms(),
                id
            ])?;
            Ok(())
        })
        .await
    }

    async fn run_waiting_child(&self, id: &str) -> StoreResult<()> {
        let id = id.to_string();
        self.with_conn(move |conn| {
            conn.prepare_cached("UPDATE runs SET status = 3, updated_at = ?1 WHERE id = ?2")?
                .execute(params![now_ms(), id])?;
            Ok(())
        })
        .await
    }

    async fn wake_parent(&self, parent_run_id: &str) -> StoreResult<bool> {
        let id = parent_run_id.to_string();
        self.with_conn(move |conn| {
            let changed = conn
                .prepare_cached(
                    "UPDATE runs SET status = 0, updated_at = ?1 WHERE id = ?2 AND status = 3",
                )?
                .execute(params![now_ms(), id])?;
            Ok(changed > 0)
        })
        .await
    }

    fn emit_event_blocking(
        &self,
        name: &str,
        payload: &str,
        targets: Vec<TriggerTarget>,
    ) -> StoreResult<EmitOutcome> {
        self.blocking(|conn| {
            let tx = conn.transaction()?;
            let outcome = Self::emit_in_tx(&tx, name, payload, targets, now_ms())?;
            tx.commit()?;
            Ok(outcome)
        })
    }

    fn machine_create_blocking(&self, machine: &str, id: &str, initial: &str) -> StoreResult<bool> {
        self.blocking(|conn| {
            let now = now_ms();
            let inserted = conn
                .prepare_cached(
                    "INSERT INTO machine_instances (machine, id, state, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT DO NOTHING",
                )?
                .execute(params![machine, id, initial, now])?;
            Ok(inserted > 0)
        })
    }

    fn machine_state_blocking(&self, machine: &str, id: &str) -> StoreResult<Option<String>> {
        self.blocking(|conn| {
            conn.query_row(
                "SELECT state FROM machine_instances WHERE machine = ?1 AND id = ?2",
                params![machine, id],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(none_on_no_rows)
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
        self.blocking(|conn| {
            let now = now_ms();
            let tx = conn.transaction()?;
            let changed = tx
                .prepare_cached(
                    "UPDATE machine_instances SET state = ?1, updated_at = ?2
                     WHERE machine = ?3 AND id = ?4 AND state = ?5",
                )?
                .execute(params![to, now, machine, id, from])?;
            if changed == 0 {
                // Race: someone else transitioned first. Nothing committed.
                return Ok(None);
            }
            tx.prepare_cached(
                "INSERT INTO machine_history (machine, instance_id, from_state, event, to_state, at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?
            .execute(params![machine, id, from, event, to, now])?;
            // Transition + event + triggered runs commit together — no
            // transition-without-event crash window.
            let outcome = Self::emit_in_tx(&tx, event_name, payload, targets, now)?;
            tx.commit()?;
            Ok(Some(outcome))
        })
    }

    fn machine_history_blocking(
        &self,
        machine: &str,
        id: &str,
        limit: u32,
    ) -> StoreResult<Vec<MachineHistoryRow>> {
        self.blocking(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT from_state, event, to_state, at FROM machine_history
                 WHERE machine = ?1 AND instance_id = ?2 ORDER BY at DESC, rowid DESC LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![machine, id, limit], |r| {
                Ok(MachineHistoryRow {
                    from_state: r.get(0)?,
                    event: r.get(1)?,
                    to_state: r.get(2)?,
                    at: r.get(3)?,
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
    }

    fn agent_session_get_blocking(&self, agent: &str, id: &str) -> StoreResult<Option<String>> {
        self.blocking(|conn| {
            conn.query_row(
                "SELECT messages FROM agent_sessions WHERE agent = ?1 AND id = ?2",
                params![agent, id],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(none_on_no_rows)
        })
    }

    fn agent_session_put_blocking(&self, agent: &str, id: &str, messages: &str) -> StoreResult<()> {
        self.blocking(|conn| {
            let now = now_ms();
            conn.prepare_cached(
                "INSERT INTO agent_sessions (agent, id, messages, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(agent, id) DO UPDATE
                     SET messages = excluded.messages, updated_at = excluded.updated_at",
            )?
            .execute(params![agent, id, messages, now])?;
            Ok(())
        })
    }

    async fn runs_list(
        &self,
        workflow: Option<String>,
        status: Option<i64>,
        limit: u32,
    ) -> StoreResult<Vec<RunRow>> {
        self.with_conn(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, workflow, status, input, output, error, version,
                        parent_run_id, parent_step_id, wait_step_id, created_at, updated_at
                 FROM runs
                 WHERE (?1 IS NULL OR workflow = ?1) AND (?2 IS NULL OR status = ?2)
                 ORDER BY created_at DESC LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![workflow, status, limit], |r| {
                Ok(RunRow {
                    id: r.get(0)?,
                    workflow: r.get(1)?,
                    status: r.get(2)?,
                    input: r.get(3)?,
                    output: r.get(4)?,
                    error: r.get(5)?,
                    version: r.get(6)?,
                    parent_run_id: r.get(7)?,
                    parent_step_id: r.get(8)?,
                    wait_step_id: r.get(9)?,
                    created_at: r.get(10)?,
                    updated_at: r.get(11)?,
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
        .await
    }

    async fn steps_for_run(&self, run_id: &str) -> StoreResult<Vec<StepRow>> {
        let run_id = run_id.to_string();
        self.with_conn(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT step_id, kind, status, result, error, attempts, updated_at
                 FROM steps WHERE run_id = ?1 ORDER BY updated_at ASC, rowid ASC",
            )?;
            let rows = stmt.query_map(params![run_id], |r| {
                Ok(StepRow {
                    step_id: r.get(0)?,
                    kind: r.get(1)?,
                    status: r.get(2)?,
                    result: r.get(3)?,
                    error: r.get(4)?,
                    attempts: r.get::<_, i64>(5)? as u32,
                    updated_at: r.get(6)?,
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
        .await
    }

    async fn queue_stats(&self) -> StoreResult<Vec<QueueStat>> {
        self.with_conn(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT queue,
                        SUM(CASE WHEN status = 0 THEN 1 ELSE 0 END),
                        SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END),
                        SUM(CASE WHEN status = 3 THEN 1 ELSE 0 END)
                 FROM jobs GROUP BY queue ORDER BY queue",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(QueueStat {
                    queue: r.get(0)?,
                    pending: r.get::<_, i64>(1)? as u64,
                    running: r.get::<_, i64>(2)? as u64,
                    dead: r.get::<_, i64>(3)? as u64,
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
        .await
    }

    async fn all_schedules(&self) -> StoreResult<Vec<ScheduleRow>> {
        self.with_conn(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT name, spec, overlap, catchup, next_run_at, last_run_at
                 FROM schedules ORDER BY name",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(ScheduleRow {
                    name: r.get(0)?,
                    spec: r.get(1)?,
                    overlap: r.get(2)?,
                    catchup: r.get(3)?,
                    next_run_at: r.get(4)?,
                    last_run_at: r.get(5)?,
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
        .await
    }

    async fn recent_events(&self, limit: u32) -> StoreResult<Vec<EventRow>> {
        self.with_conn(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, name, payload, emitted_at FROM events
                 ORDER BY emitted_at DESC, id DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit], |r| {
                Ok(EventRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    payload: r.get(2)?,
                    emitted_at: r.get(3)?,
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
        .await
    }

    async fn sweep_event_timeouts(&self, now: i64) -> StoreResult<Vec<Waiter>> {
        self.with_conn(move |conn| {
            let mut stmt = conn.prepare_cached(
                "UPDATE runs SET status = 0, wait_event = NULL, wait_match = NULL,
                                 wake_at = NULL, updated_at = ?1
                 WHERE status = 2 AND wake_at IS NOT NULL AND wake_at <= ?1
                 RETURNING id, workflow, wait_step_id",
            )?;
            let rows = stmt.query_map(params![now], |r| {
                Ok(Waiter {
                    run_id: r.get(0)?,
                    workflow: r.get(1)?,
                    step_id: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
        .await
    }

    fn cancel_run_tree_blocking(&self, root_run_id: &str) -> StoreResult<u32> {
        self.blocking(|conn| {
            let tx = conn.transaction()?;
            let mut cancelled = 0u32;
            let mut frontier = vec![root_run_id.to_string()];
            while let Some(id) = frontier.pop() {
                let changed = tx
                    .prepare_cached(
                        "UPDATE runs SET status = 6, wait_event = NULL, wait_step_id = NULL,
                                         wake_at = NULL, updated_at = ?1
                         WHERE id = ?2 AND status NOT IN (4, 5, 6)",
                    )?
                    .execute(params![now_ms(), id])?;
                cancelled += changed as u32;
                if changed > 0 {
                    let mut stmt =
                        tx.prepare_cached("SELECT id FROM runs WHERE parent_run_id = ?1")?;
                    let children = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
                    for child in children {
                        frontier.push(child?);
                    }
                }
            }
            tx.commit()?;
            Ok(cancelled)
        })
    }

    async fn upsert_schedule(&self, row: ScheduleRow) -> StoreResult<ScheduleRow> {
        self.with_conn(move |conn| {
            let existing: Option<(String, i64, Option<i64>)> = conn
                .query_row(
                    "SELECT spec, next_run_at, last_run_at FROM schedules WHERE name = ?1",
                    params![row.name],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other),
                })?;

            let (next_run_at, last_run_at) = match &existing {
                // Same spec: keep stored timing across restarts.
                Some((spec, next, last)) if *spec == row.spec => (*next, *last),
                // New or changed spec: take the freshly computed next.
                _ => (row.next_run_at, None),
            };

            conn.prepare_cached(
                "INSERT INTO schedules (name, spec, overlap, catchup, next_run_at, last_run_at, enabled)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
                 ON CONFLICT(name) DO UPDATE SET
                     spec = excluded.spec, overlap = excluded.overlap,
                     catchup = excluded.catchup, next_run_at = excluded.next_run_at,
                     last_run_at = excluded.last_run_at, enabled = 1",
            )?
            .execute(params![
                row.name,
                row.spec,
                row.overlap,
                row.catchup,
                next_run_at,
                last_run_at
            ])?;

            Ok(ScheduleRow {
                next_run_at,
                last_run_at,
                ..row
            })
        })
        .await
    }

    async fn due_schedules(&self, now: i64) -> StoreResult<Vec<ScheduleRow>> {
        self.with_conn(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT name, spec, overlap, catchup, next_run_at, last_run_at
                 FROM schedules WHERE enabled = 1 AND next_run_at <= ?1",
            )?;
            let rows = stmt.query_map(params![now], |r| {
                Ok(ScheduleRow {
                    name: r.get(0)?,
                    spec: r.get(1)?,
                    overlap: r.get(2)?,
                    catchup: r.get(3)?,
                    next_run_at: r.get(4)?,
                    last_run_at: r.get(5)?,
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
        .await
    }

    async fn set_schedule_next(
        &self,
        name: &str,
        next_run_at: i64,
        last_run_at: Option<i64>,
    ) -> StoreResult<()> {
        let name = name.to_string();
        self.with_conn(move |conn| {
            conn.prepare_cached(
                "UPDATE schedules SET next_run_at = ?1,
                                      last_run_at = COALESCE(?2, last_run_at)
                 WHERE name = ?3",
            )?
            .execute(params![next_run_at, last_run_at, name])?;
            Ok(())
        })
        .await
    }

    async fn schedule_claim_tick(
        &self,
        name: &str,
        observed_next: i64,
        new_next: i64,
        fired_at: i64,
    ) -> StoreResult<bool> {
        let name = name.to_string();
        self.with_conn(move |conn| {
            let changed = conn
                .prepare_cached(
                    "UPDATE schedules SET next_run_at = ?1, last_run_at = ?2
                     WHERE name = ?3 AND next_run_at = ?4",
                )?
                .execute(params![new_next, fired_at, name, observed_next])?;
            Ok(changed > 0)
        })
        .await
    }

    fn close_blocking(&self) {
        self.close();
    }
}

// Touch the status module so the constants stay referenced from this crate.
#[allow(dead_code)]
const _: i64 = status::PENDING;
