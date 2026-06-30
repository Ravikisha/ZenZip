import { readFileSync } from "node:fs";

import type { ZenzipOptions } from "./types.js";

/**
 * Config hardening (P13.5): validate options at boot so misconfiguration fails
 * fast with a clear message instead of a cryptic runtime error, resolve secrets
 * from the environment / files (never hard-code them), and redact secrets from
 * anything surfaced to logs.
 */

/**
 * Resolve a secret from a reference, so keys/tokens live outside the code:
 *   resolveSecret("env:ZENZIP_ENCRYPTION_KEY")  → process.env.ZENZIP_ENCRYPTION_KEY
 *   resolveSecret("file:/run/secrets/key")      → trimmed file contents (k8s/Docker secrets)
 *   resolveSecret("literal-value")              → returned as-is (discouraged)
 * Returns undefined when the ref is empty or the env var / file is missing.
 */
export function resolveSecret(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith("env:")) {
    const v = process.env[ref.slice(4)];
    return v && v.length ? v : undefined;
  }
  if (ref.startsWith("file:")) {
    try {
      const v = readFileSync(ref.slice(5), "utf8").trim();
      return v.length ? v : undefined;
    } catch {
      return undefined;
    }
  }
  return ref;
}

const SECRET_KEY_RE =
  /(pass(word)?|secret|token|api[_-]?key|encryptionkey|authorization|credential|bearer)/i;

/**
 * Deep-redact secret-looking fields from an object so a config/state dump is
 * safe to log. Keys matching common secret names become "***"; connection-URL
 * password segments are masked via `redactUrl`. Returns a redacted copy.
 */
export function redactSecrets<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "string") {
    return (value.includes("://") ? redactUrl(value) : value) as T;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, seen)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(k) && (typeof v === "string" || typeof v === "number")) {
      out[k] = "***";
    } else {
      out[k] = redactSecrets(v, seen);
    }
  }
  return out as T;
}

/** Mask the password in a connection URL so it's safe to log. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    // Not a parseable URL — best-effort mask of a `user:pass@` segment.
    return url.replace(/\/\/[^/@]*@/, "//***@");
  }
}

/** Throw a descriptive error if the options are misconfigured. */
export function validateConfig(options: ZenzipOptions): void {
  const err = (msg: string): never => {
    throw new Error(`zenzip config: ${msg}`);
  };

  const store = options.store;
  if (store?.driver === "postgres") {
    if (!store.url || !store.url.trim()) {
      err("postgres store requires a non-empty `url`");
    }
    try {
      new URL(store.url);
    } catch {
      err(`invalid postgres url "${redactUrl(store.url)}"`);
    }
  }

  const threshold = options.payloads?.threshold;
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0)) {
    err("payloads.threshold must be a non-negative number of bytes");
  }

  const wt = options.workerThreads;
  if (wt !== undefined && (!Number.isInteger(wt) || wt < 1)) {
    err("workerThreads must be a positive integer");
  }

  const levels = ["error", "warn", "info", "debug", "trace", "off"];
  if (options.logLevel !== undefined && !levels.includes(options.logLevel)) {
    err(`logLevel must be one of ${levels.join(" | ")}`);
  }
}
