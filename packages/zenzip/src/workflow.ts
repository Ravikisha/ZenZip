import type { JsExecRequest } from "@zenzipjs/core-native";

import { ms, type Duration } from "./duration.js";
import type { ZenzipApp } from "./app.js";
import type { PayloadCodec } from "./payload.js";

// ---------------------------------------------------------------------------
// Public step API (P2.12) — frozen surface, see docs/workflow-semantics.md
// ---------------------------------------------------------------------------

export interface Step {
  /**
   * Durable step: the result is persisted; on retry/resume the function is
   * NOT re-executed — the recorded result is returned. Side effects belong
   * inside step.run (idempotent where possible). With `opts.timeout` (P15.1),
   * a run that exceeds it fails the step (then retries per stepRetries) instead
   * of wedging a worker slot — pass an AbortSignal-aware fn to also cancel the
   * underlying work.
   */
  run<T>(id: string, fn: () => T | Promise<T>, opts?: { timeout?: Duration }): Promise<T>;
  /** Durable sleep — holds zero resources; survives restarts. */
  sleep(id: string, duration: Duration): Promise<void>;
  /** Suspend until app.emit(event) or timeout. Resolves null on timeout.
   * `match` is a shallow-equality predicate on the event payload. */
  waitForEvent<T = unknown>(
    id: string,
    event: string,
    opts?: { timeout?: Duration; match?: Record<string, unknown> },
  ): Promise<T | null>;
  /** Run a child workflow durably; returns its output (throws its error). */
  invoke<T = unknown>(
    id: string,
    workflow: Workflow<any, T> | string,
    input?: unknown,
  ): Promise<T>;
  /** Parallel steps with independent memoization. */
  all<T>(thunks: Array<() => Promise<T>>): Promise<T[]>;
}

export interface WorkflowContext<I = unknown> {
  step: Step;
  input: I;
  runId: string;
  /**
   * A deterministic idempotency key for an effect in this run (P7.13). Stable
   * across retries and replays — derived from the run id and `label` — so an
   * effect that runs inside a step but crashes before the result is journaled
   * does not duplicate on re-execution. Pass it through to anything that
   * dedupes: `flow.trigger(x, { idempotencyKey: ctx.idempotencyKey("order") })`,
   * a Stripe `Idempotency-Key` header, an upstream API, etc. Use a distinct
   * `label` per effect site.
   */
  idempotencyKey(label: string): string;
}

export type WorkflowFn<I, O> = (ctx: WorkflowContext<I>) => O | Promise<O>;

export interface WorkflowOptions {
  /** Max concurrent run executions. Default: 10 */
  concurrency?: number;
  /** Step retries after the first failed attempt. Default: 2 */
  stepRetries?: number;
  /** Backoff between step retries. Default: { delay: "1s", maxDelay: "60s" } */
  stepBackoff?: { delay?: Duration; maxDelay?: Duration };
  /**
   * Execution-attempt lease: if the process dies mid-attempt, the run is
   * redelivered after this. Raise for long-running steps. Default: 60s
   */
  lease?: Duration;
  /**
   * Event patterns that durably trigger this workflow (atomic outbox —
   * a persisted event implies its triggered runs exist). `*` matches one
   * dot-segment, trailing `**` matches any remainder. Triggered runs
   * receive `{ event, payload, emittedAt }` as input.
   */
  on?: string | string[];
  /**
   * Webhook sugar: "POST /hooks/stripe" registers an HTTP route (served by
   * app.listen()) that triggers this workflow with the request body and
   * responds with { runId }.
   */
  http?: string;
}

export type RunStatus =
  | "running"
  | "sleeping"
  | "waitingEvent"
  | "waitingChild"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunInfo<O = unknown> {
  runId: string;
  workflow: string;
  status: RunStatus;
  output?: O;
  error?: string;
}

export interface TriggerOptions {
  /** Same key + same workflow = same run (dedup). */
  idempotencyKey?: string;
  /** Delay the first execution. */
  delay?: Duration;
  /**
   * Data-subject tag (P14.6) — e.g. a user id. Tagged runs (+ their steps) can
   * be erased on request via `app.purgeSubject(subject)` for GDPR/PII.
   */
  subject?: string;
}

// ---------------------------------------------------------------------------
// Execution internals
// ---------------------------------------------------------------------------

const STATUS_NAMES: RunStatus[] = [
  "running",
  "sleeping",
  "waitingEvent",
  "waitingChild",
  "completed",
  "failed",
  "cancelled",
];

type SuspendInfo =
  | { type: "sleep"; stepId: string; wakeAt: number }
  | {
      type: "event";
      stepId: string;
      event: string;
      timeoutAt: number | null;
      match?: string;
    }
  | { type: "invoke"; stepId: string; workflow: string; input: string };

/** Control-flow signal — NOT an error. Don't swallow unknown throwables. */
class SuspendSignal {
  constructor(readonly suspend: SuspendInfo) {}
}

