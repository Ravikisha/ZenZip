//! Phase 1 NAPI bindings: the `ZenRuntime` class wrapping
//! `zenzip_core::runtime::CoreRuntime`.
//!
//! Boundary rules (docs/spike-results.md): registration/push/counts are sync
//! NAPI calls; handler dispatch is Rust -> JS via ThreadsafeFunction with the
//! JS side returning a Promise that Rust awaits; only `stop` is an async NAPI
//! fn (cold path).

use std::sync::Arc;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;

use std::collections::HashMap;

use zenzip_core::queue::{Backoff, Handler, QueueConfig, RateLimit};
use zenzip_core::runtime::{CoreRuntime, MachineDef, RuntimeConfig};
use zenzip_core::scheduler::{Catchup, Overlap, ScheduleDef};
use zenzip_core::store::PushJob;
use zenzip_core::workflow::{ExecRequest, Executor, WorkflowConfig};

use crate::logging::{init_logging, JsLogTsfn};

#[napi(object)]
#[derive(Clone)]
pub struct JsJob {
    pub id: String,
    pub queue: String,
    /// JSON-encoded payload.
    pub payload: String,
    pub attempt: u32,
    pub max_attempts: u32,
}

#[napi(object)]
pub struct JsRuntimeOptions {
    pub data_dir: String,
    /// When set, use the Postgres backend (P5) instead of embedded SQLite.
    pub postgres_url: Option<String>,
    pub sweep_ms: Option<f64>,
    pub scheduler_tick_ms: Option<f64>,
    pub worker_threads: Option<u32>,
    /// error | warn | info | debug | trace | off (default: off)
    pub log_level: Option<String>,
    /// Retention GC sweep cadence in ms (P7.6). Default: 1h.
    pub gc_sweep_ms: Option<f64>,
    /// Delete terminal runs older than this (ms). <= 0 disables. Default: 7d.
    pub run_retention_ms: Option<f64>,
    /// Delete events older than this (ms). <= 0 disables. Default: 7d.
    pub event_retention_ms: Option<f64>,
    /// Payload encryption-at-rest passphrase (P7.15). Unset/empty = disabled.
    pub encryption_key: Option<String>,
}

#[napi(object)]
pub struct JsQueueOptions {
    pub name: String,
    pub concurrency: Option<u32>,
    pub max_attempts: Option<u32>,
    pub backoff_delay_ms: Option<f64>,
    pub backoff_max_delay_ms: Option<f64>,
    pub lease_ms: Option<f64>,
    pub poll_ms: Option<f64>,
    pub batch: Option<u32>,
    /// Jobs per handler invocation (1 = per-job consumer).
    pub handler_batch: Option<u32>,
    pub rate_limit_max: Option<u32>,
    pub rate_limit_per_ms: Option<f64>,
    /// Per-key concurrency limit (P10.1).
    pub concurrency_key_limit: Option<u32>,
    /// Fairness across concurrency-key groups (P10.3).
    pub fair: Option<bool>,
}

#[napi(object)]
pub struct JsScheduleOptions {
    pub name: String,
    /// Exactly one of `cron` / `everyMs` must be set.
    pub cron: Option<String>,
    pub every_ms: Option<f64>,
    pub timezone: Option<String>,
    /// skip | allow | queue (default skip)
    pub overlap: Option<String>,
    /// skip | runOnce | all (default skip)
    pub catchup: Option<String>,
    /// Random 0..=jitterMs delivery delay per fire.
    pub jitter_ms: Option<f64>,
}

#[napi(object)]
pub struct JsPushOptions {
    pub delay_ms: Option<f64>,
    pub priority: Option<i32>,
    pub max_attempts: Option<u32>,
    /// Per-key concurrency bucket for this job (P10.1).
    pub concurrency_key: Option<String>,
    /// Debounce bucket for this job (P10.2).
    pub debounce_key: Option<String>,
    /// Throttle bucket + spacing (ms) for this job (P10.2).
    pub throttle_key: Option<String>,
    pub throttle_spacing_ms: Option<f64>,
}

