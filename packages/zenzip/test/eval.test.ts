// P9.5: built-in evals — rule-based, statistical, and model-graded.
import { describe, expect, it } from "vitest";

import {
  contains,
  equals,
  evaluate,
  jsonValid,
  llmJudge,
  matches,
  mockProvider,
  mockText,
  runEvals,
  similarity,
} from "../src/index.js";

describe("rule-based + statistical evaluators (P9.5)", () => {
  it("contains / matches / equals score 0 or 1", async () => {
    const r = await evaluate(
      { output: "Refund issued for order 42." },
      [contains("refund", { ignoreCase: true }), matches(/order \d+/), contains("denied")],
    );
    expect(r.results[0].passed).toBe(true);
    expect(r.results[1].passed).toBe(true);
    expect(r.results[2].passed).toBe(false);
    expect(r.passed).toBe(false); // one failed
    expect(r.score).toBeCloseTo(2 / 3, 5);
  });

  it("equals uses the sample's expected value", async () => {
    const ok = await evaluate({ output: " yes ", expected: "yes" }, [equals()]);
    expect(ok.passed).toBe(true); // trimmed exact match
    const no = await evaluate({ output: "nope", expected: "yes" }, [equals()]);
    expect(no.passed).toBe(false);
  });

  it("jsonValid checks parseability", async () => {
    expect((await evaluate({ output: '{"a":1}' }, [jsonValid()])).passed).toBe(true);
    expect((await evaluate({ output: "not json" }, [jsonValid()])).passed).toBe(false);
  });

  it("similarity scores edit distance against expected", async () => {
    const close = await evaluate({ output: "hello world", expected: "hello world!" }, [
      similarity(undefined, 0.8),
    ]);
    expect(close.passed).toBe(true);
    expect(close.score).toBeGreaterThan(0.9);
    const far = await evaluate({ output: "abc", expected: "xyz" }, [similarity(undefined, 0.8)]);
    expect(far.passed).toBe(false);
  });
});

describe("model-graded eval (P9.5)", () => {
  it("normalizes the grader's 0-10 score and applies the threshold", async () => {
    const grader = mockProvider([mockText('{"score": 8, "reason": "accurate and helpful"}')]);
    const judge = llmJudge({ provider: grader, model: "mock", rubric: "helpful + correct", threshold: 0.7 });
    const r = await judge.evaluate({ output: "Here is the answer.", input: "help me" });
    expect(r.score).toBeCloseTo(0.8, 5);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain("accurate");
  });

  it("fails closed on an unparseable grader response", async () => {
    const grader = mockProvider([mockText("I think it's pretty good honestly")]);
    const judge = llmJudge({ provider: grader, model: "mock", rubric: "x" });
    const r = await judge.evaluate({ output: "y" });
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });
});

describe("suite runner (P9.5)", () => {
  it("aggregates a pass rate across cases", async () => {
    const report = await runEvals(
      [{ output: "yes" }, { output: "yes please" }, { output: "no" }],
      [contains("yes")],
    );
    expect(report.passRate).toBeCloseTo(2 / 3, 5);
    expect(report.passed).toBe(false);
  });
});
