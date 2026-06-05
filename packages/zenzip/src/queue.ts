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
    return this.app._native.push(this.name, payload, this.#pushOptions(options));
  }

  async pushBulk(items: T[], options: PushOptions = {}): Promise<string[]> {
    const payloads = await Promise.all(items.map((d) => this.#validate(d)));
    return this.app._native.pushBulk(this.name, payloads, this.#pushOptions(options));
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
    return this.app._native.requeueDead(target);
  }

  #pushOptions(options: PushOptions) {
    const retries = options.retries ?? this.options.retries ?? this.app._defaultRetries();
    return {
      delayMs: options.delay !== undefined ? ms(options.delay) : undefined,
      priority: options.priority,
      maxAttempts: retries + 1,
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
