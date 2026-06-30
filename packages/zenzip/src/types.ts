import type { Duration } from "./duration.js";
import type { BlobStore } from "./payload.js";

export interface LogEvent {
  /** ERROR | WARN | INFO | DEBUG | TRACE */
  level: string;
  /** Rust module path, e.g. "zenzip_core::queue". */
  target: string;
  message: string;
}

export type StoreConfig =
  | { driver: "sqlite" }
  /** Multi-node backend: claims via SKIP LOCKED, cross-node wakeups via
   * LISTEN/NOTIFY, CAS scheduler election. Same API as sqlite. */
  | { driver: "postgres"; url: string };

export interface ZenzipOptions {
  /** Directory for the embedded store. Default: ".zenzip" */
  dataDir?: string;
  /** Storage backend. Default: { driver: "sqlite" }. Use postgres for multi-node. */
  store?: StoreConfig;
  /** Install SIGINT/SIGTERM handlers that gracefully stop the app. Default: true */
  handleSignals?: boolean;
  /** Lease-expiry sweep cadence. Default: 5s */
  sweep?: Duration;
  /** Scheduler tick cadence. Default: 250ms */
  schedulerTick?: Duration;
  /** Engine tokio worker threads. Default: 2 */
  workerThreads?: number;
  /**
   * Runtime log verbosity: "error" | "warn" | "info" | "debug" | "trace" | "off".
   * Default: "off" (or "info" when `logger` is set).
   * Note: the log subscriber is process-global — the first app to configure
   * logging wins for the life of the process.
   */
  logLevel?: "error" | "warn" | "info" | "debug" | "trace" | "off";
  /** Receive runtime log events. Default sink (when only logLevel set): stderr. */
  logger?: (event: LogEvent) => void;
  /**
   * Audit sink (P13.6): called for privileged actions (workflow trigger /
   * cancel, dead-letter requeue, agent approve/deny). Wire it to an append-only
   * store for a queryable audit trail. Fire-and-forget; throwing is swallowed.
   */
  onAudit?: (entry: AuditEntry) => void;
  /**
   * Error sink (P16.4): called when the engine surfaces an error it would
   * otherwise only log — native log-callback errors and background-loop
   * failures. Wire it to Sentry via `sentryReporter(Sentry)`. For HTTP handler
   * errors use `captureErrors()` middleware; for failed jobs/runs use a DLQ
   * `alerts` hook. Fire-and-forget; throwing is swallowed.
   */
  onError?: (err: Error, ctx: { source: string; [key: string]: unknown }) => void;
  /**
   * Retention / GC (P7.6). A background sweep deletes aged terminal runs
   * (with their step journal) and old events so the store doesn't grow
   * unbounded. Defaults: keep 7 days of runs + events, sweep hourly. Set a
   * window to `"off"` to keep that category forever.
   */
  retention?: {
    /** Drop COMPLETED/FAILED/CANCELLED runs older than this. Default: "7d". */
    runs?: Duration | "off";
    /** Drop events older than this. Default: "7d". */
    events?: Duration | "off";
    /** GC sweep cadence. Default: "1h". */
    sweep?: Duration;
  };
  /**
   * Large LLM payload offloading (P9.1), opt-in. Step results larger than
   * `threshold` bytes are written to a blob store and replaced in the journal
   * by a reference, keeping the run/step tables lean. Transparent — replay
   * rehydrates the real value. The default store is the local filesystem
   * (`<dataDir>/blobs`); a multi-node (postgres) deploy MUST supply a shared
   * `store` so any node can read another node's blob.
   */
  payloads?: {
    /** Offload threshold in bytes. Default: 65536 (64 KiB). */
    threshold?: number;
    /** Blob backend. Default: filesystem under the data dir. */
    store?: BlobStore;
  };
  /**
   * Payload encryption at rest (P7.15), opt-in. When set, job payloads, run
   * inputs/outputs, step results, and event payloads are AES-256-GCM encrypted
   * before they touch storage and decrypted on read — the engine only holds
   * plaintext in memory. The key is any-length secret (load it from an env var
   * or secret manager, never hard-code). Enabling it on an existing database is
   * transparent: legacy plaintext rows stay readable, new writes are encrypted.
   * Losing the key makes encrypted payloads unrecoverable.
   */
  encryptionKey?: string;
  /**
   * Operational alerting (P14.2). When set, a background loop watches for
   * dead-letter-queue growth and stuck (orphaned) runs and calls `onAlert`.
   * Wire it to PagerDuty/Slack/email — ZenZip just detects and notifies.
   */
  alerts?: {
    onAlert: (alert: Alert) => void;
    /** Check cadence. Default: "1m". */
    interval?: Duration;
    /** Fire a DLQ alert once a queue's dead count reaches this. Default: 1. */
    dlqThreshold?: number;
    /** "Stuck" run threshold passed to orphanedRuns(). Default: "5m". */
    idle?: Duration;
  };
}

