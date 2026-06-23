// Phase 13.5: config validation + secret redaction.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { redactUrl, validateConfig, zenzip, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("config validation (P13.5)", () => {
  it("rejects bad config with a clear message", () => {
    expect(() => validateConfig({ store: { driver: "postgres", url: "" } })).toThrow(
      /postgres store requires/,
    );
    expect(() => validateConfig({ store: { driver: "postgres", url: "not a url" } })).toThrow(
      /invalid postgres url/,
    );
    expect(() => validateConfig({ payloads: { threshold: -1 } })).toThrow(/threshold/);
    expect(() => validateConfig({ workerThreads: 0 })).toThrow(/workerThreads/);
    expect(() => validateConfig({ logLevel: "loud" as never })).toThrow(/logLevel/);
  });

  it("accepts valid config", () => {
    expect(() => validateConfig({})).not.toThrow();
    expect(() =>
      validateConfig({ store: { driver: "postgres", url: "postgres://u:p@host:5432/db" } }),
    ).not.toThrow();
    expect(() => validateConfig({ payloads: { threshold: 1024 }, workerThreads: 4 })).not.toThrow();
  });

  it("fails app.start() fast on misconfig", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zenzip-cfg-"));
    const app: ZenzipApp = zenzip({ dataDir: dir, handleSignals: false, store: { driver: "postgres", url: "" } });
    cleanups.push(async () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });
    await expect(app.start()).rejects.toThrow(/postgres store requires/);
  });
});

describe("redactUrl (P13.5)", () => {
  it("masks the password", () => {
    expect(redactUrl("postgres://user:s3cret@host:5432/db")).not.toContain("s3cret");
    expect(redactUrl("postgres://user:s3cret@host:5432/db")).toContain("***");
    expect(redactUrl("postgres://host/db")).toBe("postgres://host/db"); // nothing to mask
  });
});
