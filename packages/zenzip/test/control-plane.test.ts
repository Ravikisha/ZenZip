// P14.1 bulk cancel-by-filter + P14.2 alerting hooks.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type Alert, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpApp(opts: Parameters<typeof zenzip>[0] = {}): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-cp-"));
  const app = zenzip({ dataDir: dir, handleSignals: false, ...opts });
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

describe("bulk cancel-by-filter (P14.1)", () => {
  it("cancels matching non-terminal runs", async () => {
    const app = tmpApp();
    const wf = app.workflow<{ n: number }>("sleeper", async ({ step }) => {
      await step.sleep("long", "60s");
      return null;
    });
    await app.start();

    const { runId } = await wf.trigger({ n: 1 });
    // Wait until it's actually sleeping (started).
    const deadline = Date.now() + 4000;
    let status = "";
    while (Date.now() < deadline) {
      const run = await wf.getRun(runId);
      status = run?.status ?? "";
      if (status === "sleeping") break;
      await wait(25);
    }
    expect(status).toBe("sleeping");

    const { cancelled, runs } = await app.cancelRuns({ workflow: "sleeper" });
    expect(cancelled).toBeGreaterThanOrEqual(1);
    expect(runs).toContain(runId);
    expect((await wf.getRun(runId))?.status).toBe("cancelled");
  });
});

describe("alerting hooks (P14.2)", () => {
  it("fires a DLQ alert when dead jobs appear", async () => {
    const alerts: Alert[] = [];
    const app = tmpApp({
      alerts: { onAlert: (a) => alerts.push(a), interval: "300ms", dlqThreshold: 1 },
    });
    const q = app.queue<{ x: number }>("doomed", { retries: 0, poll: 20 });
    q.process(async () => {
      throw new Error("always fails");
    });
    await app.start();
    await q.push({ x: 1 });

    const deadline = Date.now() + 5000;
    while (alerts.length === 0 && Date.now() < deadline) await wait(50);

    const dlq = alerts.find((a) => a.type === "dlq");
    expect(dlq).toBeDefined();
    expect(dlq!.queue).toBe("doomed");
    expect(dlq!.count).toBeGreaterThanOrEqual(1);
  });
});