/** An operational alert (P14.2). */
export interface Alert {
  type: "dlq" | "orphaned";
  /** Human-readable summary. */
  message: string;
  /** Count of affected items (dead jobs / stuck runs). */
  count: number;
  /** Queue name (dlq alerts). */
  queue?: string;
  /** Affected run ids (orphaned alerts). */
  runs?: string[];
}

/** Rows removed by a retention GC pass (P7.6). */
export interface GcStats {
  runs: number;
  steps: number;
  events: number;
}

/** Health probe result (P7.7). */
export interface HealthStatus {
  /** Process is up and the engine is responding. */
  alive: boolean;
  /** Started AND the store is reachable — safe to route traffic. */
  ready: boolean;
}

/** One step's state in a run update (P9.4). */
export interface StepUpdate {
  stepId: string;
  kind: string;
  /** 0 = running/in-progress, 1 = completed (store step status). */
  status: number;
  attempts: number;
  error?: string;
}

/** A snapshot emitted by app.subscribe() as a run progresses (P9.4). */
export interface RunUpdate<O = unknown> {
  runId: string;
  workflow: string;
  status: "running" | "sleeping" | "waitingEvent" | "waitingChild" | "completed" | "failed" | "cancelled";
  /** True once status is completed / failed / cancelled. */
  terminal: boolean;
  output?: O;
  error?: string;
  steps: StepUpdate[];
}

/** Options for app.subscribe() (P9.4). */
export interface SubscribeOptions {
  /** Poll cadence in ms. Default: 250. */
  interval?: number;
  /** Give up after this long if the run never terminates (ms). Default: none. */
  timeout?: number;
}

/** A non-terminal run that has stopped making progress (P7.10). */
export interface OrphanedRun {
  runId: string;
  workflow: string;
  status: "running" | "sleeping" | "waitingEvent" | "waitingChild";
  /** How long since the run last changed (ms). */
  idleMs: number;
  /** Why it looks stuck — a likely lost wakeup or stalled sweep. */
  reason: string;
}

/** A privileged action recorded for the audit trail (P13.6). */
export interface AuditEntry {
  /** e.g. "workflow.trigger", "workflow.cancel", "queue.requeueDead", "agent.approve". */
  action: string;
  /** What it acted on (workflow/queue/agent name or run id). */
  target?: string;
  /** Epoch ms. */
  at: number;
  /** Action-specific extra context (run id, counts, …). */
  detail?: Record<string, unknown>;
}

/** Minimal Standard Schema v1 interface (zod 3.24+, valibot, arktype...). */
export interface StandardSchemaV1<Output = unknown> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { value: Output; issues?: undefined }
      | { issues: ReadonlyArray<{ message: string }> }
      | Promise<
          | { value: Output; issues?: undefined }
          | { issues: ReadonlyArray<{ message: string }> }
        >;
  };
}

