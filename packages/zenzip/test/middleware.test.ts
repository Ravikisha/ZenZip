// Phase 8.1: Express-style middleware chain + req/res augmentation.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Router, zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-mw-"));
  const app = zenzip({ dataDir: dir, handleSignals: false, sweep: "200ms" });
  cleanups.push(async () => {
    await app.stop({ timeout: "5s" });
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  return app;
}

/** start + listen on an ephemeral port, return base URL. */
async function serve(app: ZenzipApp): Promise<string> {
  await app.start();
  const { port, close } = await app.listen({ port: 0 });
  cleanups.push(async () => close());
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("app.use() middleware", () => {
  it("runs global middleware in order before the route, mutating req", async () => {
    const app = tmpApp();
    const order: string[] = [];
    app.use((req, _res, next) => {
      order.push("a");
      (req as { tag?: string }).tag = "tagged";
      next();
    });
    app.use((_req, _res, next) => {
      order.push("b");
      next();
    });
    app.get("/x", (ctx) => {
      order.push("handler");
      return { tag: (ctx.req as { tag?: string }).tag };
    });
    const base = await serve(app);

    const res = await fetch(`${base}/x`);
    expect(await res.json()).toEqual({ tag: "tagged" });
    expect(order).toEqual(["a", "b", "handler"]);
  });

  it("scopes path middleware to its mount point", async () => {
    const app = tmpApp();
    let hits = 0;
    app.use("/api", (_req, _res, next) => {
      hits++;
      next();
    });
    app.get("/api/users", () => ({ ok: true }));
    app.get("/public", () => ({ ok: true }));
    const base = await serve(app);

    await fetch(`${base}/public`);
    expect(hits).toBe(0);
    await fetch(`${base}/api/users`);
    expect(hits).toBe(1);
    // exact mount path also matches
    app; // no-op
  });

  it("short-circuits when middleware responds without calling next", async () => {
    const app = tmpApp();
    let handlerRan = false;
    app.use((_req, res, next) => {
      const token = (_req as { headers: Record<string, string> }).headers[
        "x-token"
      ];
      if (token !== "secret") {
        res.status(401).json({ error: "unauthorized" });
        return; // no next() — chain stops
      }
      next();
    });
    app.get("/secure", () => {
      handlerRan = true;
      return { ok: true };
    });
    const base = await serve(app);

    const denied = await fetch(`${base}/secure`);
    expect(denied.status).toBe(401);
    expect(handlerRan).toBe(false);

    const ok = await fetch(`${base}/secure`, { headers: { "x-token": "secret" } });
    expect(ok.status).toBe(200);
    expect(handlerRan).toBe(true);
  });

  it("routes next(err) to 4-arg error middleware", async () => {
    const app = tmpApp();
    app.use((_req, _res, next) => next(new Error("boom")));
    app.get("/never", () => ({ ok: true }));
    app.use((err: unknown, _req, res, _next) => {
      res.status(503).json({ handled: (err as Error).message });
    });
    const base = await serve(app);

    const res = await fetch(`${base}/never`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ handled: "boom" });
  });

  it("catches thrown/rejected errors from middleware and route handlers", async () => {
    const app = tmpApp();
    app.use("/throw", () => {
      throw new Error("sync throw");
    });
    app.use("/reject", async () => {
      throw new Error("async reject");
    });
    app.get("/throw", () => ({ ok: true }));
    app.get("/reject", () => ({ ok: true }));
    app.get("/handler-throws", () => {
      throw new Error("from handler");
    });
    app.use((err: unknown, _req, res, _next) => {
      res.status(500).json({ msg: (err as Error).message });
    });
    const base = await serve(app);

    expect(await (await fetch(`${base}/throw`)).json()).toEqual({ msg: "sync throw" });
    expect(await (await fetch(`${base}/reject`)).json()).toEqual({
      msg: "async reject",
    });
    expect(await (await fetch(`${base}/handler-throws`)).json()).toEqual({
      msg: "from handler",
    });
  });

  it("falls back to a 500 when no error middleware is registered", async () => {
    const app = tmpApp();
    app.use((_req, _res, next) => next(new Error("unhandled")));
    app.get("/x", () => ({ ok: true }));
    const base = await serve(app);

    const res = await fetch(`${base}/x`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "unhandled" });
  });

  it("rejects use() after start and with no function", async () => {
    const app = tmpApp();
    expect(() => app.use("/x")).toThrow(/at least one/);
    expect(() => app.use(123 as never)).toThrow(/function/);
    await app.start();
    expect(() => app.use((_req, _res, next) => next())).toThrow(/before app.start/);
  });
});

