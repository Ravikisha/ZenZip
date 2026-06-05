// zenzip/testing (P6.4): the helpers every zenzip test suite needs —
// a throwaway app on a temp store with fast timings, condition waiting,
// and run-status polling. Pair with mockProvider/mockText/mockToolUse
// (re-exported here) for deterministic agent tests.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zenzip, ZenzipApp } from "./app.js";
import type { ZenzipOptions } from "./types.js";
import type { RunStatus } from "./workflow.js";

export { mockProvider, mockText, mockToolUse } from "./llm/mock.js";

export interface TestApp {
  app: ZenzipApp;
  /** The temp data dir (useful for restart-style tests: same dir, new app). */
  dataDir: string;
  /** Graceful stop + best-effort temp cleanup. Call in afterEach. */
  cleanup: () => Promise<void>;
}

/**
 * A zenzip app on a fresh temp store with test-friendly timings:
 * 200ms lease sweep, 50ms scheduler tick, no signal handlers.
 */
export function createTestApp(options: ZenzipOptions = {}): TestApp {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "zenzip-test-"));
  const app = zenzip({
    handleSignals: false,
    sweep: "200ms",
    schedulerTick: "50ms",
    ...options,
    dataDir,
  });
  return {
    app,
    dataDir,
    cleanup: async () => {
      await app.stop({ timeout: "5s" });
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* temp dir — OS cleans up */
      }
    },
  };
}

export interface WaitOptions {
  /** Default: 5000 */
  timeoutMs?: number;
  /** Default: 25 */
  intervalMs?: number;
  /** Included in the timeout error. */
  label?: string;
}

/** Poll a condition (sync or async) until truthy or timeout. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: WaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms${options.label ? `: ${options.label}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

interface RunSnapshot {
  status: RunStatus;
  output?: unknown;
  error?: string;
}

/** Anything with getRun(runId) — Workflow and Agent both qualify. */
interface HasGetRun {
  getRun(runId: string): Promise<RunSnapshot | null>;
}

/**
 * Wait until a run reaches the given status. Fails fast (with the run's
 * error) if the run terminates in a different state first.
 */
export async function waitForRunStatus(
  source: HasGetRun,
  runId: string,
  status: RunStatus,
  options: WaitOptions = {},
): Promise<RunSnapshot> {
  const terminal: RunStatus[] = ["completed", "failed", "cancelled"];
  let last: RunSnapshot | null = null;
  await waitFor(
    async () => {
      last = await source.getRun(runId);
      if (!last) return false;
      if (last.status === status) return true;
      // Don't spin forever if the run terminated differently.
      if (terminal.includes(last.status) && !terminal.includes(status)) {
        throw new Error(
          `run ${runId} reached terminal status "${last.status}" while waiting for "${status}"${
            last.error ? ` (${last.error})` : ""
          }`,
        );
      }
      return false;
    },
    { label: `run ${runId} → ${status}`, ...options },
  );
  return last!;
}
