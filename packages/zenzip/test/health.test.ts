// Phase 7.7: liveness / readiness probes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-health-"));
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

describe("health probes (P7.7)", () => {
  it("app.health() reflects lifecycle", async () => {
    const app = tmpApp();
    expect(app.health()).toEqual({ alive: false, ready: false }); // before start
    await app.start();
    expect(app.health()).toEqual({ alive: true, ready: true });
    await app.stop();
    expect(app.health()).toEqual({ alive: false, ready: false }); // after stop
  });

  it("serves /healthz (liveness) and /readyz (readiness)", async () => {
    const app = tmpApp();
    await app.start();
    const { port, close } = await app.listen({ port: 0 });
    cleanups.push(async () => close());
    const base = `http://127.0.0.1:${port}`;

    const live = await fetch(`${base}/healthz`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "alive" });

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });
  });

  it("lets a user-defined route override the probe", async () => {
    const app = tmpApp();
    app.get("/healthz", () => ({ status: "custom" }));
    await app.start();
    const { port, close } = await app.listen({ port: 0 });
    cleanups.push(async () => close());

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(await res.json()).toEqual({ status: "custom" });
  });
});

describe("orphaned runs (P7.10)", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("surfaces non-terminal runs idle past the threshold", async () => {
    const app = tmpApp();
    const napping = app.workflow("napping", async ({ step }) => {
      await step.sleep("nap", "1h"); // parks the run in SLEEPING
    });
    const quick = app.workflow("quick", async () => "ok");
    await app.start();

    const { runId } = await napping.trigger({});
    await quick.triggerAndWait({}); // a terminal run — must not be flagged

    // Fresh runs are not orphaned under the default window.
    expect(await app.orphanedRuns()).toEqual([]);

    // With a tiny idle window, the sleeping run qualifies (terminal one doesn't).
    await wait(20);
    const orphans = await app.orphanedRuns({ idle: "1ms" });
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ runId, workflow: "napping", status: "sleeping" });
    expect(orphans[0].idleMs).toBeGreaterThan(0);
  });
});
