// Phase 10.1: per-key concurrency.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-conc-"));
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

describe("per-key concurrency (P10.1)", () => {
  it("caps in-flight jobs per key while running keys in parallel", async () => {
    const app = tmpApp();
    const live = new Map<string, number>();
    const peak = new Map<string, number>();
    let done = 0;

    const q = app.queue<{ user: string; n: number }>("work", {
      poll: 20,
      concurrency: { limit: 1, key: (d) => d.user },
    });
    q.process(async (job) => {
      const u = job.data.user;
      const cur = (live.get(u) ?? 0) + 1;
      live.set(u, cur);
      peak.set(u, Math.max(peak.get(u) ?? 0, cur));
      await wait(80);
      live.set(u, cur - 1);
      done++;
    });
    await app.start();

    // Two jobs for "a", two for "b": without the per-key cap, "a" (and "b")
    // would run 2-at-once under the default global concurrency of 10.
    await q.push({ user: "a", n: 1 });
    await q.push({ user: "a", n: 2 });
    await q.push({ user: "b", n: 1 });
    await q.push({ user: "b", n: 2 });

    const deadline = Date.now() + 8000;
    while (done < 4 && Date.now() < deadline) await wait(25);
    expect(done).toBe(4);

    // Never more than 1 concurrent per key.
    expect(peak.get("a")).toBe(1);
    expect(peak.get("b")).toBe(1);
  });

  it("still honors a plain numeric global concurrency", async () => {
    const app = tmpApp();
    let peak = 0;
    let live = 0;
    let done = 0;
    const q = app.queue<number>("g", { poll: 20, concurrency: 2 });
    q.process(async () => {
      live++;
      peak = Math.max(peak, live);
      await wait(60);
      live--;
      done++;
    });
    await app.start();
    for (let i = 0; i < 6; i++) await q.push(i);

    const deadline = Date.now() + 8000;
    while (done < 6 && Date.now() < deadline) await wait(25);
    expect(done).toBe(6);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1); // actually ran in parallel
  });
});
