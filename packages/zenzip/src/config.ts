import type { ZenzipOptions } from "./types.js";

/**
 * Config hardening (P13.5): validate options at boot so misconfiguration fails
 * fast with a clear message instead of a cryptic runtime error, and redact
 * secrets (passwords in connection URLs) from anything surfaced to logs.
 */

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
