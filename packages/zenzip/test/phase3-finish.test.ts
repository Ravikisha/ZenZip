// Phase 3 finish: metrics, SSE stream, dashboard auth token, toNodeHandler.
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): { app: ZenzipApp; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-p3f-"));
  const app = zenzip({
    dataDir: dir,
    handleSignals: false,
    sweep: "200ms",
    schedulerTick: "50ms",
  });
  cleanups.push(async () => {
    await app.stop({ timeout: "5s" });
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  return { app, dir };
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("metrics", () => {
  it("counts jobs, runs, steps, and events", async () => {
    const { app } = tmpApp();
    const q = app.queue("work", { poll: 20, retries: 1, backoff: { delay: 10, maxDelay: 10 } });
    let first = true;
    q.process(async () => {
      if (first) {
        first = false;
        throw new Error("flake once");
      }
    });
    const wf = app.workflow("metered", async ({ step }) => {
      await step.run("a", () => 1);
      return "ok";
    });
    await app.start();

    await q.push({});
    await wf.triggerAndWait(null, { timeout: "10s" });
    app.emit("metric.test", {});

    const deadline = Date.now() + 10_000;
    let m = app.metrics();
    while (m.jobsCompleted < 1 || m.jobsRetried < 1) {
      if (Date.now() > deadline) throw new Error(`metrics never settled: ${JSON.stringify(m)}`);
      await new Promise((r) => setTimeout(r, 50));
      m = app.metrics();
    }
    expect(m.runsCompleted).toBeGreaterThanOrEqual(1);
    expect(m.stepsRecorded).toBeGreaterThanOrEqual(1);
    expect(m.eventsEmitted).toBeGreaterThanOrEqual(1);
    expect(m.handlerCount).toBeGreaterThanOrEqual(2);
  }, 20_000);
});

describe("dashboard auth + SSE", () => {
  it("enforces the token on page, api, and stream", async () => {
    const { app } = tmpApp();
    await app.start();
    const { port } = await app.dashboard({ port: 0, token: "s3cret" });
    const base = `http://127.0.0.1:${port}`;

    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(`${base}/api/overview`)).status).toBe(401);
    expect((await fetch(`${base}/api/overview?token=wrong`)).status).toBe(401);

    expect((await fetch(`${base}/?token=s3cret`)).status).toBe(200);
    const viaHeader = await fetch(`${base}/api/overview`, {
      headers: { authorization: "Bearer s3cret" },
    });
    expect(viaHeader.status).toBe(200);
  });

  it("streams overview frames over SSE", async () => {
    const { app } = tmpApp();
    app.queue("seen", { poll: 20 }).process(async () => {});
    await app.start();
    const { port } = await app.dashboard({ port: 0 });

    const res = await fetch(`http://127.0.0.1:${port}/api/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("data: ");
    const frame = JSON.parse(chunk.split("data: ")[1].split("\n")[0]) as {
      queues: unknown[];
      metrics: Record<string, number>;
    };
    expect(Array.isArray(frame.queues)).toBe(true);
    expect(frame.metrics).toHaveProperty("jobsCompleted");
    await reader.cancel();
  });
});

describe("toNodeHandler", () => {
  it("mounts zenzip routes into a foreign http server", async () => {
    const { app } = tmpApp();
    app.get("/zen/:name", (ctx) => ({ hello: ctx.params.name }));
    await app.start();

    // A server we own — zenzip is just a handler inside it.
    const server = createServer(app.toNodeHandler());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(async () => {
      await new Promise<void>((r) => server.close(() => r()));
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/zen/world`);
    expect(await res.json()).toEqual({ hello: "world" });
  });
});
