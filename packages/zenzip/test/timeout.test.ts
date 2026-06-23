// Phase 15.1: per-step timeouts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-to-"));
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

describe("step timeout (P15.1)", () => {
  it("fails a step that exceeds its timeout", async () => {
    const app = tmpApp();
    const wf = app.workflow("slow", { stepRetries: 0 }, async ({ step }) => {
      await step.run("nap", () => new Promise((r) => setTimeout(() => r("late"), 400)), {
        timeout: "50ms",
      });
      return "done";
    });
    await app.start();
    await expect(wf.triggerAndWait({}, { timeout: "10s" })).rejects.toThrow(/timed out/);
  });

  it("lets a step finish within its timeout", async () => {
    const app = tmpApp();
    const wf = app.workflow<unknown, string>("fast", async ({ step }) => {
      return step.run("quick", () => "value", { timeout: "1s" });
    });
    await app.start();
    expect(await wf.triggerAndWait({}, { timeout: "10s" })).toBe("value");
  });
});