export interface QueueOptions<T = unknown> {
  /**
   * Concurrency limit. A number caps total in-flight handlers (default 10).
   * The object form (P10.1) caps in-flight *per key* — `{ limit, key }` runs at
   * most `limit` jobs that share `key(data)` at once (e.g. per user/tenant).
   */
  concurrency?: number | { limit: number; key: (data: T) => string };
  /** Retries after the first failed attempt (maxAttempts = retries + 1). Default: 2 */
  retries?: number;
  /** Exponential backoff between retries. Default: { delay: "1s", maxDelay: "60s" } */
  backoff?: { delay?: Duration; maxDelay?: Duration };
  /** Job lease; crashed workers' jobs are redelivered after this. Default: 30s */
  lease?: Duration;
  /** Poll interval for work pushed by other processes. Default: 250ms */
  poll?: Duration;
  /** Max jobs claimed per storage round-trip. Default: 32 */
  batch?: number;
  /** Token-bucket rate limit: at most `max` jobs started per `per` window. */
  rateLimit?: { max: number; per: Duration };
  /**
   * Debounce (P10.2): collapse rapid pushes that share `key(data)` — each push
   * cancels the prior pending one and (re)schedules `window` out, so only the
   * last push in a burst runs, once the burst is quiet for `window`.
   */
  debounce?: { key: (data: T) => string; window: Duration };
  /**
   * Throttle (P10.2): smooth starts to at most `max` per `per` window *per
   * key* by spacing each pushed job after the key's last scheduled one. Unlike
   * debounce (which drops), throttle spreads — every job runs, rate-paced.
   */
  throttle?: { key: (data: T) => string; max: number; per: Duration };
  /**
   * Backpressure / admission control (P7.8): reject pushes once this many
   * jobs are already pending, with a QueueFullError. Best-effort (concurrent
   * producers may overshoot slightly) — bounds runaway growth when consumers
   * fall behind. Omit for an unbounded queue (the default).
   */
  maxPending?: number;
  /**
   * Fairness (P10.3): round-robin claims across the `concurrency.key` groups so
   * one tenant/key can't starve others. Requires a keyed `concurrency`.
   */
  fair?: boolean;
  /** Validated on push when provided. */
  schema?: StandardSchemaV1<T>;
}

export interface PushOptions {
  delay?: Duration;
  /** Higher runs first. Default: 0 */
  priority?: number;
  /** Override the queue's retry budget for this job. */
  retries?: number;
}

export interface Job<T = unknown> {
  id: string;
  queue: string;
  data: T;
  /** 1-based attempt number. */
  attempt: number;
  maxAttempts: number;
}

export interface DeadJob<T = unknown> {
  id: string;
  queue: string;
  data: T;
  attempt: number;
  lastError?: string;
  createdAt: number;
}

export type JobHandler<T> = (job: Job<T>) => void | Promise<void>;
/** Batch consumer: all-or-nothing — a throw retries every job in the batch
 * (each on its own attempt budget). */
export type BatchJobHandler<T> = (jobs: Job<T>[]) => void | Promise<void>;

export interface ScheduleOptions {
  /** IANA timezone for cron evaluation, e.g. "Asia/Kolkata". */
  timezone?: string;
  /** What to do when the previous tick is still running. Default: "skip" */
  overlap?: "skip" | "allow" | "queue";
  /** Missed-while-down policy ("all" replays missed ticks, capped at 100). Default: "skip" */
  catchup?: "skip" | "runOnce" | "all";
  /** Random 0..=jitter delivery delay per fire (thundering-herd guard). */
  jitter?: Duration;
}

export type ScheduleSpec =
  | string // cron expression
  | ({ cron: string } & ScheduleOptions)
  | ({ every: Duration } & ScheduleOptions);

export interface ScheduleTick {
  schedule: string;
  firedAt: number;
}

// -- Events (P3.1–P3.4) -----------------------------------------------------

export interface EmittedEvent<T = unknown> {
  event: string;
  payload: T;
}

export type EventHandler<T = unknown> = (event: EmittedEvent<T>) => void | Promise<void>;

export interface EmitResult {
  /** waitForEvent waiters released. */
  woken: number;
  /** Workflow runs created via `on:` triggers. */
  triggered: number;
}

/** Input shape of a run created by an `on:` event trigger. */
export interface TriggeredRunInput<T = unknown> {
  event: string;
  payload: T;
  emittedAt: number;
}

// -- State machines (P3.5–P3.7) ---------------------------------------------

export interface MachineDefinition<S extends string = string> {
  initial: S;
  states: Record<S, { on?: Record<string, S> }>;
}

export interface MachineTransition {
  from: string;
  to: string;
}

export interface MachineHistoryEntry {
  fromState: string;
  event: string;
  toState: string;
  at: number;
}

export type ScheduleHandler = (tick: ScheduleTick) => void | Promise<void>;

export interface StopOptions {
  /** Max time to wait for in-flight jobs to drain. Default: 30s */
  timeout?: Duration;
  /**
   * Max time to let in-flight HTTP requests finish before force-closing
   * connections (P15.3). Idle keep-alive sockets are freed immediately;
   * long-lived streams (SSE) are force-closed at this deadline. Default: 5s.
   */
  httpDrain?: Duration;
}
