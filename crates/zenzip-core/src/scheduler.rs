//! Persisted scheduler (P1.12–P1.14): cron + fixed-interval schedules that
//! survive restarts. A schedule fire enqueues a job onto a hidden internal
//! queue (`zenzip.schedule.<name>`) — one engine, per docs/plan.md.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::{TimeZone, Utc};
use croner::Cron;
use tokio_util::sync::CancellationToken;

use crate::store::{PushJob, ScheduleRow, Store};
use crate::time::now_ms;

pub fn schedule_queue_name(name: &str) -> String {
    format!("zenzip.schedule.{name}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Overlap {
    /// Don't fire while a previous tick is still pending/running.
    Skip,
    /// Fire regardless; ticks may run concurrently.
    Allow,
    /// Fire regardless; ticks execute one at a time (concurrency 1).
    Queue,
}

impl Overlap {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "skip" => Ok(Self::Skip),
            "allow" => Ok(Self::Allow),
            "queue" => Ok(Self::Queue),
            other => Err(format!("invalid overlap policy: {other}")),
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Skip => "skip",
            Self::Allow => "allow",
            Self::Queue => "queue",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Catchup {
    /// Missed ticks while down are dropped; next future tick only.
    Skip,
    /// Fire exactly once on boot if ticks were missed, then resume.
    RunOnce,
    /// Fire every missed tick on boot (capped at MAX_CATCHUP_FIRES).
    All,
}

/// Cap for catchup=all so a schedule that was down for a month doesn't
/// flood the queue. Capping is logged, never silent.
pub const MAX_CATCHUP_FIRES: u32 = 100;

impl Catchup {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "skip" => Ok(Self::Skip),
            "runOnce" | "run-once" => Ok(Self::RunOnce),
            "all" => Ok(Self::All),
            other => Err(format!("invalid catchup policy: {other}")),
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Skip => "skip",
            Self::RunOnce => "runOnce",
            Self::All => "all",
        }
    }
}

#[derive(Clone)]
pub enum ScheduleKind {
    Every {
        ms: i64,
    },
    Cron {
        /// Boxed: parsed Cron is large relative to the Every variant.
        cron: Box<Cron>,
        tz: Option<chrono_tz::Tz>,
    },
}

#[derive(Clone)]
pub struct ScheduleDef {
    pub name: String,
    /// Canonical spec string persisted for change detection.
    pub spec: String,
    pub kind: ScheduleKind,
    pub overlap: Overlap,
    pub catchup: Catchup,
    /// Random 0..=jitter_ms delivery delay per fire (thundering-herd guard).
    pub jitter_ms: i64,
}

impl ScheduleDef {
    pub fn every(name: &str, ms: i64, overlap: Overlap, catchup: Catchup) -> Result<Self, String> {
        if ms < 1 {
            return Err("every interval must be >= 1ms".into());
        }
        Ok(Self {
            name: name.to_string(),
            spec: format!("every:{ms}"),
            kind: ScheduleKind::Every { ms },
            overlap,
            catchup,
            jitter_ms: 0,
        })
    }

    pub fn cron(
        name: &str,
        expr: &str,
        timezone: Option<&str>,
        overlap: Overlap,
        catchup: Catchup,
    ) -> Result<Self, String> {
        let cron = Cron::new(expr)
            .with_seconds_optional()
            .parse()
            .map_err(|e| format!("invalid cron expression '{expr}': {e}"))?;
        let tz = match timezone {
            Some(t) => Some(
                t.parse::<chrono_tz::Tz>()
                    .map_err(|_| format!("invalid timezone: {t}"))?,
            ),
            None => None,
        };
        Ok(Self {
            name: name.to_string(),
            spec: format!("cron:{expr}@{}", timezone.unwrap_or("UTC")),
            kind: ScheduleKind::Cron {
                cron: Box::new(cron),
                tz,
            },
            overlap,
            catchup,
            jitter_ms: 0,
        })
    }

    /// Next fire time (ms epoch) strictly after `after_ms`.
    pub fn next_after(&self, after_ms: i64) -> Result<i64, String> {
        match &self.kind {
            ScheduleKind::Every { ms } => Ok(after_ms + ms),
            ScheduleKind::Cron { cron, tz } => {
                let after = Utc
                    .timestamp_millis_opt(after_ms)
                    .single()
                    .ok_or_else(|| "invalid timestamp".to_string())?;
                let next_ms = match tz {
                    Some(tz) => cron
                        .find_next_occurrence(&after.with_timezone(tz), false)
                        .map_err(|e| e.to_string())?
                        .timestamp_millis(),
                    None => cron
                        .find_next_occurrence(&after, false)
                        .map_err(|e| e.to_string())?
                        .timestamp_millis(),
                };
                Ok(next_ms)
            }
        }
    }
}

