import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import type { ZenzipApp } from "./app.js";
import {
  augmentRequest,
  augmentResponse,
  finalError,
  runMiddleware,
  type MiddlewareLayer,
  type NextFunction,
  type ZenRequest,
  type ZenResponse,
} from "./express.js";

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

/** Single-arg handler: the typed runtime context (original ZenZip surface). */
export type CtxHandler = (ctx: HttpContext) => unknown | Promise<unknown>;

/**
 * Express-familiar handler (P8.2): `(req, res)` or `(req, res, next)`. Detected
 * by arity ≥ 2. Respond via `res.json()/send()/...`; calling `next()` falls
 * through to a 404, `next(err)` enters the error middleware chain. A returned
 * value (when nothing was sent) is JSON-encoded as a convenience.
 */
export type ExpressHandler = (
  req: ZenRequest,
  res: ZenResponse,
  next: NextFunction,
) => unknown | Promise<unknown>;

/** A route handler in either supported shape (chosen at dispatch by arity). */
export type RouteHandler = CtxHandler | ExpressHandler;

/** A node in the per-method route trie (P10.8). */
class RouteNode {
  /** Static-segment children, keyed by the literal segment. */
  children = new Map<string, RouteNode>();
  /** Wildcard `:name` child (at most one per node); static children win. */
  paramChild: RouteNode | null = null;
  /** Param name captured when descending into paramChild. */
  paramName: string | null = null;
  /** Terminal handler for a path ending here (null = not a leaf). */
  handler: RouteHandler | null = null;
}

/**
 * Radix/trie router (P10.8) — O(path-depth) match instead of O(routes) linear
 * scan, no per-request route-array allocation. One trie per HTTP method; static
 * segments take priority over `:param` segments at each level. First registered
 * handler wins on a conflict (no overwrite), preserving the old linear
 * first-match semantics so user routes still override later built-ins
 * (e.g. /healthz, /readyz registered after user routes).
 */
export class HttpRouter {
  #trees = new Map<string, RouteNode>();
  #size = 0;

  add(method: string, path: string, handler: CtxHandler): void;
  add(method: string, path: string, handler: ExpressHandler): void;
  add(method: string, path: string, handler: RouteHandler): void {
    if (!path.startsWith("/")) {
      throw new Error(`route path must start with "/": ${path}`);
    }
    const m = method.toUpperCase();
    let node = this.#trees.get(m);
    if (!node) {
      node = new RouteNode();
      this.#trees.set(m, node);
    }
    for (const seg of path.split("/")) {
      if (seg === "") continue;
      if (seg.startsWith(":")) {
        if (!node.paramChild) {
          node.paramChild = new RouteNode();
          node.paramName = seg.slice(1);
        }
        node = node.paramChild;
      } else {
        let child = node.children.get(seg);
        if (!child) {
          child = new RouteNode();
          node.children.set(seg, child);
        }
        node = child;
      }
    }
    if (node.handler === null) {
      node.handler = handler; // first-match-wins
      this.#size++;
    }
  }

  match(
    method: string,
    path: string,
  ): { handler: RouteHandler; params: Record<string, string> } | null {
    const root = this.#trees.get(method);
    if (!root) return null;
    let node: RouteNode = root;
    const params: Record<string, string> = {};
    let start = 0;
    const len = path.length;
    // Walk segments by slicing between "/" boundaries — no array allocation.
    while (start < len) {
      if (path.charCodeAt(start) === 47 /* "/" */) {
        start++;
        continue;
      }
      let end = path.indexOf("/", start);
      if (end === -1) end = len;
      const seg = path.slice(start, end);
      const child = node.children.get(seg);
      if (child) {
        node = child;
      } else if (node.paramChild) {
        params[node.paramName as string] = decodeURIComponent(seg);
        node = node.paramChild;
      } else {
        return null;
      }
      start = end + 1;
    }
    return node.handler ? { handler: node.handler, params } : null;
  }

