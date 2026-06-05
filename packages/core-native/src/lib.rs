//! NAPI bridge for zenzip-core.
//!
//! Phase 0: exposes benchmark entry points used to measure the JS<->Rust
//! boundary cost (docs/tasks.md P0.4–P0.7). The real framework API comes in
//! Phase 1.

#![deny(clippy::all)]

pub mod logging;
pub mod runtime_bindings;

use std::sync::Arc;

use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;

// ---------------------------------------------------------------------------
// P0.4 — JS -> Rust call round-trip cost
// ---------------------------------------------------------------------------

#[napi]
pub fn sync_noop() {}

#[napi]
pub fn sync_add(a: u32, b: u32) -> u32 {
    a + b
}

#[napi]
pub fn sync_echo_buffer(input: Buffer) -> Buffer {
    input
}

#[napi]
pub fn sync_json_parse_stringify(input: String) -> Result<String> {
    let value: serde_json::Value = serde_json::from_str(&input)
        .map_err(|e| Error::from_reason(format!("parse error: {e}")))?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(format!("stringify error: {e}")))
}

#[napi]
pub async fn async_add(a: u32, b: u32) -> u32 {
    a + b
}

#[napi]
pub async fn async_echo_buffer(input: Buffer) -> Buffer {
    Buffer::from(input.as_ref().to_vec())
}

// ---------------------------------------------------------------------------
// P0.5 — Rust -> JS ThreadsafeFunction dispatch throughput
// ---------------------------------------------------------------------------

/// Sequential round-trips: Rust awaits the JS return value each iteration.
/// Models "engine invokes a JS step handler and waits for the result".
#[napi]
pub async fn bench_tsfn_roundtrip(
    tsfn: ThreadsafeFunction<u32, u32>,
    iterations: u32,
) -> Result<f64> {
    let start = std::time::Instant::now();
    for i in 0..iterations {
        tsfn.call_async(Ok(i)).await?;
    }
    Ok(start.elapsed().as_secs_f64() * 1000.0)
}

/// Pipelined round-trips in waves of `concurrency`. Models many concurrent
/// workflow runs invoking JS handlers at once.
#[napi]
pub async fn bench_tsfn_concurrent(
    tsfn: ThreadsafeFunction<u32, u32>,
    iterations: u32,
    concurrency: u32,
) -> Result<f64> {
    let tsfn = Arc::new(tsfn);
    let start = std::time::Instant::now();
    let mut remaining = iterations;
    while remaining > 0 {
        let wave = concurrency.min(remaining);
        let futs: Vec<_> = (0..wave)
            .map(|i| {
                let tsfn = tsfn.clone();
                async move { tsfn.call_async(Ok(i)).await }
            })
            .collect();
        for r in futures::future::join_all(futs).await {
            r?;
        }
        remaining -= wave;
    }
    Ok(start.elapsed().as_secs_f64() * 1000.0)
}

// ---------------------------------------------------------------------------
// P0.7 — SQLite WAL queue throughput
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct SqliteBenchResult {
    pub jobs: u32,
    pub insert_ms: f64,
    pub claim_ack_ms: f64,
    pub insert_ops_per_sec: f64,
    pub claim_ack_ops_per_sec: f64,
}

#[napi]
pub fn bench_sqlite_queue(path: String, jobs: u32) -> Result<SqliteBenchResult> {
    let r = zenzip_core::queue_bench::run(&path, jobs)
        .map_err(|e| Error::from_reason(e.to_string()))?;
    Ok(SqliteBenchResult {
        jobs: r.jobs,
        insert_ms: r.insert_ms,
        claim_ack_ms: r.claim_ack_ms,
        insert_ops_per_sec: r.jobs as f64 / (r.insert_ms / 1000.0),
        claim_ack_ops_per_sec: r.jobs as f64 / (r.claim_ack_ms / 1000.0),
    })
}

// ---------------------------------------------------------------------------
// P0.6 — hyper HTTP server (static + JS-handler variants)
// ---------------------------------------------------------------------------

fn spawn_server_thread<F>(serve: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(serve);
    });
}

/// Pure-Rust hello-world server: the upper bound (no JS involved).
#[napi]
pub fn start_hyper_static(port: u16) -> Result<()> {
    spawn_server_thread(async move {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .expect("bind hyper static");
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            tokio::spawn(async move {
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(
                        TokioIo::new(stream),
                        service_fn(|_req: Request<Incoming>| async {
                            Ok::<_, std::convert::Infallible>(Response::new(Full::new(
                                Bytes::from_static(b"hello world"),
                            )))
                        }),
                    )
                    .await;
            });
        }
    });
    Ok(())
}

/// Rust accepts the connection, JS produces the response body via TSFN.
/// This is the architecture under evaluation in D5 (Rust HTTP go/no-go).
#[napi]
pub fn start_hyper_js(port: u16, handler: ThreadsafeFunction<String, String>) -> Result<()> {
    let handler = Arc::new(handler);
    spawn_server_thread(async move {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .expect("bind hyper js");
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let handler = handler.clone();
            tokio::spawn(async move {
                let svc = service_fn(move |req: Request<Incoming>| {
                    let handler = handler.clone();
                    async move {
                        let path = req.uri().path().to_string();
                        let body = match handler.call_async(Ok(path)).await {
                            Ok(b) => b,
                            Err(e) => format!("handler error: {e}"),
                        };
                        Ok::<_, std::convert::Infallible>(Response::new(Full::new(Bytes::from(
                            body,
                        ))))
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), svc)
                    .await;
            });
        }
    });
    Ok(())
}
