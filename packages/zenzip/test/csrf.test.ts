// P13.3: CSRF — origin-based protection for state-changing requests.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function appWithCsrf(opts?: Parameters<typeof zenzip.csrf>[0]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-csrf-"));
  const app: ZenzipApp = zenzip({ dataDir: dir, handleSignals: false });
  app.use(zenzip.csrf(opts));
  app.get("/r", () => ({ ok: true }));
  app.post("/w", () => ({ ok: true }));
  await app.start();
  const { port, close } = await app.listen({ port: 0 });
  cleanups.push(async () => {
    await close();
    await app.stop({ timeout: "5s" });
    rmSync(dir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${port}`;
}

describe("csrf (P13.3)", () => {
  it("lets safe methods through with no Origin", async () => {
    const base = await appWithCsrf();
    expect((await fetch(`${base}/r`)).status).toBe(200);
  });

  it("rejects a state-changing request with no Origin/Referer", async () => {
    const base = await appWithCsrf();
    const res = await fetch(`${base}/w`, { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("allows same-origin POST and rejects cross-origin (default, no allowlist)", async () => {
    const base = await appWithCsrf();
    const host = new URL(base).host;
    const same = await fetch(`${base}/w`, { method: "POST", headers: { origin: `http://${host}` } });
    expect(same.status).toBe(200);
    const cross = await fetch(`${base}/w`, {
      method: "POST",
      headers: { origin: "http://evil.example" },
    });
    expect(cross.status).toBe(403);
  });

  it("honors an explicit allowlist", async () => {
    const base = await appWithCsrf({ allowedOrigins: ["https://app.example"] });
    const ok = await fetch(`${base}/w`, {
      method: "POST",
      headers: { origin: "https://app.example" },
    });
    expect(ok.status).toBe(200);
    const no = await fetch(`${base}/w`, {
      method: "POST",
      headers: { origin: "https://other.example" },
    });
    expect(no.status).toBe(403);
  });
});
