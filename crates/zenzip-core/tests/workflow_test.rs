//! Workflow engine integration tests (P2.2–P2.14): scripted Rust executors
//! play the role of the JS step-memoization executor, driving the full
//! engine: trigger -> execute -> suspend -> wake -> complete.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use zenzip_core::queue::Backoff;
use zenzip_core::runtime::{CoreRuntime, RuntimeConfig};
use zenzip_core::store::run_status;
use zenzip_core::time::now_ms;
use zenzip_core::workflow::{ExecRequest, Executor, WorkflowConfig};

fn temp_runtime(tag: &str) -> (Arc<CoreRuntime>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("zenzip-wf-test-{}-{}", tag, uuid::Uuid::now_v7()));
    let mut config = RuntimeConfig::new(&dir);
    config.scheduler_tick_ms = 50;
    config.sweep_ms = 200;
    let rt = CoreRuntime::new(config).expect("runtime");
    (Arc::new(rt), dir)
}

fn journal_has(req: &ExecRequest, id: &str) -> bool {
    let journal: Vec<serde_json::Value> = serde_json::from_str(&req.journal_json).unwrap();
    journal.iter().any(|e| e["id"] == id)
}

fn journal_result(req: &ExecRequest, id: &str) -> Option<serde_json::Value> {
    let journal: Vec<serde_json::Value> = serde_json::from_str(&req.journal_json).unwrap();
    journal.iter().find(|e| e["id"] == id).map(|e| {
        e["result"]
            .as_str()
            .map(|s| serde_json::from_str(s).unwrap())
            .unwrap_or(serde_json::Value::Null)
    })
}

fn wf_config(name: &str) -> WorkflowConfig {
    let mut cfg = WorkflowConfig::new(name);
    cfg.step_backoff = Backoff {
        delay_ms: 10,
        max_delay_ms: 20,
    };
    cfg
}

