// Phase 13.6: audit log of privileged actions.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type AuditEntry, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(onAudit: (e: AuditEntry) => void): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-audit-"));
  const app = zenzip({ dataDir: dir, handleSignals: false, schedulerTick: "30ms", onAudit });
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

describe("audit log (P13.6)", () => {
  it("records privileged actions to the sink", async () => {
    const entries: AuditEntry[] = [];
    const app = tmpApp((e) => entries.push(e));
    const wf = app.workflow("noop", async () => "ok");
    await app.start();

    const { runId } = await wf.trigger({});
    await wf.cancel(runId);

    const actions = entries.map((e) => e.action);
    expect(actions).toContain("workflow.trigger");
    expect(actions).toContain("workflow.cancel");

    const trig = entries.find((e) => e.action === "workflow.trigger")!;
    expect(trig.target).toBe("noop");
    expect(trig.detail).toMatchObject({ runId });
    expect(typeof trig.at).toBe("number");
  });

  it("never lets a throwing sink break the action", async () => {
    const app = tmpApp(() => {
      throw new Error("sink boom");
    });
    const wf = app.workflow("noop2", async () => "ok");
    await app.start();
    // trigger must still succeed despite the throwing audit sink
    const { runId } = await wf.trigger({});
    expect(typeof runId).toBe("string");
  });
});
