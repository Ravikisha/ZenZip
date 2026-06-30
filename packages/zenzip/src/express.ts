import { STATUS_CODES } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ZenzipApp } from "./app.js";

/**
 * Express-shaped request/response augmentation + middleware chain (P8.1).
 *
 * Pure DX sugar over the `node:http` adapter — this never touches the engine
 * or durability semantics (design rule from new_plan §3). `req`/`res` are thin
 * augmentations of the Node objects, so Express middleware muscle memory and
 * much of its ecosystem carry over.
 */

/** Augmented request — Node IncomingMessage + Express conveniences. */
export interface ZenRequest extends IncomingMessage {
  /** Pathname without query string. */
  path: string;
  /** Path parameters from ":name" route segments (set at dispatch). */
  params: Record<string, string>;
  /** Parsed query string. Repeated keys become arrays. */
  query: Record<string, string | string[]>;
  /** Parsed body (JSON object, string for non-JSON, undefined for empty). */
  body: unknown;
  /** The owning app — `req.app.workflow("x").trigger(...)` from a handler. */
  app: ZenzipApp;
  /** Case-insensitive request header lookup, Express-style. */
  get(name: string): string | undefined;
  /** Middleware may stash arbitrary per-request state. */
  [key: string]: unknown;
}

/** Augmented response — Node ServerResponse + Express conveniences. */
export interface ZenResponse extends ServerResponse {
  /** Set the status code (chainable). */
  status(code: number): this;
  /** Send a JSON body (sets content-type if unset). */
  json(data: unknown): this;
  /** Send a body: object → JSON, string/Buffer → as-is, nullish → empty. */
  send(data?: unknown): this;
  /** Set status and send its reason phrase as the body. */
  sendStatus(code: number): this;
  /** Set a response header (or a map of headers). */
  set(field: string, value: string): this;
  set(fields: Record<string, string>): this;
  /** Redirect (default 302). */
  redirect(url: string): this;
  redirect(status: number, url: string): this;
  /** Per-request scratch space shared across middleware (Express parity). */
  locals: Record<string, unknown>;
}

export type NextFunction = (err?: unknown) => void;

/** Express `(req, res, next)` middleware. */
export type Middleware = (
  req: ZenRequest,
  res: ZenResponse,
  next: NextFunction,
) => void | Promise<void>;

/** Express 4-arg `(err, req, res, next)` error-handling middleware. */
export type ErrorMiddleware = (
  err: unknown,
  req: ZenRequest,
  res: ZenResponse,
  next: NextFunction,
) => void | Promise<void>;

/** A registered middleware, with optional mount path and error/normal kind. */
export interface MiddlewareLayer {
  /** Mount path; layer runs only when req.path is at/under it. Undefined = all. */
  path?: string;
  handle: Middleware | ErrorMiddleware;
  /** Error middleware (arity ≥ 4) — runs only while an error is propagating. */
  isError: boolean;
}

/** Build a layer; classifies error middleware by Express's arity rule. */
export function middlewareLayer(
  handle: Middleware | ErrorMiddleware,
  path?: string,
): MiddlewareLayer {
  return { path, handle, isError: handle.length >= 4 };
}

/** True if a mount path covers a request path (segment-boundary match). */
export function pathMatches(mount: string, path: string): boolean {
  if (mount === "/" || mount === "") return true;
  const m = mount.endsWith("/") ? mount.slice(0, -1) : mount;
  return path === m || path.startsWith(m + "/");
}

/** Parse a query string into Express's string|string[] shape. */
function parseQuery(search: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(search.keys())) {
    const all = search.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}

// Augmentation note (P10.8): a prototype-swap variant (Object.setPrototypeOf to
// a cached chained proto carrying shared methods) was measured and REVERTED —
// per-request setPrototypeOf is a V8 deopt that cost far more than the closure
// allocations it removed (GET throughput more than halved). Plain closures win
// here; the radix router (http.ts) is where P10.8's gains actually came from.

