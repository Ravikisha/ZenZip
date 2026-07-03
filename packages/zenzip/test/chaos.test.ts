// P2.14 (mini-chaos) — SIGKILL a workflow worker at random points across
// several respawns; the run must complete with all steps executed and no
// step lost. Side effects are at-least-once by design (docs/plan.md D7):
// each step's effect fires >= 1 time, and the final output proves every
// step's *recorded* result was used exactly once.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerScript = join(pkgRoot, "test", "fixtures", "chaos-worker.mjs");
const distEntry = join(pkgRoot, "dist", "index.js");

const KILLS = 4;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function spawnWorker(
  dir: string,
  logFile: string,
): { child: ChildProcess; exited: Promise<void>; stderr: () => string } {
  const child = spawn(process.execPath, [workerScript, dir, logFile], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
  // Attach BEFORE any waiting: a child that crashes at boot (before our
  // SIGKILL lands) must still resolve this, or the test hangs forever.
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  cleanups.push(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  return { child, exited, stderr: () => stderr };
}

it("survives repeated SIGKILLs mid-workflow without losing steps", async () => {
  if (!existsSync(distEntry)) {
    throw new Error("dist/index.js missing — run `pnpm --filter zenzipjs build` first");
  }
  const dir = mkdtempSync(join(tmpdir(), "zenzip-chaos-"));
  const logFile = join(dir, "effects.log");
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  // Rounds 1..KILLS: spawn, let it work a random slice, SIGKILL mid-flight.
  for (let round = 0; round < KILLS; round++) {
    const { child, exited, stderr } = spawnWorker(dir, logFile);
    const delay = 150 + Math.floor(Math.random() * 450);
    await new Promise((r) => setTimeout(r, delay));
    child.kill("SIGKILL");
    await exited;
    // A boot crash (vs our kill) must be surfaced, not silently retried.
    if (!child.killed && child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`round ${round} child crashed at boot: ${stderr()}`);
    }
  }

  // Final round: let it run to completion (lease 1s + sweep 150ms recovery).
  const { child: survivor, stderr: survivorStderr } = spawnWorker(dir, logFile);
  const done = await new Promise<string>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("chaos run never completed")), 60_000);
    let buffer = "";
    survivor.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const failed = /FAILED:(.*)/.exec(buffer);
      if (failed) {
        clearTimeout(timer);
        reject(new Error(`run failed: ${failed[1]}`));
      }
      const match = /DONE:(.*)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolvePromise(match[1]);
      }
    });
    survivor.on("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`survivor exited with code ${code}: ${survivorStderr()}`));
      }
    });
  });

  // 10+20+30+40+50: correct only if every step's recorded result was used
  // exactly once — no lost steps, no double-counted results.
  expect(JSON.parse(done)).toBe(150);

  // Every step's side effect fired at least once; re-execution after a
  // crash-before-record is allowed (at-least-once), but memoization must
  // keep it bounded by the number of kills.
  const lines = readFileSync(logFile, "utf8").trim().split("\n");
  for (let i = 1; i <= 5; i++) {
    const count = lines.filter((l) => l === `step-${i}`).length;
    expect(count, `step-${i} executions`).toBeGreaterThanOrEqual(1);
    expect(count, `step-${i} executions`).toBeLessThanOrEqual(KILLS + 1);
  }
}, 120_000);
