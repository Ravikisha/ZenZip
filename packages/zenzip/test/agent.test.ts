import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  handoffTool,
  mockProvider,
  mockText,
  mockToolUse,
  tool,
  zenzip,
  type ZenzipApp,
} from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): { app: ZenzipApp; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-agent-"));
  const app = zenzip({
    dataDir: dir,
    handleSignals: false,
    sweep: "200ms",
    schedulerTick: "50ms",
  });
  cleanups.push(async () => {
    await app.stop({ timeout: "5s" });
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  return { app, dir };
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("agent loop", () => {
  it("runs a tool loop: LLM -> tool -> LLM -> final answer", async () => {
    const { app } = tmpApp();
    const provider = mockProvider([
      mockToolUse("get_weather", { city: "Berlin" }, { id: "tu_1" }),
      mockText("It is 21°C in Berlin."),
    ]);
    const weather = tool({
      name: "get_weather",
      description: "Get the weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      execute: async (input: { city: string }) => ({ city: input.city, temp: 21 }),
    });
    const assistant = app.agent("assistant", {
      provider,
      model: "mock-1",
      instructions: "You are helpful.",
      tools: [weather],
    });
    await app.start();

    const result = await assistant.run("Weather in Berlin?", { timeout: "15s" });
    expect(result.text).toBe("It is 21°C in Berlin.");
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.usage.totalTokens).toBe(30); // 2 calls × (10 in + 5 out)
    expect(provider.calls).toHaveLength(2);
    // The second request carried the tool result back to the model.
    const second = provider.calls[1];
    const toolResult = second.messages.at(-1)!.content[0];
    expect(toolResult).toMatchObject({ type: "toolResult", toolUseId: "tu_1" });
  }, 20_000);

  it("retries a flaky tool WITHOUT re-calling the LLM (P4.6)", async () => {
    const { app } = tmpApp();
    const provider = mockProvider([
      mockToolUse("flaky", {}, { id: "tu_f" }),
      mockText("done"),
    ]);
    let attempts = 0;
    const flaky = tool({
      name: "flaky",
      description: "fails twice then succeeds",
      execute: async () => {
        attempts++;
        if (attempts < 3) throw new Error(`transient ${attempts}`);
        return "ok";
      },
    });
    const agent = app.agent("retrier", {
      provider,
      model: "mock-1",
      tools: [flaky],
      stepRetries: 3,
    });
    await app.start();

    const result = await agent.run("go", { timeout: "30s" });
    expect(result.text).toBe("done");
    expect(attempts).toBe(3); // tool retried
    // THE guarantee: the model was called exactly twice — the tool's two
    // failures replayed the journaled LLM response instead of re-prompting.
    expect(provider.calls).toHaveLength(2);
  }, 40_000);

  it("gates tools behind durable human approval (P4.9)", async () => {
    const { app } = tmpApp();
    const provider = mockProvider([
      mockToolUse("send_refund", { amount: 100 }, { id: "tu_refund" }),
      mockText("Refund sent."),
    ]);
    let executed = 0;
    const refund = tool({
      name: "send_refund",
      description: "Send a refund",
      requiresApproval: true,
      execute: async () => {
        executed++;
        return "refunded";
      },
    });
    const agent = app.agent("support", {
      provider,
      model: "mock-1",
      tools: [refund],
    });
    await app.start();

    const { runId } = await agent.trigger("refund order 42");
    // Reach the durable approval pause.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const run = await agent.getRun(runId);
      if (run?.status === "waitingEvent") break;
      if (Date.now() > deadline) throw new Error(`stuck in ${run?.status}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(executed).toBe(0); // nothing ran yet

    agent.approve(runId, "tu_refund");
    for (;;) {
      const run = await agent.getRun(runId);
      if (run?.status === "completed") {
        expect((run.output as { text: string }).text).toBe("Refund sent.");
        break;
      }
      if (Date.now() > deadline + 10_000) throw new Error("never completed");
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(executed).toBe(1);
  }, 30_000);

  it("deny feeds an error result to the model instead of executing", async () => {
    const { app } = tmpApp();
    const provider = mockProvider([
      mockToolUse("send_refund", { amount: 100 }, { id: "tu_d" }),
      mockText("Understood, not refunding."),
    ]);
    let executed = 0;
    const refund = tool({
      name: "send_refund",
      description: "Send a refund",
      requiresApproval: true,
      execute: async () => {
        executed++;
        return "refunded";
      },
    });
    const agent = app.agent("support2", { provider, model: "mock-1", tools: [refund] });
    await app.start();

    const { runId } = await agent.trigger("refund order 42");
    const deadline = Date.now() + 10_000;
    for (;;) {
      const run = await agent.getRun(runId);
      if (run?.status === "waitingEvent") break;
      if (Date.now() > deadline) throw new Error(`stuck in ${run?.status}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    agent.deny(runId, "tu_d", "too expensive");

    for (;;) {
      const run = await agent.getRun(runId);
      if (run?.status === "completed") break;
      if (Date.now() > deadline + 10_000) throw new Error("never completed");
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(executed).toBe(0);
    const second = provider.calls[1];
    const result = second.messages.at(-1)!.content[0];
    expect(result).toMatchObject({ type: "toolResult", isError: true });
    expect((result as { content: string }).content).toContain("too expensive");
  }, 30_000);

  it("persists session memory across runs (P4.7)", async () => {
    const { app } = tmpApp();
    const provider = mockProvider([mockText("Hi Madhur!"), mockText("Your name is Madhur.")]);
    const agent = app.agent("memoried", { provider, model: "mock-1" });
    await app.start();

    await agent.run("My name is Madhur.", { sessionId: "s1", timeout: "15s" });
    const second = await agent.run("What's my name?", { sessionId: "s1", timeout: "15s" });
    expect(second.text).toBe("Your name is Madhur.");

    // The second request included the first exchange.
    const req = provider.calls[1];
    const texts = req.messages.flatMap((m) =>
      m.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text),
    );
    expect(texts).toContain("My name is Madhur.");
    expect(texts).toContain("Hi Madhur!");

    // And the stored session has both exchanges.
    const session = await agent.session("s1");
    expect(session.length).toBe(4);
  }, 30_000);

  it("hands off to another agent as a durable child run (P4.11)", async () => {
    const { app } = tmpApp();
    const researcher = app.agent("researcher", {
      provider: mockProvider([mockText("Rust ships zero-cost abstractions.")]),
      model: "mock-1",
    });
    const planner = app.agent("planner", {
      provider: mockProvider([
        mockToolUse("ask_researcher", { message: "facts about rust" }, { id: "tu_h" }),
        (req) => {
          const last = req.messages.at(-1)!.content[0] as { content: string };
          return mockText(`Plan based on: ${last.content}`);
        },
      ]),
      model: "mock-1",
      tools: [handoffTool(researcher)],
    });
    await app.start();

    const result = await planner.run("plan rust research", { timeout: "20s" });
    expect(result.text).toBe("Plan based on: Rust ships zero-cost abstractions.");
  }, 30_000);

  it("validates structured output with a corrective round (P4.8)", async () => {
    const { app } = tmpApp();
    const provider = mockProvider([
      mockText("here you go: sentiment is positive"), // not JSON → corrective round
      mockText('{"sentiment":"positive","score":0.9}'),
    ]);
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => {
          const v = value as { sentiment?: string; score?: number };
          if (typeof v?.sentiment === "string" && typeof v?.score === "number") {
            return { value: v };
          }
          return { issues: [{ message: "need { sentiment: string, score: number }" }] };
        },
      },
    };
    const agent = app.agent("classifier", { provider, model: "mock-1", output: schema });
    await app.start();

    const result = await agent.run("classify: great product", { timeout: "15s" });
    expect(result.output).toEqual({ sentiment: "positive", score: 0.9 });
    expect(provider.calls).toHaveLength(2);
  }, 20_000);

  it("fails when maxIterations is exceeded", async () => {
    const { app } = tmpApp();
    const provider = mockProvider([mockToolUse("noop", {}, { id: "tu_loop" })]);
    const noop = tool({ name: "noop", description: "does nothing", execute: async () => "ok" });
    const agent = app.agent("looper", {
      provider,
      model: "mock-1",
      tools: [noop],
      maxIterations: 3,
      stepRetries: 0,
    });
    await app.start();

    await expect(agent.run("loop forever", { timeout: "20s" })).rejects.toThrow(
      /exceeded 3 iterations/,
    );
  }, 30_000);

  it("streams tokens for live runs (P4.10)", async () => {
    const { app } = tmpApp();
    const provider = mockProvider([mockText("streamed!")]);
    const agent = app.agent("streamer", { provider, model: "mock-1" });
    await app.start();

    const tokens: string[] = [];
    const result = await agent.run("say hi", {
      timeout: "15s",
      onToken: (t) => tokens.push(t),
    });
    expect(result.text).toBe("streamed!");
    expect(tokens.join("")).toBe("streamed!");
  }, 20_000);
});
