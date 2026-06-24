//! zenzip-core: Rust runtime core for the ZenZip framework.
//!
//! Phase 1 scope (docs/tasks.md): storage layer (`store`, `sqlite`), queue
//! engine (`queue`), persisted scheduler (`scheduler`), and the runtime shell
//! (`runtime`) that glues them onto a dedicated tokio runtime.
//!
//! Boundary rules from the Phase 0 spike (docs/spike-results.md):
//! - JS -> Rust: sync NAPI calls only (push, counts, registration).
//! - Rust -> JS: pipelined ThreadsafeFunction dispatch for handlers.
//! - No async NAPI functions on hot paths.

pub mod crypto;
pub mod fault;
pub mod metrics;
pub mod postgres;
pub mod queue;
pub mod queue_bench;
pub mod runtime;
pub mod scheduler;
pub mod sqlite;
pub mod store;
pub mod time;
pub mod workflow;
