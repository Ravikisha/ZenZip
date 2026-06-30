// Namespaces / multi-tenancy (P14.5). A Namespace is a thin scoped facade over
// the app: every queue, workflow, schedule, agent, network, and event name it
// defines is transparently prefixed with `<name>:`. This gives logical
// isolation between tenants/modules within one store — one tenant's events
// never wake another's `on:` triggers, and their queues/runs are distinct —
// without per-call prefixing in your code. (Logical isolation, not row-level
// security; for hard isolation give each tenant its own database.)
import type { Agent, AgentOptions } from "./agent.js";
import type { ZenzipApp } from "./app.js";
import type { Network, NetworkOptions } from "./network.js";
import type { Queue } from "./queue.js";
import type {
  EmitResult,
  EventHandler,
  QueueOptions,
  ScheduleHandler,
  ScheduleSpec,
} from "./types.js";
import type { Workflow, WorkflowFn, WorkflowOptions } from "./workflow.js";

export class Namespace {
  constructor(
    private readonly app: ZenzipApp,
    readonly name: string,
  ) {}

  /** Prefix a queue/workflow/agent/event name with this namespace. */
  key(name: string): string {
    return `${this.name}:${name}`;
  }

  private prefixOn(on: string | string[] | undefined): string | string[] | undefined {
    if (on === undefined) return undefined;
    return Array.isArray(on) ? on.map((p) => this.key(p)) : this.key(on);
  }

  queue<T = unknown>(name: string, options: QueueOptions<T> = {}): Queue<T> {
    return this.app.queue<T>(this.key(name), options);
  }

  workflow<I = unknown, O = unknown>(
    name: string,
    optionsOrFn: WorkflowOptions | WorkflowFn<I, O>,
    maybeFn?: WorkflowFn<I, O>,
  ): Workflow<I, O> {
    if (typeof optionsOrFn === "function") {
      return this.app.workflow<I, O>(this.key(name), optionsOrFn);
    }
    // Prefix event triggers so they fire only on this namespace's events.
    const options: WorkflowOptions = { ...optionsOrFn, on: this.prefixOn(optionsOrFn.on) };
    return this.app.workflow<I, O>(this.key(name), options, maybeFn);
  }

  schedule(name: string, spec: ScheduleSpec, handler: ScheduleHandler): this {
    this.app.schedule(this.key(name), spec, handler);
    return this;
  }

  agent<TOutput = unknown>(name: string, options: AgentOptions): Agent<TOutput> {
    return this.app.agent<TOutput>(this.key(name), options);
  }

  network<TOutput = unknown>(name: string, options: NetworkOptions): Network<TOutput> {
    return this.app.network<TOutput>(this.key(name), options);
  }

  /** Emit a namespace-scoped event. */
  emit(event: string, payload?: unknown): EmitResult {
    return this.app.emit(this.key(event), payload);
  }

  /** Subscribe to a namespace-scoped event pattern. */
  on<T = unknown>(pattern: string, handler: EventHandler<T>): () => void {
    return this.app.on<T>(this.key(pattern), handler);
  }
}
