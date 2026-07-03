// P1.5 — real kill-process crash harness: a child process claims a job and
// dies (SIGKILL) mid-execution; a fresh app on the same data dir must
// redeliver the job via lease-expiry sweep with the attempt counted.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { zenzip, type ZenzipApp } from "../src/index.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerScript = join(pkgRoot, "test", "fixtures", "crash-worker.mjs");
const distEntry = join(pkgRoot, "dist", "index.js");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

it("redelivers a job after the worker process is SIGKILLed mid-job", async () => {
  if (!existsSync(distEntry)) {
    throw new Error("dist/index.js missing — run `pnpm --filter zenzipjs build` first");
  }
  const dir = mkdtempSync(join(tmpdir(), "zenzip-crash-"));
  cleanups.push(async () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  // 1. Child claims the job (lease 2s) and hangs.
  const child = spawn(process.execPath, [workerScript, dir], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  cleanups.push(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  const claimed = await new Promise<{ id: string; attempt: number }>(
    (resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error("child never claimed the job")),
        20_000,
      );
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = /CLAIMED:([^:]+):(\d+)/.exec(buffer);
        if (match) {
          clearTimeout(timer);
          resolvePromise({ id: match[1], attempt: Number(match[2]) });
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`child exited early (code ${code})`));
      });
    },
  );
  expect(claimed.attempt).toBe(1);

  // 2. Kill -9 mid-job: no ack, no graceful shutdown.
  child.kill("SIGKILL");
  await new Promise<void>((r) => child.once("exit", () => r()));

  // 3. Fresh app, same data dir, aggressive sweep. The job's 2s lease
  //    expires, the sweeper returns it to pending, and it is redelivered.
  const redelivered: Array<{ id: string; attempt: number }> = [];
  const app: ZenzipApp = zenzip({
    dataDir: dir,
    handleSignals: false,
    sweep: "200ms",
  });
  cleanups.push(async () => {
    await app.stop({ timeout: "5s" });
  });
  const q = app.queue<{ victim: boolean }>("crash", { poll: 20 });
  q.process(async (job) => {
    redelivered.push({ id: job.id, attempt: job.attempt });
    expect(job.data).toEqual({ victim: true });
  });
  await app.start();

  const deadline = Date.now() + 15_000; // lease 2s + sweep + slack
  while (redelivered.length === 0) {
    if (Date.now() > deadline) throw new Error("job was never redelivered");
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(redelivered[0].id).toBe(claimed.id);
  expect(redelivered[0].attempt).toBe(2); // crash attempt was counted
}, 40_000);
