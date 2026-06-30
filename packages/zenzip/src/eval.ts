// Built-in evals (P9.5): score agent/workflow outputs with rule-based,
// model-graded, and statistical evaluators. First-class so you can gate deploys
// and regression-test prompts the same way you unit-test code. Pure functions
// over a sample — no engine coupling.
import type { LlmProvider } from "./llm/types.js";
import type { StandardSchemaV1 } from "./types.js";

/** One thing to score: the produced `output`, with optional context. */
export interface EvalSample {
  output: string;
  /** The prompt/input that produced it (available to model-graded evaluators). */
  input?: string;
  /** A reference / gold answer (used by equals, similarity, …). */
  expected?: string;
}

/** A single evaluator's verdict. `score` is 0..1; `passed` is its own threshold. */
export interface EvalResult {
  evaluator: string;
  score: number;
  passed: boolean;
  detail?: string;
}

export interface Evaluator {
  readonly name: string;
  evaluate(sample: EvalSample): EvalResult | Promise<EvalResult>;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

// ── Rule-based ──────────────────────────────────────────────────────────────

/** Pass if the output contains `text`. */
export function contains(text: string, opts: { ignoreCase?: boolean } = {}): Evaluator {
  return {
    name: `contains(${JSON.stringify(text)})`,
    evaluate(s) {
      const hay = opts.ignoreCase ? s.output.toLowerCase() : s.output;
      const needle = opts.ignoreCase ? text.toLowerCase() : text;
      const passed = hay.includes(needle);
      return { evaluator: this.name, score: passed ? 1 : 0, passed };
    },
  };
}

/** Pass if the output matches `re`. */
export function matches(re: RegExp): Evaluator {
  return {
    name: `matches(${re})`,
    evaluate(s) {
      const passed = re.test(s.output);
      return { evaluator: this.name, score: passed ? 1 : 0, passed };
    },
  };
}

/** Exact-match against `expected` (defaults to `sample.expected`). */
export function equals(expected?: string): Evaluator {
  return {
    name: "equals",
    evaluate(s) {
      const want = expected ?? s.expected;
      const passed = want !== undefined && s.output.trim() === want.trim();
      return { evaluator: this.name, score: passed ? 1 : 0, passed };
    },
  };
}

/** Pass if the output parses as JSON (and, if given, satisfies `schema`). */
export function jsonValid(schema?: StandardSchemaV1): Evaluator {
  return {
    name: "jsonValid",
    async evaluate(s) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(s.output);
      } catch {
        return { evaluator: this.name, score: 0, passed: false, detail: "not valid JSON" };
      }
      if (!schema) return { evaluator: this.name, score: 1, passed: true };
      let result = schema["~standard"].validate(parsed);
      if (result instanceof Promise) result = await result;
      const passed = !result.issues;
      return {
        evaluator: this.name,
        score: passed ? 1 : 0,
        passed,
        detail: passed ? undefined : "JSON failed schema",
      };
    },
  };
}

// ── Statistical ─────────────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Normalized edit-distance similarity (0..1) against `reference` (defaults to
 * `sample.expected`). `passed` when similarity ≥ `threshold` (default 0.8).
 */
export function similarity(reference?: string, threshold = 0.8): Evaluator {
  return {
    name: `similarity(>=${threshold})`,
    evaluate(s) {
      const ref = reference ?? s.expected ?? "";
      const max = Math.max(s.output.length, ref.length);
      const score = max === 0 ? 1 : clamp01(1 - levenshtein(s.output, ref) / max);
      return { evaluator: this.name, score, passed: score >= threshold };
    },
  };
}

// ── Model-graded ────────────────────────────────────────────────────────────

export interface LlmJudgeOptions {
  provider: LlmProvider;
  model: string;
  /** What "good" means — the grader scores the output against this. */
  rubric: string;
  /** Pass threshold on the 0..1 score. Default: 0.5. */
  threshold?: number;
}

/**
 * Model-graded evaluator: a separate LLM scores the output against a rubric and
 * returns `{ score: 0-10, reason }`, normalized to 0..1. Use for fuzzy quality
 * ("is this a helpful, accurate answer?") that rules can't capture.
 */
export function llmJudge(opts: LlmJudgeOptions): Evaluator {
  const threshold = opts.threshold ?? 0.5;
  return {
    name: "llmJudge",
    async evaluate(s) {
      const prompt =
        `You are grading an AI output against a rubric.\n\n` +
        `Rubric: ${opts.rubric}\n\n` +
        (s.input ? `Input: ${s.input}\n\n` : "") +
        (s.expected ? `Reference answer: ${s.expected}\n\n` : "") +
        `Output to grade:\n${s.output}\n\n` +
        `Respond with ONLY JSON: {"score": <integer 0-10>, "reason": "<short>"}.`;
      const res = await opts.provider.complete({
        model: opts.model,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        maxTokens: 200,
      });
      const text = res.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      let score = 0;
      let reason = "unparseable grader response";
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]) as { score?: number; reason?: string };
          score = clamp01((Number(parsed.score) || 0) / 10);
          reason = parsed.reason ?? reason;
        } catch {
          /* leave defaults */
        }
      }
      return { evaluator: this.name, score, passed: score >= threshold, detail: reason };
    },
  };
}

// ── Runners ─────────────────────────────────────────────────────────────────

export interface EvaluationReport {
  results: EvalResult[];
  /** Mean of the evaluator scores (0..1). */
  score: number;
  /** True only if every evaluator passed. */
  passed: boolean;
}

/** Run all evaluators against one sample and aggregate. */
export async function evaluate(
  sample: EvalSample,
  evaluators: Evaluator[],
): Promise<EvaluationReport> {
  const results = await Promise.all(evaluators.map((e) => e.evaluate(sample)));
  const score = results.length ? results.reduce((a, r) => a + r.score, 0) / results.length : 1;
  return { results, score, passed: results.every((r) => r.passed) };
}

export interface SuiteReport {
  cases: EvaluationReport[];
  /** Fraction of cases where every evaluator passed (0..1). */
  passRate: number;
  /** True if every case passed — use to gate a deploy / fail a test. */
  passed: boolean;
}

/** Run a suite of samples (regression-test a prompt) and aggregate pass rate. */
export async function runEvals(
  samples: EvalSample[],
  evaluators: Evaluator[],
): Promise<SuiteReport> {
  const cases = await Promise.all(samples.map((s) => evaluate(s, evaluators)));
  const passing = cases.filter((c) => c.passed).length;
  return {
    cases,
    passRate: cases.length ? passing / cases.length : 1,
    passed: cases.every((c) => c.passed),
  };
}
