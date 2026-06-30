//! Durable workflow engine (P2.2–P2.11) — step memoization model.
//!
//! A run's execution attempt is a job on the hidden queue
//! `zenzip.workflow.<name>` (one engine, per docs/plan.md). The handler:
//!   1. loads the run + its completed-step journal (batched prefetch),
//!   2. invokes the JS executor (opaque `Executor` closure — the NAPI layer
//!      wraps a ThreadsafeFunction),
//!   3. applies the returned outcome: completed / suspended (sleep, event,
//!      child invoke) / stepFailed (retry w/ backoff) / failed.
//!
//! Suspensions hold zero resources: sleep = delayed execution job; event
//! wait = persisted wake condition resolved by emit or timeout sweep; child
//! wait = woken by the child's completion. Crash anywhere → the queue lease
//! expires → re-execution fast-forwards through memoized steps.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use serde::Deserialize;
use tokio::sync::Notify;

use crate::metrics::Metrics;
use crate::queue::{Backoff, Handler};
use crate::store::{run_status, workflow_execution_job, NewRun, RunRow, Store, TriggerTarget};
use crate::time::now_ms;

pub use crate::store::workflow_queue_name;

/// Wildcard event-pattern match (P3.1): `*` matches one dot-segment,
/// a trailing `**` matches any remainder.
pub fn event_matches(pattern: &str, name: &str) -> bool {
    if pattern == name {
        return true;
    }
    let p: Vec<&str> = pattern.split('.').collect();
    let n: Vec<&str> = name.split('.').collect();
    if p.last() == Some(&"**") {
        let prefix = &p[..p.len() - 1];
        return n.len() >= prefix.len()
            && prefix
                .iter()
                .zip(n.iter())
                .all(|(a, b)| *a == "*" || a == b);
    }
    p.len() == n.len() && p.iter().zip(n.iter()).all(|(a, b)| *a == "*" || a == b)
}

#[derive(Debug, Clone)]
pub struct WorkflowConfig {
    pub name: String,
    /// Content hash of the JS definition (P2.11 version pinning).
    pub version: Option<String>,
    pub concurrency: u32,
    /// Per-step retry budget: attempts = retries + 1.
    pub step_max_attempts: u32,
    pub step_backoff: Backoff,
    /// Execution-attempt lease: a crashed worker's run is redelivered after
    /// this. Raise for workflows with long-running steps.
    pub lease_ms: i64,
    /// Event patterns that durably trigger this workflow (P3.2), e.g.
    /// `["user.created", "billing.*"]`.
    pub triggers: Vec<String>,
}

impl WorkflowConfig {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            version: None,
            concurrency: 10,
            step_max_attempts: 3,
            step_backoff: Backoff::default(),
            lease_ms: 60_000,
            triggers: Vec::new(),
        }
    }
}

/// What the executor hands back, serialized as JSON by the JS side.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ExecOutcome {
    #[serde(rename = "completed", rename_all = "camelCase")]
    Completed { output: Option<String> },
    #[serde(rename = "sleep", rename_all = "camelCase")]
    Sleep { step_id: String, wake_at: i64 },
    #[serde(rename = "event", rename_all = "camelCase")]
    Event {
        step_id: String,
        event: String,
        timeout_at: Option<i64>,
        /// JSON object: shallow-equality predicate on the event payload.
        #[serde(rename = "match", default)]
        match_json: Option<String>,
    },
    #[serde(rename = "invoke", rename_all = "camelCase")]
    Invoke {
        step_id: String,
        workflow: String,
        input: Option<String>,
    },
    #[serde(rename = "stepFailed", rename_all = "camelCase")]
    StepFailed { step_id: String, error: String },
    #[serde(rename = "failed", rename_all = "camelCase")]
    Failed { error: String },
}

#[derive(Debug, Clone)]
pub struct ExecRequest {
    pub run_id: String,
    pub workflow: String,
    pub input: String,
    pub version: Option<String>,
    /// JSON array of completed StepEntry.
    pub journal_json: String,
}

/// Opaque executor: invokes the user's workflow function (in JS) and returns
/// the outcome JSON. Errors are infra failures -> queue-level retry.
pub type Executor =
    Arc<dyn Fn(ExecRequest) -> BoxFuture<'static, Result<String, String>> + Send + Sync>;

pub struct WorkflowEngine {
    store: Arc<dyn Store>,
    notifies: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
    configs: Mutex<HashMap<String, WorkflowConfig>>,
    metrics: Arc<Metrics>,
}

