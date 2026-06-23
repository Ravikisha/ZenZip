// Phase 14.1 (slice): queue pause / resume.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-pause-"));
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

describe("queue pause/resume (P14.1)", () => {
  it("stops claiming while paused, resumes on resume()", async () => {
    const app = tmpApp();
    const seen: number[] = [];
    const q = app.queue<number>("work", { poll: 20 });
    q.process(async (job) => {
      seen.push(job.data);
    });
    await app.start();

    q.pause();
    expect(q.isPaused()).toBe(true);
    await q.push(1);
    await q.push(2);
    await wait(200);
    expect(seen).toEqual([]); // nothing claimed while paused

    q.resume();
    expect(q.isPaused()).toBe(false);
    const deadline = Date.now() + 3000;
    while (seen.length < 2 && Date.now() < deadline) await wait(25);
    expect(seen.sort()).toEqual([1, 2]);
  });
});
