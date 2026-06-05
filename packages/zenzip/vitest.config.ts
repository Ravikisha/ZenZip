import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Crash/chaos harnesses spawn child processes with tight lease timings;
    // parallel test files starve them on small CI runners and laptops.
    // Serial files cost ~15s and buy determinism.
    fileParallelism: false,
  },
});