/** In-place augment a Node request with Express conveniences. */
export function augmentRequest(req: IncomingMessage, url: URL, app: ZenzipApp): ZenRequest {
  const r = req as ZenRequest;
  r.path = url.pathname;
  // Most requests have no query string — skip the parse + Set allocation.
  r.query = url.search === "" ? {} : parseQuery(url.searchParams);
  r.params = {};
  r.app = app;
  r.get = (name: string) => {
    const v = req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  return r;
}

/** In-place augment a Node response with Express conveniences. */
export function augmentResponse(res: ServerResponse): ZenResponse {
  const r = res as ZenResponse;
  r.locals = {};
  r.status = (code: number) => {
    r.statusCode = code;
    return r;
  };
  r.set = (field: string | Record<string, string>, value?: string) => {
    if (typeof field === "string") {
      if (value !== undefined) r.setHeader(field, value);
    } else {
      for (const [k, v] of Object.entries(field)) r.setHeader(k, v);
    }
    return r;
  };
  r.json = (data: unknown) => {
    if (!r.headersSent && !r.getHeader("content-type")) {
      r.setHeader("content-type", "application/json; charset=utf-8");
    }
    r.end(JSON.stringify(data));
    return r;
  };
  r.send = (data?: unknown) => {
    if (data === undefined || data === null) {
      r.end();
      return r;
    }
    if (typeof data === "object" && !Buffer.isBuffer(data)) {
      return r.json(data);
    }
    if (!r.headersSent && !r.getHeader("content-type")) {
      r.setHeader("content-type", "text/html; charset=utf-8");
    }
    r.end(Buffer.isBuffer(data) ? data : String(data));
    return r;
  };
  r.sendStatus = (code: number) => {
    r.statusCode = code;
    if (!r.headersSent && !r.getHeader("content-type")) {
      r.setHeader("content-type", "text/plain; charset=utf-8");
    }
    r.end(STATUS_CODES[code] ?? String(code));
    return r;
  };
  r.redirect = (a: string | number, b?: string) => {
    const status = typeof a === "number" ? a : 302;
    const location = typeof a === "number" ? (b ?? "") : a;
    r.statusCode = status;
    r.setHeader("location", location);
    r.end();
    return r;
  };
  return r;
}

/**
 * Run the normal middleware pass, then `dispatch` as the terminal step. Any
 * failure — thrown, rejected, or passed to `next(err)`, from middleware OR the
 * route handler — switches to a separate pass over the 4-arg error middleware
 * (in registration order, so an error handler at the end of the chain still
 * catches a route-handler throw). If none handles it, `finalError` writes a
 * 500. An error handler advances with `next(err)`; if none of them respond,
 * the request is left to the user (Express parity).
 */
export function runMiddleware(
  layers: MiddlewareLayer[],
  req: ZenRequest,
  res: ZenResponse,
  dispatch: (onError: NextFunction) => void,
): void {
  let i = 0; // normal-pass cursor
  let ei = 0; // error-pass cursor
  let dispatched = false;
  let erroring = false;

  const settle = (r: void | Promise<unknown>, onReject: NextFunction) => {
    if (r && typeof (r as Promise<unknown>).then === "function") {
      (r as Promise<unknown>).then(undefined, onReject);
    }
  };

  const handleError: NextFunction = (err?: unknown) => {
    erroring = true;
    while (ei < layers.length) {
      const layer = layers[ei++];
      if (!layer.isError) continue;
      if (layer.path && !pathMatches(layer.path, req.path)) continue;
      try {
        settle((layer.handle as ErrorMiddleware)(err, req, res, next), handleError);
      } catch (e) {
        handleError(e);
      }
      return;
    }
    finalError(err, res);
  };

  const next: NextFunction = (err?: unknown) => {
    if (err !== undefined) {
      handleError(err);
      return;
    }
    if (erroring) return; // error handler called next() with no error — stop
    while (i < layers.length) {
      const layer = layers[i++];
      if (layer.isError) continue;
      if (layer.path && !pathMatches(layer.path, req.path)) continue;
      try {
        settle((layer.handle as Middleware)(req, res, next), handleError);
      } catch (e) {
        handleError(e);
      }
      return;
    }
    if (!dispatched) {
      dispatched = true;
      dispatch(handleError);
    }
  };

  next();
}

/**
 * Throw this from a handler/middleware for an explicit HTTP status + code
 * (P16.5): `throw new HttpError(409, "already exists", "CONFLICT")`. Any thrown
 * value still maps sensibly via `finalError` — this just makes it deliberate.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// Map framework error types to HTTP status (P16.5) — saturation/availability
// failures are 503, validation is 400, the rest fall through to 500.
const STATUS_BY_NAME: Record<string, number> = {
  QueueFullError: 503,
  CircuitOpenError: 503,
  BulkheadFullError: 503,
  ValidationError: 400,
};

/**
 * Terminal error writer (P16.5): emits a typed envelope
 * `{ error, code, status }`. Status comes from an explicit `status`/`statusCode`
 * on the error, else a known framework error type, else 500. `error` stays a
 * plain message string for back-compat; `code` and `status` are additive.
 */
export function finalError(err: unknown, res: ServerResponse): void {
  if (res.headersSent) return;
  const e = err as { status?: unknown; statusCode?: unknown; code?: string; name?: string };
  const status =
    typeof e?.status === "number"
      ? e.status
      : typeof e?.statusCode === "number"
        ? e.statusCode
        : (e?.name && STATUS_BY_NAME[e.name]) || 500;
  const message = err instanceof Error ? err.message : String(err);
  const code = e?.code ?? (err instanceof Error ? err.name : undefined);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: message, code, status }));
}
