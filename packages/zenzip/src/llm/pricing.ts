import type { LlmUsage } from "./types.js";

/**
 * Per-model pricing → dollar accounting (P9.7). Token usage is recorded per
 * agent run; this turns it into a USD cost. Prices are USD per 1M tokens and
 * are matched by model-id prefix (ids carry dates/suffixes). They drift —
 * override with `registerPricing()` or pass your own table; treat the built-ins
 * as sensible defaults, not a contract.
 */
export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

const PRICING = new Map<string, ModelPrice>([
  // Anthropic Claude (per 1M tokens).
  ["claude-opus", { input: 15, output: 75 }],
  ["claude-sonnet", { input: 3, output: 15 }],
  ["claude-haiku", { input: 0.8, output: 4 }],
  ["claude-3-opus", { input: 15, output: 75 }],
  ["claude-3-5-sonnet", { input: 3, output: 15 }],
  ["claude-3-5-haiku", { input: 0.8, output: 4 }],
  ["claude-3-haiku", { input: 0.25, output: 1.25 }],
  // OpenAI.
  ["gpt-4o-mini", { input: 0.15, output: 0.6 }],
  ["gpt-4o", { input: 2.5, output: 10 }],
  ["gpt-4.1-mini", { input: 0.4, output: 1.6 }],
  ["gpt-4.1", { input: 2, output: 8 }],
  ["o3-mini", { input: 1.1, output: 4.4 }],
  ["o1-mini", { input: 1.1, output: 4.4 }],
  // Google Gemini (via OpenAI-compatible endpoints).
  ["gemini-1.5-flash", { input: 0.075, output: 0.3 }],
  ["gemini-1.5-pro", { input: 1.25, output: 5 }],
  ["gemini-2.0-flash", { input: 0.1, output: 0.4 }],
]);

/** Register or override pricing for a model id (or id prefix). */
export function registerPricing(modelPrefix: string, price: ModelPrice): void {
  PRICING.set(modelPrefix, price);
}

/** Look up the price for a model id by longest matching prefix. */
export function priceFor(model: string): ModelPrice | undefined {
  let best: ModelPrice | undefined;
  let bestLen = -1;
  for (const [prefix, price] of PRICING) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = price;
      bestLen = prefix.length;
    }
  }
  return best;
}

/** USD cost of `usage` for `model`, or undefined when the model is unpriced. */
export function costOf(model: string, usage: LlmUsage): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  return (usage.inputTokens / 1e6) * price.input + (usage.outputTokens / 1e6) * price.output;
}
