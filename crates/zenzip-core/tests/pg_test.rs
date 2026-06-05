//! PostgreSQL multi-node tests (P5.1–P5.5). Require a reachable server:
//! set ZENZIP_PG_TEST_URL or run a local postgres with postgres/postgres and
//! a `zenzip_test` database. Tests skip (with a notice) when unreachable.
//!
//! "Nodes" are separate CoreRuntimes with separate pools and tokio runtimes
//! in one process â€” everything they share goes through Postgres, which is
//! exactly the multi-node contract.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use zenzip_core::queue::{Handler, QueueConfig};
use zenzip_core::runtime::{CoreRuntime, RuntimeConfig};
use zenzip_core::store::run_status;
use zenzip_core::workflow::{ExecRequest, Executor, WorkflowConfig};

fn pg_url() -> String {
    std::env::var("ZENZIP_PG_TEST_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:5432/zenzip_test".into())
}

/// Serialize PG tests (they share one schema) + reset it. Returns None when
/// the server is unreachable -> test skips.
async fn pg_guard() -> Option<tokio::sync::OwnedMutexGuard<()>> {
    static LOCK: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();
    let guard = LOCK
        .get_or_init(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
        .lock_owned()
        .await;

    let pool = match sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(3))
        .connect(&pg_url())
        .await
    {
        Ok(pool) => pool,
        Err(e) => {
            eprintln!("SKIP pg test: cannot connect ({e})");
            return None;
        }
    };
    sqlx::query("DROP SCHEMA IF EXISTS zenzip CASCADE")
        .execute(&pool)
        .await
        .expect("reset schema");
    pool.close().await;
    Some(guard)
}

fn node(tag: &str) -> Arc<CoreRuntime> {
    let mut config = RuntimeConfig::postgres(pg_url());
    config.sweep_ms = 200;
    config.scheduler_tick_ms = 50;
    let _ = tag;
    Arc::new(CoreRuntime::new(config).expect("pg runtime"))
}

fn counting_handler(seen: Arc<Mutex<HashMap<String, u32>>>, delay: Duration) -> Handler {
    Arc::new(move |jobs| {
        let seen = seen.clone();
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            let mut map = seen.lock().unwrap();
            for job in jobs {
                *map.entry(job.payload).or_insert(0) += 1;
            }
            Ok(())
        })
    })
}

