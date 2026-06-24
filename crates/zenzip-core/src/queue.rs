//! Queue engine (P1.6, P1.9): per-queue dispatcher loop that claims batches
//! from the store and runs handlers with bounded concurrency, token-bucket
//! rate limiting, batch handler groups, per-group lease renewal, retry
//! backoff, and DLQ transitions.
//!
//! Handlers are opaque async closures over a *group* of jobs — group size 1
//! for per-job consumers, N for `processBatch`. The NAPI layer wraps a
//! ThreadsafeFunction into one, keeping this module free of N-API types.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use tokio::sync::{Notify, Semaphore};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::metrics::Metrics;
use crate::store::{ClaimedJob, Store};
use crate::time::now_ms;

/// Handler outcome for a job group: Ok = ack all, Err(message) = nack all
/// (each job follows its own retry budget).
pub type HandlerResult = Result<(), String>;
pub type Handler = Arc<dyn Fn(Vec<ClaimedJob>) -> BoxFuture<'static, HandlerResult> + Send + Sync>;

#[derive(Debug, Clone)]
pub struct Backoff {
    pub delay_ms: i64,
    pub max_delay_ms: i64,
}

impl Default for Backoff {
    fn default() -> Self {
        Self {
            delay_ms: 1_000,
            max_delay_ms: 60_000,
        }
    }
}

impl Backoff {
    /// Exponential backoff with jitter: delay * 2^(attempt-1), capped,
    /// +/- up to 25%.
    pub fn delay_for(&self, attempt: u32) -> i64 {
        let exp = attempt.saturating_sub(1).min(20);
        let base = self.delay_ms.saturating_mul(1i64 << exp);
        let capped = base.min(self.max_delay_ms).max(1);
        let jitter = fastrand::i64(0..=(capped / 4).max(1));
        capped - (capped / 8) + jitter
    }
}

/// Token bucket: at most `max` jobs started per `per_ms` window (P1.9).
#[derive(Debug, Clone)]
pub struct RateLimit {
    pub max: u32,
    pub per_ms: u64,
}

struct TokenBucket {
    capacity: f64,
    tokens: f64,
    /// Tokens regenerated per millisecond.
    refill_per_ms: f64,
    last: tokio::time::Instant,
}

impl TokenBucket {
    fn new(limit: &RateLimit) -> Self {
        let capacity = limit.max.max(1) as f64;
        Self {
            capacity,
            tokens: capacity,
            refill_per_ms: capacity / limit.per_ms.max(1) as f64,
            last: tokio::time::Instant::now(),
        }
    }

    fn refill(&mut self) {
        let now = tokio::time::Instant::now();
        let elapsed_ms = now.duration_since(self.last).as_secs_f64() * 1000.0;
        self.tokens = (self.tokens + elapsed_ms * self.refill_per_ms).min(self.capacity);
        self.last = now;
    }

    fn take(&mut self, want: u32) -> u32 {
        self.refill();
        let granted = want.min(self.tokens.floor() as u32);
        self.tokens -= granted as f64;
        granted
    }

    fn ms_until_token(&self) -> u64 {
        if self.tokens >= 1.0 {
            0
        } else {
            ((1.0 - self.tokens) / self.refill_per_ms).ceil() as u64
        }
    }
}

#[derive(Debug, Clone)]
pub struct QueueConfig {
    pub name: String,
    pub concurrency: u32,
    pub max_attempts: u32,
    pub backoff: Backoff,
    pub lease_ms: i64,
    pub poll_ms: u64,
    /// Max jobs claimed per storage round-trip.
    pub batch: u32,
    /// Jobs delivered per handler invocation (1 = per-job consumer).
    pub handler_batch: u32,
    pub rate_limit: Option<RateLimit>,
    /// Per-key concurrency limit (P10.1): at most this many jobs sharing a
    /// `concurrency_key` run at once. None = global concurrency only.
    pub concurrency_key_limit: Option<u32>,
    /// Fairness (P10.3): round-robin claims across concurrency_key groups so
    /// one tenant can't starve others.
    pub fair: bool,
}

impl QueueConfig {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            concurrency: 10,
            max_attempts: 3,
            backoff: Backoff::default(),
            lease_ms: 30_000,
            poll_ms: 250,
            batch: 32,
            handler_batch: 1,
            rate_limit: None,
            concurrency_key_limit: None,
            fair: false,
        }
    }
}

pub struct QueueWorker {
    pub cfg: QueueConfig,
    pub handler: Handler,
    pub store: Arc<dyn Store>,
    /// Woken on local pushes so same-process latency is not poll-bound.
    pub notify: Arc<Notify>,
    pub metrics: Arc<Metrics>,
    /// Pause flag (P14.1): when set, the worker stops claiming new jobs.
    pub paused: Arc<AtomicBool>,
}

