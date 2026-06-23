import { timingSafeEqual } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

import { ms, type Duration } from "./duration.js";
import type { Middleware, ZenRequest } from "./express.js";
import type { StandardSchemaV1 } from "./types.js";

/**
 * Built-in middleware shipped with the framework (P8.6). All are plain
 * `(req, res, next)` functions — `app.use(zenzip.cors())`, etc. The request
 * body is already read once by the HTTP adapter; the body parsers here refine
 * that raw value in place (JSON → object, form → object) and are opt-in so the
 * behavior is explicit, Express-style.
 */

function contentType(req: { headers: Record<string, unknown> }): string {
  const ct = req.headers["content-type"];
  return typeof ct === "string" ? ct : "";
}

/** Parse JSON request bodies into `req.body` (refines the pre-read raw body). */
export function json(): Middleware {
  return (req, _res, next) => {
    if (typeof req.body === "string" && contentType(req).includes("application/json")) {
      try {
        req.body = JSON.parse(req.body);
      } catch {
        /* leave the raw string in place */
      }
    }
    next();
  };
}

/** Parse `application/x-www-form-urlencoded` bodies into `req.body`. */
export function urlencoded(): Middleware {
  return (req, _res, next) => {
    if (
      typeof req.body === "string" &&
      contentType(req).includes("application/x-www-form-urlencoded")
    ) {
      const params = new URLSearchParams(req.body);
      const out: Record<string, string | string[]> = {};
      for (const key of new Set(params.keys())) {
        const all = params.getAll(key);
        out[key] = all.length > 1 ? all : all[0];
      }
      req.body = out;
    }
    next();
  };
}

export interface CorsOptions {
  /** Allowed origin(s). `true` reflects the request origin. Default: "*". */
  origin?: string | string[] | boolean;
  /** Allowed methods. Default: all common verbs. */
  methods?: string;
  /** Allowed request headers. Default: reflects the preflight request. */
  allowedHeaders?: string;
  /** Send `Access-Control-Allow-Credentials: true`. Default: false. */
  credentials?: boolean;
  /** `Access-Control-Max-Age` in seconds for preflight caching. */
  maxAge?: number;
}

