// Phase 9.2b: MCP author — expose workflows + agents as an MCP server, and
// round-trip through the consume client (mcp()).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { mcp, mockProvider, mockText, zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-mcps-"));
  const app = zenzip({ dataDir: dir, handleSignals: false, schedulerTick: "30ms" });
  cleanups.push(async () => {
    try {
      await app.stop({ timeout: "5s" });
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  return app;
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const ctx = { runId: "r", agent: "a" };

describe("app.mcpServer (P9.2b)", () => {
  it("exposes workflows + agents, callable via mcp()", async () => {
    const app = tmpApp();
    app.workflow<{ a: number; b: number }, { sum: number }>("add", async ({ input }) => ({
      sum: input.a + input.b,
    }));
    app.agent("greeter", {
      provider: mockProvider([mockText("hello there!")]),
      model: "mock-1",
      instructions: "Greet warmly.",
    });
    await app.start();

    const { port } = await app.mcpServer({ port: 0 });
    // Consume our own server with the consume-side client (round-trip).
    const tools = await mcp(`http://127.0.0.1:${port}/`);

    expect(tools.map((t) => t.name).sort()).toEqual(["add", "greeter"]);

    // Workflow tool → durable run, JSON output.
    const add = tools.find((t) => t.name === "add")!;
    const sum = await add.execute({ a: 2, b: 3 }, ctx);
    expect(JSON.parse(sum as string)).toEqual({ sum: 5 });

    // Agent tool → runs the agent, returns its text.
    const greeter = tools.find((t) => t.name === "greeter")!;
    expect(greeter.parameters).toMatchObject({ required: ["message"] });
    const reply = await greeter.execute({ message: "hi" }, ctx);
    expect(reply).toBe("hello there!");
  });

  it("filters by allowlist and enforces a token", async () => {
    const app = tmpApp();
    app.workflow("kept", async () => "ok");
    app.workflow("hidden", async () => "no");
    await app.start();

    const { port } = await app.mcpServer({ port: 0, workflows: ["kept"], token: "secret" });
    const url = `http://127.0.0.1:${port}/`;

    // No token → mcp() initialize fails.
    await expect(mcp(url)).rejects.toThrow();

    const tools = await mcp({ url, headers: { authorization: "Bearer secret" } });
    expect(tools.map((t) => t.name)).toEqual(["kept"]); // hidden filtered out
  });
});