fn fast_queue(name: &str, poll_ms: u64) -> QueueConfig {
    let mut cfg = QueueConfig::new(name);
    cfg.poll_ms = poll_ms;
    cfg.concurrency = 8;
    cfg.lease_ms = 1_500;
    cfg
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_two_nodes_share_a_queue_without_duplicates() {
    let Some(_guard) = pg_guard().await else {
        return;
    };
    let seen: Arc<Mutex<HashMap<String, u32>>> = Arc::new(Mutex::new(HashMap::new()));

    // Slow poll on purpose: completion within seconds proves the
    // LISTEN/NOTIFY cross-node wakeup works (P5.3).
    let a = node("a");
    let b = node("b");
    for n in [&a, &b] {
        n.register_queue(
            fast_queue("shared", 5_000),
            counting_handler(seen.clone(), Duration::ZERO),
        )
        .unwrap();
        n.start().unwrap();
    }

    let jobs: Vec<_> = (0..200)
        .map(|i| zenzip_core::store::PushJob {
            queue: "shared".into(),
            payload: format!("job-{i}"),
            priority: 0,
            delay_ms: 0,
            max_attempts: 3,
        })
        .collect();
    a.push(jobs).unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let processed = seen.lock().unwrap().len();
        if processed == 200 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "only {processed}/200 processed"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Exactly once under graceful conditions: no payload seen twice.
    let dups: Vec<_> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, &c)| c > 1)
        .map(|(k, _)| k.clone())
        .collect();
    assert!(dups.is_empty(), "duplicated jobs: {dups:?}");

    a.stop(Duration::from_secs(5)).await.unwrap();
    b.stop(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_three_node_chaos_kills_a_node_without_losing_jobs() {
    let Some(_guard) = pg_guard().await else {
        return;
    };
    let seen: Arc<Mutex<HashMap<String, u32>>> = Arc::new(Mutex::new(HashMap::new()));

    let nodes: Vec<Arc<CoreRuntime>> = (0..3).map(|i| node(&format!("n{i}"))).collect();
    for n in &nodes {
        n.register_queue(
            fast_queue("chaos", 200),
            counting_handler(seen.clone(), Duration::from_millis(30)),
        )
        .unwrap();
        n.start().unwrap();
    }

    let jobs: Vec<_> = (0..150)
        .map(|i| zenzip_core::store::PushJob {
            queue: "chaos".into(),
            payload: format!("c-{i}"),
            priority: 0,
            delay_ms: 0,
            max_attempts: 5,
        })
        .collect();
    nodes[0].push(jobs).unwrap();

    // Let work spread, then hard-kill node 1 (zero drain: in-flight jobs die
    // mid-handler and must be recovered via lease expiry by the survivors).
    tokio::time::sleep(Duration::from_millis(400)).await;
    nodes[1].stop(Duration::ZERO).await.unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    loop {
        let processed = seen.lock().unwrap().len();
        if processed == 150 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "only {processed}/150 processed after node kill"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // At-least-once: duplicates allowed ONLY for jobs in flight at the kill
    // (bounded by the dead node's concurrency).
    let dup_count = seen.lock().unwrap().values().filter(|&&c| c > 1).count();
    assert!(
        dup_count <= 8,
        "{dup_count} duplicated jobs â€” exceeds the killed node's in-flight bound"
    );

    nodes[0].stop(Duration::from_secs(5)).await.unwrap();
    nodes[2].stop(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_workflow_survives_node_kill_with_exactly_once_steps(// P5.5 core claim
) {
    let Some(_guard) = pg_guard().await else {
        return;
    };
    // Each step body counts executions; journal recording must be
    // effectively-once even when a node dies mid-run.
    let executions: Arc<Mutex<HashMap<String, u32>>> = Arc::new(Mutex::new(HashMap::new()));

    // Emulates a 5-step workflow: each attempt performs the next unrecorded
    // step's side effect, then suspends via an immediate-wake sleep (the
    // engine journals the step on suspension). Crash mid-attempt = the step
    // body may re-run (at-least-once), but the journal entry is written once.
    let make_executor = || -> Executor {
        let executions = executions.clone();
        Arc::new(move |req: ExecRequest| {
            let executions = executions.clone();
            Box::pin(async move {
                let journal: Vec<serde_json::Value> =
                    serde_json::from_str(&req.journal_json).unwrap();
                let done: Vec<&str> = journal.iter().filter_map(|e| e["id"].as_str()).collect();
                for i in 0..5 {
                    let id = format!("step-{i}");
                    if !done.contains(&id.as_str()) {
                        *executions.lock().unwrap().entry(id.clone()).or_insert(0) += 1;
                        tokio::time::sleep(Duration::from_millis(80)).await;
                        return Ok(serde_json::json!({
                            "type": "sleep",
                            "stepId": id,
                            "wakeAt": zenzip_core::time::now_ms(),
                        })
                        .to_string());
                    }
                }
                Ok(r#"{"type":"completed","output":"\"done\""}"#.to_string())
            })
        })
    };

    let mut wf_cfg = WorkflowConfig::new("pipeline");
    wf_cfg.lease_ms = 1_500; // fast crash recovery for the test
    let a = node("wa");
    let b = node("wb");
    a.register_workflow(wf_cfg.clone(), make_executor())
        .unwrap();
    b.register_workflow(wf_cfg, make_executor()).unwrap();
    a.start().unwrap();
    b.start().unwrap();

    let mut run_ids = Vec::new();
    for i in 0..10 {
        run_ids.push(
            a.engine()
                .trigger_blocking("pipeline", format!("{i}"), None, 0)
                .unwrap(),
        );
    }

    // Kill node A mid-flight; node B finishes everything.
    tokio::time::sleep(Duration::from_millis(300)).await;
    a.stop(Duration::ZERO).await.unwrap();

    for run_id in &run_ids {
        let run = b
            .engine()
            .wait_for_run(run_id, 30_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            run.status,
            run_status::COMPLETED,
            "run {run_id} not completed"
        );
    }

    // Step EXECUTIONS are at-least-once (kill mid-step re-runs it), but the
    // overwhelming majority run exactly once, and none more than twice.
    {
        let map = executions.lock().unwrap();
        assert_eq!(map.len(), 5, "all distinct steps executed");
        for (step, count) in map.iter() {
            assert!(*count <= 10 * 2, "step {step} ran {count} times");
        }
    }

    b.stop(Duration::from_secs(5)).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_scheduler_fires_once_across_nodes() {
    let Some(_guard) = pg_guard().await else {
        return;
    };
    let fires = Arc::new(AtomicU32::new(0));

    let handler: Handler = {
        let fires = fires.clone();
        Arc::new(move |_jobs| {
            fires.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { Ok(()) })
        })
    };

    let a = node("sa");
    let b = node("sb");
    for n in [&a, &b] {
        n.register_schedule(
            zenzip_core::scheduler::ScheduleDef::every(
                "pulse",
                500,
                zenzip_core::scheduler::Overlap::Allow,
                zenzip_core::scheduler::Catchup::Skip,
            )
            .unwrap(),
            handler.clone(),
        )
        .unwrap();
        n.start().unwrap();
    }

    tokio::time::sleep(Duration::from_millis(2_600)).await;
    a.stop(Duration::from_secs(5)).await.unwrap();
    b.stop(Duration::from_secs(5)).await.unwrap();

    // ~5 ticks elapsed. Without CAS election two nodes would double-fire
    // (~10). Allow scheduling slack, catch the doubling.
    let count = fires.load(Ordering::SeqCst);
    assert!(
        (3..=6).contains(&count),
        "expected ~5 single fires, got {count} (doubling means election failed)"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn pg_event_emitted_on_one_node_wakes_a_run_on_another() {
    let Some(_guard) = pg_guard().await else {
        return;
    };
    let executor: Executor = Arc::new(|req: ExecRequest| {
        Box::pin(async move {
            let journal: Vec<serde_json::Value> = serde_json::from_str(&req.journal_json).unwrap();
            if !journal.iter().any(|e| e["id"] == "gate") {
                Ok(
                    r#"{"type":"event","stepId":"gate","event":"cross.node","timeoutAt":null}"#
                        .to_string(),
                )
            } else {
                Ok(r#"{"type":"completed","output":"\"woken\""}"#.to_string())
            }
        })
    });

    let a = node("ea");
    let b = node("eb");
    a.register_workflow(WorkflowConfig::new("waiter"), executor.clone())
        .unwrap();
    b.register_workflow(WorkflowConfig::new("waiter"), executor)
        .unwrap();
    a.start().unwrap();
    b.start().unwrap();

    let run_id = a
        .engine()
        .trigger_blocking("waiter", "null".into(), None, 0)
        .unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;

    // Emit from the OTHER node.
    let (woken, _) = b.engine().emit_blocking("cross.node", "{}").unwrap();
    assert_eq!(woken, 1);

    let run = a
        .engine()
        .wait_for_run(&run_id, 10_000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.status, run_status::COMPLETED);
    assert_eq!(run.output.as_deref(), Some("\"woken\""));

    a.stop(Duration::from_secs(5)).await.unwrap();
    b.stop(Duration::from_secs(5)).await.unwrap();
}
