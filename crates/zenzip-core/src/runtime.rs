//! Runtime shell (P1.15): owns the tokio runtime, the store, registered
//! queues/schedules, and the start/stop lifecycle with graceful drain.
//!
//! Threading model (plan.md D8): the engine runs on its own tokio runtime,
//! fully independent of Node's event loop and of napi's runtime. Handlers
//! cross back into JS via ThreadsafeFunctions owned by the closures.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::metrics::{Metrics, MetricsSnapshot};
use crate::queue::{Handler, QueueConfig, QueueWorker};
use crate::scheduler::{schedule_queue_name, Overlap, ScheduleDef, Scheduler};
use crate::sqlite::SqliteStore;
use crate::store::{GcStats, PushJob, Store};
use crate::workflow::{workflow_queue_name, Executor, WorkflowConfig, WorkflowEngine};

/// State machine definition (P3.5): transitions keyed by (state, event).
#[derive(Debug, Clone)]
pub struct MachineDef {
    pub name: String,
    pub initial: String,
    pub transitions: HashMap<(String, String), String>,
}

#[derive(Debug, Clone)]
pub struct TransitionResult {
    pub from: String,
    pub to: String,
}

/// Storage backend selection (P5.4): SQLite embedded (default) or Postgres
/// for multi-node — same API, one config line.
#[derive(Debug, Clone)]
pub enum StoreBackend {
    Sqlite,
    Postgres { url: String },
}

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub data_dir: PathBuf,
    pub backend: StoreBackend,
    /// Lease-expiry sweep cadence.
    pub sweep_ms: u64,
    /// Scheduler tick cadence.
    pub scheduler_tick_ms: u64,
    pub worker_threads: usize,
    /// Retention GC sweep cadence (P7.6).
    pub gc_sweep_ms: u64,
    /// Delete terminal runs (+ steps) older than this. None = keep forever.
    pub run_retention_ms: Option<i64>,
    /// Delete events older than this. None = keep forever.
    pub event_retention_ms: Option<i64>,
    /// Payload encryption-at-rest passphrase (P7.15). None = disabled
    /// (payloads stored as plaintext, the default).
    pub encryption_key: Option<String>,
}

impl RuntimeConfig {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            backend: StoreBackend::Sqlite,
            sweep_ms: 5_000,
            scheduler_tick_ms: 250,
            worker_threads: 2,
            // Sensible defaults: sweep hourly, keep 7 days of runs + events.
            // A durable engine that retains everything forever degrades over
            // time — this is a correctness default, not just a feature.
            gc_sweep_ms: 3_600_000,
            run_retention_ms: Some(7 * 86_400_000),
            event_retention_ms: Some(7 * 86_400_000),
            encryption_key: None,
        }
    }

    pub fn postgres(url: impl Into<String>) -> Self {
        let mut config = Self::new(".zenzip");
        config.backend = StoreBackend::Postgres { url: url.into() };
        config
    }
}

/// Run one retention GC pass against `store` using `config`'s windows, and
/// fold the deleted counts into the GC metrics. Shared by the background
/// sweeper and the manual `gc_now` trigger (P7.6).
async fn run_gc(
    store: &Arc<dyn Store>,
    config: &RuntimeConfig,
    metrics: &Metrics,
) -> Result<GcStats, String> {
    let now = crate::time::now_ms();
    let run_before = config.run_retention_ms.map(|r| now - r);
    let event_before = config.event_retention_ms.map(|r| now - r);
    let stats = store
        .gc(run_before, event_before)
        .await
        .map_err(|e| e.to_string())?;
    metrics.runs_gc.fetch_add(stats.runs, Ordering::Relaxed);
    metrics.steps_gc.fetch_add(stats.steps, Ordering::Relaxed);
    metrics.events_gc.fetch_add(stats.events, Ordering::Relaxed);
    Ok(stats)
}

pub struct CoreRuntime {
    store: Arc<dyn Store>,
    rt: Mutex<Option<tokio::runtime::Runtime>>,
    handle: tokio::runtime::Handle,
    token: CancellationToken,
    tracker: TaskTracker,
    queues: Mutex<Vec<(QueueConfig, Handler)>>,
    schedules: Mutex<Vec<ScheduleDef>>,
    notifies: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
    /// Per-queue pause flags (P14.1). Shared with each worker; toggling one
    /// stops/starts that queue's claiming on this node.
    paused: Mutex<HashMap<String, Arc<AtomicBool>>>,
    engine: Arc<WorkflowEngine>,
    metrics: Arc<Metrics>,
    machines: Mutex<HashMap<String, MachineDef>>,
    has_workflows: AtomicBool,
    started: AtomicBool,
    config: RuntimeConfig,
}

