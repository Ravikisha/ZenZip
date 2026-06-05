//! Store-level integration tests (P1.5 crash-safety semantics at the
//! storage layer: lease expiry, retry budget, DLQ, priorities, delays).

use std::sync::Arc;
use std::time::Duration;

use zenzip_core::queue::{Backoff, Handler, QueueConfig, QueueWorker};
use zenzip_core::sqlite::SqliteStore;
use zenzip_core::store::{PushJob, ScheduleRow, Store};
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
    }
}

#[tokio::test]
async fn push_claim_ack_roundtrip() {
    let (store, dir) = temp_store("ack");
    let ids = store.push(vec![job("q", "{\"n\":1}")]).await.unwrap();
    assert_eq!(ids.len(), 1);
    assert_eq!(store.pending_count("q").await.unwrap(), 1);

    let claimed = store.claim("q", 10, 30_000).await.unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].attempt, 1);
    assert_eq!(claimed[0].payload, "{\"n\":1}");
    // Claimed job is not claimable again while leased.
    assert!(store.claim("q", 10, 30_000).await.unwrap().is_empty());

    store.ack(&claimed[0].id).await.unwrap();
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
    let claimed = store.claim("q", 1, 30_000).await.unwrap();
    assert_eq!(claimed[0].attempt, 1);
    store
        .fail_retry(&claimed[0].id, "boom 1", now_ms())
        .await
        .unwrap();

    // Attempt 2 fails -> attempts exhausted -> dead.
    let claimed = store.claim("q", 1, 30_000).await.unwrap();
    assert_eq!(claimed[0].attempt, 2);
    store.fail_dead(&claimed[0].id, "boom 2").await.unwrap();

    assert!(store.claim("q", 1, 30_000).await.unwrap().is_empty());
    let dead = store.dead_jobs("q", 10).await.unwrap();
    assert_eq!(dead.len(), 1);
    assert_eq!(dead[0].last_error.as_deref(), Some("boom 2"));

    // Requeue resets the attempt budget.
    let n = store.requeue_dead(vec![dead[0].id.clone()]).await.unwrap();
    assert_eq!(n, 1);
    let claimed = store.claim("q", 1, 30_000).await.unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].attempt, 1);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn lease_expiry_redelivers_via_sweep() {
    let (store, dir) = temp_store("sweep");
    store.push(vec![job("q", "{}")]).await.unwrap();

    // Claim with a 50ms lease, then simulate a worker crash (no ack).
    let claimed = store.claim("q", 1, 50).await.unwrap();
    assert_eq!(claimed.len(), 1);
    tokio::time::sleep(Duration::from_millis(80)).await;

    let swept = store.sweep_expired(now_ms()).await.unwrap();
    assert_eq!(swept, 1);

    // Redelivered with the attempt already counted.
    let again = store.claim("q", 1, 30_000).await.unwrap();
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

    let claimed = store.claim("q", 1, 50).await.unwrap();
    assert_eq!(claimed[0].attempt, 1);
    tokio::time::sleep(Duration::from_millis(80)).await;
    store.sweep_expired(now_ms()).await.unwrap();

    assert!(store.claim("q", 1, 30_000).await.unwrap().is_empty());
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

    let claimed = store.claim("q", 10, 30_000).await.unwrap();
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
