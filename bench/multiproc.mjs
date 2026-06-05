// P0.7b — multi-process SQLite contention: N worker processes share one
// data dir (WAL) and consume a single queue. Validates the D8 process model
// and measures throughput degradation under writer contention.
// Run: node bench/multiproc.mjs [workers=4] [jobs=20000]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const WORKERS = Number(process.argv[2] ?? 4);
const JOBS = Number(process.argv[3] ?? 20_000);

const zenzipDist = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), "../packages/zenzip/dist/index.js"),
).href;

const dir = mkdtempSync(join(tmpdir(), "zenzip-mp-"));

const workerSrc = `
import { zenzip } from ${JSON.stringify(zenzipDist)};
const app = zenzip({ dataDir: ${JSON.stringify(dir)}, handleSignals: false });
let count = 0;
const q = app.queue("mp", { poll: 50, concurrency: 8, batch: 64 });
q.process(async () => { count++; });
await app.start();
process.on("message", async (m) => {
  if (m === "report") { process.send({ count }); }
  if (m === "stop") { await app.stop({ timeout: "5s" }); process.exit(0); }
});
process.send("ready");
`;
const workerPath = join(dir, "worker.mjs");
writeFileSync(workerPath, workerSrc);

// Producer in this process.
const { zenzip } = await import(zenzipDist);
const app = zenzip({ dataDir: dir, handleSignals: false });
const q = app.queue("mp");
await app.start();

console.log(`spawning ${WORKERS} consumer processes…`);
const workers = Array.from({ length: WORKERS }, () =>
  spawn(process.execPath, [workerPath], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    cwd: process.cwd(),
  }),
);
await Promise.all(
  workers.map(
    (w) =>
      new Promise((resolve, reject) => {
        w.once("message", resolve);
        w.once("exit", (code) => reject(new Error(`worker died at boot (${code})`)));
      }),
  ),
);

console.log(`pushing ${JOBS.toLocaleString()} jobs from the producer process…`);
const payloads = Array.from({ length: JOBS }, (_, i) => ({ n: i }));
const t0 = performance.now();
const CHUNK = 1_000;
for (let i = 0; i < payloads.length; i += CHUNK) {
  await q.pushBulk(payloads.slice(i, i + CHUNK));
}
const pushMs = performance.now() - t0;

// Wait for drain.
const t1 = performance.now();
for (;;) {
  const left = await q.activeCount();
  if (left === 0) break;
  await new Promise((r) => setTimeout(r, 100));
}
const drainMs = performance.now() - t1;

// Collect per-worker counts.
const counts = await Promise.all(
  workers.map(
    (w) =>
      new Promise((resolve) => {
        w.once("message", (m) => resolve(m.count));
        w.send("report");
      }),
  ),
);
for (const w of workers) w.send("stop");
await Promise.all(workers.map((w) => new Promise((r) => w.once("exit", r))));
await app.stop({ timeout: "5s" });

const total = counts.reduce((a, b) => a + b, 0);
console.log(`\npush:  ${pushMs.toFixed(0)} ms  →  ${Math.round(JOBS / (pushMs / 1000)).toLocaleString()} jobs/s (cross-process WAL writes)`);
console.log(`drain: ${drainMs.toFixed(0)} ms  →  ${Math.round(JOBS / (drainMs / 1000)).toLocaleString()} jobs/s across ${WORKERS} processes`);
console.log(`per-worker: [${counts.join(", ")}]  total=${total} (expected ${JOBS}${total === JOBS ? " ✓" : " ✗ MISMATCH"})`);

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* best effort */
}
process.exit(total === JOBS ? 0 : 1);
