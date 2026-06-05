// Postgres backend e2e (P5.4): the same TS API on the multi-node store.
// Gated: set ZENZIP_PG_TEST_URL (CI provides a postgres service).
import { describe, expect, it } from "vitest";

import { zenzip } from "../src/index.js";

const PG_URL = process.env.ZENZIP_PG_TEST_URL;

describe.skipIf(!PG_URL)("postgres backend", () => {
  it("runs queues, workflows, events, and machines on postgres", async () => {
    // The PG schema persists across runs — namespace everything.
    const ns = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const app = zenzip({
      store: { driver: "postgres", url: PG_URL! },
      handleSignals: false,
      sweep: "200ms",
      schedulerTick: "50ms",
    });
    try {
      const processed: number[] = [];
      const q = app.queue<{ n: number }>(`pg-jobs-${ns}`, { poll: 50 });
      q.process(async (job) => {
        processed.push(job.data.n);
      });

      const wf = app.workflow<{ id: string }, string>(
        `pg-flow-${ns}`,
        async ({ step, input }) => {
          await step.run("a", () => `a:${input.id}`);
          const ev = await step.waitForEvent<{ ok: boolean }>("gate", `pg.gate.${ns}`, {
            timeout: "10s",
            match: { id: input.id },
          });
          return ev?.ok ? "gated" : "timed-out";
        },
      );

      const machine = app.machine(`pg-order-${ns}`, {
        initial: "created",
        states: { created: { on: { PAY: "paid" } }, paid: {} },
      });

      await app.start();

      // Queue.
      await q.pushBulk([{ n: 1 }, { n: 2 }, { n: 3 }]);
      const deadline = Date.now() + 10_000;
      while (processed.length < 3) {
        if (Date.now() > deadline) throw new Error("jobs not processed on pg");
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(processed.sort()).toEqual([1, 2, 3]);

      // Workflow + matched event.
      const { runId } = await wf.trigger({ id: "x1" });
      await new Promise((r) => setTimeout(r, 600));
      const { woken } = app.emit(`pg.gate.${ns}`, { id: "x1", ok: true });
      expect(woken).toBe(1);
      let run = await wf.getRun(runId);
      while (run?.status !== "completed") {
        if (Date.now() > deadline + 10_000) throw new Error(`stuck: ${run?.status}`);
        await new Promise((r) => setTimeout(r, 50));
        run = await wf.getRun(runId);
      }
      expect(run.output).toBe("gated");

      // Machine.
      expect(await machine.create("m1")).toBe(true);
      const t = await machine.send("m1", "PAY");
      expect(t.to).toBe("paid");
      expect((await machine.history("m1")).length).toBe(1);
    } finally {
      await app.stop({ timeout: "5s" });
    }
  }, 40_000);
});
