// ZenZip alongside Fastify: Fastify owns the HTTP surface, ZenZip owns
// everything durable — same process, one SQLite file, no Redis/Temporal.
import Fastify from "fastify";
import { zenzip } from "zenzip";

const app = zenzip();

// ── Durable pieces ──────────────────────────────────────────────────────────
const emails = app.queue("emails", { concurrency: 5, retries: 3 });
emails.process(async (job) => {
  console.log(`[emails] → ${job.data.to} (attempt ${job.attempt})`);
});

const fulfilment = app.workflow("fulfilment", async ({ step, input }) => {
  const payment = await step.run("charge", () => ({ chargeId: `ch_${input.orderId}` }));
  await step.sleep("cooloff", "10s"); // survives restarts & deploys
  await step.run("confirm", () =>
    emails.push({ to: input.email, subject: `Order ${input.orderId} confirmed` }),
  );
  return { ...payment, confirmed: true };
});

await app.start();
await app.dashboard(); // http://127.0.0.1:4100

// ── Fastify owns HTTP; handlers call into the runtime (sync-cheap) ──────────
const fastify = Fastify({ logger: true });

fastify.post("/orders", async (request, reply) => {
  const { orderId, email } = request.body ?? {};
  if (!orderId || !email) {
    return reply.code(400).send({ error: "orderId and email required" });
  }
  const { runId } = await fulfilment.trigger(
    { orderId, email },
    { idempotencyKey: orderId }, // client retries can't double-fulfil
  );
  return reply.code(202).send({ runId });
});

fastify.get("/orders/runs/:runId", async (request, reply) => {
  const run = await fulfilment.getRun(request.params.runId);
  if (!run) return reply.code(404).send({ error: "unknown run" });
  return run; // { runId, status, output?, error? }
});

fastify.get("/health", async () => ({ ok: true, metrics: app.metrics() }));

// Graceful shutdown: Fastify stops taking requests, then zenzip drains.
const shutdown = async () => {
  await fastify.close();
  await app.stop({ timeout: "15s" });
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await fastify.listen({ port: 3000, host: "127.0.0.1" });
console.log(`
  api       → http://127.0.0.1:3000   (POST /orders {"orderId":"o1","email":"a@b.co"})
  dashboard → http://127.0.0.1:4100
`);
