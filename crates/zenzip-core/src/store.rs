//! Storage abstraction (P1.1). Two planned implementations: SQLite (embedded
//! default, this phase) and PostgreSQL (multi-node, Phase 5).
//!
//! Delivery semantics: at-least-once. A claimed job holds a lease
//! (`lease_until`); if the worker dies without ack/nack, the sweeper returns
//! the job to `pending` (or `dead` once attempts are exhausted).

use async_trait::async_trait;
use serde::Serialize;

pub type StoreResult<T> = Result<T, StoreError>;

#[derive(thiserror::Error, Debug)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("task join error: {0}")]
    Join(#[from] tokio::task::JoinError),
    #[error("{0}")]
    Other(String),
}

/// Job statuses as persisted in the `status` column.
pub mod status {
    pub const PENDING: i64 = 0;
    pub const RUNNING: i64 = 1;
    // 2 reserved for DONE (jobs are deleted on ack in Phase 1; a
    // keep-completed option will use this).
    pub const DEAD: i64 = 3;
}

/// Workflow run statuses (P2.1).
pub mod run_status {
    /// Claimable by the workflow queue handler (incl. retry re-enqueues).
    pub const RUNNABLE: i64 = 0;
    /// Suspended in step.sleep — woken by the delayed execution job.
    pub const SLEEPING: i64 = 1;
    /// Suspended in step.waitForEvent — woken by emit or timeout sweep.
    pub const WAIT_EVENT: i64 = 2;
    /// Suspended in step.invoke — woken by child completion.
    pub const WAIT_CHILD: i64 = 3;
    pub const COMPLETED: i64 = 4;
    pub const FAILED: i64 = 5;
    pub const CANCELLED: i64 = 6;
}

