import {
  middlewareLayer,
  type ErrorMiddleware,
  type Middleware,
  type MiddlewareLayer,
} from "./express.js";
import type { CtxHandler, ExpressHandler, RouteHandler } from "./http.js";

/** A collected route, relative to the router it belongs to. */
interface RouterRoute {
  method: string;
  path: string;
  handler: RouteHandler;
}

/** What a router contributes once mounted at a prefix. */
export interface MountedRoutes {
  routes: Array<{ method: string; path: string; handler: RouteHandler }>;
  middleware: MiddlewareLayer[];
}

/** Join a mount prefix with a relative path into one normalized route path. */
export function joinPath(prefix: string, path: string): string {
  const a = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const b = path.startsWith("/") ? path : `/${path}`;
  const joined = `${a}${b}`;
  return joined.startsWith("/") ? joined : `/${joined}`;
}

/**
 * Express-style `Router()` (P8.3): collect routes + middleware, then mount on
 * an app (or another router) at a prefix with `app.use("/api/v1", router)`.
 * Routers nest. Registration order is preserved so middleware that a router
 * declares runs before its routes, scoped to the mount path.
 */
export class Router {
  readonly #routes: RouterRoute[] = [];
  readonly #middleware: MiddlewareLayer[] = [];
  readonly #mounts: Array<{ prefix: string; router: Router }> = [];

  use(pathOrFn: string | Middleware | ErrorMiddleware | Router, ...fns: Array<Middleware | ErrorMiddleware>): this {
    if (pathOrFn instanceof Router) {
      this.#mounts.push({ prefix: "/", router: pathOrFn });
      return this;
    }
    if (typeof pathOrFn === "string" && fns.length === 1 && fns[0] instanceof Router) {
      this.#mounts.push({ prefix: pathOrFn, router: fns[0] as unknown as Router });
      return this;
    }
    const path = typeof pathOrFn === "string" ? pathOrFn : undefined;
    const handlers = typeof pathOrFn === "string" ? fns : [pathOrFn, ...fns];
    if (handlers.length === 0) {
      throw new Error("router.use() expects at least one middleware function");
    }
    for (const fn of handlers) {
      if (typeof fn !== "function") {
        throw new Error("router.use() expects middleware function(s)");
      }
      this.#middleware.push(middlewareLayer(fn, path));
    }
    return this;
  }

  get(path: string, handler: CtxHandler): this;
  get(path: string, handler: ExpressHandler): this;
  get(path: string, handler: RouteHandler): this {
    this.#routes.push({ method: "GET", path, handler });
    return this;
  }
  post(path: string, handler: CtxHandler): this;
  post(path: string, handler: ExpressHandler): this;
  post(path: string, handler: RouteHandler): this {
    this.#routes.push({ method: "POST", path, handler });
    return this;
  }
  put(path: string, handler: CtxHandler): this;
  put(path: string, handler: ExpressHandler): this;
  put(path: string, handler: RouteHandler): this {
    this.#routes.push({ method: "PUT", path, handler });
    return this;
  }
  patch(path: string, handler: CtxHandler): this;
  patch(path: string, handler: ExpressHandler): this;
  patch(path: string, handler: RouteHandler): this {
    this.#routes.push({ method: "PATCH", path, handler });
    return this;
  }
  delete(path: string, handler: CtxHandler): this;
  delete(path: string, handler: ExpressHandler): this;
  delete(path: string, handler: RouteHandler): this {
    this.#routes.push({ method: "DELETE", path, handler });
    return this;
  }

  /** @internal Expand this router (and nested ones) at a mount prefix. */
  _collect(prefix: string): MountedRoutes {
    const routes: MountedRoutes["routes"] = this.#routes.map((r) => ({
      method: r.method,
      path: joinPath(prefix, r.path),
      handler: r.handler,
    }));
    const middleware: MiddlewareLayer[] = this.#middleware.map((m) => ({
      ...m,
      path: m.path ? joinPath(prefix, m.path) : prefix === "/" ? undefined : prefix,
    }));
    for (const { prefix: sub, router } of this.#mounts) {
      const nested = router._collect(joinPath(prefix, sub));
      routes.push(...nested.routes);
      middleware.push(...nested.middleware);
    }
    return { routes, middleware };
  }
}
