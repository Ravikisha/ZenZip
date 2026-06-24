//! Runtime metrics (P3.11): cheap atomic counters incremented on the hot
//! paths, snapshotted by the dashboard / `/api/metrics`. OTLP export is a
//! separate exporter task — these counters are the source it will read.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

#[derive(Default)]
pub struct Metrics {
    pub jobs_completed: AtomicU64,
    pub jobs_retried: AtomicU64,
    pub jobs_dead: AtomicU64,
    pub handler_ms_sum: AtomicU64,
    pub handler_ms_max: AtomicU64,
    pub handler_count: AtomicU64,
    pub runs_completed: AtomicU64,
    pub runs_failed: AtomicU64,
    pub step_retries: AtomicU64,
    pub steps_recorded: AtomicU64,
    pub events_emitted: AtomicU64,
    pub schedule_fires: AtomicU64,
    pub runs_gc: AtomicU64,
    pub steps_gc: AtomicU64,
    pub events_gc: AtomicU64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    pub jobs_completed: u64,
    pub jobs_retried: u64,
    pub jobs_dead: u64,
    pub handler_avg_ms: f64,
    pub handler_max_ms: u64,
    pub handler_count: u64,
    pub runs_completed: u64,
    pub runs_failed: u64,
    pub step_retries: u64,
    pub steps_recorded: u64,
    pub events_emitted: u64,
    pub schedule_fires: u64,
    pub runs_gc: u64,
    pub steps_gc: u64,
    pub events_gc: u64,
}

impl Metrics {
    pub fn record_handler(&self, elapsed_ms: u64) {
        self.handler_ms_sum.fetch_add(elapsed_ms, Ordering::Relaxed);
        self.handler_count.fetch_add(1, Ordering::Relaxed);
        self.handler_ms_max.fetch_max(elapsed_ms, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> MetricsSnapshot {
        let count = self.handler_count.load(Ordering::Relaxed);
        let sum = self.handler_ms_sum.load(Ordering::Relaxed);
        MetricsSnapshot {
            jobs_completed: self.jobs_completed.load(Ordering::Relaxed),
            jobs_retried: self.jobs_retried.load(Ordering::Relaxed),
            jobs_dead: self.jobs_dead.load(Ordering::Relaxed),
            handler_avg_ms: if count > 0 {
                sum as f64 / count as f64
            } else {
                0.0
            },
            handler_max_ms: self.handler_ms_max.load(Ordering::Relaxed),
            handler_count: count,
            runs_completed: self.runs_completed.load(Ordering::Relaxed),
            runs_failed: self.runs_failed.load(Ordering::Relaxed),
            step_retries: self.step_retries.load(Ordering::Relaxed),
            steps_recorded: self.steps_recorded.load(Ordering::Relaxed),
            events_emitted: self.events_emitted.load(Ordering::Relaxed),
            schedule_fires: self.schedule_fires.load(Ordering::Relaxed),
            runs_gc: self.runs_gc.load(Ordering::Relaxed),
            steps_gc: self.steps_gc.load(Ordering::Relaxed),
            events_gc: self.events_gc.load(Ordering::Relaxed),
        }
    }
}
