// Phase 9.1: large LLM payload offloading to a blob store.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp, type ZenzipOptions } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(payloads?: ZenzipOptions["payloads"]): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-pay-"));
  const app = zenzip({ dataDir: dir, handleSignals: false, schedulerTick: "30ms", payloads });
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

async function waitTerminal(wf: { getRun: (id: string) => Promise<{ status: string } | null> }, runId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const r = await wf.getRun(runId);
    if (r && ["completed", "failed", "cancelled"].includes(r.status)) return r;
    await wait(15);
  }
  throw new Error("run did not finish");
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const BIG = "x".repeat(5000);

describe("payload offloading (P9.1)", () => {
  it("offloads a large step result and rehydrates it on replay", async () => {
    const app = tmpApp({ threshold: 1000 });
    const wf = app.workflow<unknown, number>("big", async ({ step }) => {
      const a = await step.run("a", () => BIG); // 5000 bytes > 1000 → offloaded
      await step.sleep("nap", "30ms"); // suspend → attempt 2 replays from journal
      const b = await step.run("b", () => a.length); // reads rehydrated `a`
      return b;
    });
    await app.start();

    const { runId } = await wf.trigger({});
    await waitTerminal(wf, runId);

    // Rehydration worked across the replay: b saw the full 5000-char value.
    const run = await wf.getRun(runId);
    expect(run?.output).toBe(5000);

    // The journal stored a blob reference for `a`, not the raw payload.
    const steps = JSON.parse(await app._native.dashboardRunSteps(runId)) as Array<{
      stepId: string;
      result: string | null;
    }>;
    const a = steps.find((s) => s.stepId === "a")!;
    const b = steps.find((s) => s.stepId === "b")!;
    expect(a.result).toContain("$zenzipBlob");
    expect(a.result!.length).toBeLessThan(200); // a tiny reference, not 5000 bytes
    expect(b.result).toBe("5000"); // small result left inline
  });

  it("stores small results inline when offloading is enabled", async () => {
    const app = tmpApp({ threshold: 1000 });
    const wf = app.workflow("small", async ({ step }) => step.run("s", () => "hi"));
    await app.start();

    const { runId } = await wf.trigger({});
    await waitTerminal(wf, runId);
    const steps = JSON.parse(await app._native.dashboardRunSteps(runId)) as Array<{
      stepId: string;
      result: string | null;
    }>;
    expect(steps.find((s) => s.stepId === "s")!.result).toBe('"hi"');
  });

  it("keeps large results inline when offloading is disabled (default)", async () => {
    const app = tmpApp(); // no payloads config
    const wf = app.workflow("inline", async ({ step }) => step.run("a", () => BIG));
    await app.start();

    const { runId } = await wf.trigger({});
    await waitTerminal(wf, runId);
    const steps = JSON.parse(await app._native.dashboardRunSteps(runId)) as Array<{
      stepId: string;
      result: string | null;
    }>;
    expect(steps.find((s) => s.stepId === "a")!.result).not.toContain("$zenzipBlob");
  });
});