describe("req/res augmentation", () => {
  it("exposes req.query, req.get, req.app", async () => {
    const app = tmpApp();
    let sawApp = false;
    app.get("/q", (ctx) => {
      const req = ctx.req as {
        query: Record<string, unknown>;
        get(n: string): string | undefined;
        app: ZenzipApp;
      };
      sawApp = req.app === app;
      return {
        query: req.query,
        ua: req.get("user-agent"),
      };
    });
    const base = await serve(app);

    const res = await fetch(`${base}/q?a=1&b=2&b=3`, {
      headers: { "user-agent": "vitest" },
    });
    const body = (await res.json()) as { query: unknown; ua: string };
    expect(body.query).toEqual({ a: "1", b: ["2", "3"] });
    expect(body.ua).toBe("vitest");
    expect(sawApp).toBe(true);
  });

  it("res.json / send / status / sendStatus / set / redirect", async () => {
    const app = tmpApp();
    app.use("/json", (_req, res) => res.status(201).json({ created: true }));
    app.use("/text", (_req, res) => res.send("hello"));
    app.use("/obj", (_req, res) => res.send({ via: "send" }));
    app.use("/nostatus", (_req, res) => res.sendStatus(418));
    app.use("/hdr", (_req, res) => res.set("x-custom", "yes").send("ok"));
    app.use("/go", (_req, res) => res.redirect("/elsewhere"));
    // routes so the router doesn't 404 before middleware responds — middleware
    // short-circuits, but register them anyway for clarity.
    for (const p of ["/json", "/text", "/obj", "/nostatus", "/hdr", "/go"]) {
      app.get(p, () => ({}));
    }
    const base = await serve(app);

    const j = await fetch(`${base}/json`);
    expect(j.status).toBe(201);
    expect(j.headers.get("content-type")).toContain("application/json");
    expect(await j.json()).toEqual({ created: true });

    const t = await fetch(`${base}/text`);
    expect(t.headers.get("content-type")).toContain("text/html");
    expect(await t.text()).toBe("hello");

    expect(await (await fetch(`${base}/obj`)).json()).toEqual({ via: "send" });

    const s = await fetch(`${base}/nostatus`);
    expect(s.status).toBe(418);
    expect(await s.text()).toBe("I'm a Teapot");

    const h = await fetch(`${base}/hdr`);
    expect(h.headers.get("x-custom")).toBe("yes");

    const g = await fetch(`${base}/go`, { redirect: "manual" });
    expect(g.status).toBe(302);
    expect(g.headers.get("location")).toBe("/elsewhere");
  });
});

