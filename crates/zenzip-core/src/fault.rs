//! Deterministic fault-injection harness (P7.14). `FaultStore` wraps any
//! `Store` and injects controllable faults — fail the next N calls to a
//! method, or delay every call — so chaos that used to need spawned processes
//! and `kill -9` becomes a repeatable `cargo test`. Faulting the store models
//! the failure modes that matter: a flaky/slow database, a lost write, a
//! transient claim error.
//!
//! Use from tests:
//! ```ignore
//! let (store, faults) = FaultStore::wrap(SqliteStore::open(path)?.into());
//! faults.fail_next("claim", 2);   // next two claims return an error
//! faults.set_delay_ms(50);        // every store call sleeps 50ms first
//! ```

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;

use crate::store::{
    ClaimedJob, DeadJob, EmitOutcome, EventRow, GcStats, MachineHistoryRow, NewRun, PushJob,
    QueueStat, RunRow, ScheduleRow, StepEntry, StepRow, Store, StoreError, StoreResult,
    TriggerTarget, Waiter,
};

/// Controls the faults a `FaultStore` injects. Cheap to clone (Arc inside).
#[derive(Default)]
pub struct FaultController {
    /// method name -> remaining failures to inject.
    fail: Mutex<HashMap<String, u32>>,
    delay_ms: AtomicU64,
}

impl FaultController {
    /// Make the next `n` calls to `method` return an injected error.
    pub fn fail_next(&self, method: &str, n: u32) {
        self.fail.lock().unwrap().insert(method.to_string(), n);
    }

    /// Sleep this many ms before every faultable call (models a slow store).
    pub fn set_delay_ms(&self, ms: u64) {
        self.delay_ms.store(ms, Ordering::Relaxed);
    }

    fn take_failure(&self, method: &str) -> bool {
        let mut guard = self.fail.lock().unwrap();
        match guard.get_mut(method) {
            Some(c) if *c > 0 => {
                *c -= 1;
                true
            }
            _ => false,
        }
    }
}

/// A `Store` decorator that injects faults on the chaos-relevant async paths
/// (claim / push / ack / fail / renew / sweep / record_step). Everything else
/// is a transparent passthrough.
pub struct FaultStore {
    inner: Arc<dyn Store>,
    ctrl: Arc<FaultController>,
}

impl FaultStore {
    /// Wrap an inner store. Returns the wrapped store and a controller handle.
    pub fn wrap(inner: Arc<dyn Store>) -> (Arc<dyn Store>, Arc<FaultController>) {
        let ctrl = Arc::new(FaultController::default());
        let store: Arc<dyn Store> = Arc::new(Self {
            inner,
            ctrl: ctrl.clone(),
        });
        (store, ctrl)
    }

    async fn gate(&self, method: &str) -> StoreResult<()> {
        let delay = self.ctrl.delay_ms.load(Ordering::Relaxed);
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        if self.ctrl.take_failure(method) {
            return Err(StoreError::Other(format!("injected fault: {method}")));
        }
        Ok(())
    }
}

