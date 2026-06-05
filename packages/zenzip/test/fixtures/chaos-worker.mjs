// Chaos-harness child (P2.14): runs a 5-step workflow with side effects
// logged to a file. The parent SIGKILLs this process at random points and
// respawns it; the same run (idempotency key) must eventually complete with
// every step executed and memoized.
import { appendFileSync } from "node:fs";
import { zenzip } from "../../dist/index.js";

const [dataDir, logFile] = process.argv.slice(2);
if (!dataDir || !logFile) {
  console.error("usage: node chaos-worker.mjs <dataDir> <logFile>");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = zenzip({
  dataDir,
  handleSignals: false,
  sweep: "150ms",
  schedulerTick: "50ms",
});

const wf = app.workflow(
  "chaos",
  { stepRetries: 10, stepBackoff: { delay: 25, maxDelay: 50 }, lease: "1s" },
  async ({ step }) => {
    const results = [];
    for (let i = 1; i <= 5; i++) {
      const value = await step.run(`step-${i}`, async () => {
        appendFileSync(logFile, `step-${i}\n`);
        await sleep(60); // window for the kill to land mid-step
        return i * 10;
      });
      results.push(value);
    }
    return results.reduce((a, b) => a + b, 0);
  },
);

await app.start();
const { runId } = await wf.trigger(null, { idempotencyKey: "chaos-run-1" });
console.log(`RUNNING:${runId}`);

for (;;) {
  const run = await wf.getRun(runId);
  if (run?.status === "completed") {
    console.log(`DONE:${JSON.stringify(run.output)}`);
    await app.stop({ timeout: "5s" });
    process.exit(0);
  }
  if (run?.status === "failed") {
    console.log(`FAILED:${run.error}`);
    process.exit(1);
  }
  await sleep(50);
}
