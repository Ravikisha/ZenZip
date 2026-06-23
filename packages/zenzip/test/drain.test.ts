// Phase 15.3: graceful HTTP drain on stop.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-drain-"));
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("graceful HTTP drain (P15.3)", () => {
  it("lets an in-flight request finish while stopping", async () => {
    const app = tmpApp();
    app.get("/slow", async () => {
      await wait(200);
      return { ok: true };
    });
    await app.start();
    const { port } = await app.listen({ port: 0 });
    const base = `http://127.0.0.1:${port}`;

    const inflight = fetch(`${base}/slow`); // start before stop
    await wait(40); // ensure it's mid-handler
    const stopping = app.stop({ httpDrain: "3s" }); // drain, don't kill

    const res = await inflight;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true }); // completed, not severed
    await stopping;
  });
});