impl CoreRuntime {
    pub fn new(config: RuntimeConfig) -> Result<Self, String> {
        // Runtime first: the Postgres store needs its handle to connect.
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(config.worker_threads.max(1))
            .enable_all()
            .thread_name("zenzip-core")
            .build()
            .map_err(|e| format!("build tokio runtime: {e}"))?;
        let handle = rt.handle().clone();
        let crypto = crate::crypto::Crypto::new(config.encryption_key.as_deref());
        let store: Arc<dyn Store> = match &config.backend {
            StoreBackend::Sqlite => {
                let db_path = config.data_dir.join("zenzip.db");
                Arc::new(
                    SqliteStore::open_with(&db_path, crypto)
                        .map_err(|e| format!("open store: {e}"))?,
                )
            }
            StoreBackend::Postgres { url } => Arc::new(
                crate::postgres::PgStore::open_with(handle.clone(), url, crypto)
                    .map_err(|e| format!("open postgres store: {e}"))?,
            ),
        };
        let notifies: Arc<Mutex<HashMap<String, Arc<Notify>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let metrics = Arc::new(Metrics::default());
        let engine = Arc::new(WorkflowEngine::new(
            store.clone(),
            notifies.clone(),
            metrics.clone(),
        ));
        Ok(Self {
            store,
            rt: Mutex::new(Some(rt)),
            handle,
            token: CancellationToken::new(),
            tracker: TaskTracker::new(),
            queues: Mutex::new(Vec::new()),
            schedules: Mutex::new(Vec::new()),
            notifies,
            paused: Mutex::new(HashMap::new()),
            engine,
            metrics,
            machines: Mutex::new(HashMap::new()),
            has_workflows: AtomicBool::new(false),
            started: AtomicBool::new(false),
            config,
        })
    }

    fn ensure_not_started(&self) -> Result<(), String> {
        if self.started.load(Ordering::SeqCst) {
            return Err("runtime already started".into());
        }
        Ok(())
    }

    pub fn register_queue(&self, cfg: QueueConfig, handler: Handler) -> Result<(), String> {
        self.ensure_not_started()?;
        let mut queues = self.queues.lock().unwrap();
        if queues.iter().any(|(c, _)| c.name == cfg.name) {
            return Err(format!("queue '{}' already registered", cfg.name));
        }
        queues.push((cfg, handler));
        Ok(())
    }

    /// A schedule is a definition plus a hidden consumer queue (one engine).
    pub fn register_schedule(&self, def: ScheduleDef, handler: Handler) -> Result<(), String> {
        self.ensure_not_started()?;
        {
            let schedules = self.schedules.lock().unwrap();
            if schedules.iter().any(|d| d.name == def.name) {
                return Err(format!("schedule '{}' already registered", def.name));
            }
        }
        let mut cfg = QueueConfig::new(schedule_queue_name(&def.name));
        cfg.concurrency = match def.overlap {
            Overlap::Allow => 8,
            Overlap::Skip | Overlap::Queue => 1,
        };
        cfg.max_attempts = 1;
        self.register_queue(cfg, handler)?;
        self.schedules.lock().unwrap().push(def);
        Ok(())
    }

