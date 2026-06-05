// Provider-agnostic LLM surface (P4.1). Everything here is JSON-serializable
// by design — responses are journaled as workflow step results, which is what
// makes agent loops durable.

export type LlmContent =
  | { type: "text"; text: string }
  | { type: "toolUse"; id: string; name: string; input: unknown }
  | { type: "toolResult"; toolUseId: string; content: string; isError?: boolean };

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmContent[];
}

/** Tool definition as the model sees it: JSON Schema parameters. */
export interface LlmToolDef {
  name: string;
  description: string;
  parameters: object;
}

export interface LlmRequest {
  model: string;
  system?: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  maxTokens?: number;
  temperature?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  content: LlmContent[];
  stopReason: "endTurn" | "toolUse" | "maxTokens" | "other";
  usage: LlmUsage;
}

export type LlmStreamHandler = (token: string) => void;

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
  /**
   * Optional streaming variant: emit text tokens as they arrive, resolve the
   * same final LlmResponse as complete(). Used when the caller passes
   * onToken AND the run is executing live (memoized replays never re-stream).
   */
  stream?(req: LlmRequest, onToken: LlmStreamHandler): Promise<LlmResponse>;
}

export function textContent(response: LlmResponse): string {
  return response.content
    .filter((c): c is Extract<LlmContent, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}

export function toolUses(
  response: LlmResponse,
): Array<Extract<LlmContent, { type: "toolUse" }>> {
  return response.content.filter(
    (c): c is Extract<LlmContent, { type: "toolUse" }> => c.type === "toolUse",
  );
}
