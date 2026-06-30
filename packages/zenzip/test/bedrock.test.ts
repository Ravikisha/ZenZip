// P9.7: AWS Bedrock adapter — SigV4 signing + Anthropic-on-Bedrock mapping.
import { afterEach, describe, expect, it, vi } from "vitest";

import { bedrock } from "../src/index.js";
import { sigv4Headers } from "../src/llm/bedrock.js";

afterEach(() => vi.restoreAllMocks());

describe("sigv4Headers (P9.7)", () => {
  it("produces a well-formed AWS4 authorization header", () => {
    const h = sigv4Headers({
      region: "us-east-1",
      service: "bedrock",
      method: "POST",
      host: "bedrock-runtime.us-east-1.amazonaws.com",
      path: "/model/anthropic.claude-3-sonnet/invoke",
      body: '{"hello":"world"}',
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret",
      date: new Date("2024-01-02T03:04:05.000Z"),
    });
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20240102\/us-east-1\/bedrock\/aws4_request/);
    expect(h.authorization).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date");
    expect(h["x-amz-date"]).toBe("20240102T030405Z");
    // Deterministic: same inputs → same signature.
    const again = sigv4Headers({
      region: "us-east-1",
      service: "bedrock",
      method: "POST",
      host: "bedrock-runtime.us-east-1.amazonaws.com",
      path: "/model/anthropic.claude-3-sonnet/invoke",
      body: '{"hello":"world"}',
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret",
      date: new Date("2024-01-02T03:04:05.000Z"),
    });
    expect(again.authorization).toBe(h.authorization);
  });

  it("adds the session-token header when present", () => {
    const h = sigv4Headers({
      region: "eu-west-1",
      service: "bedrock",
      method: "POST",
      host: "h",
      path: "/p",
      body: "{}",
      accessKeyId: "k",
      secretAccessKey: "s",
      sessionToken: "tok",
      date: new Date("2024-01-02T03:04:05.000Z"),
    });
    expect(h["x-amz-security-token"]).toBe("tok");
    expect(h.authorization).toContain("x-amz-security-token");
  });
});

describe("bedrock provider (P9.7)", () => {
  it("signs, maps the Anthropic body, and parses the response", async () => {
    let captured: { url: string; headers: Record<string, string>; body: any } = {
      url: "",
      headers: {},
      body: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        captured = {
          url: String(url),
          headers: init.headers as Record<string, string>,
          body: JSON.parse(String(init.body)),
        };
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "Hello from Bedrock." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 9, output_tokens: 3 },
          }),
          { status: 200 },
        );
      }),
    );

    const provider = bedrock({ region: "us-east-1", accessKeyId: "k", secretAccessKey: "s" });
    const res = await provider.complete({
      model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
      system: "Be concise.",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxTokens: 128,
    });

    expect(captured.url).toContain("bedrock-runtime.us-east-1.amazonaws.com/model/");
    expect(captured.url).toMatch(/\/invoke$/);
    expect(captured.headers.authorization).toContain("AWS4-HMAC-SHA256");
    expect(captured.body.anthropic_version).toBe("bedrock-2023-05-31");
    expect(captured.body.model).toBeUndefined(); // model is in the URL, not the body
    expect(captured.body.system).toBe("Be concise.");
    expect(res.content).toEqual([{ type: "text", text: "Hello from Bedrock." }]);
    expect(res.stopReason).toBe("endTurn");
    expect(res.usage).toEqual({ inputTokens: 9, outputTokens: 3 });
  });
});
