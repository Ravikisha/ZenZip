// Phase 10.6: safe workflow versioning — version routing.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";
import { hashDefinition } from "../src/workflow.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-ver-"));
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

describe("version routing (P10.6)", () => {
  it("routes a run's pinned version to the matching implementation", async () => {
    const app = tmpApp();
    const oldFn = () => "old-logic";
    const wf = app.workflow("evolve", () => "new-logic");
    wf.version(oldFn);

    const oldHash = hashDefinition(oldFn.toString());

    // A run pinned to the old hash routes to the old fn.
    const routedOld = wf._route(oldHash);
    expect(routedOld.version).toBe(oldHash);
    expect(await routedOld.fn({} as never)).toBe("old-logic");

    // Unknown / current pins route to the current fn + version.
    const routedNew = wf._route("does-not-exist");
    expect(routedNew.version).toBe(wf._version);
    expect(await routedNew.fn({} as never)).toBe("new-logic");

    // No pin → current.
    expect((await wf._route(undefined).fn({} as never))).toBe("new-logic");
  });
});
