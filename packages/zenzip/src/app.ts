import type { Server } from "node:http";

import { ZenRuntime, type JsExecRequest, type JsJob } from "@zenzip/core-native";

import { startDashboard, type DashboardOptions } from "./dashboard.js";
import { ms, type Duration } from "./duration.js";
import { eventMatches } from "./events.js";
import { Agent, type AgentOptions } from "./agent.js";
import {
  closeServer,
  HttpRouter,
  makeNodeHandler,
  serveRouter,
  type RouteHandler,
} from "./http.js";
import { Machine } from "./machine.js";
import { Queue } from "./queue.js";
import {
  executeAttempt,
  hashDefinition,
  Workflow,
  type WorkflowFn,
  type WorkflowOptions,
} from "./workflow.js";
import type {
  EmitResult,
  EventHandler,
  Job,
  LogEvent,
  MachineDefinition,
  QueueOptions,
  ScheduleHandler,
  ScheduleSpec,
  ScheduleTick,
  StopOptions,
  ZenzipOptions,
} from "./types.js";

const DEFAULT_RETRIES = 2;

/** Normalize a thrown value so the Rust side gets a useful reason string. */
function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/** Wrap a user handler into the (err, jobs[]) => Promise<boolean> TSFN shape. */
function toTsfnHandler(run: (jobs: JsJob[]) => void | Promise<void>) {
  return (err: Error | null, jobs: JsJob[]): Promise<boolean> => {
    if (err) return Promise.reject(err);
    return Promise.resolve()
      .then(() => run(jobs))
      .then(
        () => true,
        (e) => Promise.reject(toError(e)),
      );
  };
}

function parseJob<T>(job: JsJob): Job<T> {
  return {
    id: job.id,
    queue: job.queue,
    data: JSON.parse(job.payload) as T,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
  };
}

interface ScheduleRegistration {
  name: string;
  cron?: string;
  everyMs?: number;
  timezone?: string;
  overlap?: string;
  catchup?: string;
  jitterMs?: number;
  handler: ScheduleHandler;
}

export class ZenzipApp {
  readonly #options: ZenzipOptions;
  readonly #queues = new Map<string, Queue<any>>();
  readonly #schedules = new Map<string, ScheduleRegistration>();
  readonly #workflows = new Map<string, Workflow<any, any>>();
  readonly #machines = new Map<string, Machine<any>>();
  readonly #subscribers: Array<{ pattern: string; handler: EventHandler }> = [];
  readonly #router = new HttpRouter();
  readonly #servers: Server[] = [];
  #native: ZenRuntime | null = null;
  #started = false;
  #signalHandler: (() => void) | null = null;

  constructor(options: ZenzipOptions = {}) {
    this.#options = options;
  }

  /** Define (or reference) a queue. Call `.process()` to attach a consumer. */
  queue<T = unknown>(name: string, options: QueueOptions<T> = {}): Queue<T> {
    if (this.#started) {
      throw new Error("define queues before app.start()");
    }
    if (this.#queues.has(name)) {
      throw new Error(`queue "${name}" already defined`);
    }
    const queue = new Queue<T>(this, name, options);
    this.#queues.set(name, queue);
    return queue;
  }

  /** Durable workflow (P2.12): steps are memoized; runs survive restarts. */
  workflow<I = unknown, O = unknown>(
    name: string,
    optionsOrFn: WorkflowOptions | WorkflowFn<I, O>,
    maybeFn?: WorkflowFn<I, O>,
  ): Workflow<I, O> {
    if (this.#started) {
      throw new Error("define workflows before app.start()");
    }
    if (this.#workflows.has(name)) {
      throw new Error(`workflow "${name}" already defined`);
    }
    const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
    const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
    if (!fn) {
      throw new Error(`workflow "${name}": missing the workflow function`);
    }
    const version = hashDefinition(fn.toString());
    const wf = new Workflow<I, O>(this, name, options, fn, version);
    this.#workflows.set(name, wf);
    return wf;
  }

