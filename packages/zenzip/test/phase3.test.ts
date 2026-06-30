// Phase 3 surface: event bus (subscribers, durable triggers, match
// predicates), state machines, HTTP adapter + webhook sugar, dashboard API.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): { app: ZenzipApp; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-p3-"));
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

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("event bus", () => {
  it("dispatches local subscribers with wildcard patterns", async () => {
    const { app } = tmpApp();
    const seen: string[] = [];
    app.on("user.*", (e) => seen.push(`star:${e.event}`));
    app.on("user.**", (e) => seen.push(`glob:${e.event}`));
    const off = app.on("user.created", (e) => seen.push(`exact:${e.event}`));
    await app.start();

    app.emit("user.created", { id: 1 });
    app.emit("user.created.eu", { id: 2 });
    app.emit("order.created", {});
    await waitFor(() => seen.length === 4);
    expect(seen.sort()).toEqual([
      "exact:user.created",
      "glob:user.created",
      "glob:user.created.eu",
      "star:user.created",
    ]);

    off();
    app.emit("user.created", { id: 3 });
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.filter((s) => s.startsWith("exact"))).toHaveLength(1);
  });

  it("durably triggers workflows via on: patterns", async () => {
    const { app } = tmpApp();
    const inputs: unknown[] = [];
    app.workflow("onboard", { on: "user.*" }, async ({ input }) => {
      inputs.push(input);
      return "done";
    });
    await app.start();

    const result = app.emit("user.created", { id: "u1" });
    expect(result.triggered).toBe(1);
    await waitFor(() => inputs.length === 1);
    expect(inputs[0]).toMatchObject({
      event: "user.created",
      payload: { id: "u1" },
    });

    expect(app.emit("order.created", {}).triggered).toBe(0);
  });

  it("waitForEvent match predicate wakes only the matching run", async () => {
    const { app } = tmpApp();
    const completed: string[] = [];
    const wf = app.workflow<{ invoice: string }, void>(
      "collect",
      async ({ step, input }) => {
        const paid = await step.waitForEvent("paid", "invoice.paid", {
          match: { invoice: input.invoice },
        });
        completed.push(`${input.invoice}:${(paid as { amount: number }).amount}`);
      },
    );
    await app.start();

    await wf.trigger({ invoice: "inv-a" });
    await wf.trigger({ invoice: "inv-b" });
    await new Promise((r) => setTimeout(r, 500)); // both reach the wait

    const { woken } = app.emit("invoice.paid", { invoice: "inv-b", amount: 42 });
    expect(woken).toBe(1);
    await waitFor(() => completed.length === 1);
    expect(completed[0]).toBe("inv-b:42");
  }, 15_000);
});

describe("state machines", () => {
  it("validates transitions, records history, emits transition events", async () => {
    const { app } = tmpApp();
    const transitions: string[] = [];
    app.on("order.*", (e) => transitions.push(e.event));

    const order = app.machine("order", {
      initial: "created",
      states: {
        created: { on: { PAY: "paid" } },
        paid: { on: { PACK: "packed" } },
        packed: {},
      },
    });
    await app.start();

    expect(await order.create("ord_1")).toBe(true);
    expect(await order.create("ord_1")).toBe(false); // idempotent

    const t = await order.send("ord_1", "PAY");
    expect(t).toEqual({ from: "created", to: "paid" });
    expect(await order.state("ord_1")).toBe("paid");

    await expect(order.send("ord_1", "PAY")).rejects.toThrow(/invalid transition/);

    await order.send("ord_1", "PACK");
    const history = await order.history("ord_1");
    expect(history).toHaveLength(2);
    expect(history[0].event).toBe("PACK"); // newest first

    await waitFor(() => transitions.length === 2);
    expect(transitions).toEqual(["order.paid", "order.packed"]);
  });

  it("machine transitions can durably trigger workflows", async () => {
    const { app } = tmpApp();
    let notified = 0;
    app.workflow("notify-paid", { on: "order.paid" }, async () => {
      notified++;
    });
    const order = app.machine("order", {
      initial: "created",
      states: { created: { on: { PAY: "paid" } }, paid: {} },
    });
    await app.start();

    await order.create("o1");
    await order.send("o1", "PAY");
    await waitFor(() => notified === 1);
  });
});

