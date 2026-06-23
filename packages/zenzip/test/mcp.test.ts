// Phase 9.2: MCP consume — connect to an MCP server, expose its tools.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { mcp } from "../src/index.js";

const servers: Server[] = [];

/** A minimal MCP-over-HTTP (JSON-RPC) server for the test. */
function mockMcpServer(): Promise<{ url: string; sawSession: () => string | undefined }> {
  let sawSession: string | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body) as { id?: number; method: string; params?: any };
      res.setHeader("mcp-session-id", "sess-1");
      res.setHeader("content-type", "application/json");
      const reply = (result: unknown) =>
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      switch (msg.method) {
        case "initialize":
          return reply({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock", version: "1" } });
        case "notifications/initialized":
          res.statusCode = 202;
          return res.end();
        case "tools/list":
          return reply({
            tools: [
              {
                name: "echo",
                description: "Echo text",
                inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
              },
              { name: "boom", description: "Always errors" },
            ],
          });
        case "tools/call": {
          sawSession = req.headers["mcp-session-id"] as string | undefined;
          if (msg.params.name === "boom") {
            return res.end(
              JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "kaboom" } }),
            );
          }
          return reply({ content: [{ type: "text", text: `echoed: ${msg.params.arguments.text}` }] });
        }
        default:
          res.statusCode = 400;
          return res.end();
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, sawSession: () => sawSession });
    });
  });
}

afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

const ctx = { runId: "r1", agent: "a" };

describe("mcp() consume (P9.2)", () => {
  it("lists MCP tools as agent tools and calls them", async () => {
    const { url, sawSession } = await mockMcpServer();
    const tools = await mcp(url);

    expect(tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);
    const echo = tools.find((t) => t.name === "echo")!;
    expect(echo.description).toBe("Echo text");
    expect((echo.parameters as { properties?: object }).properties).toBeDefined();

    const out = await echo.execute({ text: "hi" }, ctx);
    expect(out).toBe("echoed: hi");
    expect(sawSession()).toBe("sess-1"); // session id propagated after initialize
  });

  it("propagates tool errors and applies a name prefix", async () => {
    const { url } = await mockMcpServer();
    const tools = await mcp({ url, prefix: "srv_" });

    expect(tools.map((t) => t.name).sort()).toEqual(["srv_boom", "srv_echo"]);
    const boom = tools.find((t) => t.name === "srv_boom")!;
    await expect(boom.execute({}, ctx)).rejects.toThrow(/kaboom/);
  });
});