  /**
   * Emit an event through the atomic outbox: wakes waitForEvent waiters
   * (respecting match predicates), creates runs for workflows with matching
   * `on:` triggers, and dispatches to local app.on() subscribers.
   */
  emit(event: string, payload?: unknown): EmitResult {
    const result = JSON.parse(
      this._native.emitEvent(event, JSON.stringify(payload ?? null)),
    ) as EmitResult;
    this._dispatchLocal(event, payload);
    return result;
  }

  /**
   * Ephemeral in-process subscriber. Supports wildcards (`user.*`,
   * `billing.**`). Returns an unsubscribe function. For delivery that
   * survives crashes, use a workflow `on:` trigger instead.
   */
  on<T = unknown>(pattern: string, handler: EventHandler<T>): () => void {
    const entry = { pattern, handler: handler as EventHandler };
    this.#subscribers.push(entry);
    return () => {
      const i = this.#subscribers.indexOf(entry);
      if (i >= 0) this.#subscribers.splice(i, 1);
    };
  }

  /** @internal Fire local subscribers (fire-and-forget, errors logged). */
  _dispatchLocal(event: string, payload: unknown): void {
    for (const sub of this.#subscribers) {
      if (!eventMatches(sub.pattern, event)) continue;
      Promise.resolve()
        .then(() => sub.handler({ event, payload }))
        .catch((e) => {
          const message = `subscriber for "${sub.pattern}" threw: ${
            e instanceof Error ? e.message : String(e)
          }`;
          this.#options.logger?.({
            level: "ERROR",
            target: "zenzip.events",
            message,
          }) ?? console.error(`[zenzip] ${message}`);
        });
    }
  }

  /**
   * Durable agent (P4): an LLM loop compiled to a workflow with dynamic
   * steps — every model call and tool execution is journaled. Tool failures
   * retry without re-calling the model; approvals are durable pauses; runs
   * survive crashes and appear in the dashboard like any workflow.
   */
  agent<TOutput = unknown>(name: string, options: AgentOptions): Agent<TOutput> {
    if (this.#started) {
      throw new Error("define agents before app.start()");
    }
    // The Agent registers its workflow as `agent:<name>` — uniqueness is
    // enforced by the workflow registry.
    return new Agent<TOutput>(this, name, options);
  }

  /** Persisted state machine (P3.5). Transitions emit `<name>.<toState>`. */
  machine<S extends string>(name: string, definition: MachineDefinition<S>): Machine<S> {
    if (this.#started) {
      throw new Error("define machines before app.start()");
    }
    if (this.#machines.has(name)) {
      throw new Error(`machine "${name}" already defined`);
    }
    const machine = new Machine<S>(this, name, definition);
    this.#machines.set(name, machine);
    return machine;
  }

  // -- HTTP adapter (P3.8, P3.10) -------------------------------------------

  get(path: string, handler: RouteHandler): this {
    this.#router.add("GET", path, handler);
    return this;
  }
  post(path: string, handler: RouteHandler): this {
    this.#router.add("POST", path, handler);
    return this;
  }
  put(path: string, handler: RouteHandler): this {
    this.#router.add("PUT", path, handler);
    return this;
  }
  patch(path: string, handler: RouteHandler): this {
    this.#router.add("PATCH", path, handler);
    return this;
  }
  delete(path: string, handler: RouteHandler): this {
    this.#router.add("DELETE", path, handler);
    return this;
  }

  /** Serve the registered routes (incl. workflow webhook routes). */
  async listen(options: { port?: number; host?: string } = {}): Promise<{
    port: number;
    close: () => Promise<void>;
  }> {
    if (!this.#started) {
      throw new Error("call app.listen() after app.start()");
    }
    const server = await serveRouter(
      this.#router,
      options.port ?? 3000,
      options.host ?? "127.0.0.1",
    );
    this.#servers.push(server);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
      port,
      close: () => closeServer(server),
    };
  }

  /**
   * Mountable node:http handler over the registered routes (P3.9) — for
   * embedding into an existing server: `http.createServer(app.toNodeHandler())`,
   * Express `srv.use(app.toNodeHandler())`, or any raw (req, res) hook.
   * Call after app.start() so workflow webhook routes are registered.
   */
  toNodeHandler(): (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void {
    if (!this.#started) {
      throw new Error("call app.toNodeHandler() after app.start()");
    }
    return makeNodeHandler(this.#router);
  }

  /** Engine metrics counters (jobs, runs, steps, events, handler timings). */
  metrics(): Record<string, number> {
    return JSON.parse(this._native.metricsSnapshot()) as Record<string, number>;
  }

  /** Embedded observability dashboard (default http://127.0.0.1:4100). */
  async dashboard(options: DashboardOptions = {}): Promise<{ port: number }> {
    if (!this.#started) {
      throw new Error("call app.dashboard() after app.start()");
    }
    const server = await startDashboard(this, options);
    this.#servers.push(server);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { port };
  }

  /** Persisted schedule: cron string, { cron }, or { every }. */
  schedule(name: string, spec: ScheduleSpec, handler: ScheduleHandler): this {
    if (this.#started) {
      throw new Error("define schedules before app.start()");
    }
    if (this.#schedules.has(name)) {
      throw new Error(`schedule "${name}" already defined`);
    }
    const reg: ScheduleRegistration = { name, handler };
    if (typeof spec === "string") {
      reg.cron = spec;
    } else {
      if ("cron" in spec) {
        reg.cron = spec.cron;
      } else {
        reg.everyMs = ms(spec.every);
      }
      reg.timezone = spec.timezone;
      reg.overlap = spec.overlap;
      reg.catchup = spec.catchup;
      reg.jitterMs = spec.jitter !== undefined ? ms(spec.jitter) : undefined;
    }
    this.#schedules.set(name, reg);
    return this;
  }

  async start(): Promise<void> {
    if (this.#started) {
      throw new Error("app already started");
    }
    const store = this.#options.store;
    const postgresUrl = store?.driver === "postgres" ? store.url : undefined;

    const logger = this.#options.logger;
    const native = new ZenRuntime(
      {
        dataDir: this.#options.dataDir ?? ".zenzip",
        postgresUrl,
        sweepMs: this.#options.sweep !== undefined ? ms(this.#options.sweep) : undefined,
        schedulerTickMs:
          this.#options.schedulerTick !== undefined
            ? ms(this.#options.schedulerTick)
            : undefined,
        workerThreads: this.#options.workerThreads,
        logLevel: this.#options.logLevel,
      },
      logger
        ? (err: Error | null, event: LogEvent) => {
            if (!err) logger(event);
          }
        : undefined,
    );

    for (const queue of this.#queues.values()) {
      if (!queue._handler && !queue._batchHandler) continue; // producer-only
      const o = queue.options;
      native.registerQueue(
        {
          name: queue.name,
          concurrency: o.concurrency,
          maxAttempts: (o.retries ?? DEFAULT_RETRIES) + 1,
          backoffDelayMs: o.backoff?.delay !== undefined ? ms(o.backoff.delay) : undefined,
          backoffMaxDelayMs:
            o.backoff?.maxDelay !== undefined ? ms(o.backoff.maxDelay) : undefined,
          leaseMs: o.lease !== undefined ? ms(o.lease) : undefined,
          pollMs: o.poll !== undefined ? ms(o.poll) : undefined,
          batch: o.batch,
          handlerBatch: queue._batchSize,
          rateLimitMax: o.rateLimit?.max,
          rateLimitPerMs: o.rateLimit !== undefined ? ms(o.rateLimit.per) : undefined,
        },
        toTsfnHandler((jobs) => queue._dispatch(jobs.map(parseJob))),
      );
    }

    for (const wf of this.#workflows.values()) {
      const o = wf.options;
      // Webhook sugar (P3.10): "POST /hooks/x" → route that triggers the run.
      if (o.http) {
        const [method, path] = o.http.split(/\s+/);
        if (!method || !path?.startsWith("/")) {
          throw new Error(
            `workflow "${wf.name}": http option must look like "POST /hooks/x"`,
          );
        }
        this.#router.add(method, path, async (ctx) => {
          const { runId } = await wf.trigger(ctx.body);
          return { runId };
        });
      }
      native.registerWorkflow(
        {
          name: wf.name,
          version: wf._version,
          concurrency: o.concurrency,
          stepMaxAttempts: (o.stepRetries ?? 2) + 1,
          stepBackoffDelayMs:
            o.stepBackoff?.delay !== undefined ? ms(o.stepBackoff.delay) : undefined,
          stepBackoffMaxDelayMs:
            o.stepBackoff?.maxDelay !== undefined ? ms(o.stepBackoff.maxDelay) : undefined,
          leaseMs: o.lease !== undefined ? ms(o.lease) : undefined,
          triggers:
            o.on !== undefined ? (Array.isArray(o.on) ? o.on : [o.on]) : undefined,
        },
        (err: Error | null, req: JsExecRequest): Promise<string> => {
          if (err) return Promise.reject(err);
          return executeAttempt(
            wf._fn,
            wf._version,
            req,
            (stepId, kind, result) =>
              native.recordStep(req.runId, stepId, kind, result ?? undefined),
            (target) => (typeof target === "string" ? target : target.name),
            (message) => this.#options.logger?.({
              level: "WARN",
              target: "zenzip.workflow",
              message,
            }) ?? console.warn(`[zenzip] ${message}`),
          );
        },
      );
    }

    for (const reg of this.#schedules.values()) {
      native.registerSchedule(
        {
          name: reg.name,
          cron: reg.cron,
          everyMs: reg.everyMs,
          timezone: reg.timezone,
          overlap: reg.overlap,
          catchup: reg.catchup,
          jitterMs: reg.jitterMs,
        },
        toTsfnHandler(async (jobs) => {
          for (const job of jobs) {
            const tick = JSON.parse(job.payload) as ScheduleTick;
            await reg.handler(tick);
          }
        }),
      );
    }

    for (const machine of this.#machines.values()) {
      const transitions: Array<{ from: string; event: string; to: string }> = [];
      for (const [from, def] of Object.entries(machine.definition.states)) {
        for (const [event, to] of Object.entries(def.on ?? {})) {
          transitions.push({ from, event, to });
        }
      }
      native.registerMachine({
        name: machine.name,
        initial: machine.definition.initial,
        transitions,
      });
    }

    native.start();
    this.#native = native;
    this.#started = true;

    if (this.#options.handleSignals !== false) {
      this.#signalHandler = () => {
        void this.stop().finally(() => process.exit(0));
      };
      process.once("SIGINT", this.#signalHandler);
      process.once("SIGTERM", this.#signalHandler);
    }
  }

  /** Graceful shutdown. Resolves true if all in-flight jobs drained in time. */
  async stop(options: StopOptions = {}): Promise<boolean> {
    // Close HTTP servers (routes + dashboards) first: stop new intake.
    // closeServer destroys live sockets — a streaming SSE response would
    // otherwise block server.close() forever.
    await Promise.all(this.#servers.splice(0).map(closeServer));
    const native = this.#native;
    if (!native) return true;
    this.#native = null;
    this.#started = false;
    if (this.#signalHandler) {
      process.removeListener("SIGINT", this.#signalHandler);
      process.removeListener("SIGTERM", this.#signalHandler);
      this.#signalHandler = null;
    }
    const timeout = options.timeout !== undefined ? ms(options.timeout) : 30_000;
    return native.stop(timeout);
  }

  get started(): boolean {
    return this.#started;
  }

  /** @internal */
  get _native(): ZenRuntime {
    if (!this.#native) {
      throw new Error("app not started — call await app.start() first");
    }
    return this.#native;
  }

  /** @internal */
  _defaultRetries(): number {
    return DEFAULT_RETRIES;
  }
}

export function zenzip(options: ZenzipOptions = {}): ZenzipApp {
  return new ZenzipApp(options);
}

export type { Duration };
