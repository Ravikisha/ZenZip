// P0.7 — SQLite WAL queue throughput (single process).
// Target from docs/plan.md §5: ≥10k claim+ack jobs/sec on one node.
// Run: pnpm bench:sqlite
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import native from "@zenzip/core-native";

const { benchSqliteQueue } = native;

const JOBS = 100_000;
const dir = mkdtempSync(join(tmpdir(), "zenzip-bench-"));
const db = join(dir, "queue.db");

console.log(`jobs: ${JOBS.toLocaleString()}, db: ${db}\n`);

try {
  const r = benchSqliteQueue(db, JOBS);
  console.log(
    `insert (batched tx) : ${r.insertMs.toFixed(1).padStart(9)} ms  →  ${Math.round(r.insertOpsPerSec).toLocaleString().padStart(12)} jobs/s`,
  );
  console.log(
    `claim + ack loop    : ${r.claimAckMs.toFixed(1).padStart(9)} ms  →  ${Math.round(r.claimAckOpsPerSec).toLocaleString().padStart(12)} jobs/s`,
  );
  const target = 10_000;
  const pass = r.claimAckOpsPerSec >= target;
  console.log(
    `\ntarget ≥ ${target.toLocaleString()} claim+ack/s : ${pass ? "PASS" : "FAIL"}`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