async fn finish(rt: &Arc<CoreRuntime>, dir: std::path::PathBuf) {
    rt.stop(Duration::from_secs(5)).await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn completes_a_simple_run() {
    let (rt, dir) = temp_runtime("simple");
    let executor: Executor = Arc::new(|req| {
        Box::pin(async move {
            let input: serde_json::Value = serde_json::from_str(&req.input).unwrap();
            let output =
                serde_json::to_string(&format!("hello {}", input["name"].as_str().unwrap()))
                    .unwrap();
            Ok(serde_json::json!({"type": "completed", "output": output}).to_string())
        })
    });
    rt.register_workflow(wf_config("greet"), executor).unwrap();
    rt.start().unwrap();

    let run_id = rt
        .engine()
        .trigger_blocking("greet", r#"{"name":"zen"}"#.into(), None, 0, None)
        .unwrap();
    let run = rt
        .engine()
        .wait_for_run(&run_id, 5_000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.status, run_status::COMPLETED);
    assert_eq!(run.output.as_deref(), Some("\"hello zen\""));
    finish(&rt, dir).await;
}

#[tokio::test]
async fn sleep_suspends_and_resumes() {
    let (rt, dir) = temp_runtime("sleep");
    let executor: Executor = Arc::new(|req| {
        Box::pin(async move {
            if !journal_has(&req, "nap") {
                Ok(format!(
                    r#"{{"type":"sleep","stepId":"nap","wakeAt":{}}}"#,
                    now_ms() + 200
                ))
            } else {
                Ok(r#"{"type":"completed","output":"\"rested\""}"#.to_string())
            }
        })
    });
    rt.register_workflow(wf_config("napper"), executor).unwrap();
    rt.start().unwrap();

    let started = now_ms();
    let run_id = rt
        .engine()
        .trigger_blocking("napper", "null".into(), None, 0, None)
        .unwrap();
    let run = rt
        .engine()
        .wait_for_run(&run_id, 5_000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.status, run_status::COMPLETED);
    assert!(
        now_ms() - started >= 180,
        "completed before the sleep elapsed"
    );
    finish(&rt, dir).await;
}

#[tokio::test]
async fn step_failure_retries_then_succeeds() {
    let (rt, dir) = temp_runtime("retry");
    let calls = Arc::new(AtomicU32::new(0));
    let executor: Executor = {
        let calls = calls.clone();
        Arc::new(move |_req| {
            let calls = calls.clone();
            Box::pin(async move {
                let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
                if n < 3 {
                    Ok(r#"{"type":"stepFailed","stepId":"flaky","error":"transient"}"#.to_string())
                } else {
                    Ok(r#"{"type":"completed","output":"3"}"#.to_string())
                }
            })
        })
    };
    rt.register_workflow(wf_config("flaky"), executor).unwrap();
    rt.start().unwrap();

    let run_id = rt
        .engine()
        .trigger_blocking("flaky", "null".into(), None, 0, None)
        .unwrap();
    let run = rt
        .engine()
        .wait_for_run(&run_id, 10_000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.status, run_status::COMPLETED);
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    finish(&rt, dir).await;
}

#[tokio::test]
async fn step_exhaustion_fails_the_run() {
    let (rt, dir) = temp_runtime("exhaust");
    let executor: Executor = Arc::new(|_req| {
        Box::pin(async move {
            Ok(r#"{"type":"stepFailed","stepId":"doomed","error":"permanent"}"#.to_string())
        })
    });
    let mut cfg = wf_config("doomed");
    cfg.step_max_attempts = 2;
    rt.register_workflow(cfg, executor).unwrap();
    rt.start().unwrap();

    let run_id = rt
        .engine()
        .trigger_blocking("doomed", "null".into(), None, 0, None)
        .unwrap();
    let run = rt
        .engine()
        .wait_for_run(&run_id, 10_000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.status, run_status::FAILED);
    let error = run.error.unwrap();
    assert!(error.contains("after 2 attempts"), "error: {error}");
    finish(&rt, dir).await;
}

#[tokio::test]
async fn wait_for_event_wakes_on_emit() {
    let (rt, dir) = temp_runtime("event");
    let executor: Executor = Arc::new(|req| {
        Box::pin(async move {
            match journal_result(&req, "approval") {
                None => Ok(
                    r#"{"type":"event","stepId":"approval","event":"order.approved","timeoutAt":null}"#
                        .to_string(),
                ),
                Some(result) => {
                    let by = result["event"]["by"].as_str().unwrap_or("?").to_string();
                    Ok(format!(
                        r#"{{"type":"completed","output":"\"approved by {by}\""}}"#
                    ))
                }
            }
        })
    });
    rt.register_workflow(wf_config("approval"), executor)
        .unwrap();
    rt.start().unwrap();

    let run_id = rt
        .engine()
        .trigger_blocking("approval", "null".into(), None, 0, None)
        .unwrap();
    // Let it reach the suspension first.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (woken, _) = rt
        .engine()
        .emit_blocking("order.approved", r#"{"by":"madhur"}"#)
        .unwrap();
    assert_eq!(woken, 1);

    let run = rt
        .engine()
        .wait_for_run(&run_id, 5_000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.status, run_status::COMPLETED);
    assert_eq!(run.output.as_deref(), Some("\"approved by madhur\""));
    finish(&rt, dir).await;
}

#[tokio::test]
async fn wait_for_event_times_out() {
    let (rt, dir) = temp_runtime("timeout");
    let executor: Executor = Arc::new(|req| {
        Box::pin(async move {
            match journal_result(&req, "never") {
                None => Ok(format!(
                    r#"{{"type":"event","stepId":"never","event":"no.such.event","timeoutAt":{}}}"#,
                    now_ms() + 150
                )),
                Some(result) => {
                    assert_eq!(result["timedOut"], true);
                    Ok(r#"{"type":"completed","output":"\"timed out\""}"#.to_string())
                }
            }
        })
    });
    rt.register_workflow(wf_config("patient"), executor)
        .unwrap();
    rt.start().unwrap();

    let run_id = rt
        .engine()
        .trigger_blocking("patient", "null".into(), None, 0, None)
        .unwrap();
    let run = rt
        .engine()
        .wait_for_run(&run_id, 10_000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.status, run_status::COMPLETED);
    assert_eq!(run.output.as_deref(), Some("\"timed out\""));
    finish(&rt, dir).await;
}

#[tokio::test]
async fn invoke_runs_child_and_returns_output() {
    let (rt, dir) = temp_runtime("invoke");
    let parent: Executor = Arc::new(|req| {
        Box::pin(async move {
            match journal_result(&req, "sub") {
                None => Ok(
                    r#"{"type":"invoke","stepId":"sub","workflow":"child","input":"7"}"#
                        .to_string(),
                ),
                Some(result) => {
                    let out = result["output"].as_i64().unwrap();
                    Ok(format!(r#"{{"type":"completed","output":"{}"}}"#, out * 2))
                }
            }
        })
    });
    let child: Executor = Arc::new(|req| {
        Box::pin(async move {
            let n: i64 = serde_json::from_str(&req.input).unwrap();
            Ok(format!(r#"{{"type":"completed","output":"{}"}}"#, n + 1))
        })
    });
    rt.register_workflow(wf_config("parent"), parent).unwrap();
    rt.register_workflow(wf_config("child"), child).unwrap();
    rt.start().unwrap();

    let run_id = rt
        .engine()
        .trigger_blocking("parent", "null".into(), None, 0, None)
        .unwrap();
    let run = rt
        .engine()
        .wait_for_run(&run_id, 10_000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.status, run_status::COMPLETED);
    // child: 7+1=8, parent: 8*2=16
    assert_eq!(run.output.as_deref(), Some("16"));
    finish(&rt, dir).await;
}

#[tokio::test]
async fn idempotency_key_dedupes_runs() {
    let (rt, dir) = temp_runtime("idem");
    let executor: Executor = Arc::new(|_req| {
        Box::pin(async move { Ok(r#"{"type":"completed","output":"1"}"#.to_string()) })
    });
    rt.register_workflow(wf_config("once"), executor).unwrap();
    rt.start().unwrap();

    let a = rt
        .engine()
        .trigger_blocking("once", "null".into(), Some("key-1".into()), 0, None)
        .unwrap();
    let b = rt
        .engine()
        .trigger_blocking("once", "null".into(), Some("key-1".into()), 0, None)
        .unwrap();
    let c = rt
        .engine()
        .trigger_blocking("once", "null".into(), Some("key-2".into()), 0, None)
        .unwrap();
    assert_eq!(a, b);
    assert_ne!(a, c);
    finish(&rt, dir).await;
}

#[tokio::test]
async fn cancel_stops_a_sleeping_run() {
    let (rt, dir) = temp_runtime("cancel");
    let completed = Arc::new(AtomicU32::new(0));
    let executor: Executor = {
        let completed = completed.clone();
        Arc::new(move |req| {
            let completed = completed.clone();
            Box::pin(async move {
                if !journal_has(&req, "nap") {
                    Ok(format!(
                        r#"{{"type":"sleep","stepId":"nap","wakeAt":{}}}"#,
                        now_ms() + 300
                    ))
                } else {
                    completed.fetch_add(1, Ordering::SeqCst);
                    Ok(r#"{"type":"completed","output":"null"}"#.to_string())
                }
            })
        })
    };
    rt.register_workflow(wf_config("cancellable"), executor)
        .unwrap();
    rt.start().unwrap();

    let run_id = rt
        .engine()
        .trigger_blocking("cancellable", "null".into(), None, 0, None)
        .unwrap();
    // Let it reach the sleep, then cancel before the wake.
    tokio::time::sleep(Duration::from_millis(150)).await;
    let n = rt.engine().cancel_blocking(&run_id).unwrap();
    assert_eq!(n, 1);

    // Past the wake time: the stale wake job must be a no-op.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let run = rt
        .engine()
        .wait_for_run(&run_id, 1_000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.status, run_status::CANCELLED);
    assert_eq!(completed.load(Ordering::SeqCst), 0);
    finish(&rt, dir).await;
}
