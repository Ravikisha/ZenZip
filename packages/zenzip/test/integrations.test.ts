// P16.4: log + error integrations (pino/winston/Sentry adapters).
// P13.5: secrets — resolveSecret + redactSecrets.
import { describe, expect, it } from "vitest";

import {
  captureErrors,
  pinoLogger,
  redactSecrets,
  resolveSecret,
  sentryReporter,
  winstonLogger,
} from "../src/index.js";

describe("log transports (P16.4)", () => {
  it("pinoLogger maps level + target", () => {
    const calls: Array<[string, object, string?]> = [];
    const pino = {
      error: (o: object, m?: string) => calls.push(["error", o, m]),
      warn: (o: object, m?: string) => calls.push(["warn", o, m]),
      info: (o: object, m?: string) => calls.push(["info", o, m]),
      debug: (o: object, m?: string) => calls.push(["debug", o, m]),
      trace: (o: object, m?: string) => calls.push(["trace", o, m]),
    };
    const log = pinoLogger(pino);
    log({ level: "WARN", target: "zenzip_core::queue", message: "slow" });
    log({ level: "INFO", target: "x", message: "ok" });
    expect(calls[0]).toEqual(["warn", { target: "zenzip_core::queue" }, "slow"]);
    expect(calls[1][0]).toBe("info");
  });

  it("winstonLogger folds trace into debug", () => {
    const calls: Array<[string, string, object?]> = [];
    const log = winstonLogger({ log: (l, m, meta) => calls.push([l, m, meta]) });
    log({ level: "TRACE", target: "t", message: "x" });
    expect(calls[0][0]).toBe("debug");
    expect(calls[0][2]).toEqual({ target: "t" });
  });
});

describe("error reporting (P16.4)", () => {
  it("sentryReporter forwards to captureException with extra context", () => {
    const captured: Array<{ err: unknown; hint: unknown }> = [];
    const report = sentryReporter({
      captureException: (err, hint) => captured.push({ err, hint }),
    });
    const e = new Error("boom");
    report(e, { source: "alert", count: 3 });
    expect(captured[0].err).toBe(e);
    expect(captured[0].hint).toEqual({ extra: { source: "alert", count: 3 } });
  });

  it("captureErrors middleware reports then re-propagates", () => {
    const reported: Error[] = [];
    const mw = captureErrors((e) => reported.push(e));
    let nextArg: unknown;
    const err = new Error("kaboom");
    mw(err, { method: "POST", path: "/x" } as never, {} as never, (e) => {
      nextArg = e;
    });
    expect(reported[0]).toBe(err);
    expect(nextArg).toBe(err); // re-propagated so the envelope still renders
  });
});

describe("secrets hardening (P13.5)", () => {
  it("resolveSecret reads env, file, or literal", () => {
    process.env.__ZTEST_SECRET = "from-env";
    expect(resolveSecret("env:__ZTEST_SECRET")).toBe("from-env");
    expect(resolveSecret("env:__MISSING__")).toBeUndefined();
    expect(resolveSecret("literal")).toBe("literal");
    expect(resolveSecret(undefined)).toBeUndefined();
    delete process.env.__ZTEST_SECRET;
  });

  it("redactSecrets masks secret-looking fields + url passwords", () => {
    const red = redactSecrets({
      encryptionKey: "supersecret",
      apiKey: "sk-123",
      nested: { token: "abc", keep: "visible" },
      dbUrl: "postgres://user:pass@host:5432/db",
    });
    expect(red.encryptionKey).toBe("***");
    expect(red.apiKey).toBe("***");
    expect(red.nested.token).toBe("***");
    expect(red.nested.keep).toBe("visible");
    expect(red.dbUrl).toBe("postgres://user:***@host:5432/db");
  });
});
