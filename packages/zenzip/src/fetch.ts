import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { makeNodeHandler, type HandlerConfig, type HttpRouter } from "./http.js";

/**
 * Web Fetch adapter (P8.5). Bridges the standard `Request` → `Response`
 * contract that Next.js route handlers, Hono, Bun, Deno, and edge runtimes all
 * speak, on top of the existing node:http handler — so one primitive covers
 * the whole Fetch-based cohort:
 *
 *   // Next.js App Router
 *   export const POST = app.toFetchHandler();
 *
 *   // Hono
 *   const fetchHandler = app.toFetchHandler();
 *   hono.all("*", (c) => fetchHandler(c.req.raw));
 *
 * It builds a minimal IncomingMessage (a Readable carrying the body) and a
 * ServerResponse (a Writable collecting the output), reusing the exact routing,
 * middleware, and dispatch path as the node server — no logic is duplicated.
 */
export function makeFetchHandler(
  arg: HttpRouter | HandlerConfig,
): (request: Request) => Promise<Response> {
  const handler = makeNodeHandler(arg);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const bodyBuf =
      request.method === "GET" || request.method === "HEAD" || !request.body
        ? Buffer.alloc(0)
        : Buffer.from(await request.arrayBuffer());

    // --- IncomingMessage shim: a Readable streaming the request body. -------
    const req = new Readable({ read() {} }) as unknown as IncomingMessage & {
      headers: Record<string, string>;
      method: string;
      url: string;
    };
    if (bodyBuf.length) req.push(bodyBuf);
    req.push(null);
    req.method = request.method;
    req.url = url.pathname + url.search;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    req.headers = headers;

    // --- ServerResponse shim: a Writable collecting the response body. ------
    return new Promise<Response>((resolveResponse) => {
      const chunks: Buffer[] = [];
      const outHeaders = new Headers();
      let settled = false;

      const res = new Writable({
        write(chunk, _enc, cb) {
          res.headersSent = true; // node flushes headers on first write
          chunks.push(Buffer.from(chunk));
          cb();
        },
      }) as unknown as Omit<ServerResponse, "headersSent"> & { headersSent: boolean };

      res.statusCode = 200;
      res.headersSent = false;
      // node:http marks headersSent synchronously on .end(); the Writable
      // 'finish' event is async, so set it eagerly or dispatch's "did the
      // handler respond?" check races and overwrites the body.
      const originalEnd = res.end.bind(res);
      res.end = ((...endArgs: unknown[]) => {
        res.headersSent = true;
        return (originalEnd as (...a: unknown[]) => unknown)(...endArgs);
      }) as ServerResponse["end"];
      res.setHeader = ((name: string, value: number | string | readonly string[]) => {
        outHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value));
        return res;
      }) as ServerResponse["setHeader"];
      res.getHeader = ((name: string) => outHeaders.get(name) ?? undefined) as ServerResponse["getHeader"];
      res.removeHeader = ((name: string) => {
        outHeaders.delete(name);
      }) as ServerResponse["removeHeader"];
      res.writeHead = ((
        statusCode: number,
        arg2?: unknown,
        arg3?: unknown,
      ) => {
        res.statusCode = statusCode;
        const hdrs = (typeof arg2 === "object" && arg2 ? arg2 : arg3) as
          | Record<string, string>
          | undefined;
        if (hdrs) {
          for (const [k, v] of Object.entries(hdrs)) outHeaders.set(k, String(v));
        }
        res.headersSent = true;
        return res;
      }) as ServerResponse["writeHead"];

      const finalize = () => {
        if (settled) return;
        settled = true;
        res.headersSent = true;
        const body = Buffer.concat(chunks);
        const nullBody = body.length === 0 || [204, 205, 304].includes(res.statusCode);
        resolveResponse(
          new Response(nullBody ? null : body, {
            status: res.statusCode,
            headers: outHeaders,
          }),
        );
      };
      res.on("finish", finalize);
      res.on("close", finalize);

      handler(req, res);
    });
  };
}
