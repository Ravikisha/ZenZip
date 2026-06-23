// Phase 13.1: app auth middleware.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

async function serve(app: ZenzipApp): Promise<string> {
  await app.start();
  const { port, close } = await app.listen({ port: 0 });
  cleanups.push(async () => close());
  return `http://127.0.0.1:${port}`;
}

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-auth-"));
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

describe("app auth (P13.1)", () => {
  it("guards routes with static tokens (Bearer + x-api-key) and attaches req.user", async () => {
    const app = tmpApp();
    app.use("/admin", zenzip.auth({ tokens: ["secret"] }));
    app.get("/admin/me", (ctx) => ({ user: (ctx.req as { user?: unknown }).user }));
    app.get("/public", () => ({ ok: true }));
    const base = await serve(app);

    expect((await fetch(`${base}/admin/me`)).status).toBe(401); // no token
    expect((await fetch(`${base}/admin/me`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(`${base}/public`)).status).toBe(200); // unguarded

    const viaBearer = await fetch(`${base}/admin/me`, { headers: { authorization: "Bearer secret" } });
    expect(viaBearer.status).toBe(200);
    expect(await viaBearer.json()).toEqual({ user: { token: "secret" } });

    const viaKey = await fetch(`${base}/admin/me`, { headers: { "x-api-key": "secret" } });
    expect(viaKey.status).toBe(200);
  });

  it("supports a custom verify callback (JWT/OIDC seam)", async () => {
    const app = tmpApp();
    app.use(
      "/api",
      zenzip.auth({
        verify: (token) => (token === "good" ? { id: "u1", scope: "read" } : null),
      }),
    );
    app.get("/api/who", (ctx) => (ctx.req as { user?: unknown }).user);
    const base = await serve(app);

    expect((await fetch(`${base}/api/who`, { headers: { authorization: "Bearer bad" } })).status).toBe(401);
    const ok = await fetch(`${base}/api/who`, { headers: { authorization: "Bearer good" } });
    expect(await ok.json()).toEqual({ id: "u1", scope: "read" });
  });
});
