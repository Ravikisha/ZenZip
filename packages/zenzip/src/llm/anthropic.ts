// Anthropic Messages API adapter (P4.2): tool use, system + tools prompt
// caching, SSE streaming.
import type {
  LlmContent,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamHandler,
} from "./types.js";

export interface AnthropicOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Anthropic API version header. */
  version?: string;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

function toAnthropicMessages(messages: LlmMessage[]): unknown[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((c) => {
      switch (c.type) {
        case "text":
          return { type: "text", text: c.text };
        case "toolUse":
          return { type: "tool_use", id: c.id, name: c.name, input: c.input };
        case "toolResult":
          return {
            type: "tool_result",
            tool_use_id: c.toolUseId,
            content: c.content,
            ...(c.isError ? { is_error: true } : {}),
          };
      }
    }),
  }));
}

function fromAnthropicContent(blocks: AnthropicContentBlock[]): LlmContent[] {
  const out: LlmContent[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ type: "text", text: b.text });
    } else if (b.type === "tool_use") {
      out.push({ type: "toolUse", id: b.id!, name: b.name!, input: b.input });
    }
  }
  return out;
}

function mapStopReason(reason: string | null): LlmResponse["stopReason"] {
  switch (reason) {
    case "end_turn":
      return "endTurn";
    case "tool_use":
      return "toolUse";
    case "max_tokens":
      return "maxTokens";
    default:
      return "other";
  }
}

function buildBody(req: LlmRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 4096,
    messages: toAnthropicMessages(req.messages),
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.system) {
    // Prompt caching: the system prompt is stable across the agent loop.
    body.system = [
      { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
    ];
  }
  if (req.tools?.length) {
    body.tools = req.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
      // Cache breakpoint after the (stable) tool definitions.
      ...(i === req.tools!.length - 1
        ? { cache_control: { type: "ephemeral" } }
        : {}),
    }));
  }
  return body;
}

export function anthropic(options: AnthropicOptions = {}): LlmProvider {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const version = options.version ?? "2023-06-01";

  const headers = (): Record<string, string> => {
    if (!apiKey) {
      throw new Error(
        "anthropic provider: no API key (pass apiKey or set ANTHROPIC_API_KEY)",
      );
    }
    return {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": version,
    };
  };

  return {
    name: "anthropic",

    async complete(req: LlmRequest): Promise<LlmResponse> {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(buildBody(req)),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`anthropic: ${res.status} ${detail.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        content: AnthropicContentBlock[];
        stop_reason: string | null;
        usage: { input_tokens: number; output_tokens: number };
      };
      return {
        content: fromAnthropicContent(data.content),
        stopReason: mapStopReason(data.stop_reason),
        usage: {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
        },
      };
    },

    async stream(req: LlmRequest, onToken: LlmStreamHandler): Promise<LlmResponse> {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ ...buildBody(req), stream: true }),
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`anthropic stream: ${res.status} ${detail.slice(0, 300)}`);
      }

      // Accumulate the streamed events back into a complete response.
      const blocks: AnthropicContentBlock[] = [];
      const partialJson: string[] = [];
      let stopReason: string | null = null;
      let inputTokens = 0;
      let outputTokens = 0;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          let event: any;
          try {
            event = JSON.parse(dataLine.slice(5));
          } catch {
            continue;
          }
          switch (event.type) {
            case "message_start":
              inputTokens = event.message?.usage?.input_tokens ?? 0;
              break;
            case "content_block_start":
              blocks[event.index] = { ...event.content_block };
              partialJson[event.index] = "";
              break;
            case "content_block_delta":
              if (event.delta?.type === "text_delta") {
                blocks[event.index].text =
                  (blocks[event.index].text ?? "") + event.delta.text;
                onToken(event.delta.text);
              } else if (event.delta?.type === "input_json_delta") {
                partialJson[event.index] += event.delta.partial_json;
              }
              break;
            case "content_block_stop": {
              const pj = partialJson[event.index];
              if (blocks[event.index]?.type === "tool_use" && pj) {
                try {
                  blocks[event.index].input = JSON.parse(pj);
                } catch {
                  blocks[event.index].input = {};
                }
              }
              break;
            }
            case "message_delta":
              stopReason = event.delta?.stop_reason ?? stopReason;
              outputTokens = event.usage?.output_tokens ?? outputTokens;
              break;
          }
        }
      }

      return {
        content: fromAnthropicContent(blocks.filter(Boolean)),
        stopReason: mapStopReason(stopReason),
        usage: { inputTokens, outputTokens },
      };
    },
  };
}
