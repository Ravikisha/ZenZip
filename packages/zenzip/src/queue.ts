import { ms } from "./duration.js";
import type { ZenzipApp } from "./app.js";
import type {
  BatchJobHandler,
  DeadJob,
  Job,
  JobHandler,
  PushOptions,
  QueueOptions,
} from "./types.js";

/** Thrown by push/pushBulk when a queue's `maxPending` bound is reached (P7.8). */
export class QueueFullError extends Error {
  constructor(
    readonly queue: string,
    readonly pending: number,
    readonly maxPending: number,
  ) {
    super(`queue "${queue}" is full: ${pending} pending ≥ maxPending ${maxPending}`);
    this.name = "QueueFullError";
  }
}

export class Queue<T = unknown> {
  /** @internal */
  _handler: JobHandler<T> | undefined;
  /** @internal */
  _batchHandler: BatchJobHandler<T> | undefined;
  /** @internal */
  _batchSize = 1;

  constructor(
    private readonly app: ZenzipApp,
    readonly name: string,
    readonly options: QueueOptions<T>,
  ) {}

  /** Attach a per-job consumer. Must be called before app.start(). */
  process(handler: JobHandler<T>): this {
    this.#assertNoProcessor();
    this._handler = handler;
    return this;
  }

  /**
   * Attach a batch consumer: up to `size` jobs per invocation.
   * All-or-nothing — a throw retries every job in the batch.
   */
  processBatch(handler: BatchJobHandler<T>, opts: { size: number }): this {
    this.#assertNoProcessor();
    if (!Number.isInteger(opts.size) || opts.size < 1) {
      throw new Error(`processBatch size must be a positive integer, got ${opts.size}`);
    }
    this._batchHandler = handler;
    this._batchSize = opts.size;
    return this;
  }

  /** @internal Dispatch a delivered job group to the attached consumer. */
  async _dispatch(jobs: Job<T>[]): Promise<void> {
    if (this._batchHandler) {
      await this._batchHandler(jobs);
    } else if (this._handler) {
      // Group size is 1 in per-job mode.
      for (const job of jobs) {
        await this._handler(job);
      }
    } else {
      throw new Error(`queue "${this.name}" has no processor`);
    }
  }

  #assertNoProcessor(): void {
    if (this.app.started) {
      throw new Error(`attach a processor to "${this.name}" before app.start()`);
    }
    if (this._handler || this._batchHandler) {
      throw new Error(`queue "${this.name}" already has a processor`);
    }
  }

  async push(data: T, options: PushOptions = {}): Promise<string> {
    const payload = await this.#validate(data);
    await this.#admit(1);
    return this.app._native.push(this.name, payload, this.#pushOptions(options, data));
  }

  async pushBulk(items: T[], options: PushOptions = {}): Promise<string[]> {
    // Per-key concurrency (P10.1) / debounce (P10.2) need a key per item; the
    // bulk native call takes one option set, so fall back to per-item pushes.
    if (this.#keyFn() || this.options.debounce || this.options.throttle) {
      const ids: string[] = [];
      for (const d of items) ids.push(await this.push(d, options));
      return ids;
    }
    const payloads = await Promise.all(items.map((d) => this.#validate(d)));
    await this.#admit(payloads.length);
    return this.app._native.pushBulk(this.name, payloads, this.#pushOptions(options));
  }

  #keyFn(): ((data: T) => string) | undefined {
    const c = this.options.concurrency;
    return typeof c === "object" ? c.key : undefined;
  }

  #keyFor(data: T): string | undefined {
    const fn = this.#keyFn();
    return fn ? String(fn(data)) : undefined;
  }

  /** Backpressure gate (P7.8): throw QueueFullError if maxPending is reached. */
  async #admit(incoming: number): Promise<void> {
    const max = this.options.maxPending;
    if (max === undefined) return;
    const pending = await this.pendingCount();
    if (pending + incoming > max) {
      throw new QueueFullError(this.name, pending, max);
    }
  }

  async pendingCount(): Promise<number> {
    return this.app._native.pendingCount(this.name);
  }

  async activeCount(): Promise<number> {
    return this.app._native.activeCount(this.name);
  }

  async deadJobs(limit = 100): Promise<DeadJob<T>[]> {
    const raw = JSON.parse(await this.app._native.deadJobs(this.name, limit)) as Array<{
      id: string;
      queue: string;
      payload: string;
      attempt: number;
      lastError?: string;
      createdAt: number;
    }>;
    return raw.map((j) => ({
      id: j.id,
      queue: j.queue,
      data: JSON.parse(j.payload) as T,
      attempt: j.attempt,
      lastError: j.lastError ?? undefined,
      createdAt: j.createdAt,
    }));
  }

  /** Move dead jobs back to pending with a fresh retry budget. */
  async requeueDead(ids?: string[]): Promise<number> {
    const target = ids ?? (await this.deadJobs()).map((j) => j.id);
    if (target.length === 0) return 0;
    const n = await this.app._native.requeueDead(target);
    this.app._audit("queue.requeueDead", this.name, { count: n });
    return n;
  }

  /** Permanently delete all dead-lettered jobs for this queue (P14.1). */
  async purgeDead(): Promise<number> {
    const n = await this.app._native.purgeDead(this.name);
    this.app._audit("queue.purgeDead", this.name, { count: n });
    return n;
  }

  /**
   * Pause this queue (P14.1): stop claiming new jobs; in-flight jobs finish.
   * In-process (this node) — call on each node for a cluster-wide pause.
   */
  pause(): void {
    this.app._native.pauseQueue(this.name);
    this.app._audit("queue.pause", this.name);
  }

  /** Resume a paused queue and wake its dispatcher. */
  resume(): void {
    this.app._native.resumeQueue(this.name);
    this.app._audit("queue.resume", this.name);
  }

  isPaused(): boolean {
    return this.app._native.isQueuePaused(this.name);
  }

  #pushOptions(options: PushOptions, data?: T) {
    const retries = options.retries ?? this.options.retries ?? this.app._defaultRetries();
    const deb = this.options.debounce;
    // A debounce window is the job's delay; otherwise honor an explicit delay.
    const delayMs = deb
      ? ms(deb.window)
      : options.delay !== undefined
        ? ms(options.delay)
        : undefined;
    const thr = this.options.throttle;
    return {
      delayMs,
      priority: options.priority,
      maxAttempts: retries + 1,
      concurrencyKey: data !== undefined ? this.#keyFor(data) : undefined,
      debounceKey: deb && data !== undefined ? String(deb.key(data)) : undefined,
      throttleKey: thr && data !== undefined ? String(thr.key(data)) : undefined,
      throttleSpacingMs:
        thr && data !== undefined ? Math.max(1, Math.round(ms(thr.per) / Math.max(1, thr.max))) : undefined,
    };
  }

  async #validate(data: T): Promise<string> {
    const schema = this.options.schema;
    if (schema) {
      let result = schema["~standard"].validate(data);
      if (result instanceof Promise) result = await result;
      if (result.issues) {
        const detail = result.issues.map((i) => i.message).join("; ");
        throw new Error(`invalid payload for queue "${this.name}": ${detail}`);
      }
      data = result.value;
    }
    return JSON.stringify(data);
  }
}
