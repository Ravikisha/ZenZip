import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard (P7.16). Validate a user-controlled URL before fetching it, so a
 * malicious value can't make the server reach internal/cloud-metadata
 * endpoints (e.g. http://169.254.169.254/). Resolve-then-validate: the hostname
 * is resolved and *every* resolved address is range-checked, not just the
 * literal, which blunts DNS-rebinding to a private IP.
 */
export interface SsrfOptions {
  /** If set, only these hostnames are allowed (exact, case-insensitive). */
  allowHosts?: string[];
  /** Allow private / loopback / link-local targets (default: false). */
  allowPrivate?: boolean;
  /** Allowed URL schemes. Default: ["http:", "https:"]. */
  allowSchemes?: string[];
}

/** True if an IP literal is in a private / loopback / link-local / reserved range. */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // malformed → treat unsafe
    const [a, b] = p;
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // 0/8
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (kind === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true; // loopback / unspecified
    if (v.startsWith("fe80")) return true; // link-local
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique-local fc00::/7
    // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4.
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // not a valid IP literal → unsafe
}

/**
 * Throw if `url` is unsafe to fetch under `options`. Pass it before any fetch
 * of a user-supplied URL (MCP servers, agent HTTP tools, blob stores).
 */
export async function assertPublicUrl(url: string, options: SsrfOptions = {}): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`SSRF guard: invalid URL "${url}"`);
  }
  const schemes = options.allowSchemes ?? ["http:", "https:"];
  if (!schemes.includes(parsed.protocol)) {
    throw new Error(`SSRF guard: scheme "${parsed.protocol}" not allowed`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  if (options.allowHosts) {
    const allowed = options.allowHosts.some((h) => h.toLowerCase() === host.toLowerCase());
    if (!allowed) throw new Error(`SSRF guard: host "${host}" not in allowHosts`);
  }
  if (options.allowPrivate) return;

  // Collect every address the host resolves to (IP literals resolve to self).
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0) throw new Error(`SSRF guard: "${host}" did not resolve`);
  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      throw new Error(`SSRF guard: "${host}" resolves to a private/blocked address (${addr})`);
    }
  }
}