pub struct Scheduler {
    pub store: Arc<dyn Store>,
    pub defs: HashMap<String, ScheduleDef>,
    /// Wakes the dispatcher of the hidden schedule queue after a fire.
    pub notifier: Arc<dyn Fn(&str) + Send + Sync>,
    pub tick_ms: u64,
    pub metrics: Arc<crate::metrics::Metrics>,
}

impl Scheduler {
    /// Persist definitions and apply boot catch-up policy (P1.13).
    pub async fn boot(&self) -> Result<(), String> {
        let now = now_ms();
        for def in self.defs.values() {
            let next = def.next_after(now)?;
            let stored = self
                .store
                .upsert_schedule(ScheduleRow {
                    name: def.name.clone(),
                    spec: def.spec.clone(),
                    overlap: def.overlap.as_str().to_string(),
                    catchup: def.catchup.as_str().to_string(),
                    next_run_at: next,
                    last_run_at: None,
                })
                .await
                .map_err(|e| e.to_string())?;
            // Missed while down:
            //   skip    -> advance past the gap, fire nothing
            //   runOnce -> leave the overdue next_run_at; first tick fires once
            //   all     -> enqueue every missed tick now (capped), then advance
            // Every adjustment is a CAS tick-claim, so concurrent nodes
            // booting together never double-fire (P5.1).
            if stored.next_run_at <= now {
                match def.catchup {
                    Catchup::Skip => {
                        let _ = self
                            .store
                            .schedule_claim_tick(
                                &def.name,
                                stored.next_run_at,
                                def.next_after(now)?,
                                now,
                            )
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                    Catchup::RunOnce => {}
                    Catchup::All => {
                        let mut t = stored.next_run_at;
                        let mut fired = 0u32;
                        while t <= now && fired < MAX_CATCHUP_FIRES {
                            let next_t = def.next_after(t)?;
                            let claimed = self
                                .store
                                .schedule_claim_tick(&def.name, t, next_t, now)
                                .await
                                .map_err(|e| e.to_string())?;
                            if !claimed {
                                // Another node is replaying this gap.
                                break;
                            }
                            self.fire(def, t).await?;
                            fired += 1;
                            t = next_t;
                        }
                        if fired == MAX_CATCHUP_FIRES && t <= now {
                            tracing::warn!(
                                schedule = %def.name,
                                cap = MAX_CATCHUP_FIRES,
                                "catchup=all hit the fire cap; remaining missed ticks dropped"
                            );
                            let _ = self
                                .store
                                .schedule_claim_tick(&def.name, t, def.next_after(now)?, now)
                                .await
                                .map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    async fn fire(&self, def: &ScheduleDef, fired_at: i64) -> Result<(), String> {
        let queue = schedule_queue_name(&def.name);
        let payload = format!(r#"{{"schedule":"{}","firedAt":{}}}"#, def.name, fired_at);
        let delay_ms = if def.jitter_ms > 0 {
            fastrand::i64(0..=def.jitter_ms)
        } else {
            0
        };
        self.store
            .push(vec![PushJob {
                queue: queue.clone(),
                payload,
                priority: 0,
                delay_ms,
                max_attempts: 1,
            }])
            .await
            .map_err(|e| e.to_string())?;
        (self.notifier)(&queue);
        self.metrics
            .schedule_fires
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    pub async fn run(self, token: CancellationToken) {
        if let Err(e) = self.boot().await {
            tracing::error!(error = %e, "scheduler boot failed");
            return;
        }
        loop {
            tokio::select! {
                _ = token.cancelled() => return,
                _ = tokio::time::sleep(Duration::from_millis(self.tick_ms)) => {},
            }
            let now = now_ms();
            let due = match self.store.due_schedules(now).await {
                Ok(due) => due,
                Err(e) => {
                    tracing::error!(error = %e, "due_schedules failed");
                    continue;
                }
            };
            for row in due {
                let Some(def) = self.defs.get(&row.name) else {
                    // Stored schedule no longer registered in this process.
                    continue;
                };
                // Claim the tick first (CAS) — exactly one node fires it.
                let next = def.next_after(now).unwrap_or(now + 60_000);
                let claimed = match self
                    .store
                    .schedule_claim_tick(&def.name, row.next_run_at, next, now)
                    .await
                {
                    Ok(claimed) => claimed,
                    Err(e) => {
                        tracing::error!(schedule = %def.name, error = %e, "tick claim failed");
                        continue;
                    }
                };
                if !claimed {
                    continue; // another node won this tick
                }
                let queue = schedule_queue_name(&def.name);
                let fire = match def.overlap {
                    Overlap::Skip => self.store.active_count(&queue).await.unwrap_or(1) == 0,
                    Overlap::Allow | Overlap::Queue => true,
                };
                if fire {
                    if let Err(e) = self.fire(def, now).await {
                        tracing::error!(schedule = %def.name, error = %e, "schedule fire failed");
                    }
                }
            }
        }
    }
}
