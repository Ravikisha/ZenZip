import type { AgentTool } from "./agent.js";
import { assertPublicUrl, type SsrfOptions } from "./ssrf.js";

/**
 * MCP integration — consume side (P9.2). Connect to a Model Context Protocol
 * server over Streamable HTTP, list its tools, and expose them as ZenZip
 * agent tools. Because connecting is async, spread the result into an agent's
 * `tools`:
 *
 *   const app = zenzip();
 *   app.agent("research", {
 *     model: anthropic(),
 *     tools: [...(await mcp("https://mcp.example.com/")), localTool],
 *   });
 *
 * Calls run inside the agent's journaled tool steps, so an MCP tool call is
 * durable and retried like any other step.
 */

export interface McpOptions {
  url: string;
  /** Extra headers (auth, etc.) sent on every request. */
  headers?: Record<string, string>;
  /** Prefix added to tool names (avoids collisions across servers). */
  prefix?: string;
  /**
   * SSRF guard (P7.16): validate the server URL is public before connecting.
   * Off by default (local MCP servers are common in dev); set for prod to block
   * internal/metadata targets. `true` = default guard; or pass options.
   */
  ssrf?: boolean | SsrfOptions;
}

interface JsonRpcResponse {
  result?: { tools?: McpToolDef[]; content?: unknown; [k: string]: unknown };
  error?: { code: number; message: string };
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: object;
}

/** Pull the first JSON-RPC message out of an SSE body. */
function firstSseMessage(body: string): JsonRpcResponse {
  const data = body
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("");
  return JSON.parse(data) as JsonRpcResponse;
}

/** Render MCP tool-result content into a string for the model. */
function contentToString(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && "text" in c
          ? String((c as { text: unknown }).text)
          : JSON.stringify(c),
      )
      .join("\n");
  }
  return typeof content === "string" ? content : JSON.stringify(content ?? null);
}

/** Minimal MCP client over Streamable HTTP (JSON-RPC 2.0). */
class McpHttpClient {
  #url: string;
  #headers: Record<string, string>;
  #id = 0;
  #session: string | undefined;

  constructor(url: string, headers: Record<string, string>) {
    this.#url = url;
    this.#headers = headers;
  }

  async #send(method: string, params: unknown, expectReply: boolean): Promise<JsonRpcResponse | null> {
    const res = await fetch(this.#url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.#session ? { "mcp-session-id": this.#session } : {}),
        ...this.#headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, params }),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.#session = sid;
    if (!res.ok) throw new Error(`MCP ${method}: HTTP ${res.status}`);
    if (!expectReply) return null;
    const ct = res.headers.get("content-type") ?? "";
    const msg = ct.includes("text/event-stream")
      ? firstSseMessage(await res.text())
      : ((await res.json()) as JsonRpcResponse);
    if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message}`);
    return msg;
  }

  async initialize(): Promise<void> {
    await this.#send(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "zenzip", version: "0" },
      },
      true,
    );
    // notifications/initialized has no id and expects no reply.
    await fetch(this.#url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.#session ? { "mcp-session-id": this.#session } : {}),
        ...this.#headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }).catch(() => {});
  }

  async listTools(): Promise<McpToolDef[]> {
    const msg = await this.#send("tools/list", {}, true);
    return (msg?.result?.tools ?? []) as McpToolDef[];
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const msg = await this.#send("tools/call", { name, arguments: args }, true);
    return contentToString(msg?.result?.content);
  }
}

/**
 * Connect to an MCP server and return its tools as ZenZip agent tools (P9.2).
 */
export async function mcp(target: string | McpOptions): Promise<AgentTool[]> {
  const opts: McpOptions = typeof target === "string" ? { url: target } : target;
  if (opts.ssrf) {
    await assertPublicUrl(opts.url, opts.ssrf === true ? {} : opts.ssrf);
  }
  const client = new McpHttpClient(opts.url, opts.headers ?? {});
  await client.initialize();
  const defs = await client.listTools();
  return defs.map((def) => ({
    name: opts.prefix ? `${opts.prefix}${def.name}` : def.name,
    description: def.description ?? `MCP tool ${def.name}`,
    parameters: def.inputSchema ?? { type: "object" },
    execute: (input: unknown) => client.callTool(def.name, input),
  }));
}