describe("http adapter", () => {
  it("serves routes with params, query, and JSON bodies", async () => {
    const { app } = tmpApp();
    app.get("/users/:id", (ctx) => ({
      id: ctx.params.id,
      verbose: ctx.query.get("verbose"),
    }));
    app.post("/echo", (ctx) => ctx.body);
    app.get("/boom", () => {
      throw new Error("kaboom");
    });
    await app.start();
    const { port, close } = await app.listen({ port: 0 });

    const base = `http://127.0.0.1:${port}`;
    const user = await (await fetch(`${base}/users/42?verbose=1`)).json();
    expect(user).toEqual({ id: "42", verbose: "1" });

    const echoRes = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(await echoRes.json()).toEqual({ hello: "world" });

    const boom = await fetch(`${base}/boom`);
    expect(boom.status).toBe(500);
    expect(await boom.json()).toMatchObject({ error: "kaboom" });

    expect((await fetch(`${base}/nope`)).status).toBe(404);
    await close();
  });

  it("webhook sugar triggers a workflow with the request body", async () => {
    const { app } = tmpApp();
    const received: unknown[] = [];
    app.workflow(
      "stripe-hook",
      { http: "POST /hooks/stripe" },
      async ({ input }) => {
        received.push(input);
      },
    );
    await app.start();
    const { port, close } = await app.listen({ port: 0 });

    const res = await fetch(`http://127.0.0.1:${port}/hooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "invoice.paid" }),
    });
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toBeTruthy();
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ type: "invoice.paid" });
    await close();
  });
});

describe("dashboard", () => {
  it("serves overview, run detail, and requeues dead jobs", async () => {
    const { app } = tmpApp();
    const q = app.queue("doomed", { poll: 20, retries: 0 });
    q.process(async () => {
      throw new Error("always fails");
    });
    const wf = app.workflow("hello", async ({ step }) => {
      await step.run("greet", () => "hi");
      return "done";
    });
    await app.start();
    const { port } = await app.dashboard({ port: 0 });
    const base = `http://127.0.0.1:${port}`;

    // Seed data: a completed run and a dead job.
    const out = await wf.triggerAndWait(null, { timeout: "10s" });
    expect(out).toBe("done");
    await q.push({ n: 1 });
    const deadline = Date.now() + 10_000;
    while ((await q.deadJobs()).length === 0) {
      if (Date.now() > deadline) throw new Error("job never dead-lettered");
      await new Promise((r) => setTimeout(r, 50));
    }

    // HTML shell.
    const html = await (await fetch(base)).text();
    expect(html).toContain("zenzip dashboard");

    // Overview JSON.
    const overview = (await (await fetch(`${base}/api/overview`)).json()) as {
      queues: Array<{ queue: string; dead: number }>;
      runs: Array<{ id: string; workflow: string }>;
      events: unknown[];
      schedules: unknown[];
    };
    expect(overview.runs.some((r) => r.workflow === "hello")).toBe(true);
    const doomed = overview.queues.find((s) => s.queue === "doomed");
    expect(doomed?.dead).toBe(1);

    // Run detail with steps.
    const runId = overview.runs.find((r) => r.workflow === "hello")!.id;
    const detail = (await (await fetch(`${base}/api/runs/${runId}`)).json()) as {
      run: { status: number };
      steps: Array<{ stepId: string }>;
    };
    expect(detail.run.status).toBe(4); // completed
    expect(detail.steps.map((s) => s.stepId)).toContain("greet");

    // Requeue the dead job.
    const requeue = (await (
      await fetch(`${base}/api/queues/doomed/requeue-dead`, { method: "POST" })
    ).json()) as { requeued: number };
    expect(requeue.requeued).toBe(1);
  }, 30_000);
});