/** CORS headers + automatic OPTIONS preflight handling. */
export function cors(options: CorsOptions = {}): Middleware {
  const { origin = "*", methods, allowedHeaders, credentials, maxAge } = options;
  return (req, res, next) => {
    const reqOrigin = req.get("origin");
    let allow: string | undefined;
    if (origin === true) {
      allow = reqOrigin ?? "*";
    } else if (Array.isArray(origin)) {
      allow = reqOrigin && origin.includes(reqOrigin) ? reqOrigin : origin[0];
    } else if (typeof origin === "string") {
      allow = origin;
    }
    if (allow) res.setHeader("access-control-allow-origin", allow);
    if (allow && allow !== "*") res.setHeader("vary", "Origin");
    if (credentials) res.setHeader("access-control-allow-credentials", "true");
    res.setHeader(
      "access-control-allow-methods",
      methods ?? "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    );
    res.setHeader(
      "access-control-allow-headers",
      allowedHeaders ?? req.get("access-control-request-headers") ?? "content-type",
    );
    if (maxAge !== undefined) res.setHeader("access-control-max-age", String(maxAge));
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return; // preflight handled — don't fall through
    }
    next();
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

export interface StaticOptions {
  /** Directory index file, or false to disable. Default: "index.html". */
  index?: string | false;
  /** Strip this mount prefix from the request path before resolving. */
  prefix?: string;
}

/**
 * Serve files from a directory. Path traversal is blocked (resolved target
 * must stay within root, DNS-rebind-irrelevant — pure filesystem). Falls
 * through to `next()` when no file matches, so routes can take over.
 *
 *   app.use(zenzip.static("public"));                  // GET /app.css
 *   app.use(zenzip.static("public", { prefix: "/assets" }));
 */
export function serveStatic(root: string, options: StaticOptions = {}): Middleware {
  const rootDir = resolve(root);
  const index = options.index === undefined ? "index.html" : options.index;
  const prefix = options.prefix;
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    let rel = req.path;
    if (prefix) {
      const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
      if (rel !== p && !rel.startsWith(p + "/")) {
        next();
        return;
      }
      rel = rel.slice(p.length) || "/";
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      next();
      return;
    }
    // Drop leading slashes, then normalize so any "../" is resolved before the
    // containment check below catches an escape.
    const safeRel = normalize(decoded).replace(/^([/\\])+/, "");
    const target = join(rootDir, safeRel);
    if (target !== rootDir && !target.startsWith(rootDir + sep)) {
      next(); // traversal attempt — refuse
      return;
    }
    let filePath = target;
    let stat;
    try {
      stat = statSync(target);
    } catch {
      next();
      return;
    }
    if (stat.isDirectory()) {
      if (!index) {
        next();
        return;
      }
      filePath = join(target, index);
      try {
        if (!statSync(filePath).isFile()) {
          next();
          return;
        }
      } catch {
        next();
        return;
      }
    } else if (!stat.isFile()) {
      next();
      return;
    }
    res.setHeader("content-type", MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream");
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  };
}

export interface SecureHeadersOptions {
  /** Strict-Transport-Security (only honored over HTTPS). Default: on, 180d. */
  hsts?: boolean | { maxAgeSeconds?: number };
  /** Content-Security-Policy value. Off by default (CSP commonly breaks apps). */
  contentSecurityPolicy?: string;
  /** X-Frame-Options. Default: "DENY". */
  frameOptions?: string | false;
  /** Referrer-Policy. Default: "no-referrer". */
  referrerPolicy?: string | false;
}

/**
 * Security headers (P13.3) — a helmet-equivalent sensible default set:
 * X-Content-Type-Options nosniff, X-Frame-Options DENY, Referrer-Policy
 * no-referrer, X-DNS-Prefetch-Control off, and HSTS. CSP is opt-in (it breaks
 * apps when wrong). Override or disable any header via options.
 */
export function secureHeaders(options: SecureHeadersOptions = {}): Middleware {
  const hsts = options.hsts ?? true;
  const hstsMaxAge =
    typeof hsts === "object" ? (hsts.maxAgeSeconds ?? 15_552_000) : 15_552_000;
  const frame = options.frameOptions ?? "DENY";
  const referrer = options.referrerPolicy ?? "no-referrer";
  return (_req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-dns-prefetch-control", "off");
    if (frame) res.setHeader("x-frame-options", frame);
    if (referrer) res.setHeader("referrer-policy", referrer);
    if (hsts) res.setHeader("strict-transport-security", `max-age=${hstsMaxAge}; includeSubDomains`);
    if (options.contentSecurityPolicy) {
      res.setHeader("content-security-policy", options.contentSecurityPolicy);
    }
    next();
  };
}

export interface RateLimitOptions {
  /** Max requests allowed per key per window. */
  max: number;
  /** Sliding window length. Default: "1m". */
  window?: Duration;
  /** Key a request to a bucket. Default: client IP (X-Forwarded-For aware). */
  key?: (req: ZenRequest) => string;
  /** Body returned with the 429. */
  message?: string;
}

function clientIp(req: ZenRequest): string {
  const fwd = req.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

/**
 * HTTP rate limiting (P13.4) — fixed-window per key (default: client IP), in
 * memory. Returns 429 with Retry-After + X-RateLimit-* headers when exceeded.
 * Single-process; for multi-node, supply a shared-store `key`/limiter or front
 * with an LB limiter. Distinct from the *queue* rate limit.
 */
export function rateLimit(options: RateLimitOptions): Middleware {
  const windowMs = options.window !== undefined ? ms(options.window) : 60_000;
  const keyOf = options.key ?? clientIp;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const now = Date.now();
    const k = keyOf(req);
    let b = buckets.get(k);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(k, b);
    }
    b.count++;
    const remaining = Math.max(0, options.max - b.count);
    res.setHeader("x-ratelimit-limit", String(options.max));
    res.setHeader("x-ratelimit-remaining", String(remaining));
    res.setHeader("x-ratelimit-reset", String(Math.ceil(b.resetAt / 1000)));
    if (b.count > options.max) {
      res.setHeader("retry-after", String(Math.ceil((b.resetAt - now) / 1000)));
      res.status(429).json({ error: options.message ?? "too many requests" });
      return;
    }
    next();
  };
}

export interface AuthOptions {
  /** Static tokens/API keys accepted (Bearer or x-api-key), timing-safe. */
  tokens?: string[];
  /**
   * Custom verifier — return a principal (truthy) to accept, or null/false to
   * reject. The seam for JWT/OIDC: verify the token here with your library.
   */
  verify?: (token: string, req: ZenRequest) => unknown | Promise<unknown>;
  /** Property to attach the principal to on req. Default: "user". */
  attach?: string;
}

function bearerToken(req: ZenRequest): string | undefined {
  const auth = req.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return req.get("x-api-key") ?? undefined;
}

function timingSafeMatch(token: string, candidates: string[]): boolean {
  const t = Buffer.from(token);
  let ok = false;
  for (const c of candidates) {
    const b = Buffer.from(c);
    // Compare all (no early return) to keep timing roughly constant.
    if (b.length === t.length && timingSafeEqual(b, t)) ok = true;
  }
  return ok;
}

/**
 * Authentication middleware (P13.1). Reads a Bearer token / `x-api-key`,
 * accepts it against static `tokens` and/or a `verify` callback (the JWT/OIDC
 * seam), attaches the principal to `req.user` (configurable), and 401s
 * otherwise. Mount path-scoped as a route guard: `app.use("/admin", auth(...))`.
 */
export function auth(options: AuthOptions): Middleware {
  const attach = options.attach ?? "user";
  return async (req, res, next) => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    let principal: unknown;
    if (options.tokens && timingSafeMatch(token, options.tokens)) {
      principal = { token };
    } else if (options.verify) {
      principal = await options.verify(token, req);
    }
    if (!principal) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    (req as Record<string, unknown>)[attach] = principal;
    next();
  };
}

