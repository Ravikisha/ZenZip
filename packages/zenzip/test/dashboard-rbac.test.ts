// Phase 7.17: dashboard RBAC — operator vs read-only viewer tokens.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-rbac-"));
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

describe("dashboard RBAC (P7.17)", () => {
  it("separates read-only viewer from operator", async () => {
    const app = tmpApp();
    await app.start();
    const { port } = await app.dashboard({ port: 0, token: "op", viewerToken: "view" });
    const base = `http://127.0.0.1:${port}`;
    const overview = `${base}/api/overview`;
    const mutate = `${base}/api/queues/work/requeue-dead`;

    // No token → 401 everywhere.
    expect((await fetch(overview)).status).toBe(401);

    // Viewer: can read, cannot mutate.
    expect((await fetch(`${overview}?token=view`)).status).toBe(200);
    const viewerMutate = await fetch(`${mutate}?token=view`, { method: "POST" });
    expect(viewerMutate.status).toBe(403);

    // Operator: can read and mutate.
    expect((await fetch(`${overview}?token=op`)).status).toBe(200);
    const opMutate = await fetch(`${mutate}?token=op`, { method: "POST" });
    expect(opMutate.status).toBe(200);
    expect(await opMutate.json()).toEqual({ requeued: 0 });

    // Bearer header works too.
    const viaHeader = await fetch(overview, { headers: { authorization: "Bearer view" } });
    expect(viaHeader.status).toBe(200);
  });

  it("stays open when no tokens are configured (back-compat)", async () => {
    const app = tmpApp();
    await app.start();
    const { port } = await app.dashboard({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${port}/api/overview`);
    expect(res.status).toBe(200);
  });
});
