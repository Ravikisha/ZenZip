// Crash-harness child (P1.5): claims a job, reports it, then hangs until the
// parent SIGKILLs the process — simulating a worker dying mid-job.
import { zenzip } from "../../dist/index.js";

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("usage: node crash-worker.mjs <dataDir>");
  process.exit(2);
}

const app = zenzip({ dataDir, handleSignals: false });
const q = app.queue("crash", { lease: "2s", poll: 20 });
q.process(async (job) => {
  console.log(`CLAIMED:${job.id}:${job.attempt}`);
  // Hang forever — the parent kills us mid-job.
  await new Promise(() => {});
});

await app.start();
await q.push({ victim: true });
console.log("READY");
