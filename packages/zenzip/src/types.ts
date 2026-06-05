import type { Duration } from "./duration.js";

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
  /** Storage backend. Default: { driver: "sqlite" }. Postgres lands in Phase 5. */
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
  /** Max handler invocations in flight. Default: 10 */
  concurrency?: number;
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
}
