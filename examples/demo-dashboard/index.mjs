// ZenZip launch demo (P3.17): continuous activity across every primitive,
// visible live in the dashboard. Kill the process at any point and restart —
// runs resume, jobs redeliver, schedules continue.
//
//   pnpm --filter @zenzipjs/example-demo-dashboard start
//   → dashboard at http://127.0.0.1:4100  (SSE live)
//
// Demo flow for recording: open the dashboard, watch orders march through
// charge → cooloff → approval → ship, then kill -9 the process mid-run,
// restart it, and watch the same runs pick up exactly where they were.
import { zenzip } from "zenzipjs";

const app = zenzip({ dataDir: ".zenzip-demo", logLevel: "info" });

// Flaky queue: visible retries + the occasional dead letter to requeue.
const emails = app.queue("emails", {
  concurrency: 4,
  retries: 2,
  backoff: { delay: "1s", maxDelay: "5s" },
});
emails.process(async (job) => {
  if (Math.random() < 0.3) throw new Error("smtp: connection reset");
  await new Promise((r) => setTimeout(r, 150));
});

// The order machine + a workflow durably triggered by its transitions.
const orderMachine = app.machine("order", {
  initial: "created",
  states: {
    created: { on: { PAY: "paid" } },
    paid: { on: { SHIP: "shipped" } },
    shipped: {},
  },
});

app.workflow("on-paid", { on: "order.paid" }, async ({ step, input }) => {
  await step.run("receipt", () =>
    emails.push({ to: "buyer@example.com", re: input.payload.id }),
  );
});

// The flagship: multi-step durable workflow with sleep + event wait.
const fulfilment = app.workflow("fulfilment", async ({ step, input, runId }) => {
  await step.run("charge", async () => {
    await new Promise((r) => setTimeout(r, 300));
    return { chargeId: `ch_${runId.slice(-6)}` };
  });
  await step.sleep("cooloff", "8s");
  const approved = await step.waitForEvent("approval", "order.approved", {
    timeout: "20s",
    match: { order: input.order },
  });
  await step.run("ship", () => orderMachine.send(input.order, "SHIP"));
  return { approved: approved !== null };
});

// Heartbeat schedule keeps the cron table moving.
app.schedule("heartbeat", { every: "15s" }, async () => {
  await emails.push({ to: "digest@example.com" });
});

await app.start();
const { port } = await app.dashboard();
console.log(`dashboard → http://127.0.0.1:${port}`);

// Activity generator: a new order every 6 seconds.
let n = 0;
setInterval(async () => {
  const order = `ord_${++n}`;
  await orderMachine.create(order);
  await orderMachine.send(order, "PAY");
  await fulfilment.trigger({ order }, { idempotencyKey: order });
  // Approve it midway through its cooloff+wait, sometimes too late.
  setTimeout(() => {
    app.emit("order.approved", { order, by: "ops" });
  }, 9_000 + Math.random() * 8_000);
}, 6_000);

console.log("generating orders — Ctrl-C for graceful stop, kill -9 to test recovery");