    /// A workflow is a config in the engine plus a hidden execution queue
    /// whose handler drives the step-memoization protocol (one engine).
    pub fn register_workflow(&self, cfg: WorkflowConfig, executor: Executor) -> Result<(), String> {
        self.ensure_not_started()?;
        let name = cfg.name.clone();
        let concurrency = cfg.concurrency;
        let lease_ms = cfg.lease_ms;
        self.engine.add_config(cfg)?;
        let mut queue_cfg = QueueConfig::new(workflow_queue_name(&name));
        queue_cfg.concurrency = concurrency.max(1);
        // Infra retries for the execution attempt itself; step retries are
        // engine-managed via fresh jobs.
        queue_cfg.max_attempts = 3;
        queue_cfg.lease_ms = lease_ms.max(1_000);
        queue_cfg.poll_ms = 100;
        let handler = self.engine.make_handler(name, executor);
        self.register_queue(queue_cfg, handler)?;
        self.has_workflows.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn engine(&self) -> Arc<WorkflowEngine> {
        self.engine.clone()
    }

    // -- State machines (P3.5–P3.7) ----------------------------------------

    pub fn register_machine(&self, def: MachineDef) -> Result<(), String> {
        let mut machines = self.machines.lock().unwrap();
        if machines.contains_key(&def.name) {
            return Err(format!("machine '{}' already registered", def.name));
        }
        if def.initial.is_empty() {
            return Err(format!("machine '{}': initial state required", def.name));
        }
        machines.insert(def.name.clone(), def);
        Ok(())
    }

    /// Create an instance in the machine's initial state. False = existed.
    pub fn machine_create(&self, machine: &str, id: &str) -> Result<bool, String> {
        let initial = self
            .machines
            .lock()
            .unwrap()
            .get(machine)
            .map(|d| d.initial.clone())
            .ok_or_else(|| format!("unknown machine '{machine}'"))?;
        self.store
            .machine_create_blocking(machine, id, &initial)
            .map_err(|e| e.to_string())
    }

    /// Apply an event: validates the transition against the definition, then
    /// commits the state change, history entry, AND the
    /// `<machine>.<toState>` event (with its triggered runs) in ONE store
    /// transaction — no transition-without-event crash window.
    pub fn machine_send(
        &self,
        machine: &str,
        id: &str,
        event: &str,
    ) -> Result<TransitionResult, String> {
        let def = self
            .machines
            .lock()
            .unwrap()
            .get(machine)
            .cloned()
            .ok_or_else(|| format!("unknown machine '{machine}'"))?;

        // Optimistic transition with a couple of retries on races.
        for _ in 0..3 {
            let current = self
                .store
                .machine_state_blocking(machine, id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("unknown instance '{id}' of machine '{machine}'"))?;
            let Some(to) = def
                .transitions
                .get(&(current.clone(), event.to_string()))
                .cloned()
            else {
                return Err(format!(
                    "invalid transition: machine '{machine}' instance '{id}' \
                     cannot handle '{event}' in state '{current}'"
                ));
            };
            let event_name = format!("{machine}.{to}");
            let payload = serde_json::json!({
                "machine": machine,
                "id": id,
                "from": current,
                "event": event,
                "to": to,
            })
            .to_string();
            let targets = self.engine.trigger_targets(&event_name);
            let outcome = self
                .store
                .machine_send_blocking(
                    machine,
                    id,
                    &current,
                    event,
                    &to,
                    &event_name,
                    &payload,
                    targets,
                )
                .map_err(|e| e.to_string())?;
            if let Some(outcome) = outcome {
                self.engine.notify_emit_outcome(&outcome);
                return Ok(TransitionResult { from: current, to });
            }
        }
        Err(format!(
            "concurrent transitions on machine '{machine}' instance '{id}' — retry"
        ))
    }

    pub fn metrics(&self) -> MetricsSnapshot {
        self.metrics.snapshot()
    }

    pub fn metrics_handle(&self) -> Arc<Metrics> {
        self.metrics.clone()
    }

    pub fn machine_state(&self, machine: &str, id: &str) -> Result<Option<String>, String> {
        self.store
            .machine_state_blocking(machine, id)
            .map_err(|e| e.to_string())
    }

    pub fn machine_history(
        &self,
        machine: &str,
        id: &str,
        limit: u32,
    ) -> Result<Vec<crate::store::MachineHistoryRow>, String> {
        self.store
            .machine_history_blocking(machine, id, limit)
            .map_err(|e| e.to_string())
    }

    /// Get-or-create the pause flag for a queue (P14.1). Shared Arc so a
    /// toggle is seen by the worker whether the flag is set before or after
    /// the worker spawns.
    fn pause_flag(&self, name: &str) -> Arc<AtomicBool> {
        self.paused
            .lock()
            .unwrap()
            .entry(name.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    /// Pause a queue: stop claiming new jobs (in-flight jobs finish). P14.1.
    pub fn pause_queue(&self, name: &str) {
        self.pause_flag(name).store(true, Ordering::SeqCst);
    }

    /// Resume a paused queue and wake its dispatcher.
    pub fn resume_queue(&self, name: &str) {
        self.pause_flag(name).store(false, Ordering::SeqCst);
        if let Some(n) = self.notifies.lock().unwrap().get(name) {
            n.notify_one();
        }
    }

    pub fn is_queue_paused(&self, name: &str) -> bool {
        self.paused
            .lock()
            .unwrap()
            .get(name)
            .map(|f| f.load(Ordering::SeqCst))
            .unwrap_or(false)
    }

    pub fn start(&self) -> Result<(), String> {
        if self.started.swap(true, Ordering::SeqCst) {
            return Err("runtime already started".into());
        }

        // Queue dispatchers.
        let queues: Vec<(QueueConfig, Handler)> = self.queues.lock().unwrap().clone();
        for (cfg, handler) in queues {
            let notify = Arc::new(Notify::new());
            self.notifies
                .lock()
                .unwrap()
                .insert(cfg.name.clone(), notify.clone());
            let paused = self.pause_flag(&cfg.name);
            let worker = QueueWorker {
                cfg,
                handler,
                store: self.store.clone(),
                notify,
                metrics: self.metrics.clone(),
                paused,
            };
            let token = self.token.clone();
            let tracker = self.tracker.clone();
            self.tracker
                .spawn_on(worker.run(token, tracker.clone()), &self.handle);
        }

        // Lease-expiry sweeper (P1.5 crash recovery).
        {
            let store = self.store.clone();
            let token = self.token.clone();
            let sweep_ms = self.config.sweep_ms;
            let notifies = self.notifies.clone();
            self.tracker.spawn_on(
                async move {
                    loop {
                        tokio::select! {
                            _ = token.cancelled() => return,
                            _ = tokio::time::sleep(Duration::from_millis(sweep_ms)) => {},
                        }
                        match store.sweep_expired(crate::time::now_ms()).await {
                            Ok(0) => {}
                            Ok(n) => {
                                tracing::info!(count = n, "recovered lease-expired jobs");
                                // Re-deliverable immediately: wake everyone.
                                for notify in notifies.lock().unwrap().values() {
                                    notify.notify_one();
                                }
                            }
                            Err(e) => tracing::error!(error = %e, "sweep failed"),
                        }
                    }
                },
                &self.handle,
            );
        }

        // Retention GC sweeper (P7.6): delete aged terminal runs + events so
        // tables don't grow unbounded. Only spawned when retention is enabled.
        if self.config.run_retention_ms.is_some() || self.config.event_retention_ms.is_some() {
            let store = self.store.clone();
            let token = self.token.clone();
            let metrics = self.metrics.clone();
            let config = self.config.clone();
            let gc_ms = self.config.gc_sweep_ms.max(1_000);
            self.tracker.spawn_on(
                async move {
                    loop {
                        tokio::select! {
                            _ = token.cancelled() => return,
                            _ = tokio::time::sleep(Duration::from_millis(gc_ms)) => {},
                        }
                        match run_gc(&store, &config, &metrics).await {
                            Ok(s) if s.runs == 0 && s.events == 0 => {}
                            Ok(s) => tracing::info!(
                                runs = s.runs,
                                steps = s.steps,
                                events = s.events,
                                "retention GC removed rows"
                            ),
                            Err(e) => tracing::error!(error = %e, "retention GC failed"),
                        }
                    }
                },
                &self.handle,
            );
        }

        // Workflow event-timeout sweeper (P2.6): releases waitForEvent
        // waiters whose timeout passed.
        if self.has_workflows.load(Ordering::SeqCst) {
            let engine = self.engine.clone();
            let token = self.token.clone();
            let tick_ms = self.config.scheduler_tick_ms.max(50);
            self.tracker.spawn_on(
                async move {
                    loop {
                        tokio::select! {
                            _ = token.cancelled() => return,
                            _ = tokio::time::sleep(Duration::from_millis(tick_ms)) => {},
                        }
                        match engine.sweep(crate::time::now_ms()).await {
                            Ok(0) => {}
                            Ok(n) => tracing::debug!(count = n, "event waits timed out"),
                            Err(e) => tracing::error!(error = %e, "workflow sweep failed"),
                        }
                    }
                },
                &self.handle,
            );
        }

        // Scheduler.
        let defs: Vec<ScheduleDef> = self.schedules.lock().unwrap().clone();
        if !defs.is_empty() {
            let notifies = self.notifies.clone();
            let scheduler = Scheduler {
                store: self.store.clone(),
                defs: defs.into_iter().map(|d| (d.name.clone(), d)).collect(),
                notifier: Arc::new(move |queue: &str| {
                    if let Some(n) = notifies.lock().unwrap().get(queue) {
                        n.notify_one();
                    }
                }),
                tick_ms: self.config.scheduler_tick_ms,
                metrics: self.metrics.clone(),
            };
            let token = self.token.clone();
            self.tracker.spawn_on(scheduler.run(token), &self.handle);
        }

        // Cross-node wakeups (P5.3): pushes/emits on OTHER nodes notify our
        // dispatchers instantly instead of waiting out the poll interval.
        if let StoreBackend::Postgres { url } = &self.config.backend {
            let notifies = self.notifies.clone();
            crate::postgres::spawn_wake_listener(
                &self.handle,
                url.clone(),
                Arc::new(move |queue: &str| {
                    if let Some(n) = notifies.lock().unwrap().get(queue) {
                        n.notify_one();
                    }
                }),
                self.token.clone(),
            );
        }

        tracing::info!(
            queues = self.queues.lock().unwrap().len(),
            schedules = self.schedules.lock().unwrap().len(),
            backend = match &self.config.backend {
                StoreBackend::Sqlite => "sqlite",
                StoreBackend::Postgres { .. } => "postgres",
            },
            "zenzip runtime started"
        );
        Ok(())
    }

    /// Sync push from the JS thread (sync NAPI fast path). Pushing to a queue
    /// with no local consumer is allowed (producer-only processes).
    pub fn push(&self, jobs: Vec<PushJob>) -> Result<Vec<String>, String> {
        let queues: Vec<String> = jobs.iter().map(|j| j.queue.clone()).collect();
        let ids = self
            .store
            .push_blocking(jobs)
            .map_err(|e| format!("push: {e}"))?;
        let notifies = self.notifies.lock().unwrap();
        for queue in queues {
            if let Some(n) = notifies.get(&queue) {
                n.notify_one();
            }
        }
        Ok(ids)
    }

    pub fn store(&self) -> Arc<dyn Store> {
        self.store.clone()
    }

    /// Readiness probe (P7.7): started AND the store answers a ping. Liveness
    /// (process up) is decided by the caller without touching the store.
    pub fn ready(&self) -> bool {
        if !self.started.load(Ordering::SeqCst) {
            return false;
        }
        let store = self.store.clone();
        self.handle.block_on(async move { store.ping().await.is_ok() })
    }

    /// Run a retention GC pass now, using the configured windows (P7.6).
    /// For ops tooling (`zenzip doctor`) and tests; the background sweeper
    /// runs it on a cadence automatically.
    pub fn gc_now(&self) -> Result<GcStats, String> {
        let store = self.store.clone();
        let config = self.config.clone();
        let metrics = self.metrics.clone();
        self.handle
            .block_on(async move { run_gc(&store, &config, &metrics).await })
    }

    /// Default config for a queue (used by push when the producer didn't
    /// specify maxAttempts and the queue is registered locally).
    pub fn queue_config(&self, name: &str) -> Option<QueueConfig> {
        self.queues
            .lock()
            .unwrap()
            .iter()
            .find(|(c, _)| c.name == name)
            .map(|(c, _)| c.clone())
    }

    /// Graceful shutdown (P1.11): stop claiming, drain in-flight handlers up
    /// to `timeout`, then release the runtime. Returns true on clean drain.
    pub async fn stop(&self, timeout: Duration) -> Result<bool, String> {
        if !self.started.swap(false, Ordering::SeqCst) {
            // Never started (or already stopped): still release resources.
            self.release();
            return Ok(true);
        }
        self.token.cancel();
        self.tracker.close();
        let drained = tokio::time::timeout(timeout, self.tracker.wait())
            .await
            .is_ok();
        self.release();
        Ok(drained)
    }

    fn release(&self) {
        // Drop handler closures -> releases ThreadsafeFunctions -> lets the
        // Node event loop exit.
        self.queues.lock().unwrap().clear();
        self.schedules.lock().unwrap().clear();
        self.notifies.lock().unwrap().clear();
        // Close the store BEFORE the runtime: the Postgres pool needs the
        // engine runtime alive to drain.
        self.store.close_blocking();
        if let Some(rt) = self.rt.lock().unwrap().take() {
            // Non-blocking: safe to call from an async context.
            rt.shutdown_background();
        }
    }
}
