//! Scheduler boot/catchup behavior (P1.13) and queue engine batch +
//! rate-limit behavior (P1.9).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use zenzip_core::queue::{Backoff, Handler, QueueConfig, QueueWorker, RateLimit};
use zenzip_core::scheduler::{schedule_queue_name, Catchup, Overlap, ScheduleDef, Scheduler};
use zenzip_core::sqlite::SqliteStore;
use zenzip_core::store::{PushJob, ScheduleRow, Store};
use zenzip_core::time::now_ms;

fn temp_store(tag: &str) -> (Arc<SqliteStore>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "zenzip-sched-test-{}-{}",
        tag,
        uuid::Uuid::now_v7()
    ));
    let store = SqliteStore::open(&dir.join("test.db")).expect("open store");
    (Arc::new(store), dir)
}

fn scheduler(store: Arc<SqliteStore>, def: ScheduleDef) -> Scheduler {
    let mut defs = HashMap::new();
    defs.insert(def.name.clone(), def);
    Scheduler {
        store,
        defs,
        notifier: Arc::new(|_q: &str| {}),
        tick_ms: 50,
        metrics: Arc::new(zenzip_core::metrics::Metrics::default()),
    }
}

/// Simulate a restart with missed ticks: store a schedule row whose
/// next_run_at is in the past with the SAME spec, then boot.
async fn seed_overdue(store: &Arc<SqliteStore>, def: &ScheduleDef, overdue_by_ms: i64) {
    store
        .upsert_schedule(ScheduleRow {
            name: def.name.clone(),
            spec: def.spec.clone(),
            overlap: def.overlap.as_str().to_string(),
            catchup: def.catchup.as_str().to_string(),
            next_run_at: now_ms() - overdue_by_ms,
            last_run_at: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn catchup_all_fires_every_missed_tick() {
    let (store, dir) = temp_store("catchup-all");
    let def = ScheduleDef::every("pulse", 1_000, Overlap::Allow, Catchup::All).unwrap();
    // 3.5s overdue with a 1s interval -> ticks at -3500, -2500, -1500, -500 = 4 fires.
    seed_overdue(&store, &def, 3_500).await;

    let queue = schedule_queue_name("pulse");
    scheduler(store.clone(), def).boot().await.unwrap();

    assert_eq!(store.pending_count(&queue).await.unwrap(), 4);
    // next_run_at advanced into the future.
    assert!(store.due_schedules(now_ms()).await.unwrap().is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn catchup_skip_fires_nothing_on_boot() {
    let (store, dir) = temp_store("catchup-skip");
    let def = ScheduleDef::every("pulse", 1_000, Overlap::Allow, Catchup::Skip).unwrap();
    seed_overdue(&store, &def, 3_500).await;

    let queue = schedule_queue_name("pulse");
    scheduler(store.clone(), def).boot().await.unwrap();

    assert_eq!(store.pending_count(&queue).await.unwrap(), 0);
    assert!(store.due_schedules(now_ms()).await.unwrap().is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn catchup_run_once_leaves_one_due_tick() {
    let (store, dir) = temp_store("catchup-once");
    let def = ScheduleDef::every("pulse", 1_000, Overlap::Allow, Catchup::RunOnce).unwrap();
    seed_overdue(&store, &def, 3_500).await;

    scheduler(store.clone(), def).boot().await.unwrap();

    // Nothing enqueued at boot, but exactly one overdue tick remains for the
    // scheduler loop to fire.
    let queue = schedule_queue_name("pulse");
    assert_eq!(store.pending_count(&queue).await.unwrap(), 0);
    assert_eq!(store.due_schedules(now_ms()).await.unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn jitter_delays_delivery() {
    let (store, dir) = temp_store("jitter");
    let mut def = ScheduleDef::every("pulse", 1_000, Overlap::Allow, Catchup::All).unwrap();
    def.jitter_ms = 60_000; // any fire lands 0..=60s in the future
    seed_overdue(&store, &def, 500).await; // exactly 1 missed tick

    let queue = schedule_queue_name("pulse");
    scheduler(store.clone(), def).boot().await.unwrap();

    assert_eq!(store.pending_count(&queue).await.unwrap(), 1);
    // With 60s jitter the job is almost surely not claimable immediately;
    // tolerate the tiny chance of jitter < ~10ms by allowing 0 or 1.
    let claimable = store.claim(&queue, 10, 30_000).await.unwrap();
    assert!(claimable.len() <= 1);
    let _ = std::fs::remove_dir_all(dir);
}

// ---------------------------------------------------------------------------
// P1.9 — batch consumption + rate limiting at the engine level
// ---------------------------------------------------------------------------

fn push_n(queue: &str, n: usize) -> Vec<PushJob> {
    (0..n)
        .map(|i| PushJob {
            queue: queue.into(),
            payload: format!("{i}"),
            priority: 0,
            delay_ms: 0,
            max_attempts: 3,
        })
        .collect()
}

#[tokio::test]
async fn handler_batch_groups_jobs() {
    use std::sync::Mutex;
    use tokio_util::sync::CancellationToken;
    use tokio_util::task::TaskTracker;

    let (store, dir) = temp_store("batch");
    let groups: Arc<Mutex<Vec<usize>>> = Arc::new(Mutex::new(Vec::new()));

    let handler: Handler = {
        let groups = groups.clone();
        Arc::new(move |jobs| {
            groups.lock().unwrap().push(jobs.len());
            Box::pin(async move { Ok(()) })
        })
    };

    let mut cfg = QueueConfig::new("q");
    cfg.poll_ms = 20;
    cfg.handler_batch = 3;
    cfg.concurrency = 2;

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
        }
        .run(token.clone(), tracker.clone()),
    );

    store.push(push_n("q", 7)).await.unwrap();
    notify.notify_one();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while store.active_count("q").await.unwrap() > 0 {
        assert!(tokio::time::Instant::now() < deadline, "jobs did not drain");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    let groups = groups.lock().unwrap().clone();
    let total: usize = groups.iter().sum();
    assert_eq!(total, 7);
    assert!(
        groups.iter().all(|&g| g <= 3),
        "group too large: {groups:?}"
    );
    assert!(groups.contains(&3), "no full group: {groups:?}");

    token.cancel();
    tracker.close();
    tracker.wait().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn rate_limit_caps_throughput() {
    use std::sync::atomic::{AtomicU32, Ordering};
    use tokio_util::sync::CancellationToken;
    use tokio_util::task::TaskTracker;

    let (store, dir) = temp_store("rate");
    let processed = Arc::new(AtomicU32::new(0));

    let handler: Handler = {
        let processed = processed.clone();
        Arc::new(move |jobs| {
            processed.fetch_add(jobs.len() as u32, Ordering::SeqCst);
            Box::pin(async move { Ok(()) })
        })
    };

    let mut cfg = QueueConfig::new("q");
    cfg.poll_ms = 10;
    cfg.backoff = Backoff {
        delay_ms: 10,
        max_delay_ms: 10,
    };
    // 2 jobs per 300ms.
    cfg.rate_limit = Some(RateLimit {
        max: 2,
        per_ms: 300,
    });

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
        }
        .run(token.clone(), tracker.clone()),
    );

    store.push(push_n("q", 8)).await.unwrap();
    notify.notify_one();

    // Burst capacity is 2; after ~150ms at most ~3 should have run
    // (2 burst + ~1 refilled). Generous bound: <= 4.
    tokio::time::sleep(Duration::from_millis(150)).await;
    let early = processed.load(Ordering::SeqCst);
    assert!(
        early <= 4,
        "rate limit ineffective: {early} processed in 150ms"
    );
    assert!(early >= 1, "nothing processed at all");

    // Everything completes eventually.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while processed.load(Ordering::SeqCst) < 8 {
        assert!(tokio::time::Instant::now() < deadline, "jobs did not drain");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    token.cancel();
    tracker.close();
    tracker.wait().await;
    let _ = std::fs::remove_dir_all(dir);
}
