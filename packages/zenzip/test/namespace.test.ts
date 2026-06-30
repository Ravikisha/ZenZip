// P14.5: namespaces / multi-tenancy — prefixed names + isolated events.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-ns-"));
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

describe("namespaces (P14.5)", () => {
  it("prefixes queue names with the namespace", () => {
    const app = tmpApp();
    const t1 = app.namespace("tenant1");
    const q = t1.queue("emails");
    expect(q.name).toBe("tenant1:emails");
    expect(t1.key("x")).toBe("tenant1:x");
  });

  it("isolates events between namespaces", async () => {
    const app = tmpApp();
    const t1 = app.namespace("t1");
    const t2 = app.namespace("t2");
    const t1seen: unknown[] = [];
    const t2seen: unknown[] = [];
    t1.on("order.*", (e) => t1seen.push(e));
    t2.on("order.*", (e) => t2seen.push(e));
    await app.start();

    t1.emit("order.created", { id: 1 });
    await wait(50);

    expect(t1seen.length).toBe(1);
    expect(t2seen.length).toBe(0); // t2's subscriber never fires on t1's event
  });
});