  get size(): number {
    return this.#size;
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

/** What makeNodeHandler/serveRouter need to serve requests. */
export interface HandlerConfig {
  router: HttpRouter;
  /** Express-style middleware chain (P8.1). Runs before route dispatch. */
  middleware?: MiddlewareLayer[];
  /** Owning app, exposed as `req.app` to handlers/middleware. */
  app?: ZenzipApp;
}

function toConfig(arg: HttpRouter | HandlerConfig): HandlerConfig {
  return arg instanceof HttpRouter ? { router: arg } : arg;
}

/**
 * Match a route and run its ctx handler against the already-augmented req/res.
 * The body was parsed once during augmentation (the stream is consumed), so it
 * is reused here rather than re-read. A handler throw/reject is forwarded to
 * `onError` (the middleware error chain), not swallowed into a 500 directly.
 */
async function dispatchRoute(
  router: HttpRouter,
  req: ZenRequest,
  res: ServerResponse,
  onError: NextFunction,
  url: URL,
): Promise<void> {
  const matched = router.match(req.method ?? "GET", req.path);
  if (!matched) {
    if (!res.headersSent) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
    return;
  }
  req.params = matched.params;
  const handler = matched.handler;

  // Express-familiar (req, res, next) handler — arity ≥ 2 (P8.2).
  if (handler.length >= 2) {
    const eres = res as ZenResponse;
    let nexted = false;
    const next: NextFunction = (err?: unknown) => {
      nexted = true;
      if (err !== undefined) {
        onError(err);
      } else if (!res.headersSent) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    };
    try {
      const result = await (handler as ExpressHandler)(req, eres, next);
      if (!res.headersSent && !nexted) {
        if (result === undefined) {
          res.statusCode = res.statusCode === 200 ? 204 : res.statusCode;
          res.end();
        } else {
          eres.json(result);
        }
      }
    } catch (e) {
      onError(e);
    }
    return;
  }

  let statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 200;
  let responded = false;
  const respond = (code: number, type: string, data: string) => {
    if (responded || res.headersSent) return;
    responded = true;
    res.writeHead(code, { "content-type": type });
    res.end(data);
  };

  const ctx: HttpContext = {
    method: req.method ?? "GET",
    path: req.path,
    params: matched.params,
    query: url.searchParams, // reuse the URL already parsed in makeNodeHandler
    body: req.body,
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
    const result = await (handler as CtxHandler)(ctx);
    // Streaming/Express handlers (SSE, res.json) write to res directly — leave
    // them be once anything was sent.
    if (!responded && !res.headersSent) {
      if (result === undefined) {
        respond(statusCode === 200 ? 204 : statusCode, "application/json", "");
      } else {
        respond(statusCode, "application/json", JSON.stringify(result));
      }
    }
  } catch (e) {
    onError(e);
  }
}

/**
 * A plain node:http request handler — mountable anywhere (P3.9):
 * `http.createServer(handler)`, Express `app.use(handler)`, or any framework
 * that exposes raw (req, res). Accepts a bare router (back-compat) or a full
 * HandlerConfig with the Express middleware chain (P8.1).
 */
export function makeNodeHandler(
  arg: HttpRouter | HandlerConfig,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { router, middleware = [], app } = toConfig(arg);
  return async (rawReq, rawRes) => {
    const url = new URL(rawReq.url ?? "/", "http://localhost");
    const req = augmentRequest(rawReq, url, app as ZenzipApp);
    const res = augmentResponse(rawRes);
    // Parse the body once, up front — middleware and the route handler share
    // it; the request stream can only be consumed once. Skip the read entirely
    // for methods that carry no body (GET/HEAD/OPTIONS) and for bodies declared
    // empty — `for await (const chunk of req)` otherwise forces an extra
    // event-loop turn on every body-less request (the dominant GET overhead).
    const method = rawReq.method ?? "GET";
    const mayHaveBody =
      method !== "GET" &&
      method !== "HEAD" &&
      method !== "OPTIONS" &&
      rawReq.headers["content-length"] !== "0";
    req.body = mayHaveBody ? await readJsonBody(rawReq) : undefined;

    if (middleware.length === 0) {
      await dispatchRoute(router, req, res, (e) => finalError(e, res), url);
      return;
    }
    runMiddleware(middleware, req, res, (onError) => {
      void dispatchRoute(router, req, res, onError, url);
    });
  };
}

const serverSockets = new WeakMap<Server, Set<Socket>>();

/** Serve a router (or full handler config) on node:http. */
export function serveRouter(
  arg: HttpRouter | HandlerConfig,
  port: number,
  host: string,
): Promise<Server> {
  const server = createServer(makeNodeHandler(arg));
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
 * Graceful HTTP drain (P15.3): stop accepting new connections, free idle
 * keep-alive sockets immediately, let in-flight requests finish for up to
 * `drainMs`, then force-close any stragglers (e.g. SSE streams that never end).
 * The other half of zero-downtime deploys (the queue drain in app.stop is the
 * first half). Resolves as soon as connections are gone or the deadline hits.
 */
export function closeServer(server: Server, drainMs = 5_000): Promise<void> {
  type Closable = Server & {
    closeIdleConnections?: () => void;
    closeAllConnections?: () => void;
  };
  const s = server as Closable;
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    server.close(() => done()); // resolves once all connections have ended
    // Idle keep-alive sockets would otherwise hold close() open — free them now.
    s.closeIdleConnections?.();
    const timer = setTimeout(() => {
      // Force-close whatever is left (in-flight past the deadline, SSE, …).
      if (s.closeAllConnections) {
        s.closeAllConnections();
      } else {
        for (const socket of serverSockets.get(server) ?? []) socket.destroy();
      }
      done();
    }, drainMs);
    if (typeof timer.unref === "function") timer.unref();
  });
}
