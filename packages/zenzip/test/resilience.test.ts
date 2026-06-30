// P15.2: circuit breaker + bulkhead state machine.
import { describe, expect, it } from "vitest";

import {
  BulkheadFullError,
  CircuitOpenError,
  circuitBreaker,
} from "../src/resilience.js";

const ok = () => Promise.resolve("ok");
const boom = () => Promise.reject(new Error("boom"));

describe("circuit breaker (P15.2)", () => {
  it("opens after the failure threshold, then fails fast without calling", async () => {
    const cb = circuitBreaker({ failureThreshold: 3, resetTimeout: "1s", now: () => 0 });
    for (let i = 0; i < 3; i++) await expect(cb.run(boom)).rejects.toThrow("boom");
    expect(cb.state).toBe("open");

    let called = false;
    await expect(
      cb.run(async () => {
        called = true;
        return "x";
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false); // fail fast — the fn never ran
  });

  it("half-opens after the cooldown and closes on a successful probe", async () => {
    let clock = 0;
    const cb = circuitBreaker({ failureThreshold: 1, resetTimeout: "1s", now: () => clock });
    await expect(cb.run(boom)).rejects.toThrow();
    expect(cb.state).toBe("open");

    clock = 1000; // cooldown elapsed
    expect(cb.state).toBe("half-open");
    await expect(cb.run(ok)).resolves.toBe("ok");
    expect(cb.state).toBe("closed");
  });

  it("a failed probe re-opens and restarts the cooldown", async () => {
    let clock = 0;
    const cb = circuitBreaker({ failureThreshold: 1, resetTimeout: "1s", now: () => clock });
    await expect(cb.run(boom)).rejects.toThrow(); // open
    clock = 1000; // half-open
    await expect(cb.run(boom)).rejects.toThrow("boom"); // probe fails
    expect(cb.state).toBe("open"); // back to open
    // Still within the fresh cooldown → fail fast.
    clock = 1500;
    await expect(cb.run(ok)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("a success resets the consecutive-failure tally", async () => {
    const cb = circuitBreaker({ failureThreshold: 3, now: () => 0 });
    await expect(cb.run(boom)).rejects.toThrow();
    await expect(cb.run(boom)).rejects.toThrow();
    await expect(cb.run(ok)).resolves.toBe("ok"); // resets
    await expect(cb.run(boom)).rejects.toThrow();
    await expect(cb.run(boom)).rejects.toThrow();
    expect(cb.state).toBe("closed"); // 2 < threshold after the reset
  });

  it("isFailure can exclude expected errors from tripping the circuit", async () => {
    const notFound = Object.assign(new Error("404"), { status: 404 });
    const cb = circuitBreaker({
      failureThreshold: 2,
      isFailure: (e) => (e as { status?: number }).status !== 404,
      now: () => 0,
    });
    await expect(cb.run(() => Promise.reject(notFound))).rejects.toThrow("404");
    await expect(cb.run(() => Promise.reject(notFound))).rejects.toThrow("404");
    expect(cb.state).toBe("closed"); // 404s didn't count
  });

  it("bulkhead rejects calls past the concurrency limit", async () => {
    const cb = circuitBreaker({ maxConcurrent: 1, now: () => 0 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inflight = cb.run(() => gate.then(() => "done"));
    await expect(cb.run(ok)).rejects.toBeInstanceOf(BulkheadFullError); // slot taken
    release();
    await expect(inflight).resolves.toBe("done");
    await expect(cb.run(ok)).resolves.toBe("ok"); // slot freed
  });
});
