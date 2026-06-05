//! P1.17 — surface Rust `tracing` events to a JS-configurable sink.
//!
//! The JS logger TSFN is built WEAK so holding it does not keep the Node
//! event loop alive; after the JS side is gone, dispatch becomes a no-op.
//! The tracing subscriber is process-global: the first ZenRuntime that
//! configures logging wins (subsequent ones inherit it).

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use tracing::field::{Field, Visit};
use tracing_subscriber::filter::{LevelFilter, Targets};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::Layer;

#[napi(object)]
#[derive(Clone)]
pub struct JsLogEvent {
    /// ERROR | WARN | INFO | DEBUG | TRACE
    pub level: String,
    /// Rust module path, e.g. "zenzip_core::queue".
    pub target: String,
    pub message: String,
}

/// Weak TSFN (does not hold the event loop), fire-and-forget dispatch.
pub type JsLogTsfn = ThreadsafeFunction<JsLogEvent, (), JsLogEvent, napi::Status, true, true>;

#[derive(Default)]
struct MessageVisitor(String);

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        use std::fmt::Write;
        if field.name() == "message" {
            let _ = write!(self.0, "{value:?}");
        } else {
            if !self.0.is_empty() {
                self.0.push(' ');
            }
            let _ = write!(self.0, "{}={:?}", field.name(), value);
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        use std::fmt::Write;
        if field.name() == "message" {
            self.0.push_str(value);
        } else {
            if !self.0.is_empty() {
                self.0.push(' ');
            }
            let _ = write!(self.0, "{}={}", field.name(), value);
        }
    }
}

struct JsLogLayer {
    tsfn: JsLogTsfn,
}

impl<S: tracing::Subscriber> Layer<S> for JsLogLayer {
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        let meta = event.metadata();
        self.tsfn.call(
            Ok(JsLogEvent {
                level: meta.level().to_string(),
                target: meta.target().to_string(),
                message: visitor.0,
            }),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }
}

fn parse_level(level: &str) -> Option<LevelFilter> {
    match level {
        "error" => Some(LevelFilter::ERROR),
        "warn" => Some(LevelFilter::WARN),
        "info" => Some(LevelFilter::INFO),
        "debug" => Some(LevelFilter::DEBUG),
        "trace" => Some(LevelFilter::TRACE),
        _ => None, // "off" or unknown -> no subscriber
    }
}

/// Install the global tracing subscriber for zenzip crates. No-op if a
/// subscriber is already set (first caller wins) or level is "off".
pub fn init_logging(level: &str, tsfn: Option<JsLogTsfn>) {
    let Some(level) = parse_level(level) else {
        return;
    };
    let targets = Targets::new()
        .with_target("zenzip_core", level)
        .with_target("zenzip_napi", level);
    match tsfn {
        Some(tsfn) => {
            let _ = tracing_subscriber::registry()
                .with(JsLogLayer { tsfn }.with_filter(targets))
                .try_init();
        }
        None => {
            let _ = tracing_subscriber::registry()
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_writer(std::io::stderr)
                        .with_filter(targets),
                )
                .try_init();
        }
    }
}
