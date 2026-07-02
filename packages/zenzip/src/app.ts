import type { Server } from "node:http";
import { join } from "node:path";

import { ZenRuntime, type JsExecRequest, type JsJob } from "@zenzipjs/core-native";

import { startDashboard, type DashboardOptions } from "./dashboard.js";
import { ms, type Duration } from "./duration.js";
import { eventMatches } from "./events.js";
import { Agent, type AgentOptions } from "./agent.js";
import { Network, type NetworkOptions } from "./network.js";
import { Namespace } from "./namespace.js";
import {
  closeServer,
  HttpRouter,
  makeNodeHandler,
  serveRouter,
  type CtxHandler,
  type ExpressHandler,
  type RouteHandler,
} from "./http.js";
import {
  middlewareLayer,
  type ErrorMiddleware,
  type Middleware,
  type MiddlewareLayer,
} from "./express.js";
import { Router } from "./router.js";
import {
  auth,
  cors,
  csrf,
  json,
  logger,
  rateLimit,
  secureHeaders,
  serveStatic,
  urlencoded,
  validate,
} from "./middleware.js";
import { makeFetchHandler } from "./fetch.js";
import { validateConfig } from "./config.js";
import { createPayloadCodec, FilesystemBlobStore, type PayloadCodec } from "./payload.js";
import { buildMcpHandler, serveMcp, type McpServerOptions } from "./mcp-server.js";
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
  AuditEntry,
  EmitResult,
  EventHandler,
  GcStats,
  HealthStatus,
  Job,
  LogEvent,
  MachineDefinition,
  OrphanedRun,
  QueueOptions,
  RunUpdate,
  ScheduleHandler,
  StepUpdate,
  SubscribeOptions,
  ScheduleSpec,
  ScheduleTick,
  StopOptions,
  ZenzipOptions,
} from "./types.js";

const DEFAULT_RETRIES = 2;

/** Run status code → name, matching the store's run_status ordering. */
const RUN_STATUS_NAMES = [
  "running",
  "sleeping",
  "waitingEvent",
  "waitingChild",
  "completed",
  "failed",
  "cancelled",
] as const;

