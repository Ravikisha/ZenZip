//! P7.14: deterministic fault-injection — the FaultStore harness drives the
//! queue worker through transient store failures and slow-store delays, and
//! asserts at-least-once delivery still holds.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use zenzip_core::fault::FaultStore;
use zenzip_core::metrics::Metrics;
use zenzip_core::queue::{Backoff, Handler, QueueConfig, QueueWorker};
use zenzip_core::sqlite::SqliteStore;
use zenzip_core::store::{PushJob, Store};

fn temp_dir(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("zenzip-fault-{}-{}", tag, uuid::Uuid::now_v7()))
}

fn job(payload: &str) -> PushJob {
    PushJob {
        queue: "q".into(),
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

fn spawn_worker(
    store: Arc<dyn Store>,
    handler: Handler,
    notify: Arc<tokio::sync::Notify>,
) -> (CancellationToken, TaskTracker) {
    let mut cfg = QueueConfig::new("q");
    cfg.poll_ms = 20;
    cfg.backoff = Backoff {
        delay_ms: 10,
        max_delay_ms: 20,
    };
    let token = CancellationToken::new();
    let tracker = TaskTracker::new();
    let worker = QueueWorker {
        cfg,
        handler,
        store,
        notify,
        metrics: Arc::new(Metrics::default()),
        paused: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    tokio::spawn(worker.run(token.clone(), tracker.clone()));
    (token, tracker)
}

async fn drain(store: &Arc<dyn Store>) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while store.active_count("q").await.unwrap() > 0 {
        assert!(tokio::time::Instant::now() < deadline, "jobs did not drain");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn worker_drains_despite_injected_claim_faults() {
    let dir = temp_dir("claim");
    let inner: Arc<dyn Store> = Arc::new(SqliteStore::open(&dir.join("t.db")).unwrap());
    let (store, faults) = FaultStore::wrap(inner);

    // The next three claim attempts error before any job is delivered.
    faults.fail_next("claim", 3);

    let runs = Arc::new(AtomicU32::new(0));
    let handler: Handler = {
        let runs = runs.clone();
        Arc::new(move |_jobs| {
            let runs = runs.clone();
            Box::pin(async move {
                runs.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        })
    };
    let notify = Arc::new(tokio::sync::Notify::new());
    let (token, tracker) = spawn_worker(store.clone(), handler, notify.clone());

    store.push(vec![job("\"x\"")]).await.unwrap();
    notify.notify_one();

    drain(&store).await;
    assert_eq!(runs.load(Ordering::SeqCst), 1); // processed exactly once
    assert!(store.dead_jobs("q", 10).await.unwrap().is_empty());

    token.cancel();
    tracker.close();
    tracker.wait().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn worker_tolerates_a_slow_store() {
    let dir = temp_dir("slow");
    let inner: Arc<dyn Store> = Arc::new(SqliteStore::open(&dir.join("t.db")).unwrap());
    let (store, faults) = FaultStore::wrap(inner);
    faults.set_delay_ms(30); // every faultable store call sleeps 30ms

    let runs = Arc::new(AtomicU32::new(0));
    let handler: Handler = {
        let runs = runs.clone();
        Arc::new(move |_jobs| {
            let runs = runs.clone();
            Box::pin(async move {
                runs.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        })
    };
    let notify = Arc::new(tokio::sync::Notify::new());
    let (token, tracker) = spawn_worker(store.clone(), handler, notify.clone());

    store.push(vec![job("\"a\""), job("\"b\"")]).await.unwrap();
    notify.notify_one();

    drain(&store).await;
    assert_eq!(runs.load(Ordering::SeqCst), 2);

    token.cancel();
    tracker.close();
    tracker.wait().await;
    let _ = std::fs::remove_dir_all(dir);
}
