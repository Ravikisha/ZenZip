// Deterministic scripted provider for tests and offline development (P4.14).
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamHandler,
} from "./types.js";

type ScriptEntry = LlmResponse | ((req: LlmRequest) => LlmResponse);

export interface MockProvider extends LlmProvider {
  /** Every request the agent actually sent — assert call counts here. */
  calls: LlmRequest[];
}

/** Responses are consumed in order; the last entry repeats if exceeded. */
export function mockProvider(script: ScriptEntry[]): MockProvider {
  if (script.length === 0) {
    throw new Error("mockProvider needs at least one scripted response");
  }
  const calls: LlmRequest[] = [];
  const next = (req: LlmRequest): LlmResponse => {
    const entry = script[Math.min(calls.length - 1, script.length - 1)];
    return typeof entry === "function" ? entry(req) : entry;
  };
  return {
    name: "mock",
    calls,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      calls.push(req);
      return structuredClone(next(req));
    },
    async stream(req: LlmRequest, onToken: LlmStreamHandler): Promise<LlmResponse> {
      calls.push(req);
      const response = structuredClone(next(req));
      for (const block of response.content) {
        if (block.type === "text") {
          for (const ch of block.text) onToken(ch);
        }
      }
      return response;
    },
  };
}

/** Scripted final-text response. */
export function mockText(text: string, usage = { inputTokens: 10, outputTokens: 5 }): LlmResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "endTurn",
    usage,
  };
}

/** Scripted tool-call response (optionally with leading thinking text). */
export function mockToolUse(
  name: string,
  input: unknown,
  opts: { id?: string; text?: string } = {},
): LlmResponse {
  return {
    content: [
      ...(opts.text ? [{ type: "text" as const, text: opts.text }] : []),
      { type: "toolUse", id: opts.id ?? `tu_${name}_${Math.random().toString(36).slice(2, 8)}`, name, input },
    ],
    stopReason: "toolUse",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}