#[napi(object)]
pub struct JsWorkflowOptions {
    pub name: String,
    /// Content hash of the definition (P2.11 version pinning).
    pub version: Option<String>,
    pub concurrency: Option<u32>,
    /// Total step attempts (retries + 1).
    pub step_max_attempts: Option<u32>,
    pub step_backoff_delay_ms: Option<f64>,
    pub step_backoff_max_delay_ms: Option<f64>,
    /// Execution-attempt lease (crash redelivery horizon).
    pub lease_ms: Option<f64>,
    /// Event patterns that durably trigger this workflow (P3.2).
    pub triggers: Option<Vec<String>>,
}

#[napi(object)]
pub struct JsTransition {
    pub from: String,
    pub event: String,
    pub to: String,
}

#[napi(object)]
pub struct JsMachineOptions {
    pub name: String,
    pub initial: String,
    pub transitions: Vec<JsTransition>,
}

#[napi(object)]
pub struct JsTriggerOptions {
    pub idempotency_key: Option<String>,
    pub delay_ms: Option<f64>,
    /// Data-subject tag for PII purge (P14.6).
    pub subject: Option<String>,
}

/// One execution attempt request handed to the JS executor.
#[napi(object)]
#[derive(Clone)]
pub struct JsExecRequest {
    pub run_id: String,
    pub workflow: String,
    /// JSON input.
    pub input: String,
    pub version: Option<String>,
    /// JSON array of completed steps: [{ id, kind, result }].
    pub journal: String,
}

/// Executor TSFN: returns the outcome JSON (completed / sleep / event /
/// invoke / stepFailed / failed).
type JsExecutorTsfn = ThreadsafeFunction<JsExecRequest, Promise<String>>;

fn wrap_executor(tsfn: JsExecutorTsfn) -> Executor {
    let tsfn = Arc::new(tsfn);
    Arc::new(move |req: ExecRequest| {
        let tsfn = tsfn.clone();
        Box::pin(async move {
            let js_req = JsExecRequest {
                run_id: req.run_id,
                workflow: req.workflow,
                input: req.input,
                version: req.version,
                journal: req.journal_json,
            };
            let promise = tsfn
                .call_async(Ok(js_req))
                .await
                .map_err(|e| e.reason.clone())?;
            promise.await.map_err(|e| e.reason.clone())
        })
    })
}

/// Handler TSFN receives the job GROUP (length 1 for per-job consumers).
type JsHandlerTsfn = ThreadsafeFunction<Vec<JsJob>, Promise<bool>>;

fn wrap_handler(tsfn: JsHandlerTsfn) -> Handler {
    let tsfn = Arc::new(tsfn);
    Arc::new(move |jobs| {
        let tsfn = tsfn.clone();
        Box::pin(async move {
            let js_jobs: Vec<JsJob> = jobs
                .into_iter()
                .map(|job| JsJob {
                    id: job.id,
                    queue: job.queue,
                    payload: job.payload,
                    attempt: job.attempt,
                    max_attempts: job.max_attempts,
                })
                .collect();
            let promise = tsfn
                .call_async(Ok(js_jobs))
                .await
                .map_err(|e| e.reason.clone())?;
            promise.await.map(|_| ()).map_err(|e| e.reason.clone())
        })
    })
}

fn queue_config(opts: &JsQueueOptions) -> QueueConfig {
    let mut cfg = QueueConfig::new(opts.name.clone());
    if let Some(c) = opts.concurrency {
        cfg.concurrency = c.max(1);
    }
    if let Some(m) = opts.max_attempts {
        cfg.max_attempts = m.max(1);
    }
    let mut backoff = Backoff::default();
    if let Some(d) = opts.backoff_delay_ms {
        backoff.delay_ms = (d as i64).max(1);
    }
    if let Some(d) = opts.backoff_max_delay_ms {
        backoff.max_delay_ms = (d as i64).max(backoff.delay_ms);
    }
    cfg.backoff = backoff;
    if let Some(l) = opts.lease_ms {
        cfg.lease_ms = (l as i64).max(1_000);
    }
    if let Some(p) = opts.poll_ms {
        cfg.poll_ms = (p as u64).max(10);
    }
    if let Some(b) = opts.batch {
        cfg.batch = b.max(1);
    }
    if let Some(h) = opts.handler_batch {
        cfg.handler_batch = h.max(1);
    }
    if let Some(k) = opts.concurrency_key_limit {
        cfg.concurrency_key_limit = Some(k.max(1));
    }
    if let Some(f) = opts.fair {
        cfg.fair = f;
    }
    if let (Some(max), Some(per_ms)) = (opts.rate_limit_max, opts.rate_limit_per_ms) {
        cfg.rate_limit = Some(RateLimit {
            max: max.max(1),
            per_ms: (per_ms as u64).max(1),
        });
    }
    cfg
}

