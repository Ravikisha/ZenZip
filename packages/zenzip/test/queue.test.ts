import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): { app: ZenzipApp; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-test-"));
  const app = zenzip({
    dataDir: dir,
    handleSignals: false,
    sweep: "500ms",
    schedulerTick: "50ms",
  });
  cleanups.push(async () => {
    await app.stop({ timeout: "5s" });
    // Best effort: on Windows the store may briefly hold the db file.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp dir, OS cleans up */
    }
  });
  return { app, dir };
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("queue", () => {
  it("processes pushed jobs", async () => {
    const { app } = tmpApp();
    const seen: number[] = [];
    const q = app.queue<{ n: number }>("jobs", { poll: 20 });
    q.process(async (job) => {
      seen.push(job.data.n);
    });
    await app.start();

    await q.pushBulk([{ n: 1 }, { n: 2 }, { n: 3 }]);
    await q.push({ n: 4 });

    await waitFor(() => seen.length === 4);
    expect(seen.sort()).toEqual([1, 2, 3, 4]);
    expect(await q.activeCount()).toBe(0);
  });

  it("retries failures with attempt numbers, then succeeds", async () => {
    const { app } = tmpApp();
    const attempts: number[] = [];
    const q = app.queue("flaky", {
      poll: 20,
      retries: 3,
      backoff: { delay: 10, maxDelay: 20 },
    });
    q.process(async (job) => {
      attempts.push(job.attempt);
      if (job.attempt < 3) throw new Error(`fail attempt ${job.attempt}`);
    });
    await app.start();
    await q.push({});

    await waitFor(() => attempts.length === 3);
    expect(attempts).toEqual([1, 2, 3]);
    expect(await q.deadJobs()).toEqual([]);
  });

  it("dead-letters exhausted jobs and requeues them", async () => {
    const { app } = tmpApp();
    let failing = true;
    let processed = 0;
    const q = app.queue<{ id: string }>("doomed", {
      poll: 20,
      retries: 1,
      backoff: { delay: 10, maxDelay: 10 },
    });
    q.process(async () => {
      if (failing) throw new Error("permanent-ish failure");
      processed++;
    });
    await app.start();
    await q.push({ id: "x" });

    let dead: Awaited<ReturnType<typeof q.deadJobs>> = [];
    const deadline = Date.now() + 5_000;
    while (dead.length === 0) {
      if (Date.now() > deadline) throw new Error("job never dead-lettered");
      await new Promise((r) => setTimeout(r, 25));
      dead = await q.deadJobs();
    }
    expect(dead[0].lastError).toContain("permanent-ish failure");
    expect(dead[0].attempt).toBe(2); // retries:1 -> 2 attempts
    expect(dead[0].data).toEqual({ id: "x" });

    failing = false;
    const n = await q.requeueDead();
    expect(n).toBe(1);
    await waitFor(() => processed === 1);
    expect(await q.deadJobs()).toEqual([]);
  });

  it("respects push delay", async () => {
    const { app } = tmpApp();
    const seen: number[] = [];
    const q = app.queue("later", { poll: 20 });
    q.process(async () => {
      seen.push(Date.now());
    });
    await app.start();

    const pushedAt = Date.now();
    await q.push({}, { delay: 300 });
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toHaveLength(0);
    await waitFor(() => seen.length === 1, 3_000);
    expect(seen[0] - pushedAt).toBeGreaterThanOrEqual(280);
  });

  it("drains in-flight jobs on graceful stop", async () => {
    const { app } = tmpApp();
    let finished = 0;
    const q = app.queue("slow", { poll: 20 });
    q.process(async () => {
      await new Promise((r) => setTimeout(r, 300));
      finished++;
    });
    await app.start();
    await q.push({});
    // Give the dispatcher a moment to claim the job.
    await new Promise((r) => setTimeout(r, 150));

    const clean = await app.stop({ timeout: "5s" });
    expect(clean).toBe(true);
    expect(finished).toBe(1);
  });

  it("rejects push before start", async () => {
    const { app } = tmpApp();
    const q = app.queue("early", {});
    await expect(q.push({})).rejects.toThrow(/not started/);
  });

  it("validates payloads with a standard schema on push", async () => {
    const { app } = tmpApp();
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => {
          if (typeof value === "object" && value !== null && "ok" in value) {
            return { value: value as { ok: boolean } };
          }
          return { issues: [{ message: "missing 'ok' field" }] };
        },
      },
    };
    const q = app.queue("typed", { schema, poll: 20 });
    q.process(async () => {});
    await app.start();

    await expect(q.push({ bad: true } as any)).rejects.toThrow(/missing 'ok' field/);
    await expect(q.push({ ok: true })).resolves.toBeTruthy();
  });
});