#[async_trait]
impl Store for FaultStore {
    // -- Faultable paths ---------------------------------------------------
    async fn push(&self, jobs: Vec<PushJob>) -> StoreResult<Vec<String>> {
        self.gate("push").await?;
        self.inner.push(jobs).await
    }
    async fn claim(
        &self,
        queue: &str,
        limit: u32,
        lease_ms: i64,
        key_limit: Option<u32>,
        fair: bool,
    ) -> StoreResult<Vec<ClaimedJob>> {
        self.gate("claim").await?;
        self.inner.claim(queue, limit, lease_ms, key_limit, fair).await
    }
    async fn ack(&self, id: &str, fence: i64) -> StoreResult<()> {
        self.gate("ack").await?;
        self.inner.ack(id, fence).await
    }
    async fn fail_retry(
        &self,
        id: &str,
        error: &str,
        available_at: i64,
        fence: i64,
    ) -> StoreResult<()> {
        self.gate("fail_retry").await?;
        self.inner.fail_retry(id, error, available_at, fence).await
    }
    async fn fail_dead(&self, id: &str, error: &str, fence: i64) -> StoreResult<()> {
        self.gate("fail_dead").await?;
        self.inner.fail_dead(id, error, fence).await
    }
    async fn renew_leases(&self, leases: Vec<(String, i64)>, lease_ms: i64) -> StoreResult<()> {
        self.gate("renew_leases").await?;
        self.inner.renew_leases(leases, lease_ms).await
    }
    async fn sweep_expired(&self, now: i64) -> StoreResult<u64> {
        self.gate("sweep_expired").await?;
        self.inner.sweep_expired(now).await
    }
    async fn record_step(
        &self,
        run_id: &str,
        step_id: &str,
        kind: &str,
        result: Option<String>,
    ) -> StoreResult<()> {
        self.gate("record_step").await?;
        self.inner.record_step(run_id, step_id, kind, result).await
    }