class StepFailure {
  constructor(
    readonly stepId: string,
    readonly cause: unknown,
  ) {}
}

interface JournalEntry {
  id: string;
  kind: string;
  result: string | null;
}

/** Race a step body against a timeout (P15.1). The underlying work isn't
 * forcibly cancelled (JS can't abort an arbitrary promise) — the result is
 * discarded; pass an AbortSignal-aware fn to cancel real I/O. */
async function runWithTimeout<T>(fn: () => T | Promise<T>, timeoutMs: number, id: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`step "${id}" timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([Promise.resolve(fn()), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function makeStep(
  journal: Map<string, JournalEntry>,
  recordStep: (stepId: string, kind: string, result: string | null) => void,
  resolveWorkflowName: (wf: Workflow<any, any> | string) => string,
  runId: string,
  payloads?: PayloadCodec,
): Step {
  const usedIds = new Set<string>();
  const claim = (id: string, kind: string): JournalEntry | undefined => {
    if (usedIds.has(id)) {
      throw new Error(
        `duplicate step id "${id}" — every step in a run needs a unique, stable id`,
      );
    }
    usedIds.add(id);
    const entry = journal.get(id);
    if (entry && entry.kind !== kind) {
      throw new Error(
        `step "${id}" changed kind from "${entry.kind}" to "${kind}" — ` +
          "in-flight runs must keep stable step ids (docs: workflow versioning)",
      );
    }
    return entry;
  };

  return {
    async run<T>(
      id: string,
      fn: () => T | Promise<T>,
      opts?: { timeout?: Duration },
    ): Promise<T> {
      const entry = claim(id, "run");
      if (entry) {
        return entry.result === null ? (undefined as T) : (JSON.parse(entry.result) as T);
      }
      let result: T;
      try {
        result =
          opts?.timeout !== undefined ? await runWithTimeout(fn, ms(opts.timeout), id) : await fn();
      } catch (e) {
        throw new StepFailure(id, e);
      }
      const json = JSON.stringify(result ?? null);
      // Offload large results to the blob store (P9.1) before journaling.
      const toStore = payloads ? await payloads.offload(runId, id, json) : json;
      recordStep(id, "run", toStore);
      return result;
    },

    sleep(id: string, duration: Duration): Promise<void> {
      const entry = claim(id, "sleep");
      if (entry) return Promise.resolve();
      throw new SuspendSignal({
        type: "sleep",
        stepId: id,
        wakeAt: Date.now() + ms(duration),
      });
    },

    waitForEvent<T>(
      id: string,
      event: string,
      opts?: { timeout?: Duration; match?: Record<string, unknown> },
    ): Promise<T | null> {
      const entry = claim(id, "waitForEvent");
      if (entry) {
        const r = JSON.parse(entry.result ?? "{}") as {
          event?: T;
          timedOut?: boolean;
        };
        return Promise.resolve(r.timedOut ? null : (r.event as T));
      }
      throw new SuspendSignal({
        type: "event",
        stepId: id,
        event,
        timeoutAt: opts?.timeout !== undefined ? Date.now() + ms(opts.timeout) : null,
        match: opts?.match !== undefined ? JSON.stringify(opts.match) : undefined,
      });
    },

    invoke<T>(id: string, workflow: Workflow<any, T> | string, input?: unknown): Promise<T> {
      const entry = claim(id, "invoke");
      if (entry) {
        const r = JSON.parse(entry.result ?? "{}") as { output?: T; error?: string };
        if (r.error !== undefined) return Promise.reject(new Error(r.error));
        return Promise.resolve(r.output as T);
      }
      throw new SuspendSignal({
        type: "invoke",
        stepId: id,
        workflow: resolveWorkflowName(workflow),
        input: JSON.stringify(input ?? null),
      });
    },

    all<T>(thunks: Array<() => Promise<T>>): Promise<T[]> {
      return Promise.all(thunks.map((t) => t()));
    },
  };
}

/** FNV-1a content hash of the definition (P2.11 version pinning). */
export function hashDefinition(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Execute one attempt; returns the outcome JSON for the Rust engine. */
export async function executeAttempt(
  fn: WorkflowFn<any, any>,
  expectedVersion: string | undefined,
  req: JsExecRequest,
  recordStep: (stepId: string, kind: string, result: string | null) => void,
  resolveWorkflowName: (wf: Workflow<any, any> | string) => string,
  warn: (message: string) => void,
  payloads?: PayloadCodec,
): Promise<string> {
  if (expectedVersion && req.version && expectedVersion !== req.version) {
    warn(
      `run ${req.runId} of "${req.workflow}" was started by version ${req.version}, ` +
        `current is ${expectedVersion} — keep step ids stable or in-flight runs may misbehave`,
    );
  }
  const entries = JSON.parse(req.journal) as JournalEntry[];
  // Rehydrate any offloaded results (P9.1) before fast-forward — steps read
  // their journal entries synchronously, so the real values must be in hand.
  if (payloads) {
    for (const e of entries) {
      e.result = await payloads.rehydrate(e.result);
    }
  }
  const journal = new Map(entries.map((e) => [e.id, e]));
  const step = makeStep(journal, recordStep, resolveWorkflowName, req.runId, payloads);

  try {
    const output = await fn({
      step,
      input: JSON.parse(req.input),
      runId: req.runId,
      idempotencyKey: (label: string) => `${req.runId}:${label}`,
    });
    return JSON.stringify({ type: "completed", output: JSON.stringify(output ?? null) });
  } catch (e) {
    if (e instanceof SuspendSignal) {
      return JSON.stringify({ ...e.suspend, type: e.suspend.type });
    }
    if (e instanceof StepFailure) {
      const cause = e.cause;
      const message =
        cause instanceof Error ? cause.message : String(cause ?? "unknown error");
      return JSON.stringify({ type: "stepFailed", stepId: e.stepId, error: message });
    }
    const message = e instanceof Error ? e.message : String(e);
    return JSON.stringify({ type: "failed", error: message });
  }
}

// ---------------------------------------------------------------------------
// Workflow handle
// ---------------------------------------------------------------------------

export class Workflow<I = unknown, O = unknown> {
  constructor(
    private readonly app: ZenzipApp,
    readonly name: string,
    readonly options: WorkflowOptions,
    /** @internal */
    readonly _fn: WorkflowFn<I, O>,
    /** @internal */
    readonly _version: string,
  ) {}

  /** Prior-version implementations, keyed by their content hash (P10.6). */
  readonly #versions = new Map<string, WorkflowFn<I, O>>();

  /**
   * Register a previous implementation for version routing (P10.6). In-flight
   * runs pinned to that definition's content hash keep executing the old
   * function; new runs use the current one — so a deploy never re-runs live
   * runs on changed logic. Keep the old function around and register it:
   *
   *   const order = app.workflow("order", newFn);
   *   order.version(oldFn);   // self-hashes; old in-flight runs route here
   */
  version(legacyFn: WorkflowFn<I, O>): this {
    this.#versions.set(hashDefinition(legacyFn.toString()), legacyFn);
    return this;
  }

  /** @internal Pick the fn + version to run for a run's pinned version. */
  _route(pinned: string | undefined): { fn: WorkflowFn<I, O>; version: string } {
    if (pinned && this.#versions.has(pinned)) {
      return { fn: this.#versions.get(pinned)!, version: pinned };
    }
    return { fn: this._fn, version: this._version };
  }

  /** Start a run (durable from this moment). Returns immediately. */
  async trigger(input: I, options: TriggerOptions = {}): Promise<{ runId: string }> {
    const runId = this.app._native.triggerWorkflow(this.name, JSON.stringify(input ?? null), {
      idempotencyKey: options.idempotencyKey,
      delayMs: options.delay !== undefined ? ms(options.delay) : undefined,
      subject: options.subject,
    });
    this.app._audit("workflow.trigger", this.name, { runId });
    return { runId };
  }

  /** Trigger and wait for the result (throws on failure/cancel/timeout). */
  async triggerAndWait(
    input: I,
    options: TriggerOptions & { timeout?: Duration } = {},
  ): Promise<O> {
    const { runId } = await this.trigger(input, options);
    const timeout = options.timeout !== undefined ? ms(options.timeout) : 60_000;
    const raw = await this.app._native.waitForRun(runId, timeout);
    if (!raw) throw new Error(`run ${runId} not found`);
    const run = this.#parseRun(raw);
    switch (run.status) {
      case "completed":
        return run.output as O;
      case "failed":
        throw new Error(run.error ?? `run ${runId} failed`);
      case "cancelled":
        throw new Error(`run ${runId} was cancelled`);
      default:
        throw new Error(`run ${runId} did not finish within the timeout (${run.status})`);
    }
  }

  async getRun(runId: string): Promise<RunInfo<O> | null> {
    const raw = this.app._native.getRun(runId);
    return raw ? this.#parseRun(raw) : null;
  }

  /** Cancel a run and all its child runs. Returns the number cancelled. */
  async cancel(runId: string): Promise<number> {
    const n = this.app._native.cancelRun(runId);
    this.app._audit("workflow.cancel", this.name, { runId, cancelled: n });
    return n;
  }

  #parseRun(raw: string): RunInfo<O> {
    const row = JSON.parse(raw) as {
      id: string;
      workflow: string;
      status: number;
      output: string | null;
      error: string | null;
    };
    return {
      runId: row.id,
      workflow: row.workflow,
      status: STATUS_NAMES[row.status] ?? "running",
      output: row.output !== null ? (JSON.parse(row.output) as O) : undefined,
      error: row.error ?? undefined,
    };
  }
}