fn err(msg: String) -> Error {
    Error::from_reason(msg)
}

#[napi]
pub struct ZenRuntime {
    core: Arc<CoreRuntime>,
}

#[napi]
impl ZenRuntime {
    #[napi(constructor)]
    pub fn new(options: JsRuntimeOptions, logger: Option<JsLogTsfn>) -> Result<Self> {
        let log_level =
            options
                .log_level
                .as_deref()
                .unwrap_or(if logger.is_some() { "info" } else { "off" });
        init_logging(log_level, logger);
        let mut config = RuntimeConfig::new(options.data_dir);
        if let Some(url) = options.postgres_url {
            config.backend = zenzip_core::runtime::StoreBackend::Postgres { url };
        }
        if let Some(s) = options.sweep_ms {
            config.sweep_ms = (s as u64).max(100);
        }
        if let Some(t) = options.scheduler_tick_ms {
            config.scheduler_tick_ms = (t as u64).max(50);
        }
        if let Some(w) = options.worker_threads {
            config.worker_threads = (w as usize).max(1);
        }
        if let Some(g) = options.gc_sweep_ms {
            config.gc_sweep_ms = (g as u64).max(1_000);
        }
        if let Some(r) = options.run_retention_ms {
            config.run_retention_ms = if r <= 0.0 { None } else { Some(r as i64) };
        }
        if let Some(e) = options.event_retention_ms {
            config.event_retention_ms = if e <= 0.0 { None } else { Some(e as i64) };
        }
        config.encryption_key = options.encryption_key.filter(|k| !k.is_empty());
        let core = CoreRuntime::new(config).map_err(err)?;
        Ok(Self {
            core: Arc::new(core),
        })
    }

    #[napi]
    pub fn register_queue(&self, options: JsQueueOptions, handler: JsHandlerTsfn) -> Result<()> {
        self.core
            .register_queue(queue_config(&options), wrap_handler(handler))
            .map_err(err)
    }

    #[napi]
    pub fn register_schedule(
        &self,
        options: JsScheduleOptions,
        handler: JsHandlerTsfn,
    ) -> Result<()> {
        let overlap = Overlap::parse(options.overlap.as_deref().unwrap_or("skip")).map_err(err)?;
        let catchup = Catchup::parse(options.catchup.as_deref().unwrap_or("skip")).map_err(err)?;
        let mut def = match (&options.cron, options.every_ms) {
            (Some(expr), None) => ScheduleDef::cron(
                &options.name,
                expr,
                options.timezone.as_deref(),
                overlap,
                catchup,
            )
            .map_err(err)?,
            (None, Some(ms)) => {
                ScheduleDef::every(&options.name, ms as i64, overlap, catchup).map_err(err)?
            }
            _ => {
                return Err(err(format!(
                    "schedule '{}': exactly one of cron / everyMs required",
                    options.name
                )))
            }
        };
        if let Some(j) = options.jitter_ms {
            def.jitter_ms = (j as i64).max(0);
        }
        self.core
            .register_schedule(def, wrap_handler(handler))
            .map_err(err)
    }

    #[napi]
    pub fn register_workflow(
        &self,
        options: JsWorkflowOptions,
        executor: JsExecutorTsfn,
    ) -> Result<()> {
        let mut cfg = WorkflowConfig::new(options.name);
        cfg.version = options.version;
        if let Some(c) = options.concurrency {
            cfg.concurrency = c.max(1);
        }
        if let Some(m) = options.step_max_attempts {
            cfg.step_max_attempts = m.max(1);
        }
        let mut backoff = Backoff::default();
        if let Some(d) = options.step_backoff_delay_ms {
            backoff.delay_ms = (d as i64).max(1);
        }
        if let Some(d) = options.step_backoff_max_delay_ms {
            backoff.max_delay_ms = (d as i64).max(backoff.delay_ms);
        }
        cfg.step_backoff = backoff;
        if let Some(l) = options.lease_ms {
            cfg.lease_ms = (l as i64).max(1_000);
        }
        if let Some(triggers) = options.triggers {
            cfg.triggers = triggers;
        }
        self.core
            .register_workflow(cfg, wrap_executor(executor))
            .map_err(err)
    }