describe("batch + rate limit", () => {
  it("delivers jobs in batches via processBatch", async () => {
    const { app } = tmpApp();
    const batches: number[][] = [];
    const q = app.queue<{ n: number }>("batched", { poll: 20, concurrency: 2 });
    q.processBatch(
      async (jobs) => {
        batches.push(jobs.map((j) => j.data.n));
      },
      { size: 3 },
    );
    await app.start();
    await q.pushBulk(Array.from({ length: 7 }, (_, n) => ({ n })));

    await waitFor(() => batches.flat().length === 7);
    expect(batches.every((b) => b.length <= 3)).toBe(true);
    expect(batches.some((b) => b.length === 3)).toBe(true);
    expect(batches.flat().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("retries the whole batch on failure", async () => {
    const { app } = tmpApp();
    let failedOnce = false;
    const attempts: number[][] = [];
    const q = app.queue("batch-retry", {
      poll: 20,
      retries: 2,
      backoff: { delay: 10, maxDelay: 20 },
    });
    q.processBatch(
      async (jobs) => {
        attempts.push(jobs.map((j) => j.attempt));
        if (!failedOnce) {
          failedOnce = true;
          throw new Error("batch failure");
        }
      },
      { size: 2 },
    );
    await app.start();
    await q.pushBulk([{ a: 1 }, { a: 2 }]);

    await waitFor(() => attempts.flat().length >= 4);
    expect(attempts[0]).toEqual([1, 1]); // first delivery, both fail together
    await waitFor(() => attempts.flat().filter((a) => a === 2).length === 2);
    expect(await q.deadJobs()).toEqual([]);
  });

  it("rejects double processors and bad batch sizes", async () => {
    const { app } = tmpApp();
    const q = app.queue("strict", {});
    q.process(async () => {});
    expect(() => q.processBatch(async () => {}, { size: 5 })).toThrow(/already has/);
    const q2 = app.queue("strict2", {});
    expect(() => q2.processBatch(async () => {}, { size: 0 })).toThrow(/positive integer/);
  });

  it("rate limits job starts", async () => {
    const { app } = tmpApp();
    let processed = 0;
    const q = app.queue("limited", {
      poll: 10,
      rateLimit: { max: 2, per: "400ms" },
    });
    q.process(async () => {
      processed++;
    });
    await app.start();
    await q.pushBulk(Array.from({ length: 8 }, (_, n) => ({ n })));

    // Burst of 2, then ~1 per 200ms refill: at 250ms expect <= 4.
    await new Promise((r) => setTimeout(r, 250));
    expect(processed).toBeLessThanOrEqual(4);
    expect(processed).toBeGreaterThanOrEqual(1);

    await waitFor(() => processed === 8, 10_000);
  });
});

describe("logging", () => {
  it("delivers runtime logs to the JS logger sink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zenzip-test-"));
    const events: Array<{ level: string; target: string; message: string }> = [];
    const app = zenzip({
      dataDir: dir,
      handleSignals: false,
      logLevel: "info",
      logger: (e) => events.push(e),
    });
    cleanups.push(async () => {
      await app.stop({ timeout: "5s" });
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });
    app.queue("logged", { poll: 20 }).process(async () => {});
    await app.start();

    await waitFor(() => events.some((e) => e.message.includes("runtime started")));
    const started = events.find((e) => e.message.includes("runtime started"))!;
    expect(started.level).toBe("INFO");
    expect(started.target).toContain("zenzip_core");
  });
});

describe("schedule", () => {
  it("fires interval schedules repeatedly", async () => {
    const { app } = tmpApp();
    const ticks: number[] = [];
    app.schedule("pulse", { every: 200 }, (tick) => {
      ticks.push(tick.firedAt);
      expect(tick.schedule).toBe("pulse");
    });
    await app.start();

    await waitFor(() => ticks.length >= 2, 5_000);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts cron specs with options", async () => {
    const { app } = tmpApp();
    // Won't fire during the test — registration/parse path only.
    app.schedule(
      "daily",
      { cron: "0 9 * * *", timezone: "Asia/Kolkata", overlap: "queue" },
      () => {},
    );
    await app.start();
    expect(app.started).toBe(true);
  });

  it("rejects invalid cron expressions at start", async () => {
    const { app } = tmpApp();
    app.schedule("broken", "not a cron", () => {});
    await expect(app.start()).rejects.toThrow(/invalid cron/);
  });
});