describe("dual handler signature (P8.2)", () => {
  it("supports (req, res) Express handlers alongside ctx handlers", async () => {
    const app = tmpApp();
    app.get("/express/:id", (req, res) => {
      res.status(201).json({ id: req.params.id, q: req.query.x });
    });
    app.get("/ctx/:id", (ctx) => ({ id: ctx.params.id }));
    const base = await serve(app);

    const e = await fetch(`${base}/express/7?x=hi`);
    expect(e.status).toBe(201);
    expect(await e.json()).toEqual({ id: "7", q: "hi" });

    expect(await (await fetch(`${base}/ctx/9`)).json()).toEqual({ id: "9" });
  });

  it("JSON-encodes a returned value when the handler didn't respond", async () => {
    const app = tmpApp();
    app.post("/orders", (req, res, _next) => {
      void res; // not used — return value is encoded
      return { received: req.body };
    });
    const base = await serve(app);

    const res = await fetch(`${base}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(await res.json()).toEqual({ received: { a: 1 } });
  });

  it("next() falls through to 404, next(err) hits error middleware", async () => {
    const app = tmpApp();
    app.get("/fall", (_req, _res, next) => next());
    app.get("/boom", (_req, _res, next) => next(new Error("handler error")));
    app.use((err: unknown, _req, res, _next) => {
      res.status(500).json({ e: (err as Error).message });
    });
    const base = await serve(app);

    expect((await fetch(`${base}/fall`)).status).toBe(404);
    const b = await fetch(`${base}/boom`);
    expect(b.status).toBe(500);
    expect(await b.json()).toEqual({ e: "handler error" });
  });
});

describe("Router + mounting (P8.3)", () => {
  it("mounts a router at a prefix", async () => {
    const app = tmpApp();
    const api = zenzip.Router();
    api.get("/users/:id", (ctx) => ({ id: ctx.params.id }));
    api.post("/users", (req, res) => res.status(201).json({ created: req.body }));
    app.use("/api/v1", api);
    const base = await serve(app);

    expect(await (await fetch(`${base}/api/v1/users/5`)).json()).toEqual({ id: "5" });
    const created = await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ created: { name: "x" } });
  });

  it("scopes router-level middleware to the mount path", async () => {
    const app = tmpApp();
    const api = new Router();
    let hits = 0;
    api.use((_req, _res, next) => {
      hits++;
      next();
    });
    api.get("/ping", () => ({ pong: true }));
    app.use("/svc", api);
    app.get("/outside", () => ({ ok: true }));
    const base = await serve(app);

    await fetch(`${base}/outside`);
    expect(hits).toBe(0);
    await fetch(`${base}/svc/ping`);
    expect(hits).toBe(1);
  });

  it("nests routers", async () => {
    const app = tmpApp();
    const inner = zenzip.Router();
    inner.get("/leaf", () => ({ deep: true }));
    const outer = zenzip.Router();
    outer.use("/inner", inner);
    app.use("/root", outer);
    const base = await serve(app);

    expect(await (await fetch(`${base}/root/inner/leaf`)).json()).toEqual({ deep: true });
  });
});

describe("built-in middleware (P8.6)", () => {
  it("cors() sets headers and short-circuits OPTIONS preflight", async () => {
    const app = tmpApp();
    app.use(zenzip.cors({ origin: "https://example.com", credentials: true }));
    app.get("/data", () => ({ ok: true }));
    const base = await serve(app);

    const pre = await fetch(`${base}/data`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://example.com");
    expect(pre.headers.get("access-control-allow-credentials")).toBe("true");

    const get = await fetch(`${base}/data`);
    expect(get.headers.get("access-control-allow-origin")).toBe("https://example.com");
    expect(await get.json()).toEqual({ ok: true });
  });

  it("urlencoded() parses form bodies into req.body", async () => {
    const app = tmpApp();
    app.use(zenzip.urlencoded());
    app.post("/form", (req, res) => res.json(req.body));
    const base = await serve(app);

    const res = await fetch(`${base}/form`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1&b=2&b=3",
    });
    expect(await res.json()).toEqual({ a: "1", b: ["2", "3"] });
  });

  it("logger() emits a line on response finish", async () => {
    const app = tmpApp();
    const lines: string[] = [];
    app.use(zenzip.logger({ log: (l) => lines.push(l) }));
    app.get("/hi", () => ({ ok: true }));
    const base = await serve(app);

    await fetch(`${base}/hi`);
    // finish fires after the response is sent — poll briefly.
    const deadline = Date.now() + 1000;
    while (lines.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(lines[0]).toMatch(/^GET \/hi 200 \d+ms$/);
  });

  it("json() is a no-op when body already parsed (back-compat)", async () => {
    const app = tmpApp();
    app.use(zenzip.json());
    app.post("/j", (req, res) => res.json(req.body));
    const base = await serve(app);

    const res = await fetch(`${base}/j`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: 1 }),
    });
    expect(await res.json()).toEqual({ n: 1 });
  });
});

describe("static() file middleware (P8.6)", () => {
  function staticDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "zenzip-static-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "app.css"), "body{color:red}");
    writeFileSync(join(dir, "index.html"), "<h1>home</h1>");
    writeFileSync(join(dir, "assets", "logo.svg"), "<svg/>");
    cleanups.push(async () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });
    return dir;
  }

  it("serves files with the right content-type and falls through otherwise", async () => {
    const app = tmpApp();
    const dir = staticDir();
    app.use(zenzip.static(dir));
    app.get("/api/ping", () => ({ pong: true }));
    const base = await serve(app);

    const css = await fetch(`${base}/app.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe("body{color:red}");

    const svg = await fetch(`${base}/assets/logo.svg`);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");

    // unmatched path falls through to routes
    expect(await (await fetch(`${base}/api/ping`)).json()).toEqual({ pong: true });
    // missing file → 404 (no route either)
    expect((await fetch(`${base}/nope.css`)).status).toBe(404);
  });

  it("serves the directory index and blocks path traversal", async () => {
    const app = tmpApp();
    const dir = staticDir();
    app.use(zenzip.static(dir));
    const base = await serve(app);

    const idx = await fetch(`${base}/`);
    expect(await idx.text()).toBe("<h1>home</h1>");

    // traversal attempt must not escape root
    const esc = await fetch(`${base}/..%2f..%2f..%2fetc%2fpasswd`);
    expect(esc.status).toBe(404);
  });

  it("strips a mount prefix", async () => {
    const app = tmpApp();
    const dir = staticDir();
    app.use(zenzip.static(dir, { prefix: "/assets" }));
    const base = await serve(app);

    // /assets/logo.svg → dir/logo.svg (prefix stripped, not dir/assets/logo.svg)
    writeFileSync(join(dir, "logo.svg"), "<svg id='root'/>");
    const r = await fetch(`${base}/assets/logo.svg`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("<svg id='root'/>");
  });
});

describe("Web Fetch adapter — toFetchHandler() (P8.5)", () => {
  it("handles a Request → Response through routes + middleware", async () => {
    const app = tmpApp();
    app.use((req, _res, next) => {
      (req as { tag?: string }).tag = "mw";
      next();
    });
    app.get("/users/:id", (req, res) => {
      res.status(200).json({ id: req.params.id, tag: (req as { tag?: string }).tag });
    });
    app.post("/orders", (ctx) => ({ body: ctx.body }));
    await app.start();
    const handler = app.toFetchHandler();

    const get = await handler(new Request("http://x/users/9?a=1"));
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toContain("application/json");
    expect(await get.json()).toEqual({ id: "9", tag: "mw" });

    const post = await handler(
      new Request("http://x/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ n: 1 }),
      }),
    );
    expect(await post.json()).toEqual({ body: { n: 1 } });

    const missing = await handler(new Request("http://x/nope"));
    expect(missing.status).toBe(404);
  });

  it("routes errors and serves 204 for empty responses", async () => {
    const app = tmpApp();
    app.get("/empty", () => undefined);
    app.get("/boom", () => {
      throw new Error("kaboom");
    });
    await app.start();
    const handler = app.toFetchHandler();

    const empty = await handler(new Request("http://x/empty"));
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");

    const boom = await handler(new Request("http://x/boom"));
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ error: "kaboom" });
  });
});

describe("back-compat", () => {
  it("existing ctx handlers work unchanged with no middleware", async () => {
    const app = tmpApp();
    app.post("/echo", (ctx) => ({ got: ctx.body }));
    app.get("/p/:id", (ctx) => ({ id: ctx.params.id }));
    const base = await serve(app);

    const echo = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: 7 }),
    });
    expect(await echo.json()).toEqual({ got: { n: 7 } });
    expect(await (await fetch(`${base}/p/42`)).json()).toEqual({ id: "42" });
  });

  it("body is parsed once and shared between middleware and handler", async () => {
    const app = tmpApp();
    app.use((req, _res, next) => {
      // middleware reads body; handler must still see it (stream consumed once)
      (req as { seenBody?: unknown }).seenBody = req.body;
      next();
    });
    app.post("/orders", (ctx) => ({
      body: ctx.body,
      mwSaw: (ctx.req as { seenBody?: unknown }).seenBody,
    }));
    const base = await serve(app);

    const res = await fetch(`${base}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc" }),
    });
    expect(await res.json()).toEqual({
      body: { id: "abc" },
      mwSaw: { id: "abc" },
    });
  });
});
