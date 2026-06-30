// P9.7: Google Gemini adapter — request mapping + response parsing.
import { afterEach, describe, expect, it, vi } from "vitest";

import { googleGemini } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

describe("googleGemini adapter (P9.7)", () => {
  it("maps system/tools/messages to generateContent and parses the response", async () => {
    let captured: { url: string; body: any } = { url: "", body: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url: String(url), body: JSON.parse(String(init.body)) };
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: "Booking confirmed." }] },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const gemini = googleGemini({ apiKey: "k" });
    const res = await gemini.complete({
      model: "gemini-2.0-flash",
      system: "You are a travel agent.",
      messages: [
        { role: "user", content: [{ type: "text", text: "Book a flight" }] },
        {
          role: "assistant",
          content: [{ type: "toolUse", id: "call_1", name: "book", input: { to: "NYC" } }],
        },
        { role: "user", content: [{ type: "toolResult", toolUseId: "call_1", content: "ok" }] },
      ],
      tools: [{ name: "book", description: "Book a flight", parameters: { type: "object" } }],
      maxTokens: 256,
    });

    // Request mapping.
    expect(captured.url).toContain("models/gemini-2.0-flash:generateContent");
    expect(captured.body.systemInstruction.parts[0].text).toContain("travel agent");
    expect(captured.body.tools[0].functionDeclarations[0].name).toBe("book");
    expect(captured.body.generationConfig.maxOutputTokens).toBe(256);
    // assistant → model role; toolUse → functionCall.
    const modelTurn = captured.body.contents.find((c: any) => c.role === "model");
    expect(modelTurn.parts[0].functionCall.name).toBe("book");
    // tool result correlated back to the function NAME (Gemini quirk), not the id.
    const toolTurn = captured.body.contents.at(-1);
    expect(toolTurn.parts[0].functionResponse.name).toBe("book");

    // Response parsing.
    expect(res.content).toEqual([{ type: "text", text: "Booking confirmed." }]);
    expect(res.stopReason).toBe("endTurn");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
  });

  it("parses a functionCall response into a toolUse with a synthetic id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: { parts: [{ functionCall: { name: "search", args: { q: "x" } } }] },
                  finishReason: "STOP",
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const res = await googleGemini({ apiKey: "k" }).complete({
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "find x" }] }],
    });
    expect(res.stopReason).toBe("toolUse");
    expect(res.content[0]).toMatchObject({ type: "toolUse", name: "search", input: { q: "x" } });
    expect((res.content[0] as { id: string }).id).toBeTruthy();
  });
});
