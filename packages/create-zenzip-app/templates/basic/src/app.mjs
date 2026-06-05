// Your ZenZip app: a durable queue, a cron schedule, and a crash-proof
// workflow — backed by a single SQLite file in .zenzip/. No other services.
//
// Try it: npm run dev → push happens on boot → watch http://127.0.0.1:4100
// Then kill the process mid-workflow and start it again. It resumes.
import { zenzip } from "zenzip";

const app = zenzip();

// ── Queue: throw = retry with backoff, then dead-letter ─────────────────────
const emails = app.queue("emails", {
  concurrency: 5,
  retries: 3,
  backoff: { delay: "1s", maxDelay: "30s" },
});

emails.process(async (job) => {
  console.log(`[emails] sending to ${job.data.to} (attempt ${job.attempt})`);
  if (Math.random() < 0.2) throw new Error("smtp: connection reset"); // retried!
});

// ── Schedule: persisted, survives restarts ──────────────────────────────────
app.schedule("heartbeat", { every: "30s" }, async () => {
  console.log("[schedule] heartbeat");
});

// ── Workflow: every step journaled; sleep holds zero resources ──────────────
const onboarding = app.workflow("onboarding", async ({ step, input }) => {
  await step.run("welcome", () =>
    emails.push({ to: input.email, subject: "Welcome!" }),
  );
  await step.sleep("wait", "20s"); // kill the process here — it still fires
  await step.run("follow-up", () =>
    emails.push({ to: input.email, subject: "How is it going?" }),
  );
  return "onboarded";
});

await app.start();
await app.dashboard(); // http://127.0.0.1:4100

await onboarding.trigger(
  { email: "you@example.com" },
  { idempotencyKey: "you@example.com" }, // restarts won't double-trigger
);
console.log("app running — dashboard at http://127.0.0.1:4100 (Ctrl-C to stop)");
