// OpenAI-compatible chat-completions adapter (P4.3): covers OpenAI, local
// servers (Ollama, llama.cpp, vLLM), OpenRouter — anything speaking
// /v1/chat/completions with function calling.
import type {
  LlmContent,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
} from "./types.js";

export interface OpenAiCompatibleOptions {
  apiKey?: string;
  /** e.g. "https://api.openai.com/v1", "http://localhost:11434/v1" */
  baseUrl?: string;
}

interface OaToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

function toOpenAiMessages(system: string | undefined, messages: LlmMessage[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("");
      const toolCalls: OaToolCall[] = m.content
        .filter((c) => c.type === "toolUse")
        .map((c) => {
          const tu = c as Extract<LlmContent, { type: "toolUse" }>;
          return {
            id: tu.id,
            type: "function" as const,
            function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
          };
        });
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // User message: tool results become role:"tool" messages; the rest is text.
      for (const c of m.content) {
        if (c.type === "toolResult") {
          out.push({
            role: "tool",
            tool_call_id: c.toolUseId,
            content: c.content,
          });
        }
      }
      const text = m.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("");
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

export function openaiCompatible(options: OpenAiCompatibleOptions = {}): LlmProvider {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");

  return {
    name: "openai-compatible",

    async complete(req: LlmRequest): Promise<LlmResponse> {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: toOpenAiMessages(req.system, req.messages),
      };
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }));
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`openai-compatible: ${res.status} ${detail.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        choices: Array<{
          message: { content: string | null; tool_calls?: OaToolCall[] };
          finish_reason: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = data.choices[0];
      const content: LlmContent[] = [];
      if (choice.message.content) {
        content.push({ type: "text", text: choice.message.content });
      }
      for (const call of choice.message.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* malformed args -> empty input */
        }
        content.push({ type: "toolUse", id: call.id, name: call.function.name, input });
      }
      return {
        content,
        stopReason:
          choice.finish_reason === "tool_calls"
            ? "toolUse"
            : choice.finish_reason === "length"
              ? "maxTokens"
              : choice.finish_reason === "stop"
                ? "endTurn"
                : "other",
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}