impl WorkflowEngine {
    pub fn new(
        store: Arc<dyn Store>,
        notifies: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
        metrics: Arc<Metrics>,
    ) -> Self {
        Self {
            store,
            notifies,
            configs: Mutex::new(HashMap::new()),
            metrics,
        }
    }

    /// Workflows whose `on:` patterns match this event (P3.2).
    pub fn trigger_targets(&self, event: &str) -> Vec<TriggerTarget> {
        self.configs
            .lock()
            .unwrap()
            .values()
            .filter(|cfg| cfg.triggers.iter().any(|p| event_matches(p, event)))
            .map(|cfg| TriggerTarget {
                workflow: cfg.name.clone(),
                version: cfg.version.clone(),
            })
            .collect()
    }

    /// Wake the dispatchers for an emit's consequences (jobs already exist).
    pub fn notify_emit_outcome(&self, outcome: &crate::store::EmitOutcome) {
        for w in &outcome.waiters {
            self.notify(&workflow_queue_name(&w.workflow));
        }
        for t in &outcome.triggered {
            self.notify(&workflow_queue_name(&t.workflow));
        }
        self.metrics
            .events_emitted
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn add_config(&self, cfg: WorkflowConfig) -> Result<(), String> {
        let mut configs = self.configs.lock().unwrap();
        if configs.contains_key(&cfg.name) {
            return Err(format!("workflow '{}' already registered", cfg.name));
        }
        configs.insert(cfg.name.clone(), cfg);
        Ok(())
    }

    fn config(&self, workflow: &str) -> Option<WorkflowConfig> {
        self.configs.lock().unwrap().get(workflow).cloned()
    }

    fn notify(&self, queue: &str) {
        if let Some(n) = self.notifies.lock().unwrap().get(queue) {
            n.notify_one();
        }
    }

    async fn enqueue(&self, workflow: &str, run_id: &str, delay_ms: i64) -> Result<(), String> {
        self.store
            .push(vec![workflow_execution_job(workflow, run_id, delay_ms)])
            .await
            .map_err(|e| e.to_string())?;
        self.notify(&workflow_queue_name(workflow));
        Ok(())
    }

    fn enqueue_blocking(&self, workflow: &str, run_id: &str, delay_ms: i64) -> Result<(), String> {
        self.store
            .push_blocking(vec![workflow_execution_job(workflow, run_id, delay_ms)])
            .map_err(|e| e.to_string())?;
        self.notify(&workflow_queue_name(workflow));
        Ok(())
    }

    /// Sync trigger for the JS-thread fast path. Returns the run id (existing
    /// one when the idempotency key dedupes).
    pub fn trigger_blocking(
        &self,
        workflow: &str,
        input: String,
        idempotency_key: Option<String>,
        delay_ms: i64,
        subject: Option<String>,
    ) -> Result<String, String> {
        let version = self.config(workflow).and_then(|c| c.version);
        let (run_id, created) = self
            .store
            .create_run_blocking(NewRun {
                workflow: workflow.to_string(),
                input,
                version,
                idempotency_key,
                parent_run_id: None,
                parent_step_id: None,
                subject,
            })
            .map_err(|e| e.to_string())?;
        if created {
            self.enqueue_blocking(workflow, &run_id, delay_ms)?;
        }
        Ok(run_id)
    }

    /// Sync event emit through the atomic outbox (P3.2): persists the event,
    /// releases matching waiters, and creates runs for `on:` trigger targets
    /// — all in one store transaction. Returns (woken, triggered).
    pub fn emit_blocking(&self, event: &str, payload: &str) -> Result<(u32, u32), String> {
        let targets = self.trigger_targets(event);
        let outcome = self
            .store
            .emit_event_blocking(event, payload, targets)
            .map_err(|e| e.to_string())?;
        // Jobs were inserted inside the transaction; we only wake dispatchers.
        self.notify_emit_outcome(&outcome);
        Ok((outcome.waiters.len() as u32, outcome.triggered.len() as u32))
    }

    pub fn cancel_blocking(&self, run_id: &str) -> Result<u32, String> {
        self.store
            .cancel_run_tree_blocking(run_id)
            .map_err(|e| e.to_string())
    }

    /// Release timed-out event waiters (called from the runtime sweeper).
    pub async fn sweep(&self, now: i64) -> Result<u32, String> {
        let waiters = self
            .store
            .sweep_event_timeouts(now)
            .await
            .map_err(|e| e.to_string())?;
        let count = waiters.len() as u32;
        for w in waiters {
            self.store
                .record_step(
                    &w.run_id,
                    &w.step_id,
                    "waitForEvent",
                    Some(r#"{"timedOut":true}"#.to_string()),
                )
                .await
                .map_err(|e| e.to_string())?;
            self.enqueue(&w.workflow, &w.run_id, 0).await?;
        }
        Ok(count)
    }

    /// Poll a run until terminal or timeout. Used by triggerAndWait — a long
    /// wait anyway, so polling is fine for Phase 2.
    pub async fn wait_for_run(
        &self,
        run_id: &str,
        timeout_ms: i64,
    ) -> Result<Option<RunRow>, String> {
        let deadline = now_ms() + timeout_ms;
        loop {
            let run = self
                .store
                .get_run(run_id)
                .await
                .map_err(|e| e.to_string())?;
            match run {
                None => return Ok(None),
                Some(run) if run.status >= run_status::COMPLETED => return Ok(Some(run)),
                Some(run) => {
                    if now_ms() >= deadline {
                        return Ok(Some(run));
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        }
    }

    /// Build the queue handler for a workflow (group size 1).
    pub fn make_handler(self: &Arc<Self>, workflow: String, executor: Executor) -> Handler {
        let engine = self.clone();
        Arc::new(move |jobs| {
            let engine = engine.clone();
            let executor = executor.clone();
            let workflow = workflow.clone();
            Box::pin(async move {
                for job in jobs {
                    engine.execute(&workflow, &job.payload, &executor).await?;
                }
                Ok(())
            })
        })
    }

    async fn execute(
        &self,
        workflow: &str,
        payload: &str,
        executor: &Executor,
    ) -> Result<(), String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload {
            run_id: String,
        }
        let run_id = serde_json::from_str::<Payload>(payload)
            .map_err(|e| format!("bad execution payload: {e}"))?
            .run_id;

        let Some(run) = self
            .store
            .get_run(&run_id)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(()); // run vanished — ack the stale job
        };
        // Runnable, or a sleeping run woken by its delayed job. Anything
        // else (waiting, terminal, cancelled) means this job is stale.
        if run.status != run_status::RUNNABLE && run.status != run_status::SLEEPING {
            return Ok(());
        }

        let journal = self
            .store
            .load_journal(&run_id)
            .await
            .map_err(|e| e.to_string())?;
        let journal_json = serde_json::to_string(&journal).map_err(|e| e.to_string())?;

        let outcome_json = executor(ExecRequest {
            run_id: run_id.clone(),
            workflow: workflow.to_string(),
            input: run.input.clone(),
            version: run.version.clone(),
            journal_json,
        })
        .await?;
        let outcome: ExecOutcome = serde_json::from_str(&outcome_json)
            .map_err(|e| format!("bad executor outcome: {e}"))?;

        // The run may have been cancelled while the executor ran — discard.
        let Some(current) = self
            .store
            .get_run(&run_id)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(());
        };
        if current.status == run_status::CANCELLED {
            return Ok(());
        }

        self.apply(&run, outcome).await
    }

    async fn apply(&self, run: &RunRow, outcome: ExecOutcome) -> Result<(), String> {
        let store = &self.store;
        match outcome {
            ExecOutcome::Completed { output } => {
                store
                    .run_completed(&run.id, output.clone())
                    .await
                    .map_err(|e| e.to_string())?;
                self.metrics
                    .runs_completed
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                self.settle_parent(run, Ok(output.unwrap_or_else(|| "null".into())))
                    .await
            }
            ExecOutcome::Failed { error } => {
                store
                    .run_failed(&run.id, &error)
                    .await
                    .map_err(|e| e.to_string())?;
                self.metrics
                    .runs_failed
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                self.settle_parent(run, Err(error)).await
            }
            ExecOutcome::Sleep { step_id, wake_at } => {
                // Safe to record now: nothing re-executes until the delayed
                // job arrives at wake time.
                store
                    .record_step(&run.id, &step_id, "sleep", None)
                    .await
                    .map_err(|e| e.to_string())?;
                store
                    .run_sleeping(&run.id, wake_at)
                    .await
                    .map_err(|e| e.to_string())?;
                self.enqueue(&run.workflow, &run.id, (wake_at - now_ms()).max(0))
                    .await
            }
            ExecOutcome::Event {
                step_id,
                event,
                timeout_at,
                match_json,
            } => store
                .run_waiting_event(&run.id, &event, &step_id, timeout_at, match_json)
                .await
                .map_err(|e| e.to_string()),
            ExecOutcome::Invoke {
                step_id,
                workflow,
                input,
            } => self.apply_invoke(run, &step_id, &workflow, input).await,
            ExecOutcome::StepFailed { step_id, error } => {
                let cfg = self
                    .config(&run.workflow)
                    .unwrap_or_else(|| WorkflowConfig::new(&run.workflow));
                let attempts = store
                    .step_failed_attempt(&run.id, &step_id, &error)
                    .await
                    .map_err(|e| e.to_string())?;
                if attempts < cfg.step_max_attempts {
                    let delay = cfg.step_backoff.delay_for(attempts);
                    tracing::debug!(run = %run.id, step = %step_id, attempts, "step retry scheduled");
                    self.metrics
                        .step_retries
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    self.enqueue(&run.workflow, &run.id, delay).await
                } else {
                    let final_error =
                        format!("step '{step_id}' failed after {attempts} attempts: {error}");
                    store
                        .run_failed(&run.id, &final_error)
                        .await
                        .map_err(|e| e.to_string())?;
                    self.metrics
                        .runs_failed
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    self.settle_parent(run, Err(final_error)).await
                }
            }
        }
    }

    async fn apply_invoke(
        &self,
        run: &RunRow,
        step_id: &str,
        child_workflow: &str,
        input: Option<String>,
    ) -> Result<(), String> {
        if self.config(child_workflow).is_none() {
            let error = format!("step '{step_id}': unknown workflow '{child_workflow}'");
            self.store
                .run_failed(&run.id, &error)
                .await
                .map_err(|e| e.to_string())?;
            return self.settle_parent(run, Err(error)).await;
        }
        let version = self.config(child_workflow).and_then(|c| c.version);
        // Deterministic key: crash-replay of this suspension reuses the child.
        let idem = format!("zenzip.invoke:{}:{}", run.id, step_id);
        let (child_id, created) = self
            .store
            .create_run(NewRun {
                workflow: child_workflow.to_string(),
                input: input.unwrap_or_else(|| "null".to_string()),
                version,
                idempotency_key: Some(idem),
                parent_run_id: Some(run.id.clone()),
                parent_step_id: Some(step_id.to_string()),
                subject: None,
            })
            .await
            .map_err(|e| e.to_string())?;

        if created {
            self.store
                .run_waiting_child(&run.id)
                .await
                .map_err(|e| e.to_string())?;
            return self.enqueue(child_workflow, &child_id, 0).await;
        }

        // Replayed suspension: the child already exists. If it finished, the
        // parent step may already be recorded (or we record it now); either
        // way the parent stays runnable.
        let child = self
            .store
            .get_run(&child_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "child run vanished".to_string())?;
        match child.status {
            run_status::COMPLETED => {
                let result = format!(
                    r#"{{"output":{}}}"#,
                    child.output.unwrap_or_else(|| "null".into())
                );
                self.store
                    .record_step(&run.id, step_id, "invoke", Some(result))
                    .await
                    .map_err(|e| e.to_string())?;
                self.enqueue(&run.workflow, &run.id, 0).await
            }
            run_status::FAILED | run_status::CANCELLED => {
                let error = child.error.unwrap_or_else(|| "child run failed".into());
                let result = serde_json::to_string(&serde_json::json!({ "error": error }))
                    .map_err(|e| e.to_string())?;
                self.store
                    .record_step(&run.id, step_id, "invoke", Some(result))
                    .await
                    .map_err(|e| e.to_string())?;
                self.enqueue(&run.workflow, &run.id, 0).await
            }
            _ => {
                // Child still in flight: park the parent again.
                self.store
                    .run_waiting_child(&run.id)
                    .await
                    .map_err(|e| e.to_string())
            }
        }
    }

    /// Propagate a child's terminal state to its waiting parent.
    async fn settle_parent(
        &self,
        child: &RunRow,
        result: Result<String, String>,
    ) -> Result<(), String> {
        let (Some(parent_id), Some(parent_step)) =
            (child.parent_run_id.clone(), child.parent_step_id.clone())
        else {
            return Ok(());
        };
        let step_result = match result {
            Ok(output) => format!(r#"{{"output":{output}}}"#),
            Err(error) => serde_json::to_string(&serde_json::json!({ "error": error }))
                .map_err(|e| e.to_string())?,
        };
        // Record first, then the guarded wake: if the parent isn't parked in
        // WAIT_CHILD yet, its next invoke-suspension finds the recorded step.
        self.store
            .record_step(&parent_id, &parent_step, "invoke", Some(step_result))
            .await
            .map_err(|e| e.to_string())?;
        if self
            .store
            .wake_parent(&parent_id)
            .await
            .map_err(|e| e.to_string())?
        {
            let parent = self
                .store
                .get_run(&parent_id)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "parent run vanished".to_string())?;
            self.enqueue(&parent.workflow, &parent_id, 0).await?;
        }
        Ok(())
    }
}
