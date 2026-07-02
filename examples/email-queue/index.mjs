// ZenZip example: durable email queue + recurring digest schedule.
// Zero infrastructure — state lives in ./.zenzip-data/zenzip.db (SQLite WAL).
//
// Run: pnpm --filter @zenzipjs/example-email-queue start
// Kill it mid-run and start again: pending/in-flight jobs survive.
import { zenzip } from "zenzip";

const RUN_FOR_MS = Number(process.env.RUN_FOR_MS ?? 15_000);

const app = zenzip({ dataDir: ".zenzip-data" });

const emails = app.queue("emails", {
  concurrency: 5,
  retries: 3,
  backoff: { delay: "500ms", maxDelay: "5s" },
});

emails.process(async (job) => {
  // Simulate a flaky SMTP provider.
  if (Math.random() < 0.25) {
    throw new Error("smtp: connection reset");
  }
  console.log(
    `[email] sent to=${job.data.to} subject="${job.data.subject}" (attempt ${job.attempt})`,
  );
});

app.schedule("digest", { every: "5s" }, async (tick) => {
  console.log(`[schedule] digest tick at ${new Date(tick.firedAt).toISOString()}`);
  await emails.push({ to: "digest@example.com", subject: "Your digest" });
});

await app.start();
console.log("started — pushing 5 welcome emails");

for (let i = 0; i < 5; i++) {
  await emails.push({ to: `user${i}@example.com`, subject: "Welcome!" });
}

setTimeout(async () => {
  const dead = await emails.deadJobs();
  if (dead.length > 0) {
    console.log(`dead letters: ${dead.length} (requeue with emails.requeueDead())`);
  }
  const clean = await app.stop({ timeout: "10s" });
  console.log(`stopped (clean drain: ${clean})`);
  process.exit(0);
}, RUN_FOR_MS);
