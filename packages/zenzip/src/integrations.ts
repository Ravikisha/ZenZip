// Log + error integrations (P16.4). Thin, dependency-free adapters: ZenZip
// never imports pino/winston/Sentry — you pass your instance and we duck-type
// it. Engine logs flow through `logger`, errors through `onError` / the
// error-capturing middleware.
import type { ErrorMiddleware } from "./express.js";
import type { LogEvent } from "./types.js";

/** Minimal pino-shaped logger. */
interface PinoLike {
  error: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  info: (obj: object, msg?: string) => void;
  debug: (obj: object, msg?: string) => void;
  trace: (obj: object, msg?: string) => void;
}

/**
 * Route engine log events into a pino logger, preserving level + target:
 * `zenzip({ logLevel: "info", logger: pinoLogger(pino()) })`.
 */
export function pinoLogger(pino: PinoLike): (event: LogEvent) => void {
  return (e) => {
    const level = e.level.toLowerCase();
    const fn =
      level === "error"
        ? pino.error
        : level === "warn"
          ? pino.warn
          : level === "debug"
            ? pino.debug
            : level === "trace"
              ? pino.trace
              : pino.info;
    fn.call(pino, { target: e.target }, e.message);
  };
}

/** Minimal winston-shaped logger. */
interface WinstonLike {
  log: (level: string, message: string, meta?: object) => void;
}

/** Route engine log events into a winston logger (level mapped to winston's). */
export function winstonLogger(winston: WinstonLike): (event: LogEvent) => void {
  return (e) => {
    const level = e.level.toLowerCase();
    // winston has no "trace"; fold it into debug.
    const mapped = level === "trace" ? "debug" : level;
    winston.log(mapped, e.message, { target: e.target });
  };
}

/** Minimal Sentry-shaped client. */
interface SentryLike {
  captureException: (err: unknown, hint?: unknown) => void;
}

/** Context passed to an error reporter. */
export interface ErrorContext {
  /** Where the error came from: "http" | "alert" | "log" | string. */
  source: string;
  [key: string]: unknown;
}

/**
 * Build an `onError` reporter backed by Sentry:
 * `zenzip({ onError: sentryReporter(Sentry) })`. Adds the source + context as
 * extra data on the captured event.
 */
export function sentryReporter(
  Sentry: SentryLike,
): (err: Error, ctx?: ErrorContext) => void {
  return (err, ctx) => {
    Sentry.captureException(err, ctx ? { extra: ctx } : undefined);
  };
}

/**
 * Express error-middleware that reports a thrown error to `reporter`, then
 * re-propagates it (so the typed error envelope still renders). Mount it last:
 * `app.use(captureErrors(sentryReporter(Sentry)))`.
 */
export function captureErrors(
  reporter: (err: Error, ctx?: ErrorContext) => void,
): ErrorMiddleware {
  return (err, req, _res, next) => {
    const e = err instanceof Error ? err : new Error(String(err));
    reporter(e, { source: "http", method: req.method, path: req.path });
    next(err);
  };
}
