// Circuit breakers + bulkheads (P15.2). Protect the live process from a
// flailing external dependency (LLM provider, third-party HTTP): once failures
// pile up, fail fast instead of piling more load onto a service that is already
// down, then probe for recovery. This is process-local, in-memory state — it is
// about protecting *this* process, not durable execution, so it is deliberately
// NOT journaled (a retried workflow step re-evaluates the live circuit).
import { ms, type Duration } from "./duration.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the circuit open. Default: 5. */
  failureThreshold?: number;
  /** How long to stay open before allowing a probe (half-open). Default: "30s". */
  resetTimeout?: Duration;
  /** Probe calls allowed while half-open. Default: 1. */
  halfOpenMax?: number;
  /** Bulkhead: max concurrent in-flight calls. Default: unlimited. */
  maxConcurrent?: number;
  /** Count this error toward the failure tally? Default: every error counts. */
  isFailure?: (err: unknown) => boolean;
  /** Observe state transitions (for logging/metrics). */
  onStateChange?: (state: CircuitState, name?: string) => void;
  /** Label used in errors + the onStateChange callback. */
  name?: string;
  /** Injected clock (tests). Default: Date.now. */
  now?: () => number;
}

/** Thrown when the circuit is open (fail-fast) — the call never ran. */
export class CircuitOpenError extends Error {
  readonly code = "CIRCUIT_OPEN";
  constructor(name?: string) {
    super(`circuit breaker${name ? ` "${name}"` : ""} is open`);
    this.name = "CircuitOpenError";
  }
}

/** Thrown when the bulkhead concurrency limit is saturated. */
export class BulkheadFullError extends Error {
  readonly code = "BULKHEAD_FULL";
  constructor(limit: number, name?: string) {
    super(`bulkhead${name ? ` "${name}"` : ""} is full (max ${limit} concurrent)`);
    this.name = "BulkheadFullError";
  }
}

export class CircuitBreaker {
  #state: CircuitState = "closed";
  #failures = 0;
  #openedAt = 0;
  #halfOpenInFlight = 0;
  #inFlight = 0;

  readonly #threshold: number;
  readonly #resetMs: number;
  readonly #halfOpenMax: number;
  readonly #maxConcurrent: number;
  readonly #isFailure: (err: unknown) => boolean;
  readonly #onStateChange?: (state: CircuitState, name?: string) => void;
  readonly #name?: string;
  readonly #now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.#threshold = Math.max(1, opts.failureThreshold ?? 5);
    this.#resetMs = opts.resetTimeout ? ms(opts.resetTimeout) : 30_000;
    this.#halfOpenMax = Math.max(1, opts.halfOpenMax ?? 1);
    this.#maxConcurrent = opts.maxConcurrent ?? Infinity;
    this.#isFailure = opts.isFailure ?? (() => true);
    this.#onStateChange = opts.onStateChange;
    this.#name = opts.name;
    this.#now = opts.now ?? Date.now;
  }

  get state(): CircuitState {
    // Lazily transition open → half-open once the cooldown has elapsed.
    if (this.#state === "open" && this.#now() - this.#openedAt >= this.#resetMs) {
      this.#transition("half-open");
    }
    return this.#state;
  }

  #transition(to: CircuitState): void {
    if (this.#state === to) return;
    this.#state = to;
    if (to === "closed") this.#failures = 0;
    if (to === "half-open") this.#halfOpenInFlight = 0;
    if (to === "open") this.#openedAt = this.#now();
    this.#onStateChange?.(to, this.#name);
  }

  /** Run `fn` through the breaker. Fails fast (no call) when open/saturated. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state; // evaluates the lazy open → half-open
    if (state === "open") throw new CircuitOpenError(this.#name);
    if (state === "half-open") {
      if (this.#halfOpenInFlight >= this.#halfOpenMax) {
        throw new CircuitOpenError(this.#name);
      }
      this.#halfOpenInFlight++;
    }
    if (this.#inFlight >= this.#maxConcurrent) {
      if (state === "half-open") this.#halfOpenInFlight--;
      throw new BulkheadFullError(this.#maxConcurrent, this.#name);
    }

    this.#inFlight++;
    try {
      const result = await fn();
      this.#onSuccess();
      return result;
    } catch (err) {
      if (this.#isFailure(err)) this.#onFailure();
      else this.#onSuccess(); // a "non-failure" error still clears the probe
      throw err;
    } finally {
      this.#inFlight--;
      if (state === "half-open") this.#halfOpenInFlight--;
    }
  }

  #onSuccess(): void {
    // Any success closes the circuit (a half-open probe succeeded, or we were
    // already closed and just reset the consecutive-failure tally).
    if (this.#state !== "closed") this.#transition("closed");
    this.#failures = 0;
  }

  #onFailure(): void {
    if (this.#state === "half-open") {
      // Probe failed — straight back to open, restart the cooldown.
      this.#transition("open");
      return;
    }
    this.#failures++;
    if (this.#failures >= this.#threshold) this.#transition("open");
  }
}

/** Build a circuit breaker. Wrap any async external call: `cb.run(() => fetch(url))`. */
export function circuitBreaker(opts: CircuitBreakerOptions = {}): CircuitBreaker {
  return new CircuitBreaker(opts);
}
