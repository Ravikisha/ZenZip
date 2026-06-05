import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

/** Request context handed to route handlers (P3.8). */
export interface HttpContext<B = unknown> {
  method: string;
  path: string;
  /** Path parameters from ":name" segments. */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body (undefined for empty / non-JSON bodies). */
  body: B;
  headers: IncomingHttpHeaders;
  /** Set the response status for the next json()/text()/returned value. */
  status(code: number): HttpContext<B>;
  json(data: unknown): void;
  text(data: string): void;
  req: IncomingMessage;
  res: ServerResponse;
}

export type RouteHandler = (ctx: HttpContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

export class HttpRouter {
  #routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): void {
    if (!path.startsWith("/")) {
      throw new Error(`route path must start with "/": ${path}`);
    }
    this.#routes.push({
      method: method.toUpperCase(),
      segments: path.split("/").filter(Boolean),
      handler,
    });
  }

  match(
    method: string,
    path: string,
  ): { handler: RouteHandler; params: Record<string, string> } | null {
    const parts = path.split("/").filter(Boolean);
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(":")) {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
        } else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }

  get size(): number {
    return this.#routes.length;
  }
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // non-JSON body delivered as a string
  }
}

/**
 * A plain node:http request handler over a router — mountable anywhere
 * (P3.9): `http.createServer(handler)`, Express `app.use(handler)`, or any
 * framework that exposes raw (req, res).
 */
export function makeNodeHandler(
  router: HttpRouter,
): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const matched = router.match(req.method ?? "GET", url.pathname);
    if (!matched) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    let statusCode = 200;
    let responded = false;
    const respond = (code: number, type: string, data: string) => {
      if (responded || res.headersSent) return;
      responded = true;
      res.writeHead(code, { "content-type": type });
      res.end(data);
    };

    const ctx: HttpContext = {
      method: req.method ?? "GET",
      path: url.pathname,
      params: matched.params,
      query: url.searchParams,
      body: await readJsonBody(req),
      headers: req.headers,
      status(code: number) {
        statusCode = code;
        return ctx;
      },
      json(data: unknown) {
        respond(statusCode, "application/json", JSON.stringify(data));
      },
      text(data: string) {
        respond(statusCode, "text/plain; charset=utf-8", data);
      },
      req,
      res,
    };

    try {
      const result = await matched.handler(ctx);
      // Streaming handlers (SSE) write to ctx.res directly — leave them be.
      if (!responded && !res.headersSent) {
        if (result === undefined) {
          respond(statusCode === 200 ? 204 : statusCode, "application/json", "");
        } else {
          respond(statusCode, "application/json", JSON.stringify(result));
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      respond(500, "application/json", JSON.stringify({ error: message }));
    }
  };
}

const serverSockets = new WeakMap<Server, Set<Socket>>();

/** Serve a router on node:http. Returns the listening server. */
export function serveRouter(
  router: HttpRouter,
  port: number,
  host: string,
): Promise<Server> {
  const server = createServer(makeNodeHandler(router));
  // Track live sockets so closeServer() can terminate long-lived
  // connections (SSE streams, keep-alive) instead of waiting forever.
  const sockets = new Set<Socket>();
  serverSockets.set(server, sockets);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

/**
 * Close a server created by serveRouter, destroying open connections —
 * server.close() alone never resolves while an SSE response is streaming.
 */
export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    for (const socket of serverSockets.get(server) ?? []) {
      socket.destroy();
    }
    server.close(() => resolve());
  });
}
