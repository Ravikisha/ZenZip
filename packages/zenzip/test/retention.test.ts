// Phase 7.6: retention / GC of aged terminal runs, their steps, and events.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp, type ZenzipOptions } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(retention: ZenzipOptions["retention"]): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-gc-"));
  const app = zenzip({
    dataDir: dir,
    handleSignals: false,
    schedulerTick: "50ms",
    // Long sweep so only the manual app.gc() runs during the test.
    retention: { sweep: "1h", ...retention },
  });
  cleanups.push(async () => {
    await app.stop({ timeout: "5s" });
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  return app;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Trigger a workflow and return its runId once the run is terminal. */
async function runOnce(wf: {
  trigger: (input: unknown) => Promise<{ runId: string }>;
  getRun: (id: string) => Promise<{ status: string } | null>;
}): Promise<string> {
  const { runId } = await wf.trigger({});
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const r = await wf.getRun(runId);
    if (r && ["completed", "failed", "cancelled"].includes(r.status)) return runId;
    await wait(10);
  }
  throw new Error(`run ${runId} did not finish`);
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("retention GC (P7.6)", () => {
  it("deletes aged terminal runs + their steps", async () => {
    const app = tmpApp({ runs: "1ms" });
    const wf = app.workflow("noop", async ({ step }) => {
      await step.run("a", () => 1);
      await step.run("b", () => 2);
      return "done";
    });
    await app.start();

    await runOnce(wf);
    const runId = await runOnce(wf);
    // ensure the completed runs are older than the 1ms window
    await wait(20);

    const stats = app.gc();
    expect(stats.runs).toBeGreaterThanOrEqual(2);
    expect(stats.steps).toBeGreaterThanOrEqual(4); // 2 steps × ≥2 runs
    // the GC'd run is gone
    expect(await wf.getRun(runId)).toBeNull();

    const metrics = app.metrics();
    expect(metrics.runsGc).toBe(stats.runs);
    expect(metrics.stepsGc).toBe(stats.steps);
  });

  it("deletes aged events", async () => {
    const app = tmpApp({ events: "1ms", runs: "off" });
    await app.start();

    app.emit("thing.happened", { n: 1 });
    app.emit("thing.happened", { n: 2 });
    await wait(20);

    const stats = app.gc();
    expect(stats.events).toBeGreaterThanOrEqual(2);
    expect(stats.runs).toBe(0); // runs disabled
    expect(app.metrics().eventsGc).toBe(stats.events);
  });

  it('keeps everything when a window is "off"', async () => {
    const app = tmpApp({ runs: "off", events: "off" });
    const wf = app.workflow("keepme", async () => "ok");
    await app.start();

    const runId = await runOnce(wf);
    await wait(20);

    const stats = app.gc();
    expect(stats.runs).toBe(0);
    expect(stats.events).toBe(0);
    expect(await wf.getRun(runId)).not.toBeNull();
  });

  it("does not delete recent or non-terminal runs", async () => {
    // Generous window: nothing is old enough to collect.
    const app = tmpApp({ runs: "1h", events: "1h" });
    const wf = app.workflow("recent", async () => "ok");
    await app.start();

    const runId = await runOnce(wf);

    const stats = app.gc();
    expect(stats.runs).toBe(0);
    expect(await wf.getRun(runId)).not.toBeNull();
  });
});
