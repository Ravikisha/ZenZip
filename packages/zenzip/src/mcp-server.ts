import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ZenzipApp } from "./app.js";
import type { Duration } from "./duration.js";
import { readJsonBody } from "./http.js";

/**
 * MCP author side (P9.2b): expose this app's workflows and agents as a Model
 * Context Protocol server (Streamable HTTP / JSON-RPC), so other agents can
 * call them durably. Each workflow tool triggers a durable run; each agent
 * tool runs the agent. Symmetric with the consume side (`mcp(url)`).
 */
export interface McpServerOptions {
  port?: number;
  host?: string;
  /** Expose workflows: true = all, or an allowlist of names. Default: true. */
  workflows?: boolean | string[];
  /** Expose agents: true = all, or an allowlist of names. Default: true. */
  agents?: boolean | string[];
  /**
   * triggerAndWait timeout for workflow tools; `false` returns `{ runId }`
   * immediately (fire-and-forget). Default: "60s".
   */
  wait?: Duration | false;
  /** Require this bearer token on every request. */
  token?: string;
  /** Server name reported in `initialize`. Default: "zenzip". */
  name?: string;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
  invoke(args: Record<string, unknown>): Promise<unknown>;
}

function selected(mode: boolean | string[] | undefined, name: string): boolean {
  const m = mode ?? true;
  return Array.isArray(m) ? m.includes(name) : m;
}

function buildTools(app: ZenzipApp, options: McpServerOptions): Map<string, McpTool> {
  const tools = new Map<string, McpTool>();
  const wait = options.wait;

  for (const wf of app._listWorkflows()) {
    if (!selected(options.workflows, wf.name)) continue;
    tools.set(wf.name, {
      name: wf.name,
      description: `Run the "${wf.name}" workflow durably. Arguments are the workflow input.`,
      inputSchema: { type: "object" },
      invoke: async (args) => {
        if (wait === false) return wf.trigger(args);
        return wf.triggerAndWait(args, { timeout: wait ?? "60s" });
      },
    });
  }

  for (const agent of app._listAgents()) {
    if (!selected(options.agents, agent.name)) continue;
    if (tools.has(agent.name)) continue; // workflow with same name wins
    tools.set(agent.name, {
      name: agent.name,
      description:
        agent.options.instructions?.slice(0, 200) ?? `Run the "${agent.name}" agent.`,
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "The task or question." } },
        required: ["message"],
      },
      invoke: async (args) => {
        const result = await agent.run(String(args.message ?? ""));
        return result.output ?? result.text;
      },
    });
  }
  return tools;
}

/**
 * Build a node:http request handler implementing the MCP server protocol over
 * a single endpoint. Mount it anywhere (`http.createServer`, a route) or use
 * `app.mcpServer()` to run it standalone.
 */
export function buildMcpHandler(
  app: ZenzipApp,
  options: McpServerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const tools = buildTools(app, options);
  const token = options.token;
  const serverName = options.name ?? "zenzip";

  const authorized = (req: IncomingMessage): boolean => {
    if (!token) return true;
    const header = req.headers.authorization;
    const provided = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!provided) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(provided);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  return async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "mcp-session-id": "zenzip" });
      res.end(JSON.stringify(body));
    };
    const rpc = (id: unknown, result: unknown) => send(200, { jsonrpc: "2.0", id, result });
    const rpcError = (id: unknown, code: number, message: string) =>
      send(200, { jsonrpc: "2.0", id, error: { code, message } });

    if (req.method !== "POST") {
      send(405, { error: "method not allowed" });
      return;
    }
    if (!authorized(req)) {
      send(401, { error: "unauthorized" });
      return;
    }

    const msg = (await readJsonBody(req)) as {
      id?: unknown;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    } | undefined;
    if (!msg || typeof msg.method !== "string") {
      send(400, { error: "invalid JSON-RPC request" });
      return;
    }

    switch (msg.method) {
      case "initialize":
        return rpc(msg.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: "1" },
        });
      case "notifications/initialized":
        res.writeHead(202).end();
        return;
      case "tools/list":
        return rpc(msg.id, {
          tools: [...tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case "tools/call": {
        const tool = msg.params?.name ? tools.get(msg.params.name) : undefined;
        if (!tool) return rpcError(msg.id, -32602, `unknown tool: ${msg.params?.name}`);
        try {
          const out = await tool.invoke(msg.params?.arguments ?? {});
          const text = typeof out === "string" ? out : JSON.stringify(out ?? null);
          return rpc(msg.id, { content: [{ type: "text", text }] });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return rpc(msg.id, { content: [{ type: "text", text: message }], isError: true });
        }
      }
      default:
        return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
    }
  };
}

/** Serve the MCP handler on its own node:http server. */
export function serveMcp(
  app: ZenzipApp,
  options: McpServerOptions = {},
): Promise<Server> {
  const server = createServer(buildMcpHandler(app, options));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4200, options.host ?? "127.0.0.1", () => resolve(server));
  });
}
