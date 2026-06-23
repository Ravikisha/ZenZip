// Phase 13.2: request validation middleware.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type StandardSchemaV1, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

async function serve(app: ZenzipApp): Promise<string> {
  await app.start();
  const { port, close } = await app.listen({ port: 0 });
  cleanups.push(async () => close());
  return `http://127.0.0.1:${port}`;
}

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-val-"));
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

// Minimal Standard Schema: requires { name: string }, trims it.
const nameSchema: StandardSchemaV1<{ name: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (v: unknown) => {
      const o = v as { name?: unknown };
      if (o && typeof o.name === "string" && o.name.trim().length > 0) {
        return { value: { name: o.name.trim() } };
      }
      return { issues: [{ message: "name is required" }] };
    },
  },
};

describe("request validation (P13.2)", () => {
  it("rejects invalid body with 400 + issues, passes + parses valid", async () => {
    const app = tmpApp();
    app.use("/users", zenzip.validate({ body: nameSchema }));
    app.post("/users", (ctx) => ({ created: ctx.body }));
    const base = await serve(app);

    const bad = await fetch(`${base}/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "validation failed", part: "body" });

    const ok = await fetch(`${base}/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "  Ada  " }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ created: { name: "Ada" } }); // trimmed by schema
  });

  it("validates query too", async () => {
    const app = tmpApp();
    const qSchema: StandardSchemaV1<{ q: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (v: unknown) =>
          (v as { q?: unknown }).q ? { value: v as { q: string } } : { issues: [{ message: "q required" }] },
      },
    };
    app.use("/search", zenzip.validate({ query: qSchema }));
    app.get("/search", (ctx) => ({ ok: true }));
    const base = await serve(app);

    expect((await fetch(`${base}/search`)).status).toBe(400);
    expect((await fetch(`${base}/search?q=hi`)).status).toBe(200);
  });
});