    #[napi]
    pub fn register_machine(&self, options: JsMachineOptions) -> Result<()> {
        let mut transitions = HashMap::new();
        for t in options.transitions {
            transitions.insert((t.from, t.event), t.to);
        }
        self.core
            .register_machine(MachineDef {
                name: options.name,
                initial: options.initial,
                transitions,
            })
            .map_err(err)
    }

    /// Create a machine instance in its initial state. False = existed.
    #[napi]
    pub fn machine_create(&self, machine: String, id: String) -> Result<bool> {
        self.core.machine_create(&machine, &id).map_err(err)
    }

    /// Apply an event; returns JSON { from, to }. Invalid transitions throw.
    #[napi]
    pub fn machine_send(&self, machine: String, id: String, event: String) -> Result<String> {
        let r = self.core.machine_send(&machine, &id, &event).map_err(err)?;
        Ok(format!(r#"{{"from":"{}","to":"{}"}}"#, r.from, r.to))
    }

    #[napi]
    pub fn machine_state(&self, machine: String, id: String) -> Result<Option<String>> {
        self.core.machine_state(&machine, &id).map_err(err)
    }

    /// History as a JSON array (newest first).
    #[napi]
    pub fn machine_history(
        &self,
        machine: String,
        id: String,
        limit: Option<u32>,
    ) -> Result<String> {
        let rows = self
            .core
            .machine_history(&machine, &id, limit.unwrap_or(100))
            .map_err(err)?;
        serde_json::to_string(&rows).map_err(|e| err(e.to_string()))
    }

    /// Sync trigger (hot path). Returns the run id.
    #[napi]
    pub fn trigger_workflow(
        &self,
        workflow: String,
        input: String,
        options: Option<JsTriggerOptions>,
    ) -> Result<String> {
        let opts = options.unwrap_or(JsTriggerOptions {
            idempotency_key: None,
            delay_ms: None,
            subject: None,
        });
        self.core
            .engine()
            .trigger_blocking(
                &workflow,
                input,
                opts.idempotency_key,
                opts.delay_ms.unwrap_or(0.0) as i64,
                opts.subject,
            )
            .map_err(err)
    }

    /// Sync step recording (hot path — called once per completed step).
    #[napi]
    pub fn record_step(
        &self,
        run_id: String,
        step_id: String,
        kind: String,
        result: Option<String>,
    ) -> Result<()> {
        self.core
            .store()
            .record_step_blocking(&run_id, &step_id, &kind, result)
            .map_err(|e| err(e.to_string()))?;
        self.core
            .metrics_handle()
            .steps_recorded
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    /// Runtime metrics counters as JSON (P3.11).
    #[napi]
    pub fn metrics_snapshot(&self) -> Result<String> {
        serde_json::to_string(&self.core.metrics()).map_err(|e| err(e.to_string()))
    }

    /// Run a retention GC pass now; returns `{ runs, steps, events }` JSON (P7.6).
    #[napi]
    pub fn run_gc(&self) -> Result<String> {
        let stats = self.core.gc_now().map_err(err)?;
        serde_json::to_string(&stats).map_err(|e| err(e.to_string()))
    }

    /// Readiness: started AND the store answers a ping (P7.7).
    #[napi]
    pub fn health_check(&self) -> bool {
        self.core.ready()
    }

    /// Agent session conversation JSON, or null (P4.7).
    #[napi]
    pub fn agent_session_get(&self, agent: String, id: String) -> Result<Option<String>> {
        self.core
            .store()
            .agent_session_get_blocking(&agent, &id)
            .map_err(|e| err(e.to_string()))
    }

    #[napi]
    pub fn agent_session_put(&self, agent: String, id: String, messages: String) -> Result<()> {
        self.core
            .store()
            .agent_session_put_blocking(&agent, &id, &messages)
            .map_err(|e| err(e.to_string()))
    }

    /// Sync event emit through the atomic outbox. Returns JSON
    /// { woken, triggered }.
    #[napi]
    pub fn emit_event(&self, event: String, payload: String) -> Result<String> {
        let (woken, triggered) = self
            .core
            .engine()
            .emit_blocking(&event, &payload)
            .map_err(err)?;
        Ok(format!(r#"{{"woken":{woken},"triggered":{triggered}}}"#))
    }

    // -- Dashboard introspection (P3.13). Async is fine — cold path. -------

    #[napi]
    pub async fn dashboard_runs(
        &self,
        workflow: Option<String>,
        status: Option<i64>,
        limit: Option<u32>,
    ) -> Result<String> {
        let runs = self
            .core
            .store()
            .runs_list(workflow, status, limit.unwrap_or(50))
            .await
            .map_err(|e| err(e.to_string()))?;
        serde_json::to_string(&runs).map_err(|e| err(e.to_string()))
    }

    #[napi]
    pub async fn dashboard_run_steps(&self, run_id: String) -> Result<String> {
        let steps = self
            .core
            .store()
            .steps_for_run(&run_id)
            .await
            .map_err(|e| err(e.to_string()))?;
        serde_json::to_string(&steps).map_err(|e| err(e.to_string()))
    }

    #[napi]
    pub async fn dashboard_queues(&self) -> Result<String> {
        let stats = self
            .core
            .store()
            .queue_stats()
            .await
            .map_err(|e| err(e.to_string()))?;
        serde_json::to_string(&stats).map_err(|e| err(e.to_string()))
    }

    #[napi]
    pub async fn dashboard_schedules(&self) -> Result<String> {
        let schedules = self
            .core
            .store()
            .all_schedules()
            .await
            .map_err(|e| err(e.to_string()))?;
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Row {
            name: String,
            spec: String,
            overlap: String,
            catchup: String,
            next_run_at: i64,
            last_run_at: Option<i64>,
        }
        let rows: Vec<Row> = schedules
            .into_iter()
            .map(|s| Row {
                name: s.name,
                spec: s.spec,
                overlap: s.overlap,
                catchup: s.catchup,
                next_run_at: s.next_run_at,
                last_run_at: s.last_run_at,
            })
            .collect();
        serde_json::to_string(&rows).map_err(|e| err(e.to_string()))
    }

    #[napi]
    pub async fn dashboard_events(&self, limit: Option<u32>) -> Result<String> {
        let events = self
            .core
            .store()
            .recent_events(limit.unwrap_or(50))
            .await
            .map_err(|e| err(e.to_string()))?;
        serde_json::to_string(&events).map_err(|e| err(e.to_string()))
    }

    /// Run row as JSON, or null when unknown.
    #[napi]
    pub fn get_run(&self, run_id: String) -> Result<Option<String>> {
        let run = self
            .core
            .store()
            .get_run_blocking(&run_id)
            .map_err(|e| err(e.to_string()))?;
        match run {
            Some(run) => Ok(Some(
                serde_json::to_string(&run).map_err(|e| err(e.to_string()))?,
            )),
            None => Ok(None),
        }
    }

    /// Wait until the run is terminal (or timeout). Async is fine — long wait.
    #[napi]
    pub async fn wait_for_run(&self, run_id: String, timeout_ms: f64) -> Result<Option<String>> {
        let run = self
            .core
            .engine()
            .wait_for_run(&run_id, timeout_ms as i64)
            .await
            .map_err(err)?;
        match run {
            Some(run) => Ok(Some(
                serde_json::to_string(&run).map_err(|e| err(e.to_string()))?,
            )),
            None => Ok(None),
        }
    }

    /// Cancel a run and its descendants. Returns the number cancelled.
    #[napi]
    pub fn cancel_run(&self, run_id: String) -> Result<u32> {
        self.core.engine().cancel_blocking(&run_id).map_err(err)
    }

    #[napi]
    pub fn start(&self) -> Result<()> {
        self.core.start().map_err(err)
    }

    /// Sync push (hot path). Returns the job id.
    #[napi]
    pub fn push(
        &self,
        queue: String,
        payload: String,
        options: Option<JsPushOptions>,
    ) -> Result<String> {
        let ids = self.push_bulk(queue, vec![payload], options)?;
        Ok(ids.into_iter().next().expect("one id per job"))
    }

    #[napi]
    pub fn push_bulk(
        &self,
        queue: String,
        payloads: Vec<String>,
        options: Option<JsPushOptions>,
    ) -> Result<Vec<String>> {
        let opts = options.unwrap_or(JsPushOptions {
            delay_ms: None,
            priority: None,
            max_attempts: None,
            concurrency_key: None,
            debounce_key: None,
            throttle_key: None,
            throttle_spacing_ms: None,
        });
        // Default maxAttempts from the locally registered queue config when
        // the producer didn't specify one.
        let default_attempts = opts.max_attempts.unwrap_or_else(|| {
            self.core
                .queue_config(&queue)
                .map(|c| c.max_attempts)
                .unwrap_or(3)
        });
        let jobs = payloads
            .into_iter()
            .map(|payload| PushJob {
                queue: queue.clone(),
                payload,
                priority: opts.priority.unwrap_or(0),
                delay_ms: opts.delay_ms.unwrap_or(0.0) as i64,
                max_attempts: default_attempts,
                concurrency_key: opts.concurrency_key.clone(),
                debounce_key: opts.debounce_key.clone(),
                throttle_key: opts.throttle_key.clone(),
                throttle_spacing_ms: opts.throttle_spacing_ms.map(|m| m as i64),
            })
            .collect();
        self.core.push(jobs).map_err(err)
    }

    /// Graceful shutdown; returns true if all in-flight jobs drained within
    /// the timeout. Async NAPI is fine here — cold path.
    #[napi]
    pub async fn stop(&self, timeout_ms: Option<f64>) -> Result<bool> {
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000.0).max(0.0) as u64);
        self.core.stop(timeout).await.map_err(err)
    }

    #[napi]
    pub async fn pending_count(&self, queue: String) -> Result<f64> {
        let store = self.core.store();
        let n = store
            .pending_count(&queue)
            .await
            .map_err(|e| err(e.to_string()))?;
        Ok(n as f64)
    }

    #[napi]
    pub async fn active_count(&self, queue: String) -> Result<f64> {
        let store = self.core.store();
        let n = store
            .active_count(&queue)
            .await
            .map_err(|e| err(e.to_string()))?;
        Ok(n as f64)
    }

    /// Dead-letter jobs as a JSON string (parsed JS-side).
    #[napi]
    pub async fn dead_jobs(&self, queue: String, limit: Option<u32>) -> Result<String> {
        let store = self.core.store();
        let jobs = store
            .dead_jobs(&queue, limit.unwrap_or(100))
            .await
            .map_err(|e| err(e.to_string()))?;
        serde_json::to_string(&jobs).map_err(|e| err(e.to_string()))
    }

    #[napi]
    pub async fn requeue_dead(&self, ids: Vec<String>) -> Result<f64> {
        let store = self.core.store();
        let n = store
            .requeue_dead(ids)
            .await
            .map_err(|e| err(e.to_string()))?;
        Ok(n as f64)
    }

    /// Pause a queue: stop claiming new jobs on this node (P14.1).
    #[napi]
    pub fn pause_queue(&self, queue: String) {
        self.core.pause_queue(&queue);
    }

    /// Resume a paused queue.
    #[napi]
    pub fn resume_queue(&self, queue: String) {
        self.core.resume_queue(&queue);
    }

    #[napi]
    pub fn is_queue_paused(&self, queue: String) -> bool {
        self.core.is_queue_paused(&queue)
    }

    /// Bulk control-plane op (P14.1): delete all dead-lettered jobs for a queue.
    #[napi]
    pub async fn purge_dead(&self, queue: String) -> Result<f64> {
        let store = self.core.store();
        let n = store
            .purge_dead(&queue)
            .await
            .map_err(|e| err(e.to_string()))?;
        Ok(n as f64)
    }

    /// PII purge (P14.6): delete all runs + steps tagged with `subject`.
    #[napi]
    pub async fn purge_subject(&self, subject: String) -> Result<f64> {
        let n = self
            .core
            .store()
            .purge_subject(&subject)
            .await
            .map_err(|e| err(e.to_string()))?;
        Ok(n as f64)
    }
}
