// Phase 13.3 / 13.4: security headers + HTTP rate limiting.
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
  const dir = mkdtempSync(join(tmpdir(), "zenzip-secmw-"));
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

describe("secureHeaders (P13.3)", () => {
  it("sets a sensible default header set", async () => {
    const app = tmpApp();
    app.use(zenzip.secureHeaders());
    app.get("/x", () => ({ ok: true }));
    const base = await serve(app);

    const res = await fetch(`${base}/x`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("content-security-policy")).toBeNull(); // opt-in
  });

  it("honors a CSP + custom options", async () => {
    const app = tmpApp();
    app.use(zenzip.secureHeaders({ contentSecurityPolicy: "default-src 'self'", frameOptions: "SAMEORIGIN" }));
    app.get("/x", () => ({ ok: true }));
    const base = await serve(app);
    const res = await fetch(`${base}/x`);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });
});

describe("rateLimit (P13.4)", () => {
  it("429s past the limit and exposes X-RateLimit headers", async () => {
    const app = tmpApp();
    app.use(zenzip.rateLimit({ max: 3, window: "10s" }));
    app.get("/x", () => ({ ok: true }));
    const base = await serve(app);

    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/x`)).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);

    const blocked = await fetch(`${base}/x`);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("x-ratelimit-limit")).toBe("3");
    expect(blocked.headers.get("retry-after")).not.toBeNull();
  });

  it("buckets by a custom key", async () => {
    const app = tmpApp();
    app.use(zenzip.rateLimit({ max: 1, window: "10s", key: (req) => req.get("x-tenant") ?? "anon" }));
    app.get("/x", () => ({ ok: true }));
    const base = await serve(app);

    expect((await fetch(`${base}/x`, { headers: { "x-tenant": "a" } })).status).toBe(200);
    expect((await fetch(`${base}/x`, { headers: { "x-tenant": "a" } })).status).toBe(429);
    // different tenant → own bucket
    expect((await fetch(`${base}/x`, { headers: { "x-tenant": "b" } })).status).toBe(200);
  });
});
