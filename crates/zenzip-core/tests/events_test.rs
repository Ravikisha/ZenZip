//! Event bus (P3.1–P3.3) + state machine (P3.5–P3.7) integration tests.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use zenzip_core::runtime::{CoreRuntime, MachineDef, RuntimeConfig};
use zenzip_core::store::run_status;
use zenzip_core::workflow::{event_matches, ExecRequest, Executor, WorkflowConfig};

fn temp_runtime(tag: &str) -> (Arc<CoreRuntime>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("zenzip-ev-test-{}-{}", tag, uuid::Uuid::now_v7()));
    let mut config = RuntimeConfig::new(&dir);
    config.scheduler_tick_ms = 50;
    config.sweep_ms = 200;
    let rt = CoreRuntime::new(config).expect("runtime");
    (Arc::new(rt), dir)
}

async fn finish(rt: &Arc<CoreRuntime>, dir: std::path::PathBuf) {
    rt.stop(Duration::from_secs(5)).await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
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

#[test]
fn wildcard_patterns() {
    assert!(event_matches("user.created", "user.created"));
    assert!(event_matches("user.*", "user.created"));
    assert!(!event_matches("user.*", "user.created.eu"));
    assert!(event_matches("user.**", "user.created.eu"));
    assert!(event_matches("**", "anything.at.all"));
    assert!(!event_matches("order.*", "user.created"));
    assert!(event_matches("*.created", "user.created"));
}

#[tokio::test]
async fn emit_triggers_workflow_via_pattern() {
    let (rt, dir) = temp_runtime("trigger");
    let executor: Executor = Arc::new(|req| {
        Box::pin(async move {
            // Trigger-created runs receive { event, payload, emittedAt }.
            let input: serde_json::Value = serde_json::from_str(&req.input).unwrap();
            assert_eq!(input["event"], "user.created");
            assert_eq!(input["payload"]["id"], "u1");
            Ok(r#"{"type":"completed","output":"\"onboarded\""}"#.to_string())
        })
    });
    let mut cfg = WorkflowConfig::new("onboard");
    cfg.triggers = vec!["user.*".to_string()];
    rt.register_workflow(cfg, executor).unwrap();
    rt.start().unwrap();

    let (woken, triggered) = rt
        .engine()
        .emit_blocking("user.created", r#"{"id":"u1"}"#)
        .unwrap();
    assert_eq!(woken, 0);
    assert_eq!(triggered, 1);

    // The triggered run completes.
    let runs = rt
        .store()
        .runs_list(Some("onboard".into()), None, 10)
        .await
        .unwrap();
    assert_eq!(runs.len(), 1);
    let run = rt
        .engine()
        .wait_for_run(&runs[0].id, 5_000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.status, run_status::COMPLETED);

    // Non-matching event triggers nothing.
    let (_, triggered) = rt.engine().emit_blocking("order.created", "{}").unwrap();
    assert_eq!(triggered, 0);
    finish(&rt, dir).await;
}

#[tokio::test]
async fn match_predicate_wakes_only_matching_waiter() {
    let (rt, dir) = temp_runtime("match");
    let executor: Executor = Arc::new(|req| {
        Box::pin(async move {
            let input: serde_json::Value = serde_json::from_str(&req.input).unwrap();
            let invoice = input["invoice"].as_str().unwrap().to_string();
            match journal_result(&req, "paid") {
                None => Ok(serde_json::json!({
                    "type": "event",
                    "stepId": "paid",
                    "event": "invoice.paid",
                    "timeoutAt": null,
                    "match": serde_json::json!({ "invoice": invoice }).to_string(),
                })
                .to_string()),
                Some(result) => {
                    let amount = result["event"]["amount"].as_i64().unwrap();
                    Ok(format!(r#"{{"type":"completed","output":"{amount}"}}"#))
                }
            }
        })
    });
    rt.register_workflow(WorkflowConfig::new("collect"), executor)
        .unwrap();
    rt.start().unwrap();

    let run_a = rt
        .engine()
        .trigger_blocking("collect", r#"{"invoice":"inv-a"}"#.into(), None, 0)
        .unwrap();
    let run_b = rt
        .engine()
        .trigger_blocking("collect", r#"{"invoice":"inv-b"}"#.into(), None, 0)
        .unwrap();
    // Let both reach their waits.
    tokio::time::sleep(Duration::from_millis(400)).await;

    // Emit for invoice B only: exactly one waiter wakes.
    let (woken, _) = rt
        .engine()
        .emit_blocking("invoice.paid", r#"{"invoice":"inv-b","amount":42}"#)
        .unwrap();
    assert_eq!(woken, 1);

    let b = rt
        .engine()
        .wait_for_run(&run_b, 5_000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(b.status, run_status::COMPLETED);
    assert_eq!(b.output.as_deref(), Some("42"));

    // A is still waiting.
    let a = rt.store().get_run(&run_a).await.unwrap().unwrap();
    assert_eq!(a.status, run_status::WAIT_EVENT);
    finish(&rt, dir).await;
}

#[tokio::test]
async fn machine_transitions_validate_and_emit() {
    let (rt, dir) = temp_runtime("machine");

    // A workflow durably triggered by the machine's "paid" transition.
    let executor: Executor = Arc::new(|req| {
        Box::pin(async move {
            let input: serde_json::Value = serde_json::from_str(&req.input).unwrap();
            assert_eq!(input["payload"]["to"], "paid");
            Ok(r#"{"type":"completed","output":"null"}"#.to_string())
        })
    });
    let mut cfg = WorkflowConfig::new("on-paid");
    cfg.triggers = vec!["order.paid".to_string()];
    rt.register_workflow(cfg, executor).unwrap();

    let mut transitions = HashMap::new();
    transitions.insert(("created".into(), "PAY".into()), "paid".into());
    transitions.insert(("paid".into(), "PACK".into()), "packed".into());
    rt.register_machine(MachineDef {
        name: "order".into(),
        initial: "created".into(),
        transitions,
    })
    .unwrap();
    rt.start().unwrap();

    assert!(rt.machine_create("order", "ord_1").unwrap());
    assert!(!rt.machine_create("order", "ord_1").unwrap()); // idempotent

    let r = rt.machine_send("order", "ord_1", "PAY").unwrap();
    assert_eq!(r.from, "created");
    assert_eq!(r.to, "paid");
    assert_eq!(
        rt.machine_state("order", "ord_1").unwrap().as_deref(),
        Some("paid")
    );

    // Invalid transition: PAY again from 'paid'.
    let err = rt.machine_send("order", "ord_1", "PAY").unwrap_err();
    assert!(err.contains("invalid transition"), "{err}");

    // History recorded.
    let history = rt.machine_history("order", "ord_1", 10).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].event, "PAY");

    // The transition event durably triggered the workflow.
    let runs = rt
        .store()
        .runs_list(Some("on-paid".into()), None, 10)
        .await
        .unwrap();
    assert_eq!(runs.len(), 1);
    let run = rt
        .engine()
        .wait_for_run(&runs[0].id, 5_000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.status, run_status::COMPLETED);
    finish(&rt, dir).await;
}

#[tokio::test]
async fn events_are_persisted_to_the_outbox() {
    let (rt, dir) = temp_runtime("outbox");
    rt.start().unwrap();
    rt.engine().emit_blocking("a.b", r#"{"n":1}"#).unwrap();
    rt.engine().emit_blocking("a.c", r#"{"n":2}"#).unwrap();

    let events = rt.store().recent_events(10).await.unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].name, "a.c"); // newest first
    assert_eq!(events[1].name, "a.b");
    finish(&rt, dir).await;
}
