// P16.5: typed error envelope + error→HTTP status mapping.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, HttpError, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function serve(build: (app: ZenzipApp) => void): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-err-"));
  const app: ZenzipApp = zenzip({ dataDir: dir, handleSignals: false });
  build(app);
  await app.start();
  const { port, close } = await app.listen({ port: 0 });
  cleanups.push(async () => {
    await close();
    await app.stop({ timeout: "5s" });
    rmSync(dir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${port}`;
}

describe("typed error envelope (P16.5)", () => {
  it("maps a plain throw to 500 with { error, code, status }", async () => {
    const base = await serve((app) =>
      app.get("/boom", () => {
        throw new Error("kaboom");
      }),
    );
    const res = await fetch(`${base}/boom`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ error: "kaboom", code: "Error", status: 500 });
  });

  it("honors HttpError status + code", async () => {
    const base = await serve((app) =>
      app.get("/conflict", () => {
        throw new HttpError(409, "already exists", "CONFLICT");
      }),
    );
    const res = await fetch(`${base}/conflict`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "already exists", code: "CONFLICT", status: 409 });
  });

  it("maps a known framework error name to its status (saturation → 503)", async () => {
    const base = await serve((app) =>
      app.get("/full", () => {
        const e = new Error("queue full");
        e.name = "QueueFullError";
        throw e;
      }),
    );
    const res = await fetch(`${base}/full`);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("QueueFullError");
  });
});
