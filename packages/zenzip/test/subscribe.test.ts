// Phase 9.4: realtime run subscription (app.subscribe).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type RunUpdate, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-sub-"));
  const app = zenzip({ dataDir: dir, handleSignals: false, schedulerTick: "30ms" });
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

describe("app.subscribe (P9.4)", () => {
  it("streams run status + step events to a terminal state", async () => {
    const app = tmpApp();
    const wf = app.workflow("sub", async ({ step }) => {
      await step.run("a", () => 1);
      await step.sleep("nap", "80ms");
      await step.run("b", () => 2);
      return "done";
    });
    await app.start();

    const { runId } = await wf.trigger({});
    const updates: RunUpdate[] = [];
    for await (const u of app.subscribe<string>(runId, { interval: 25, timeout: 10_000 })) {
      updates.push(u);
    }

    expect(updates.length).toBeGreaterThan(0);
    const last = updates[updates.length - 1];
    expect(last.terminal).toBe(true);
    expect(last.status).toBe("completed");
    expect(last.output).toBe("done");
    expect(last.steps.map((s) => s.stepId).sort()).toEqual(["a", "b", "nap"]);
    // We observed it before it finished (sleeping shows up).
    expect(updates.some((u) => !u.terminal)).toBe(true);
  });

  it("throws for an unknown run", async () => {
    const app = tmpApp();
    await app.start();
    const iter = app.subscribe("does-not-exist");
    await expect(iter.next()).rejects.toThrow(/not found/);
  });
});