#[derive(Debug, Clone, Default)]
pub struct PushJob {
    pub queue: String,
    /// JSON-encoded payload, opaque to the store.
    pub payload: String,
    pub priority: i32,
    pub delay_ms: i64,
    pub max_attempts: u32,
    /// Per-key concurrency bucket (P10.1): at most `concurrency_key_limit` jobs
    /// with the same key run at once. None = unbounded (global limit only).
    pub concurrency_key: Option<String>,
    /// Debounce bucket (P10.2): pushing with a key deletes any pending job with
    /// the same key first, so only the latest (delayed by its window) runs.
    pub debounce_key: Option<String>,
    /// Throttle bucket (P10.2): pushing with a key spaces this job's
    /// `available_at` by `throttle_spacing_ms` after the key's last scheduled
    /// job, smoothing starts to a steady per-key rate (cross-node via a cursor).
    pub throttle_key: Option<String>,
    pub throttle_spacing_ms: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ClaimedJob {
    pub id: String,
    pub queue: String,
    pub payload: String,
    /// 1-based attempt number (incremented at claim time).
    pub attempt: u32,
    pub max_attempts: u32,
    /// Monotonic fencing token, bumped on every claim (P7.11). The worker
    /// presents it on ack/fail/renew; a stale token (a job re-claimed by
    /// another worker after lease expiry) is rejected — a zombie's late write
    /// can't clobber the new owner.
    pub fence: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadJob {
    pub id: String,
    pub queue: String,
    pub payload: String,
    pub attempt: u32,
    pub last_error: Option<String>,
    pub created_at: i64,
}

// ---------------------------------------------------------------------------
// Workflow runs + step journal (P2.1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct NewRun {
    pub workflow: String,
    /// JSON input.
    pub input: String,
    pub version: Option<String>,
    pub idempotency_key: Option<String>,
    pub parent_run_id: Option<String>,
    pub parent_step_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    pub workflow: String,
    pub status: i64,
    pub input: String,
    pub output: Option<String>,
    pub error: Option<String>,
    pub version: Option<String>,
    pub parent_run_id: Option<String>,
    pub parent_step_id: Option<String>,
    pub wait_step_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Completed journal entry handed to the executor for fast-forward.
#[derive(Debug, Clone, Serialize)]
pub struct StepEntry {
    pub id: String,
    pub kind: String,
    /// JSON result (None for void steps like sleep).
    pub result: Option<String>,
}

/// A run released from waitForEvent by an emit or a timeout sweep.
#[derive(Debug, Clone)]
pub struct Waiter {
    pub run_id: String,
    pub workflow: String,
    pub step_id: String,
}

// ---------------------------------------------------------------------------
// Event bus (P3.1, P3.2) + state machines (P3.5) + introspection (P3.13)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRow {
    pub id: String,
    pub name: String,
    pub payload: String,
    pub emitted_at: i64,
}

/// A workflow registered with an `on:` pattern matching the emitted event.
#[derive(Debug, Clone)]
pub struct TriggerTarget {
    pub workflow: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TriggeredRun {
    pub workflow: String,
    pub run_id: String,
}

#[derive(Debug, Clone)]
pub struct EmitOutcome {
    pub event_id: String,
    pub waiters: Vec<Waiter>,
    pub triggered: Vec<TriggeredRun>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineHistoryRow {
    pub from_state: String,
    pub event: String,
    pub to_state: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRow {
    pub step_id: String,
    pub kind: String,
    pub status: i64,
    pub result: Option<String>,
    pub error: Option<String>,
    pub attempts: u32,
    pub updated_at: i64,
}

/// Rows removed by a retention GC pass (P7.6).
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcStats {
    pub runs: u64,
    pub steps: u64,
    pub events: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStat {
    pub queue: String,
    pub pending: u64,
    pub running: u64,
    pub dead: u64,
}

#[derive(Debug, Clone)]
pub struct ScheduleRow {
    pub name: String,
    /// Canonical spec string (e.g. `cron:0 9 * * *@UTC` or `every:30000`),
    /// used to detect definition changes across restarts.
    pub spec: String,
    pub overlap: String,
    pub catchup: String,
    pub next_run_at: i64,
    pub last_run_at: Option<i64>,
}

/// Hidden queue carrying a workflow's execution jobs (one engine).
pub fn workflow_queue_name(name: &str) -> String {
    format!("zenzip.workflow.{name}")
}

/// The job that drives one execution attempt of a run.
pub fn workflow_execution_job(workflow: &str, run_id: &str, delay_ms: i64) -> PushJob {
    PushJob {
        queue: workflow_queue_name(workflow),
        payload: format!(r#"{{"runId":"{run_id}"}}"#),
        priority: 0,
        delay_ms,
        // Infra retries for the attempt itself; step retries are engine-managed.
        max_attempts: 3,
        concurrency_key: None,
        debounce_key: None,
        throttle_key: None,
        throttle_spacing_ms: None,
    }
}

#[async_trait]
pub trait Store: Send + Sync + 'static {
    async fn push(&self, jobs: Vec<PushJob>) -> StoreResult<Vec<String>>;
    /// Synchronous push for the JS-thread fast path (sync NAPI call; a WAL
    /// insert is tens of microseconds — see spike results).
    fn push_blocking(&self, jobs: Vec<PushJob>) -> StoreResult<Vec<String>>;

    /// Atomically claim up to `limit` ready jobs: pending, available, ordered
    /// by priority DESC then id ASC. Increments `attempt`, sets the lease.
    /// `key_limit` (P10.1): when set, a job is only claimed if fewer than
    /// `key_limit` jobs with its `concurrency_key` are already running.
    async fn claim(
        &self,
        queue: &str,
        limit: u32,
        lease_ms: i64,
        key_limit: Option<u32>,
        fair: bool,
    ) -> StoreResult<Vec<ClaimedJob>>;
    /// Ack a job, guarded by its fencing token (P7.11): a stale fence (the job
    /// was re-claimed elsewhere) is a no-op.
    async fn ack(&self, id: &str, fence: i64) -> StoreResult<()>;
    /// Failure with retry budget left: back to pending at `available_at`.
    /// Fence-guarded.
    async fn fail_retry(&self, id: &str, error: &str, available_at: i64, fence: i64)
        -> StoreResult<()>;
    /// Failure with attempts exhausted: dead-letter the job. Fence-guarded.
    async fn fail_dead(&self, id: &str, error: &str, fence: i64) -> StoreResult<()>;
    /// Renew leases for in-flight jobs, each guarded by its fence token. Takes
    /// the lease *duration* (ms), not an absolute time: the Postgres backend
    /// computes the new `lease_until` from server time so a skewed worker clock
    /// can't mis-set it (P7.12).
    async fn renew_leases(&self, leases: Vec<(String, i64)>, lease_ms: i64) -> StoreResult<()>;
    /// Cheap reachability probe for readiness checks (P7.7): a trivial query
    /// that confirms the backend is connected and answering.
    async fn ping(&self) -> StoreResult<()>;

    /// Return lease-expired running jobs to pending (or dead if exhausted).
    /// Returns number of jobs transitioned.
    async fn sweep_expired(&self, now: i64) -> StoreResult<u64>;

    /// Retention GC (P7.6): delete terminal runs (COMPLETED/FAILED/CANCELLED)
    /// and their step journal whose `updated_at` predates `run_before`, and
    /// events whose `emitted_at` predates `event_before`. `None` skips that
    /// category (keep forever). One transaction; returns rows removed.
    async fn gc(&self, run_before: Option<i64>, event_before: Option<i64>) -> StoreResult<GcStats>;

    async fn pending_count(&self, queue: &str) -> StoreResult<u64>;
    /// pending + running, used for schedule overlap=skip.
    async fn active_count(&self, queue: &str) -> StoreResult<u64>;
    async fn dead_jobs(&self, queue: &str, limit: u32) -> StoreResult<Vec<DeadJob>>;
    async fn requeue_dead(&self, ids: Vec<String>) -> StoreResult<u64>;
    /// Bulk control-plane op (P14.1): permanently delete all dead-lettered jobs
    /// for a queue. Returns the number removed.
    async fn purge_dead(&self, queue: &str) -> StoreResult<u64>;

    // -- Workflow runs + step journal (P2) ---------------------------------

    /// Create a run. With an idempotency key, a duplicate returns the
    /// existing run id with `created = false`. Blocking variant exists for
    /// the sync NAPI trigger path.
    async fn create_run(&self, run: NewRun) -> StoreResult<(String, bool)>;
    fn create_run_blocking(&self, run: NewRun) -> StoreResult<(String, bool)>;

    async fn get_run(&self, id: &str) -> StoreResult<Option<RunRow>>;
    fn get_run_blocking(&self, id: &str) -> StoreResult<Option<RunRow>>;

    /// Completed steps only — the executor's fast-forward journal.
    async fn load_journal(&self, run_id: &str) -> StoreResult<Vec<StepEntry>>;

    /// Record a completed step. Idempotent; never overwrites a completed
    /// entry (effectively-once recording).
    async fn record_step(
        &self,
        run_id: &str,
        step_id: &str,
        kind: &str,
        result: Option<String>,
    ) -> StoreResult<()>;
    fn record_step_blocking(
        &self,
        run_id: &str,
        step_id: &str,
        kind: &str,
        result: Option<String>,
    ) -> StoreResult<()>;

    /// Bump the step's failed-attempt counter; returns the new count.
    async fn step_failed_attempt(
        &self,
        run_id: &str,
        step_id: &str,
        error: &str,
    ) -> StoreResult<u32>;

    async fn run_completed(&self, id: &str, output: Option<String>) -> StoreResult<()>;
    async fn run_failed(&self, id: &str, error: &str) -> StoreResult<()>;
    async fn run_sleeping(&self, id: &str, wake_at: i64) -> StoreResult<()>;
    async fn run_waiting_event(
        &self,
        id: &str,
        event: &str,
        step_id: &str,
        timeout_at: Option<i64>,
        match_json: Option<String>,
    ) -> StoreResult<()>;
    async fn run_waiting_child(&self, id: &str) -> StoreResult<()>;

    /// Atomically release a parent from WAIT_CHILD (guard against double
    /// wake). Returns true if the transition happened.
    async fn wake_parent(&self, parent_run_id: &str) -> StoreResult<bool>;

    /// Atomic event emit — the outbox (P3.2). In ONE transaction: persist the
    /// event, release matching waitForEvent waiters (respecting their match
    /// predicates), record their step results, create runs for `on:` trigger
    /// targets, and insert all execution jobs. Crash-safe by construction.
    fn emit_event_blocking(
        &self,
        name: &str,
        payload: &str,
        targets: Vec<TriggerTarget>,
    ) -> StoreResult<EmitOutcome>;

    // -- State machines (P3.5–P3.7) ----------------------------------------

    /// Create an instance in the initial state. False if it already exists.
    fn machine_create_blocking(&self, machine: &str, id: &str, initial: &str) -> StoreResult<bool>;
    fn machine_state_blocking(&self, machine: &str, id: &str) -> StoreResult<Option<String>>;
    /// Optimistic transition + event emit in ONE transaction: state moves
    /// from `from` to `to`, history is appended, and `event_name` is emitted
    /// through the outbox (waking waiters, creating triggered runs). Returns
    /// None when the current state was no longer `from` (race — caller
    /// retries). Closes the transition-without-event crash window.
    #[allow(clippy::too_many_arguments)]
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
    ) -> StoreResult<Option<EmitOutcome>>;
    fn machine_history_blocking(
        &self,
        machine: &str,
        id: &str,
        limit: u32,
    ) -> StoreResult<Vec<MachineHistoryRow>>;

    // -- Agent sessions (P4.7) ---------------------------------------------

    /// Conversation JSON for an agent session, if any.
    fn agent_session_get_blocking(&self, agent: &str, id: &str) -> StoreResult<Option<String>>;
    /// Upsert the conversation JSON for an agent session.
    fn agent_session_put_blocking(&self, agent: &str, id: &str, messages: &str) -> StoreResult<()>;

    // -- Introspection for the dashboard (P3.13) ---------------------------

    async fn runs_list(
        &self,
        workflow: Option<String>,
        status: Option<i64>,
        limit: u32,
    ) -> StoreResult<Vec<RunRow>>;
    async fn steps_for_run(&self, run_id: &str) -> StoreResult<Vec<StepRow>>;
    async fn queue_stats(&self) -> StoreResult<Vec<QueueStat>>;
    async fn all_schedules(&self) -> StoreResult<Vec<ScheduleRow>>;
    async fn recent_events(&self, limit: u32) -> StoreResult<Vec<EventRow>>;

    /// Release event waiters whose timeout passed. Returns the released runs.
    async fn sweep_event_timeouts(&self, now: i64) -> StoreResult<Vec<Waiter>>;

    /// Cancel a run and all its descendants (non-terminal only). Returns the
    /// number of runs cancelled.
    fn cancel_run_tree_blocking(&self, root_run_id: &str) -> StoreResult<u32>;

    /// Insert or update a schedule. If a row exists with the same `spec`,
    /// its `next_run_at`/`last_run_at` are preserved (restart continuity).
    /// Returns the effective stored row.
    async fn upsert_schedule(&self, row: ScheduleRow) -> StoreResult<ScheduleRow>;
    async fn due_schedules(&self, now: i64) -> StoreResult<Vec<ScheduleRow>>;
    async fn set_schedule_next(
        &self,
        name: &str,
        next_run_at: i64,
        last_run_at: Option<i64>,
    ) -> StoreResult<()>;

    /// CAS tick claim (P5.1 scheduler election): advance next_run_at from the
    /// observed value to `new_next`. True = this node won the tick; false =
    /// another node already claimed it. Replaces advisory locks — works
    /// identically on SQLite (single-node) and Postgres (multi-node).
    async fn schedule_claim_tick(
        &self,
        name: &str,
        observed_next: i64,
        new_next: i64,
        fired_at: i64,
    ) -> StoreResult<bool>;

    /// Release backend resources (file handles / connection pools). Safe to
    /// call more than once; subsequent operations fail with "store closed".
    fn close_blocking(&self);
}
