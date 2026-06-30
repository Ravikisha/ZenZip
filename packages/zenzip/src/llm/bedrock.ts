// AWS Bedrock adapter (P9.7) for Anthropic Claude models. Bedrock's InvokeModel
// takes the Anthropic Messages body (minus `model`, which is in the URL) and
// requires AWS Signature V4 auth. We sign with node:crypto — no AWS SDK.
//
// NOTE: validated for request mapping + SigV4 shape via tests; not exercised
// against a live Bedrock endpoint here. Provide credentials via options or the
// standard AWS_* environment variables.
import { createHash, createHmac } from "node:crypto";

import type {
  LlmContent,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
} from "./types.js";

export interface BedrockOptions {
  /** AWS region, e.g. "us-east-1". Falls back to AWS_REGION. */
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** Bedrock anthropic_version. Default: "bedrock-2023-05-31". */
  anthropicVersion?: string;
  /** Injected clock for deterministic signing in tests. */
  now?: () => Date;
}

interface AnthropicBlock {
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

function fromAnthropicContent(blocks: AnthropicBlock[]): LlmContent[] {
  const out: LlmContent[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") out.push({ type: "text", text: b.text });
    else if (b.type === "tool_use")
      out.push({ type: "toolUse", id: b.id!, name: b.name!, input: b.input });
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

const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data, "utf8").digest();
const sha256hex = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");

/** Build AWS SigV4 headers for a POST request. Exported for testing. */
export function sigv4Headers(args: {
  region: string;
  service: string;
  method: string;
  host: string;
  path: string;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  date: Date;
}): Record<string, string> {
  const { region, service, method, host, path, body, accessKeyId, secretAccessKey, sessionToken } =
    args;
  const amzDate = args.date.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);

  let canonicalHeaders =
    `content-type:application/json\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  let signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  if (sessionToken) {
    canonicalHeaders += `x-amz-security-token:${sessionToken}\n`;
    signedHeaders += ";x-amz-security-token";
  }

  const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join(
    "\n",
  );
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    authorization,
    "content-type": "application/json",
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    ...(sessionToken ? { "x-amz-security-token": sessionToken } : {}),
  };
}

export function bedrock(options: BedrockOptions = {}): LlmProvider {
  const region = options.region ?? process.env.AWS_REGION ?? "us-east-1";
  const accessKeyId = options.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = options.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = options.sessionToken ?? process.env.AWS_SESSION_TOKEN;
  const anthropicVersion = options.anthropicVersion ?? "bedrock-2023-05-31";
  const now = options.now ?? (() => new Date());

  return {
    name: "bedrock",

    async complete(req: LlmRequest): Promise<LlmResponse> {
      if (!accessKeyId || !secretAccessKey) {
        throw new Error(
          "bedrock provider: missing AWS credentials (set accessKeyId/secretAccessKey or AWS_* env)",
        );
      }
      const host = `bedrock-runtime.${region}.amazonaws.com`;
      const path = `/model/${encodeURIComponent(req.model)}/invoke`;
      const payload: Record<string, unknown> = {
        anthropic_version: anthropicVersion,
        max_tokens: req.maxTokens ?? 4096,
        messages: toAnthropicMessages(req.messages),
      };
      if (req.system) payload.system = req.system;
      if (req.temperature !== undefined) payload.temperature = req.temperature;
      if (req.tools?.length) {
        payload.tools = req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }));
      }
      const body = JSON.stringify(payload);
      const headers = sigv4Headers({
        region,
        service: "bedrock",
        method: "POST",
        host,
        path,
        body,
        accessKeyId,
        secretAccessKey,
        sessionToken,
        date: now(),
      });

      const res = await fetch(`https://${host}${path}`, { method: "POST", headers, body });
      if (!res.ok) {
        throw new Error(`bedrock: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        content: AnthropicBlock[];
        stop_reason: string | null;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      return {
        content: fromAnthropicContent(data.content ?? []),
        stopReason: mapStopReason(data.stop_reason),
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}
