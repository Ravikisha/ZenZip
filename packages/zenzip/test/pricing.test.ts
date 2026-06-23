// Phase 9.7: per-model pricing → dollar accounting.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { costOf, priceFor, registerPricing, mockProvider, mockText, zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-price-"));
  const app = zenzip({ dataDir: dir, handleSignals: false });
  cleanups.push(async () => {
    try {
      await app.stop({ timeout: "5s" });
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  return app;
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("pricing (P9.7)", () => {
  it("computes USD cost from usage, by model-id prefix", () => {
    // gpt-4o: $2.5/1M in, $10/1M out
    const c = costOf("gpt-4o-2024-08-06", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(c).toBeCloseTo(12.5, 6);
    // prefix match picks the most specific (gpt-4o-mini over gpt-4o)
    const mini = priceFor("gpt-4o-mini-2024");
    expect(mini).toEqual({ input: 0.15, output: 0.6 });
    expect(costOf("totally-unknown-model", { inputTokens: 100, outputTokens: 100 })).toBeUndefined();
  });

  it("honors registerPricing overrides", () => {
    registerPricing("my-llm", { input: 1, output: 2 });
    expect(costOf("my-llm-v1", { inputTokens: 1_000_000, outputTokens: 500_000 })).toBeCloseTo(2, 6);
  });

  it("attaches costUsd to an agent result", async () => {
    const app = tmpApp();
    const a = app.agent("priced", {
      provider: mockProvider([mockText("hi", { inputTokens: 1_000_000, outputTokens: 1_000_000 })]),
      model: "claude-sonnet-4-6",
    });
    await app.start();
    const result = await a.run("hello");
    // claude-sonnet: $3 in + $15 out per 1M → 18 for 1M+1M
    expect(result.costUsd).toBeCloseTo(18, 6);
    expect(result.usage.totalTokens).toBe(2_000_000);
  });
});
