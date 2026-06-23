// Phase 7.8: backpressure / admission control via maxPending.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { QueueFullError, zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-bp-"));
  const app = zenzip({ dataDir: dir, handleSignals: false });
  cleanups.push(async () => {
    try {
      await app.stop({ timeout: "5s" });
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  return app;
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("backpressure (P7.8)", () => {
  it("rejects push once maxPending is reached", async () => {
    const app = tmpApp();
    const q = app.queue<{ n: number }>("bounded", { maxPending: 2 }); // producer-only
    await app.start();

    await q.push({ n: 1 });
    await q.push({ n: 2 });
    await expect(q.push({ n: 3 })).rejects.toBeInstanceOf(QueueFullError);
    expect(await q.pendingCount()).toBe(2);
  });

  it("rejects a bulk push that would overflow, atomically", async () => {
    const app = tmpApp();
    const q = app.queue<number>("bulk", { maxPending: 5 });
    await app.start();

    await expect(q.pushBulk([1, 2, 3, 4, 5, 6])).rejects.toBeInstanceOf(QueueFullError);
    expect(await q.pendingCount()).toBe(0); // nothing enqueued
    await q.pushBulk([1, 2, 3, 4, 5]); // exactly at the bound is allowed
    expect(await q.pendingCount()).toBe(5);
  });

  it("is unbounded by default", async () => {
    const app = tmpApp();
    const q = app.queue<number>("free");
    await app.start();
    for (let i = 0; i < 20; i++) await q.push(i);
    expect(await q.pendingCount()).toBe(20);
  });
});