export interface ValidateSchemas {
  /** Validate (and replace) the parsed request body. */
  body?: StandardSchemaV1;
  /** Validate (and replace) the parsed query object. */
  query?: StandardSchemaV1;
}

/**
 * Request validation middleware (P13.2). Validates `req.body` / `req.query`
 * against Standard Schema schemas (zod 3.24+, valibot, arktype, …); on failure
 * responds 400 with the issues, otherwise replaces the value with the parsed
 * output so the handler sees typed, validated data. Runs before route dispatch,
 * so route params aren't available here — validate those in the handler.
 */
export function validate(schemas: ValidateSchemas): Middleware {
  return async (req, res, next) => {
    for (const part of ["query", "body"] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      let result = schema["~standard"].validate((req as Record<string, unknown>)[part]);
      if (result instanceof Promise) result = await result;
      if (result.issues) {
        res.status(400).json({
          error: "validation failed",
          part,
          issues: result.issues.map((i) => ({ message: i.message })),
        });
        return;
      }
      (req as Record<string, unknown>)[part] = result.value;
    }
    next();
  };
}

export interface LoggerOptions {
  /** Sink for one-line request logs. Default: console.log. */
  log?: (line: string) => void;
}

/**
 * Request logger: emits `METHOD /path STATUS DURms` on response finish. Wire
 * `log` to the structured log sink for log↔trace correlation (P7.4).
 */
export function logger(options: LoggerOptions = {}): Middleware {
  const sink = options.log ?? ((line: string) => console.log(line));
  return (req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      sink(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  };
}
