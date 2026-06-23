// Phase 7.13: effect-level idempotency helper (ctx.idempotencyKey).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-idem-"));
  const app = zenzip({ dataDir: dir, handleSignals: false, schedulerTick: "50ms" });
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

describe("ctx.idempotencyKey (P7.13)", () => {
  it("is deterministic and dedupes a repeated effect within a run", async () => {
    const app = tmpApp();
    const child = app.workflow("child", async () => "ok");
    const parent = app.workflow(
      "parent",
      async ({ idempotencyKey, runId }) => {
        const key = idempotencyKey("order");
        // Simulate a replay re-issuing the same effect: same key → same run.
        const a = await child.trigger({ n: 1 }, { idempotencyKey: key });
        const b = await child.trigger({ n: 1 }, { idempotencyKey: key });
        return { key, runId, a: a.runId, b: b.runId };
      },
    );
    await app.start();

    const out = (await parent.triggerAndWait({})) as {
      key: string;
      runId: string;
      a: string;
      b: string;
    };
    expect(out.key).toBe(`${out.runId}:order`); // derived from runId + label
    expect(out.a).toBe(out.b); // same key deduped to one child run
  });

  it("gives distinct keys for distinct labels", async () => {
    const app = tmpApp();
    const wf = app.workflow("labels", async ({ idempotencyKey }) => ({
      one: idempotencyKey("a"),
      two: idempotencyKey("b"),
    }));
    await app.start();

    const out = (await wf.triggerAndWait({})) as { one: string; two: string };
    expect(out.one).not.toBe(out.two);
    expect(out.one.endsWith(":a")).toBe(true);
    expect(out.two.endsWith(":b")).toBe(true);
  });
});
