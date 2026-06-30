// Google Gemini adapter (P9.7). Maps the provider-agnostic LlmRequest onto the
// Generative Language `:generateContent` API. Gemini correlates tool results by
// function *name* (not an id), so we recover the name from the preceding
// tool-use blocks when translating tool results back.
import type { LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse } from "./types.js";

export interface GoogleGeminiOptions {
  apiKey?: string;
  /** Default: https://generativelanguage.googleapis.com/v1beta */
  baseUrl?: string;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: unknown };
  functionResponse?: { name: string; response: unknown };
}

/** Map our messages to Gemini `contents` (+ a name lookup for tool results). */
function toGeminiContents(messages: LlmMessage[]): Array<{ role: string; parts: GeminiPart[] }> {
  // toolUseId → function name, harvested from every assistant tool-use block.
  const nameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const c of m.content) {
      if (c.type === "toolUse") nameById.set(c.id, c.name);
    }
  }
  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];
  for (const m of messages) {
    const parts: GeminiPart[] = [];
    for (const c of m.content) {
      if (c.type === "text") {
        if (c.text) parts.push({ text: c.text });
      } else if (c.type === "toolUse") {
        parts.push({ functionCall: { name: c.name, args: c.input ?? {} } });
      } else if (c.type === "toolResult") {
        parts.push({
          functionResponse: {
            name: nameById.get(c.toolUseId) ?? c.toolUseId,
            response: { result: c.content },
          },
        });
      }
    }
    if (parts.length === 0) continue;
    // Gemini roles: user | model. Tool results ride in a "user" turn.
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }
  return contents;
}

export function googleGemini(options: GoogleGeminiOptions = {}): LlmProvider {
  const apiKey = options.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  const baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(
    /\/$/,
    "",
  );

  return {
    name: "google-gemini",

    async complete(req: LlmRequest): Promise<LlmResponse> {
      const body: Record<string, unknown> = {
        contents: toGeminiContents(req.messages),
      };
      if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
      if (req.tools?.length) {
        body.tools = [
          {
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          },
        ];
      }
      const genConfig: Record<string, unknown> = {};
      if (req.maxTokens !== undefined) genConfig.maxOutputTokens = req.maxTokens;
      if (req.temperature !== undefined) genConfig.temperature = req.temperature;
      if (Object.keys(genConfig).length) body.generationConfig = genConfig;

      const res = await fetch(
        `${baseUrl}/models/${encodeURIComponent(req.model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { "x-goog-api-key": apiKey } : {}),
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`google-gemini: ${res.status} ${detail.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        candidates?: Array<{
          content?: { parts?: GeminiPart[] };
          finishReason?: string;
        }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const candidate = data.candidates?.[0];
      const content: LlmContent[] = [];
      let toolIndex = 0;
      for (const part of candidate?.content?.parts ?? []) {
        if (part.text) {
          content.push({ type: "text", text: part.text });
        } else if (part.functionCall) {
          // Gemini returns no call id — synthesize a stable one for correlation.
          content.push({
            type: "toolUse",
            id: `${part.functionCall.name}-${toolIndex++}`,
            name: part.functionCall.name,
            input: part.functionCall.args ?? {},
          });
        }
      }
      const finish = candidate?.finishReason;
      const stopReason = content.some((c) => c.type === "toolUse")
        ? "toolUse"
        : finish === "MAX_TOKENS"
          ? "maxTokens"
          : finish === "STOP"
            ? "endTurn"
            : "other";
      return {
        content,
        stopReason,
        usage: {
          inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    },
  };
}