    // -- Transparent passthroughs ------------------------------------------
    fn push_blocking(&self, jobs: Vec<PushJob>) -> StoreResult<Vec<String>> {
        self.inner.push_blocking(jobs)
    }
    async fn gc(&self, run_before: Option<i64>, event_before: Option<i64>) -> StoreResult<GcStats> {
        self.inner.gc(run_before, event_before).await
    }
    async fn ping(&self) -> StoreResult<()> {
        self.inner.ping().await
    }
    async fn pending_count(&self, queue: &str) -> StoreResult<u64> {
        self.inner.pending_count(queue).await
    }
    async fn active_count(&self, queue: &str) -> StoreResult<u64> {
        self.inner.active_count(queue).await
    }
    async fn dead_jobs(&self, queue: &str, limit: u32) -> StoreResult<Vec<DeadJob>> {
        self.inner.dead_jobs(queue, limit).await
    }
    async fn requeue_dead(&self, ids: Vec<String>) -> StoreResult<u64> {
        self.inner.requeue_dead(ids).await
    }
    async fn purge_dead(&self, queue: &str) -> StoreResult<u64> {
        self.inner.purge_dead(queue).await
    }
    async fn create_run(&self, run: NewRun) -> StoreResult<(String, bool)> {
        self.inner.create_run(run).await
    }
    fn create_run_blocking(&self, run: NewRun) -> StoreResult<(String, bool)> {
        self.inner.create_run_blocking(run)
    }
    async fn get_run(&self, id: &str) -> StoreResult<Option<RunRow>> {
        self.inner.get_run(id).await
    }
    fn get_run_blocking(&self, id: &str) -> StoreResult<Option<RunRow>> {
        self.inner.get_run_blocking(id)
    }
    async fn load_journal(&self, run_id: &str) -> StoreResult<Vec<StepEntry>> {
        self.inner.load_journal(run_id).await
    }
    fn record_step_blocking(
        &self,
        run_id: &str,
        step_id: &str,
        kind: &str,
        result: Option<String>,
    ) -> StoreResult<()> {
        self.inner.record_step_blocking(run_id, step_id, kind, result)
    }
    async fn step_failed_attempt(
        &self,
        run_id: &str,
        step_id: &str,
        error: &str,
    ) -> StoreResult<u32> {
        self.inner.step_failed_attempt(run_id, step_id, error).await
    }
    async fn run_completed(&self, id: &str, output: Option<String>) -> StoreResult<()> {
        self.inner.run_completed(id, output).await
    }
    async fn run_failed(&self, id: &str, error: &str) -> StoreResult<()> {
        self.inner.run_failed(id, error).await
    }
    async fn run_sleeping(&self, id: &str, wake_at: i64) -> StoreResult<()> {
        self.inner.run_sleeping(id, wake_at).await
    }
    async fn run_waiting_event(
        &self,
        id: &str,
        event: &str,
        step_id: &str,
        timeout_at: Option<i64>,
        match_json: Option<String>,
    ) -> StoreResult<()> {
        self.inner
            .run_waiting_event(id, event, step_id, timeout_at, match_json)
            .await
    }
    async fn run_waiting_child(&self, id: &str) -> StoreResult<()> {
        self.inner.run_waiting_child(id).await
    }
    async fn wake_parent(&self, parent_run_id: &str) -> StoreResult<bool> {
        self.inner.wake_parent(parent_run_id).await
    }
    fn emit_event_blocking(
        &self,
        name: &str,
        payload: &str,
        targets: Vec<TriggerTarget>,
    ) -> StoreResult<EmitOutcome> {
        self.inner.emit_event_blocking(name, payload, targets)
    }
    fn machine_create_blocking(&self, machine: &str, id: &str, initial: &str) -> StoreResult<bool> {
        self.inner.machine_create_blocking(machine, id, initial)
    }
    fn machine_state_blocking(&self, machine: &str, id: &str) -> StoreResult<Option<String>> {
        self.inner.machine_state_blocking(machine, id)
    }
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
    ) -> StoreResult<Option<EmitOutcome>> {
        self.inner
            .machine_send_blocking(machine, id, from, event, to, event_name, payload, targets)
    }
    fn machine_history_blocking(
        &self,
        machine: &str,
        id: &str,
        limit: u32,
    ) -> StoreResult<Vec<MachineHistoryRow>> {
        self.inner.machine_history_blocking(machine, id, limit)
    }
    fn agent_session_get_blocking(&self, agent: &str, id: &str) -> StoreResult<Option<String>> {
        self.inner.agent_session_get_blocking(agent, id)
    }
    fn agent_session_put_blocking(&self, agent: &str, id: &str, messages: &str) -> StoreResult<()> {
        self.inner.agent_session_put_blocking(agent, id, messages)
    }
    async fn runs_list(
        &self,
        workflow: Option<String>,
        status: Option<i64>,
        limit: u32,
    ) -> StoreResult<Vec<RunRow>> {
        self.inner.runs_list(workflow, status, limit).await
    }
    async fn steps_for_run(&self, run_id: &str) -> StoreResult<Vec<StepRow>> {
        self.inner.steps_for_run(run_id).await
    }
    async fn queue_stats(&self) -> StoreResult<Vec<QueueStat>> {
        self.inner.queue_stats().await
    }
    async fn all_schedules(&self) -> StoreResult<Vec<ScheduleRow>> {
        self.inner.all_schedules().await
    }
    async fn recent_events(&self, limit: u32) -> StoreResult<Vec<EventRow>> {
        self.inner.recent_events(limit).await
    }
    async fn sweep_event_timeouts(&self, now: i64) -> StoreResult<Vec<Waiter>> {
        self.inner.sweep_event_timeouts(now).await
    }
    fn cancel_run_tree_blocking(&self, root_run_id: &str) -> StoreResult<u32> {
        self.inner.cancel_run_tree_blocking(root_run_id)
    }
    async fn upsert_schedule(&self, row: ScheduleRow) -> StoreResult<ScheduleRow> {
        self.inner.upsert_schedule(row).await
    }
    async fn due_schedules(&self, now: i64) -> StoreResult<Vec<ScheduleRow>> {
        self.inner.due_schedules(now).await
    }
    async fn set_schedule_next(
        &self,
        name: &str,
        next_run_at: i64,
        last_run_at: Option<i64>,
    ) -> StoreResult<()> {
        self.inner.set_schedule_next(name, next_run_at, last_run_at).await
    }
    async fn schedule_claim_tick(
        &self,
        name: &str,
        observed_next: i64,
        new_next: i64,
        fired_at: i64,
    ) -> StoreResult<bool> {
        self.inner
            .schedule_claim_tick(name, observed_next, new_next, fired_at)
            .await
    }
    fn close_blocking(&self) {
        self.inner.close_blocking()
    }
}