impl QueueWorker {
    pub async fn run(self, token: CancellationToken, tracker: TaskTracker) {
        let semaphore = Arc::new(Semaphore::new(self.cfg.concurrency.max(1) as usize));
        let group = self.cfg.handler_batch.max(1);
        let mut bucket = self.cfg.rate_limit.as_ref().map(TokenBucket::new);

        loop {
            let mut rate_wait_ms: Option<u64> = None;
            let mut saturated = false;

            // Claim until drained, saturated, or out of rate-limit tokens.
            loop {
                if token.is_cancelled() {
                    return;
                }
                // Paused (P14.1): don't claim; fall through to the sleep below
                // and re-check on the next poll / on resume's notify.
                if self.paused.load(Ordering::Relaxed) {
                    break;
                }
                let available = semaphore.available_permits() as u32;
                if available == 0 {
                    saturated = true;
                    break;
                }
                let mut want = (available.saturating_mul(group)).min(self.cfg.batch.max(group));
                if let Some(bucket) = bucket.as_mut() {
                    want = bucket.take(want);
                    if want == 0 {
                        rate_wait_ms = Some(bucket.ms_until_token().max(1));
                        break;
                    }
                }
                let jobs = match self
                    .store
                    .claim(
                        &self.cfg.name,
                        want,
                        self.cfg.lease_ms,
                        self.cfg.concurrency_key_limit,
                        self.cfg.fair,
                    )
                    .await
                {
                    Ok(jobs) => jobs,
                    Err(e) => {
                        tracing::error!(queue = %self.cfg.name, error = %e, "claim failed");
                        break;
                    }
                };
                if jobs.is_empty() {
                    // Unused tokens go back to the bucket.
                    if let Some(bucket) = bucket.as_mut() {
                        bucket.tokens = (bucket.tokens + want as f64).min(bucket.capacity);
                    }
                    break;
                }
                // Return tokens for the jobs we didn't actually get.
                if let Some(bucket) = bucket.as_mut() {
                    let unused = want.saturating_sub(jobs.len() as u32);
                    bucket.tokens = (bucket.tokens + unused as f64).min(bucket.capacity);
                }
                for chunk in jobs.chunks(group as usize) {
                    let permit = semaphore
                        .clone()
                        .acquire_owned()
                        .await
                        .expect("semaphore closed");
                    tracker.spawn(run_group(
                        chunk.to_vec(),
                        permit,
                        self.store.clone(),
                        self.handler.clone(),
                        self.cfg.clone(),
                        self.metrics.clone(),
                    ));
                }
            }

            if saturated && rate_wait_ms.is_none() {
                // Backlog remains but concurrency is full: resume the moment
                // a permit frees instead of sleeping out the poll interval —
                // a single push-notification must drain an arbitrary burst.
                tokio::select! {
                    _ = token.cancelled() => return,
                    _ = self.notify.notified() => {},
                    permit = semaphore.clone().acquire_owned() => { drop(permit); },
                }
                continue;
            }

            let sleep_ms = rate_wait_ms
                .map(|w| w.min(self.cfg.poll_ms))
                .unwrap_or(self.cfg.poll_ms);
            tokio::select! {
                _ = token.cancelled() => return,
                _ = self.notify.notified() => {},
                _ = tokio::time::sleep(Duration::from_millis(sleep_ms)) => {},
            }
        }
    }
}

async fn run_group(
    jobs: Vec<ClaimedJob>,
    _permit: tokio::sync::OwnedSemaphorePermit,
    store: Arc<dyn Store>,
    handler: Handler,
    cfg: QueueConfig,
    metrics: Arc<Metrics>,
) {
    let ids: Vec<String> = jobs.iter().map(|j| j.id.clone()).collect();
    // (id, fence) pairs so lease renewal is fence-guarded too (P7.11).
    let leases: Vec<(String, i64)> = jobs.iter().map(|j| (j.id.clone(), j.fence)).collect();
    let started = tokio::time::Instant::now();
    let fut = handler(jobs.clone());
    tokio::pin!(fut);

    // Renew the group's leases at lease/3 cadence while the handler runs, so
    // long-running jobs are not swept mid-flight (P1.3 heartbeat).
    let renew_every = Duration::from_millis((cfg.lease_ms / 3).max(1_000) as u64);
    let mut renew = tokio::time::interval(renew_every);
    renew.tick().await; // consume the immediate first tick

    let result = loop {
        tokio::select! {
            r = &mut fut => break r,
            _ = renew.tick() => {
                if let Err(e) = store.renew_leases(leases.clone(), cfg.lease_ms).await {
                    tracing::warn!(queue = %cfg.name, error = %e, "lease renewal failed");
                }
            }
        }
    };

    metrics.record_handler(started.elapsed().as_millis() as u64);
    match result {
        Ok(()) => {
            for job in &jobs {
                if let Err(e) = store.ack(&job.id, job.fence).await {
                    tracing::error!(job = %job.id, error = %e, "ack failed");
                }
            }
            metrics
                .jobs_completed
                .fetch_add(ids.len() as u64, std::sync::atomic::Ordering::Relaxed);
        }
        Err(message) => {
            for job in &jobs {
                let outcome = if job.attempt >= job.max_attempts {
                    metrics
                        .jobs_dead
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    store.fail_dead(&job.id, &message, job.fence).await
                } else {
                    metrics
                        .jobs_retried
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let at = now_ms() + cfg.backoff.delay_for(job.attempt);
                    store.fail_retry(&job.id, &message, at, job.fence).await
                };
                if let Err(e) = outcome {
                    tracing::error!(job = %job.id, error = %e, "nack persistence failed");
                }
            }
        }
    }
}