/** Normalize a thrown value so the Rust side gets a useful reason string. */
function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/** Retention window → native ms (0 disables); undefined keeps the default. */
function retentionMs(v: Duration | "off" | undefined): number | undefined {
  if (v === undefined) return undefined;
  return v === "off" ? 0 : ms(v);
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
  readonly #agents = new Map<string, Agent<any>>();
  readonly #machines = new Map<string, Machine<any>>();
  readonly #subscribers: Array<{ pattern: string; handler: EventHandler }> = [];
  readonly #router = new HttpRouter();
  readonly #middleware: MiddlewareLayer[] = [];
  readonly #servers: Server[] = [];
  #payloadCodec: PayloadCodec | undefined;
  #native: ZenRuntime | null = null;
  #started = false;
  #signalHandler: (() => void) | null = null;
  #alertTimer: ReturnType<typeof setInterval> | null = null;
  /** Per-queue last DLQ size, so alerts fire on *growth*, not on every tick. */
  readonly #lastDlq = new Map<string, number>();

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
    const agent = new Agent<TOutput>(this, name, options);
    this.#agents.set(name, agent);
    return agent;
  }

  /**
   * A multi-agent network (P9.6): a coordinator that durably routes a request
   * among `options.agents` specialists. Define members with `app.agent()`
   * first, then compose them. Returns a {@link Network} whose `run`/`trigger`
   * behave like an agent's.
   */
  network<TOutput = unknown>(name: string, options: NetworkOptions): Network<TOutput> {
    if (this.#started) {
      throw new Error("define networks before app.start()");
    }
    return new Network<TOutput>(this, name, options);
  }

  /**
   * A namespace (P14.5): a scoped facade whose queues, workflows, schedules,
   * agents, and events are all prefixed with `<name>:` for logical multi-tenant
   * isolation within one store. One tenant's events never wake another's
   * triggers. `const t = app.namespace(tenantId); t.queue("jobs")` →  a queue
   * named `<tenantId>:jobs`.
   */
  namespace(name: string): Namespace {
    return new Namespace(this, name);
  }

  /** @internal Registered workflows (excludes hidden agent workflows). */
  _listWorkflows(): Workflow<any, any>[] {
    return [...this.#workflows.values()].filter((w) => !w.name.startsWith("agent:"));
  }

  /** @internal Registered agents. */
  _listAgents(): Agent<any>[] {
    return [...this.#agents.values()];
  }

  /** @internal Record a privileged action to the audit sink (P13.6). */
  _audit(action: string, target?: string, detail?: Record<string, unknown>): void {
    const sink = this.#options.onAudit;
    if (!sink) return;
    try {
      sink({ action, target, at: Date.now(), detail });
    } catch {
      /* audit must never break the action it records */
    }
  }

  /**
   * Erase all runs (+ their step journal) tagged with `subject` (P14.6) —
   * GDPR/PII "right to erasure". Tag runs at trigger time:
   * `wf.trigger(input, { subject: userId })`, then `app.purgeSubject(userId)`.
   * Returns the number of runs removed. (Encrypt payloads with `encryptionKey`
   * and set `retention` to bound how long un-purged data lives.)
   */
  async purgeSubject(subject: string): Promise<number> {
    const n = await this._native.purgeSubject(subject);
    this._audit("subject.purge", subject, { runs: n });
    return n;
  }

  /** @internal Report an engine error to the onError sink (P16.4). */
  _reportError(err: unknown, ctx: { source: string; [key: string]: unknown }): void {
    const sink = this.#options.onError;
    if (!sink) return;
    try {
      sink(err instanceof Error ? err : new Error(String(err)), ctx);
    } catch {
      /* reporting must never break the path it observes */
    }
  }

  /**
   * Realtime run subscription (P9.4): an async-iterable stream of run status
   * + step events, emitted whenever the run changes, ending when it reaches a
   * terminal state. Store-backed polling, so it works across processes/nodes:
   *
   *   for await (const u of app.subscribe(runId)) {
   *     console.log(u.status, u.steps.length);
   *   }
   *
   * Pipe it to an SSE/WebSocket response to drive a frontend. (LLM token
   * streaming is same-process via the agent stream API.)
   */
  async *subscribe<O = unknown>(
    runId: string,
    options: SubscribeOptions = {},
  ): AsyncGenerator<RunUpdate<O>> {
    const interval = options.interval ?? 250;
    const deadline = options.timeout !== undefined ? Date.now() + options.timeout : undefined;
    let last = "";
    let first = true;
    for (;;) {
      const raw = this._native.getRun(runId);
      if (!raw) {
        if (first) throw new Error(`run ${runId} not found`);
        return; // run was GC'd mid-stream
      }
      first = false;
      const row = JSON.parse(raw) as {
        id: string;
        workflow: string;
        status: number;
        output: string | null;
        error: string | null;
      };
      const stepsRaw = JSON.parse(await this._native.dashboardRunSteps(runId)) as Array<{
        stepId: string;
        kind: string;
        status: number;
        attempts: number;
        error: string | null;
      }>;
      const steps: StepUpdate[] = stepsRaw.map((s) => ({
        stepId: s.stepId,
        kind: s.kind,
        status: s.status,
        attempts: s.attempts,
        error: s.error ?? undefined,
      }));
      const terminal = row.status >= 4;
      const update: RunUpdate<O> = {
        runId: row.id,
        workflow: row.workflow,
        status: RUN_STATUS_NAMES[row.status] ?? "running",
        terminal,
        output: row.output !== null ? (JSON.parse(row.output) as O) : undefined,
        error: row.error ?? undefined,
        steps,
      };
      const sig = JSON.stringify({ s: update.status, steps });
      if (sig !== last) {
        last = sig;
        yield update;
      }
      if (terminal) return;
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error(`subscribe(${runId}) timed out (status ${update.status})`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
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

  /**
   * Register Express-style middleware (P8.1). Runs in registration order
   * before route dispatch, with augmented `(req, res, next)`:
   *
   *   app.use((req, res, next) => { req.startedAt = Date.now(); next(); });
   *   app.use("/api", authMiddleware);          // path-scoped
   *   app.use((err, req, res, next) => { ... }); // 4-arg error middleware
   *
   * A handler/middleware that throws, rejects, or calls next(err) skips to the
   * next 4-arg error middleware; if none handles it, a 500 is written. Error
   * middleware (arity ≥ 4) runs only while an error is propagating.
   */
  use(router: Router): this;
  use(path: string, router: Router): this;
  use(...middleware: Array<Middleware | ErrorMiddleware>): this;
  use(path: string, ...middleware: Array<Middleware | ErrorMiddleware>): this;
  use(
    pathOrFn: string | Middleware | ErrorMiddleware | Router,
    ...rest: Array<Middleware | ErrorMiddleware | Router>
  ): this {
    if (this.#started) {
      throw new Error("register middleware before app.start()");
    }
    // Mount a Router (P8.3): app.use(router) or app.use("/prefix", router).
    if (pathOrFn instanceof Router) {
      this.#mountRouter("/", pathOrFn);
      return this;
    }
    if (typeof pathOrFn === "string" && rest[0] instanceof Router) {
      this.#mountRouter(pathOrFn, rest[0]);
      return this;
    }
    const fns = rest as Array<Middleware | ErrorMiddleware>;
    const path = typeof pathOrFn === "string" ? pathOrFn : undefined;
    const handlers = typeof pathOrFn === "string" ? fns : [pathOrFn, ...fns];
    if (handlers.length === 0) {
      throw new Error("app.use() expects at least one middleware function");
    }
    for (const fn of handlers) {
      if (typeof fn !== "function") {
        throw new Error("app.use() expects middleware function(s)");
      }
      this.#middleware.push(middlewareLayer(fn, path));
    }
    return this;
  }

  #mountRouter(prefix: string, router: Router): void {
    const { routes, middleware } = router._collect(prefix);
    for (const layer of middleware) this.#middleware.push(layer);
    for (const r of routes) this.#router.add(r.method, r.path, r.handler as CtxHandler);
  }

  get(path: string, handler: CtxHandler): this;
  get(path: string, handler: ExpressHandler): this;
  get(path: string, handler: RouteHandler): this {
    this.#router.add("GET", path, handler as CtxHandler);
    return this;
  }
  post(path: string, handler: CtxHandler): this;
  post(path: string, handler: ExpressHandler): this;
  post(path: string, handler: RouteHandler): this {
    this.#router.add("POST", path, handler as CtxHandler);
    return this;
  }
  put(path: string, handler: CtxHandler): this;
  put(path: string, handler: ExpressHandler): this;
  put(path: string, handler: RouteHandler): this {
    this.#router.add("PUT", path, handler as CtxHandler);
    return this;
  }
  patch(path: string, handler: CtxHandler): this;
  patch(path: string, handler: ExpressHandler): this;
  patch(path: string, handler: RouteHandler): this {
    this.#router.add("PATCH", path, handler as CtxHandler);
    return this;
  }
  delete(path: string, handler: CtxHandler): this;
  delete(path: string, handler: ExpressHandler): this;
  delete(path: string, handler: RouteHandler): this {
    this.#router.add("DELETE", path, handler as CtxHandler);
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
      { router: this.#router, middleware: this.#middleware, app: this },
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
    return makeNodeHandler({
      router: this.#router,
      middleware: this.#middleware,
      app: this,
    });
  }

  /**
   * Web Fetch handler over the registered routes + middleware (P8.5): takes a
   * standard `Request`, returns a `Response`. Mount into Next.js route handlers
   * (`export const POST = app.toFetchHandler()`), Hono, Bun, Deno, or any edge
   * runtime. Call after app.start().
   */
  toFetchHandler(): (request: Request) => Promise<Response> {
    if (!this.#started) {
      throw new Error("call app.toFetchHandler() after app.start()");
    }
    return makeFetchHandler({
      router: this.#router,
      middleware: this.#middleware,
      app: this,
    });
  }

  /** Engine metrics counters (jobs, runs, steps, events, handler timings). */
  metrics(): Record<string, number> {
    return JSON.parse(this._native.metricsSnapshot()) as Record<string, number>;
  }

  /**
   * Run a retention GC pass now (P7.6): delete aged terminal runs + events
   * using the configured `retention` windows. The background sweep does this
   * automatically; this is for ops/manual use. Returns rows removed.
   */
  gc(): GcStats {
    return JSON.parse(this._native.runGc()) as GcStats;
  }

  /**
   * Liveness + readiness (P7.7). `alive` = process up + engine responding
   * (zero store I/O). `ready` = started AND the store is reachable — use it
   * to gate rolling deploys. Also served as `/healthz` and `/readyz`.
   */
  health(): HealthStatus {
    const alive = this.#native !== null;
    return { alive, ready: alive && this.#native!.healthCheck() };
  }

  /**
   * Surface orphaned runs (P7.10): non-terminal runs that haven't progressed
   * within `idle` (default 5m) — a sleeping run past its wake, a wait stuck
   * past timeout, or an execution whose wakeup was lost. These should be rare;
   * a non-empty result points at a stalled sweeper or a lost notification.
   * Scans the most recent `limit` runs (default 1000).
   */
  async orphanedRuns(
    options: { idle?: Duration; limit?: number } = {},
  ): Promise<OrphanedRun[]> {
    const idleMs = options.idle !== undefined ? ms(options.idle) : 300_000;
    const cutoff = Date.now() - idleMs;
    const raw = await this._native.dashboardRuns(undefined, undefined, options.limit ?? 1000);
    const rows = JSON.parse(raw) as Array<{
      id: string;
      workflow: string;
      status: number;
      updatedAt: number;
    }>;
    const names = ["running", "sleeping", "waitingEvent", "waitingChild"] as const;
    const out: OrphanedRun[] = [];
    for (const r of rows) {
      if (r.status > 3 || r.updatedAt >= cutoff) continue; // terminal or fresh
      const status = names[r.status];
      out.push({
        runId: r.id,
        workflow: r.workflow,
        status,
        idleMs: Date.now() - r.updatedAt,
        reason:
          status === "sleeping"
            ? "sleeping past its wake — the wake job may have been lost"
            : status === "waitingEvent"
              ? "waiting on an event past its timeout — the sweep may have stalled"
              : "no progress — execution may be stuck or its wakeup lost",
      });
    }
    return out;
  }

  /**
   * Bulk-cancel non-terminal runs matching a filter (P14.1) — the fleet-wide
   * companion to `workflow.cancel(runId)`. Cancels each match and its child
   * runs. Use for incident response ("cancel everything still running on the
   * broken workflow") or draining before a breaking deploy.
   */
  async cancelRuns(
    filter: {
      workflow?: string;
      status?: "running" | "sleeping" | "waitingEvent" | "waitingChild";
      olderThan?: Duration;
      limit?: number;
    } = {},
  ): Promise<{ cancelled: number; runs: string[] }> {
    const statusNum = filter.status ? RUN_STATUS_NAMES.indexOf(filter.status) : undefined;
    const raw = await this._native.dashboardRuns(
      filter.workflow ?? undefined,
      statusNum,
      filter.limit ?? 1000,
    );
    const rows = JSON.parse(raw) as Array<{ id: string; status: number; updatedAt: number }>;
    const cutoff = filter.olderThan !== undefined ? Date.now() - ms(filter.olderThan) : undefined;
    const runs: string[] = [];
    let cancelled = 0;
    for (const r of rows) {
      if (r.status > 3) continue; // already terminal
      if (cutoff !== undefined && r.updatedAt >= cutoff) continue;
      cancelled += this._native.cancelRun(r.id);
      runs.push(r.id);
    }
    this._audit("runs.cancel", filter.workflow ?? "*", { count: runs.length, filter });
    return { cancelled, runs };
  }

  /** Background alerting loop (P14.2) — started when `options.alerts` is set. */
  #startAlerts(): void {
    const cfg = this.#options.alerts;
    if (!cfg) return;
    const interval = cfg.interval !== undefined ? ms(cfg.interval) : 60_000;
    const dlqThreshold = cfg.dlqThreshold ?? 1;
    const tick = async () => {
      if (!this.#native) return;
      try {
        // DLQ growth: fire when a queue's dead count rises past the threshold.
        for (const name of this.#queues.keys()) {
          const dead = (await this.#queues.get(name)!.deadJobs(1000)).length;
          const prev = this.#lastDlq.get(name) ?? 0;
          this.#lastDlq.set(name, dead);
          if (dead >= dlqThreshold && dead > prev) {
            cfg.onAlert({
              type: "dlq",
              queue: name,
              count: dead,
              message: `dead-letter queue "${name}" grew to ${dead} job(s)`,
            });
          }
        }
        // Stuck runs (reuses the P7.10 orphaned-run detector).
        const orphaned = await this.orphanedRuns({ idle: cfg.idle });
        if (orphaned.length > 0) {
          cfg.onAlert({
            type: "orphaned",
            count: orphaned.length,
            message: `${orphaned.length} run(s) stuck without progress`,
            runs: orphaned.map((o) => o.runId),
          });
        }
      } catch (err) {
        // best-effort — never let the alert loop crash the app, but surface it
        this._reportError(err, { source: "alert" });
      }
    };
    this.#alertTimer = setInterval(() => void tick(), interval);
    if (typeof this.#alertTimer.unref === "function") this.#alertTimer.unref();
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

  /**
   * Expose this app's workflows + agents as an MCP server (P9.2b) — other
   * agents can then call them durably via `mcp(url)`. Runs on its own server
   * (default http://127.0.0.1:4200); closed by app.stop(). Call after start().
   */
  async mcpServer(options: McpServerOptions = {}): Promise<{ port: number }> {
    if (!this.#started) {
      throw new Error("call app.mcpServer() after app.start()");
    }
    const server = await serveMcp(this, options);
    this.#servers.push(server);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { port };
  }

  /**
   * A mountable node:http handler for the MCP server (P9.2b) — embed the MCP
   * endpoint into an existing server instead of running a standalone one.
   * Call after app.start().
   */
  mcpHandler(
    options: McpServerOptions = {},
  ): (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void {
    if (!this.#started) {
      throw new Error("call app.mcpHandler() after app.start()");
    }
    return buildMcpHandler(this, options);
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
    validateConfig(this.#options); // fail fast on misconfig (P13.5)
    const store = this.#options.store;
    const postgresUrl = store?.driver === "postgres" ? store.url : undefined;

    // Large-payload offloading (P9.1), opt-in. The fs default is single-node;
    // a multi-node (postgres) deploy must supply a shared store (e.g. S3).
    const p = this.#options.payloads;
    if (p) {
      const dataDir = this.#options.dataDir ?? ".zenzip";
      const blobStore = p.store ?? new FilesystemBlobStore(join(dataDir, "blobs"));
      this.#payloadCodec = createPayloadCodec(blobStore, p.threshold ?? 65_536);
    }

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
        gcSweepMs:
          this.#options.retention?.sweep !== undefined
            ? ms(this.#options.retention.sweep)
            : undefined,
        runRetentionMs: retentionMs(this.#options.retention?.runs),
        eventRetentionMs: retentionMs(this.#options.retention?.events),
        encryptionKey: this.#options.encryptionKey,
      },
      logger || this.#options.onError
        ? (err: Error | null, event: LogEvent) => {
            if (err) this._reportError(err, { source: "log" });
            else logger?.(event);
          }
        : undefined,
    );

    for (const queue of this.#queues.values()) {
      if (!queue._handler && !queue._batchHandler) continue; // producer-only
      const o = queue.options;
      const conc = o.concurrency;
      native.registerQueue(
        {
          name: queue.name,
          // Number → global limit; { limit, key } → per-key limit (P10.1).
          concurrency: typeof conc === "number" ? conc : undefined,
          concurrencyKeyLimit: typeof conc === "object" ? conc.limit : undefined,
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
          fair: o.fair,
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
          // Version routing (P10.6): in-flight runs pinned to an older
          // definition execute that definition's fn; new runs use the current.
          const routed = wf._route(req.version ?? undefined);
          return executeAttempt(
            routed.fn,
            routed.version,
            req,
            (stepId, kind, result) =>
              native.recordStep(req.runId, stepId, kind, result ?? undefined),
            (target) => (typeof target === "string" ? target : target.name),
            (message) => this.#options.logger?.({
              level: "WARN",
              target: "zenzip.workflow",
              message,
            }) ?? console.warn(`[zenzip] ${message}`),
            this.#payloadCodec,
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

    // Health probes (P7.7). Registered after user routes, so an app that
    // defines its own /healthz or /readyz keeps precedence (first match wins).
    this.#router.add("GET", "/healthz", () => ({ status: "alive" }));
    this.#router.add("GET", "/readyz", (ctx) => {
      const ready = this._native.healthCheck();
      if (!ready) ctx.status(503);
      return { status: ready ? "ready" : "unavailable" };
    });

    if (this.#options.handleSignals !== false) {
      this.#signalHandler = () => {
        void this.stop().finally(() => process.exit(0));
      };
      process.once("SIGINT", this.#signalHandler);
      process.once("SIGTERM", this.#signalHandler);
    }

    this.#startAlerts(); // P14.2 — no-op unless options.alerts is set
  }

  /** Graceful shutdown. Resolves true if all in-flight jobs drained in time. */
  async stop(options: StopOptions = {}): Promise<boolean> {
    // Close HTTP servers (routes + dashboards) first: stop new intake, then
    // gracefully drain in-flight requests (P15.3) before draining the queues.
    const httpDrain = options.httpDrain !== undefined ? ms(options.httpDrain) : 5_000;
    await Promise.all(this.#servers.splice(0).map((s) => closeServer(s, httpDrain)));
    const native = this.#native;
    if (!native) return true;
    if (this.#alertTimer) {
      clearInterval(this.#alertTimer);
      this.#alertTimer = null;
    }
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

export interface ZenzipFactory {
  (options?: ZenzipOptions): ZenzipApp;
  /** Express-style `Router()` for grouping + mounting routes (P8.3). */
  Router: () => Router;
  /** Built-in middleware (P8.6). */
  json: typeof json;
  urlencoded: typeof urlencoded;
  cors: typeof cors;
  csrf: typeof csrf;
  logger: typeof logger;
  static: typeof serveStatic;
  validate: typeof validate;
  auth: typeof auth;
  secureHeaders: typeof secureHeaders;
  rateLimit: typeof rateLimit;
}

export const zenzip: ZenzipFactory = Object.assign(
  (options: ZenzipOptions = {}): ZenzipApp => new ZenzipApp(options),
  {
    Router: () => new Router(),
    json,
    urlencoded,
    cors,
    csrf,
    logger,
    static: serveStatic,
    validate,
    auth,
    secureHeaders,
    rateLimit,
  },
);

export type { Duration };
