// Phase 10.2: debounce — collapse rapid same-key pushes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-deb-"));
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

describe("debounce (P10.2)", () => {
  it("collapses a burst to the last push per key", async () => {
    const app = tmpApp();
    const seen: Array<{ id: string; n: number }> = [];
    const q = app.queue<{ id: string; n: number }>("deb", {
      poll: 20,
      debounce: { key: (d) => d.id, window: "150ms" },
    });
    q.process(async (job) => {
      seen.push(job.data);
    });
    await app.start();

    // Rapid burst for "a" → only the last (n=3) should run; "b" independent.
    await q.push({ id: "a", n: 1 });
    await q.push({ id: "a", n: 2 });
    await q.push({ id: "a", n: 3 });
    await q.push({ id: "b", n: 1 });

    const deadline = Date.now() + 4000;
    while (seen.length < 2 && Date.now() < deadline) await wait(25);
    // Give a moment to ensure no extra "a" runs slipped through.
    await wait(150);

    expect(seen.filter((x) => x.id === "a")).toEqual([{ id: "a", n: 3 }]);
    expect(seen.filter((x) => x.id === "b")).toEqual([{ id: "b", n: 1 }]);
    expect(seen.length).toBe(2);
  });
});

describe("throttle (P10.2)", () => {
  it("spaces starts to the configured per-key rate", async () => {
    const app = tmpApp();
    const at: number[] = [];
    const q = app.queue<{ k: string; n: number }>("thr", {
      poll: 20,
      throttle: { key: (d) => d.k, max: 1, per: "120ms" }, // ~1 per 120ms per key
    });
    q.process(async () => {
      at.push(Date.now());
    });
    await app.start();

    await q.push({ k: "x", n: 1 });
    await q.push({ k: "x", n: 2 });
    await q.push({ k: "x", n: 3 });

    const deadline = Date.now() + 5000;
    while (at.length < 3 && Date.now() < deadline) await wait(25);
    expect(at.length).toBe(3); // every job runs (spread, not dropped)
    // ~2 spacings between first and last; tolerate scheduling slack.
    expect(at[at.length - 1] - at[0]).toBeGreaterThanOrEqual(180);
  });
});
