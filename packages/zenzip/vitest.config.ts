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
  },
});
