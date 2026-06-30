// P14.6: PII purge — erase a data subject's runs + steps.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("PII purge by subject (P14.6)", () => {
  it("erases a subject's runs and leaves others", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zenzip-pii-"));
    const app: ZenzipApp = zenzip({ dataDir: dir, handleSignals: false });
    const wf = app.workflow<{ name: string }>("greet", async ({ step, input }) => {
      return step.run("hello", () => `hi ${input.name}`);
    });
    await app.start();

    // Two runs for user-1, one for user-2.
    const a = await wf.triggerAndWait({ name: "a" }, { subject: "user-1", timeout: "5s" });
    const r1 = await wf.trigger({ name: "b" }, { subject: "user-1" });
    const r2 = await wf.trigger({ name: "c" }, { subject: "user-2" });
    expect(a).toBe("hi a");
    // let the fire-and-forget runs land
    await new Promise((r) => setTimeout(r, 200));

    const purged = await app.purgeSubject("user-1");
    expect(purged).toBeGreaterThanOrEqual(2);

    expect(await wf.getRun(r1.runId)).toBeNull(); // user-1 erased
    expect(await wf.getRun(r2.runId)).not.toBeNull(); // user-2 untouched

    await app.stop({ timeout: "5s" });
    rmSync(dir, { recursive: true, force: true });
  });
});
