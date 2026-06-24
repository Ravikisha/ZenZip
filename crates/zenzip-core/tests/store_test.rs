//! Store-level integration tests (P1.5 crash-safety semantics at the
//! storage layer: lease expiry, retry budget, DLQ, priorities, delays).

use std::sync::Arc;
use std::time::Duration;

use zenzip_core::queue::{Backoff, Handler, QueueConfig, QueueWorker};
use zenzip_core::sqlite::SqliteStore;
use zenzip_core::store::{NewRun, PushJob, ScheduleRow, Store};
use zenzip_core::time::now_ms;

fn temp_store(tag: &str) -> (Arc<SqliteStore>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "zenzip-store-test-{}-{}",
        tag,
        uuid::Uuid::now_v7()
    ));
    let store = SqliteStore::open(&dir.join("test.db")).expect("open store");
    (Arc::new(store), dir)
}

fn job(queue: &str, payload: &str) -> PushJob {
    PushJob {
        queue: queue.into(),
        payload: payload.into(),
        priority: 0,
        delay_ms: 0,
        max_attempts: 3,
        concurrency_key: None,
        debounce_key: None,
        throttle_key: None,
        throttle_spacing_ms: None,
    }
}

#[tokio::test]
async fn push_claim_ack_roundtrip() {
    let (store, dir) = temp_store("ack");
    let ids = store.push(vec![job("q", "{\"n\":1}")]).await.unwrap();
    assert_eq!(ids.len(), 1);
    assert_eq!(store.pending_count("q").await.unwrap(), 1);

    let claimed = store.claim("q", 10, 30_000, None, false).await.unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].attempt, 1);
    assert_eq!(claimed[0].payload, "{\"n\":1}");
    // Claimed job is not claimable again while leased.
    assert!(store.claim("q", 10, 30_000, None, false).await.unwrap().is_empty());

    store.ack(&claimed[0].id, claimed[0].fence).await.unwrap();
    assert_eq!(store.active_count("q").await.unwrap(), 0);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn retry_then_dead_letter() {
    let (store, dir) = temp_store("dlq");
    store
        .push(vec![PushJob {
            max_attempts: 2,
            ..job("q", "{}")
        }])
        .await
        .unwrap();

    // Attempt 1 fails -> retry.
    let claimed = store.claim("q", 1, 30_000, None, false).await.unwrap();
    assert_eq!(claimed[0].attempt, 1);
    store
        .fail_retry(&claimed[0].id, "boom 1", now_ms(), claimed[0].fence)
        .await
        .unwrap();

    // Attempt 2 fails -> attempts exhausted -> dead.
    let claimed = store.claim("q", 1, 30_000, None, false).await.unwrap();
    assert_eq!(claimed[0].attempt, 2);
    store
        .fail_dead(&claimed[0].id, "boom 2", claimed[0].fence)
        .await
        .unwrap();

    assert!(store.claim("q", 1, 30_000, None, false).await.unwrap().is_empty());
    let dead = store.dead_jobs("q", 10).await.unwrap();
    assert_eq!(dead.len(), 1);
    assert_eq!(dead[0].last_error.as_deref(), Some("boom 2"));

    // Requeue resets the attempt budget.
    let n = store.requeue_dead(vec![dead[0].id.clone()]).await.unwrap();
    assert_eq!(n, 1);
    let claimed = store.claim("q", 1, 30_000, None, false).await.unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].attempt, 1);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn lease_expiry_redelivers_via_sweep() {
    let (store, dir) = temp_store("sweep");
    store.push(vec![job("q", "{}")]).await.unwrap();

    // Claim with a 50ms lease, then simulate a worker crash (no ack).
    let claimed = store.claim("q", 1, 50, None, false).await.unwrap();
    assert_eq!(claimed.len(), 1);
    tokio::time::sleep(Duration::from_millis(80)).await;

    let swept = store.sweep_expired(now_ms()).await.unwrap();
    assert_eq!(swept, 1);

    // Redelivered with the attempt already counted.
    let again = store.claim("q", 1, 30_000, None, false).await.unwrap();
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].attempt, 2);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn lease_expiry_with_exhausted_attempts_goes_dead() {
    let (store, dir) = temp_store("sweep-dead");
    store
        .push(vec![PushJob {
            max_attempts: 1,
            ..job("q", "{}")
        }])
        .await
        .unwrap();

    let claimed = store.claim("q", 1, 50, None, false).await.unwrap();
    assert_eq!(claimed[0].attempt, 1);
    tokio::time::sleep(Duration::from_millis(80)).await;
    store.sweep_expired(now_ms()).await.unwrap();

    assert!(store.claim("q", 1, 30_000, None, false).await.unwrap().is_empty());
    let dead = store.dead_jobs("q", 10).await.unwrap();
    assert_eq!(dead.len(), 1);
    assert_eq!(dead[0].last_error.as_deref(), Some("lease expired"));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn priority_and_delay_ordering() {
    let (store, dir) = temp_store("prio");
    store
        .push(vec![
            PushJob {
                priority: 0,
                ..job("q", "\"low\"")
            },
            PushJob {
                priority: 5,
                ..job("q", "\"high\"")
            },
            PushJob {
                delay_ms: 60_000,
                priority: 9,
                ..job("q", "\"delayed\"")
            },
        ])
        .await
        .unwrap();

    let claimed = store.claim("q", 10, 30_000, None, false).await.unwrap();
    // Delayed job must not be claimable yet, high priority first.
    assert_eq!(claimed.len(), 2);
    assert_eq!(claimed[0].payload, "\"high\"");
    assert_eq!(claimed[1].payload, "\"low\"");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn schedule_upsert_preserves_timing_for_same_spec() {
    let (store, dir) = temp_store("sched");
    let row = ScheduleRow {
        name: "daily".into(),
        spec: "cron:0 9 * * *@UTC".into(),
        overlap: "skip".into(),
        catchup: "skip".into(),
        next_run_at: 1_000,
        last_run_at: None,
    };
    let stored = store.upsert_schedule(row.clone()).await.unwrap();
    assert_eq!(stored.next_run_at, 1_000);
    store
        .set_schedule_next("daily", 2_000, Some(1_000))
        .await
        .unwrap();

    // Same spec on restart: stored timing wins over the recomputed value.
    let stored = store
        .upsert_schedule(ScheduleRow {
            next_run_at: 9_999,
            ..row.clone()
        })
        .await
        .unwrap();
    assert_eq!(stored.next_run_at, 2_000);
    assert_eq!(stored.last_run_at, Some(1_000));

    // Changed spec: recomputed value wins, timing reset.
    let stored = store
        .upsert_schedule(ScheduleRow {
            spec: "cron:0 10 * * *@UTC".into(),
            next_run_at: 9_999,
            ..row
        })
        .await
        .unwrap();
    assert_eq!(stored.next_run_at, 9_999);
    assert_eq!(stored.last_run_at, None);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn queue_worker_processes_and_retries() {
    use std::sync::atomic::{AtomicU32, Ordering};
    use tokio_util::sync::CancellationToken;
    use tokio_util::task::TaskTracker;

    let (store, dir) = temp_store("worker");
    let attempts = Arc::new(AtomicU32::new(0));

    let handler: Handler = {
        let attempts = attempts.clone();
        Arc::new(move |jobs| {
            let attempts = attempts.clone();
            Box::pin(async move {
                let job = &jobs[0]; // handler_batch = 1 in this test
                attempts.fetch_add(1, Ordering::SeqCst);
                // First delivery of the "flaky" job fails, retry succeeds.
                if job.payload == "\"flaky\"" && job.attempt == 1 {
                    Err("transient".to_string())
                } else {
                    Ok(())
                }
            })
        })
    };

    let mut cfg = QueueConfig::new("q");
    cfg.poll_ms = 20;
    cfg.backoff = Backoff {
        delay_ms: 10,
        max_delay_ms: 20,
    };

    let notify = Arc::new(tokio::sync::Notify::new());
    let token = CancellationToken::new();
    let tracker = TaskTracker::new();
    let worker = QueueWorker {
        cfg,
        handler,
        store: store.clone(),
        notify: notify.clone(),
        metrics: Arc::new(zenzip_core::metrics::Metrics::default()),
        paused: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    tokio::spawn(worker.run(token.clone(), tracker.clone()));

    store
        .push(vec![job("q", "\"ok\""), job("q", "\"flaky\"")])
        .await
        .unwrap();
    notify.notify_one();

    // ok: 1 attempt; flaky: 2 attempts.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while store.active_count("q").await.unwrap() > 0 {
        assert!(tokio::time::Instant::now() < deadline, "jobs did not drain");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
    assert!(store.dead_jobs("q", 10).await.unwrap().is_empty());

    token.cancel();
    tracker.close();
    tracker.wait().await;
    let _ = std::fs::remove_dir_all(dir);
}

fn new_run() -> NewRun {
    NewRun {
        workflow: "wf".into(),
        input: "{}".into(),
        version: None,
        idempotency_key: None,
        parent_run_id: None,
        parent_step_id: None,
    }
}

#[tokio::test]
async fn paused_worker_does_not_claim_until_resumed() {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use tokio_util::sync::CancellationToken;
    use tokio_util::task::TaskTracker;

    let (store, dir) = temp_store("pause");
    let processed = Arc::new(AtomicU32::new(0));
    let paused = Arc::new(AtomicBool::new(true)); // start paused

    let handler: Handler = {
        let processed = processed.clone();
        Arc::new(move |_jobs| {
            let processed = processed.clone();
            Box::pin(async move {
                processed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        })
    };
    let mut cfg = QueueConfig::new("q");
    cfg.poll_ms = 20;
    let notify = Arc::new(tokio::sync::Notify::new());
    let token = CancellationToken::new();
    let tracker = TaskTracker::new();
    tokio::spawn(
        QueueWorker {
            cfg,
            handler,
            store: store.clone(),
            notify: notify.clone(),
            metrics: Arc::new(zenzip_core::metrics::Metrics::default()),
            paused: paused.clone(),
        }
        .run(token.clone(), tracker.clone()),
    );

    store.push(vec![job("q", "{}")]).await.unwrap();
    notify.notify_one();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(processed.load(Ordering::SeqCst), 0, "paused queue must not claim");

    paused.store(false, Ordering::SeqCst);
    notify.notify_one();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while processed.load(Ordering::SeqCst) == 0 {
        assert!(tokio::time::Instant::now() < deadline, "did not resume");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(processed.load(Ordering::SeqCst), 1);

    token.cancel();
    tracker.close();
    tracker.wait().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn fair_claim_round_robins_across_keys() {
    let (store, dir) = temp_store("fair");
    // Tenant "a" floods 3 jobs; tenant "b" has 1.
    for i in 0..3 {
        store
            .push(vec![PushJob {
                concurrency_key: Some("a".into()),
                ..job("q", &format!("a{i}"))
            }])
            .await
            .unwrap();
    }
    store
        .push(vec![PushJob {
            concurrency_key: Some("b".into()),
            ..job("q", "b0")
        }])
        .await
        .unwrap();

    // Fair claim of 2 round-robins → one "a" and one "b", not two "a"s.
    let claimed = store.claim("q", 2, 30_000, None, true).await.unwrap();
    assert_eq!(claimed.len(), 2);
    let a = claimed.iter().filter(|j| j.payload.starts_with('a')).count();
    let b = claimed.iter().filter(|j| j.payload.starts_with('b')).count();
    assert_eq!((a, b), (1, 1), "fair claim must not let one key starve the other");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn throttle_spaces_starts_by_key() {
    let (store, dir) = temp_store("throttle");
    // Three jobs, throttle key "k", 60s spacing → first now, rest scheduled ahead.
    for i in 0..3 {
        store
            .push(vec![PushJob {
                throttle_key: Some("k".into()),
                throttle_spacing_ms: Some(60_000),
                ..job("q", &format!("t{i}"))
            }])
            .await
            .unwrap();
    }
    // Only the first slot is claimable now; the rest are spaced into the future.
    let claimed = store.claim("q", 10, 30_000, None, false).await.unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].payload, "t0");
    assert_eq!(store.pending_count("q").await.unwrap(), 2);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn debounce_collapses_pending_by_key() {
    let (store, dir) = temp_store("debounce");
    // Three rapid pushes with the same debounce key → only the last survives.
    for i in 0..3 {
        store
            .push(vec![PushJob {
                debounce_key: Some("k".into()),
                ..job("q", &format!("v{i}"))
            }])
            .await
            .unwrap();
    }
    assert_eq!(store.pending_count("q").await.unwrap(), 1);
    let claimed = store.claim("q", 10, 30_000, None, false).await.unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].payload, "v2"); // latest wins

    // A different key is an independent bucket.
    store
        .push(vec![PushJob {
            debounce_key: Some("other".into()),
            ..job("q", "x")
        }])
        .await
        .unwrap();
    assert_eq!(store.pending_count("q").await.unwrap(), 1);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn purge_dead_removes_dead_lettered_jobs() {
    let (store, dir) = temp_store("purge");
    // Two jobs → claim → dead-letter each.
    store
        .push(vec![job("q", "\"a\""), job("q", "\"b\"")])
        .await
        .unwrap();
    for _ in 0..2 {
        let c = store.claim("q", 1, 30_000, None, false).await.unwrap();
        store.fail_dead(&c[0].id, "boom", c[0].fence).await.unwrap();
    }
    assert_eq!(store.dead_jobs("q", 10).await.unwrap().len(), 2);

    let purged = store.purge_dead("q").await.unwrap();
    assert_eq!(purged, 2);
    assert!(store.dead_jobs("q", 10).await.unwrap().is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn per_key_concurrency_caps_running_per_key() {
    let (store, dir) = temp_store("ckey");
    let mut jobs = Vec::new();
    for i in 0..3 {
        jobs.push(PushJob {
            concurrency_key: Some("a".into()),
            ..job("q", &format!("a{i}"))
        });
    }
    for i in 0..2 {
        jobs.push(PushJob {
            concurrency_key: Some("b".into()),
            ..job("q", &format!("b{i}"))
        });
    }
    jobs.push(job("q", "nokey")); // unbucketed — not capped
    store.push(jobs).await.unwrap();

    // limit 1 per key: one "a", one "b", plus the unbucketed job.
    let first = store.claim("q", 10, 30_000, Some(1), false).await.unwrap();
    assert_eq!(first.iter().filter(|j| j.payload.starts_with('a')).count(), 1);
    assert_eq!(first.iter().filter(|j| j.payload.starts_with('b')).count(), 1);
    assert!(first.iter().any(|j| j.payload == "nokey"));
    assert_eq!(first.len(), 3);

    // Nothing new claimable: both keys at their cap, the free job is gone.
    let second = store.claim("q", 10, 30_000, Some(1), false).await.unwrap();
    assert_eq!(second.len(), 0);

    // Finish the running "a" → its key frees a slot for the next "a".
    let a = first.iter().find(|j| j.payload.starts_with('a')).unwrap().clone();
    store.ack(&a.id, a.fence).await.unwrap();
    let third = store.claim("q", 10, 30_000, Some(1), false).await.unwrap();
    assert_eq!(third.len(), 1);
    assert!(third[0].payload.starts_with('a'));

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn fencing_token_rejects_a_zombie_workers_late_write() {
    let (store, dir) = temp_store("fence");
    store.push(vec![job("q", "{}")]).await.unwrap();

    // Worker A claims (fence increments to 1).
    let a = store.claim("q", 1, 50, None, false).await.unwrap();
    assert_eq!(a[0].fence, 1);
    tokio::time::sleep(Duration::from_millis(80)).await;

    // Lease expires, sweep returns it, worker B re-claims (fence -> 2).
    assert_eq!(store.sweep_expired(now_ms()).await.unwrap(), 1);
    let b = store.claim("q", 1, 30_000, None, false).await.unwrap();
    assert_eq!(b[0].fence, 2);

    // Zombie worker A wakes and tries to finish with its STALE fence — no-op.
    store.ack(&a[0].id, a[0].fence).await.unwrap();
    assert_eq!(store.active_count("q").await.unwrap(), 1); // still owned by B
    store
        .fail_retry(&a[0].id, "stale", now_ms(), a[0].fence)
        .await
        .unwrap();
    // The job is still RUNNING under B (fail_retry didn't move it back).
    assert!(store.claim("q", 1, 30_000, None, false).await.unwrap().is_empty());

    // Worker B finishes with the current fence — that one takes effect.
    store.ack(&b[0].id, b[0].fence).await.unwrap();
    assert_eq!(store.active_count("q").await.unwrap(), 0);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn gc_removes_aged_terminal_runs_steps_and_events() {
    let (store, dir) = temp_store("gc");

    // A completed run with two journaled steps.
    let (rid, _) = store.create_run(new_run()).await.unwrap();
    store.record_step(&rid, "a", "run", Some("1".into())).await.unwrap();
    store.record_step(&rid, "b", "run", Some("2".into())).await.unwrap();
    store.run_completed(&rid, Some("\"ok\"".into())).await.unwrap();

    // A still-runnable (non-terminal) run must survive GC.
    let (live, _) = store.create_run(new_run()).await.unwrap();

    // A persisted event (no targets).
    store.emit_event_blocking("e", "{}", vec![]).unwrap();

    // Window in the future → the terminal run + event qualify; the live run
    // is non-terminal and is kept regardless.
    let future = now_ms() + 60_000;
    let stats = store.gc(Some(future), Some(future)).await.unwrap();
    assert_eq!(stats.runs, 1);
    assert_eq!(stats.steps, 2);
    assert!(stats.events >= 1);
    assert!(store.get_run(&rid).await.unwrap().is_none());
    assert!(store.get_run(&live).await.unwrap().is_some());
    assert!(store.load_journal(&rid).await.unwrap().is_empty());

    // None windows are a no-op.
    let none = store.gc(None, None).await.unwrap();
    assert_eq!(none.runs, 0);
    assert_eq!(none.events, 0);

    let _ = std::fs::remove_dir_all(dir);
}
