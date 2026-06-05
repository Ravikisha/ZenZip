import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): { app: ZenzipApp; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-wf-"));
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

describe("workflow", () => {
  it("runs the order demo: step -> sleep -> waitForEvent -> step (P2.16)", async () => {
    const { app } = tmpApp();
    const executed: string[] = [];

    const order = app.workflow<{ orderId: string }, { shipped: boolean; by: string }>(
      "order",
      async ({ step, input }) => {
        const payment = await step.run("charge", () => {
          executed.push("charge");
          return { chargeId: `ch_${input.orderId}` };
        });
        await step.sleep("cooloff", "200ms");
        const approval = await step.waitForEvent<{ by: string }>(
          "approval",
          "order.approved",
          { timeout: "30s" },
        );
        await step.run("ship", () => {
          executed.push("ship");
          expect(payment.chargeId).toBe(`ch_${input.orderId}`);
        });
        return { shipped: true, by: approval?.by ?? "nobody" };
      },
    );
    await app.start();

    const { runId } = await order.trigger({ orderId: "o1" });
    // Reach the event wait (past charge + 200ms sleep), then approve.
    await new Promise((r) => setTimeout(r, 800));
    const { woken } = app.emit("order.approved", { by: "madhur" });
    expect(woken).toBe(1);

    const deadline = Date.now() + 10_000;
    let run = await order.getRun(runId);
    while (run?.status !== "completed") {
      if (Date.now() > deadline) throw new Error(`stuck in ${run?.status}`);
      await new Promise((r) => setTimeout(r, 50));
      run = await order.getRun(runId);
    }
    expect(run.output).toEqual({ shipped: true, by: "madhur" });
    // Steps executed exactly once despite multiple execution attempts.
    expect(executed).toEqual(["charge", "ship"]);
  }, 20_000);

  it("memoizes completed steps across step retries", async () => {
    const { app } = tmpApp();
    const counts = { stable: 0, flaky: 0 };
    const wf = app.workflow(
      "retryer",
      { stepRetries: 3, stepBackoff: { delay: 10, maxDelay: 20 } },
      async ({ step }) => {
        await step.run("stable", () => {
          counts.stable++;
        });
        await step.run("flaky", () => {
          counts.flaky++;
          if (counts.flaky < 3) throw new Error(`flaky attempt ${counts.flaky}`);
          return "ok";
        });
        return "done";
      },
    );
    await app.start();

    const result = await wf.triggerAndWait(null, { timeout: "15s" });
    expect(result).toBe("done");
    expect(counts.flaky).toBe(3);
    expect(counts.stable).toBe(1); // never re-executed
  }, 20_000);

  it("fails the run when step retries are exhausted", async () => {
    const { app } = tmpApp();
    const wf = app.workflow(
      "doomed",
      { stepRetries: 1, stepBackoff: { delay: 10, maxDelay: 10 } },
      async ({ step }) => {
        await step.run("always-fails", () => {
          throw new Error("permanent failure");
        });
      },
    );
    await app.start();

    await expect(wf.triggerAndWait(null, { timeout: "15s" })).rejects.toThrow(
      /after 2 attempts.*permanent failure/,
    );
  }, 20_000);

  it("waitForEvent resolves null on timeout", async () => {
    const { app } = tmpApp();
    const wf = app.workflow("patient", async ({ step }) => {
      const ev = await step.waitForEvent("never", "no.such.event", { timeout: "300ms" });
      return ev === null ? "timed-out" : "got-event";
    });
    await app.start();

    const result = await wf.triggerAndWait(null, { timeout: "15s" });
    expect(result).toBe("timed-out");
  }, 20_000);

  it("step.all runs parallel steps with independent memoization", async () => {
    const { app } = tmpApp();
    const counts = { a: 0, b: 0, c: 0 };
    const wf = app.workflow(
      "parallel",
      { stepRetries: 3, stepBackoff: { delay: 10, maxDelay: 20 } },
      async ({ step }) => {
        const [a, b, c] = await step.all([
          () => step.run("a", () => ++counts.a),
          () =>
            step.run("b", () => {
              counts.b++;
              if (counts.b < 2) throw new Error("b flaky");
              return counts.b;
            }),
          () => step.run("c", () => ++counts.c),
        ]);
        return a + b + c;
      },
    );
    await app.start();

    const result = await wf.triggerAndWait(null, { timeout: "15s" });
    expect(result).toBe(1 + 2 + 1);
    // a and c executed once; only b re-ran.
    expect(counts).toEqual({ a: 1, b: 2, c: 1 });
  }, 20_000);

  it("invokes child workflows and returns their output", async () => {
    const { app } = tmpApp();
    const child = app.workflow<number, number>("double", async ({ input }) => input * 2);
    const parent = app.workflow<number, number>("plus-double", async ({ step, input }) => {
      const doubled = await step.invoke("dbl", child, input);
      return doubled + 1;
    });
    await app.start();

    const result = await parent.triggerAndWait(21, { timeout: "15s" });
    expect(result).toBe(43);
  }, 20_000);

  it("dedupes runs by idempotency key", async () => {
    const { app } = tmpApp();
    let executions = 0;
    const wf = app.workflow("once", async () => {
      executions++;
      return executions;
    });
    await app.start();

    const a = await wf.trigger(null, { idempotencyKey: "evt-42" });
    const b = await wf.trigger(null, { idempotencyKey: "evt-42" });
    expect(a.runId).toBe(b.runId);
    await wf.triggerAndWait(null, { idempotencyKey: "evt-42", timeout: "10s" });
    expect(executions).toBe(1);
  }, 20_000);

  it("cancels a sleeping run", async () => {
    const { app } = tmpApp();
    let finished = false;
    const wf = app.workflow("cancellable", async ({ step }) => {
      await step.sleep("long-nap", "10s");
      finished = true;
    });
    await app.start();

    const { runId } = await wf.trigger(null);
    await new Promise((r) => setTimeout(r, 300));
    expect(await wf.cancel(runId)).toBe(1);

    const run = await wf.getRun(runId);
    expect(run?.status).toBe("cancelled");
    expect(finished).toBe(false);
  }, 20_000);

  it("rejects duplicate step ids", async () => {
    const { app } = tmpApp();
    const wf = app.workflow("dupe", async ({ step }) => {
      await step.run("same", () => 1);
      await step.run("same", () => 2);
    });
    await app.start();

    await expect(wf.triggerAndWait(null, { timeout: "10s" })).rejects.toThrow(
      /duplicate step id/,
    );
  }, 20_000);

  it("resumes a sleeping run after a restart (durability)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zenzip-wf-restart-"));
    cleanups.push(async () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });
    const defineApp = () => {
      const app = zenzip({ dataDir: dir, handleSignals: false, schedulerTick: "50ms" });
      const wf = app.workflow<null, string>("resumer", async ({ step }) => {
        await step.run("before", () => "x");
        await step.sleep("nap", "1s");
        await step.run("after", () => "y");
        return "resumed";
      });
      return { app, wf };
    };

    // App 1: trigger, let it suspend in the sleep, then stop (simulated deploy).
    const first = defineApp();
    await first.app.start();
    const { runId } = await first.wf.trigger(null);
    await new Promise((r) => setTimeout(r, 400));
    expect((await first.wf.getRun(runId))?.status).toBe("sleeping");
    await first.app.stop({ timeout: "5s" });

    // App 2: same data dir picks the run up and finishes it.
    const second = defineApp();
    cleanups.push(async () => {
      await second.app.stop({ timeout: "5s" });
    });
    await second.app.start();

    const deadline = Date.now() + 15_000;
    let run = await second.wf.getRun(runId);
    while (run?.status !== "completed") {
      if (Date.now() > deadline) throw new Error(`stuck in ${run?.status}`);
      await new Promise((r) => setTimeout(r, 100));
      run = await second.wf.getRun(runId);
    }
    expect(run.output).toBe("resumed");
  }, 30_000);
});
