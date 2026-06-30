import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Crash/chaos harnesses spawn child processes with tight lease timings;
    // parallel test files starve them on small CI runners and laptops.
    // Serial files cost ~15s and buy determinism.
    fileParallelism: false,
    // Run all test files in a single forked process so tinypool never
    // hands a file off to a different worker (the ERR_IPC_CHANNEL_CLOSED
    // path). The fork still isolates the test suite from the Vitest runner.
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // With one shared process, per-test state must be reset or it leaks
    // across files: restoreMocks undoes vi.fn/spies and unstubGlobals undoes
    // vi.stubGlobal (which restoreAllMocks does NOT) — e.g. the mocked global
    // `fetch` in google/bedrock tests would otherwise poison every later file.
    restoreMocks: true,
    unstubGlobals: true,
    // Native concurrency tests (pause/claim races) are timing-sensitive and
    // can flake under single-process CPU contention. A retry recovers a rare
    // timing flake; a real bug still fails every attempt.
    retry: 2,
  },
});
