// Phase 14.1 (slice): bulk DLQ purge.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-purge-"));
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("queue.purgeDead (P14.1)", () => {
  it("deletes all dead-lettered jobs", async () => {
    const app = tmpApp();
    const q = app.queue<number>("work", { poll: 20, retries: 0, backoff: { delay: 5, maxDelay: 5 } });
    q.process(async () => {
      throw new Error("always fails");
    });
    await app.start();
    await q.push(1);
    await q.push(2);

    const deadline = Date.now() + 5000;
    while ((await q.deadJobs()).length < 2 && Date.now() < deadline) await wait(25);
    expect((await q.deadJobs()).length).toBe(2);

    const purged = await q.purgeDead();
    expect(purged).toBe(2);
    expect((await q.deadJobs()).length).toBe(0);
  });
});
