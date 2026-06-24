import type { Metadata } from "next";

import { CodeBlock } from "@/components/code-block";
import { DocPage } from "@/components/docs/doc-page";
import {
  A,
  Callout,
  Code,
  H2,
  H3,
  LI,
  P,
  Strong,
  Table,
  UL,
} from "@/components/docs/typography";

export const metadata: Metadata = { title: "Express & Middleware" };

const toc = [
  { id: "middleware", title: "Middleware — app.use()" },
  { id: "signatures", title: "Handler signatures" },
  { id: "errors", title: "Error handling" },
  { id: "routers", title: "Routers & mounting" },
  { id: "built-ins", title: "Built-in middleware" },
  { id: "augmentation", title: "req / res augmentation" },
  { id: "adapters", title: "Mounting & adapters" },
  { id: "scope", title: "Scope & positioning" },
];

const middleware = `const app = zenzip();

// Global middleware — Express (req, res, next) signature.
app.use((req, res, next) => {
  req.startedAt = Date.now();
  next();
});

// Path-scoped middleware — runs only at/under the mount path.
app.use("/api", authMiddleware);

// Built-in middleware shipped with the framework.
app.use(zenzip.json());                  // parse JSON bodies
app.use(zenzip.cors({ origin: "*" }));   // CORS + OPTIONS preflight
app.use(zenzip.logger());                // one-line request logs`;

const signatures = `// Express-familiar: (req, res) — req.params/query/body, res.json/send/status.
app.post("/orders", (req, res) => {
  res.status(201).json({ id: req.body.id });
});

// Runtime-aware: durability primitives are reachable on req.app.
app.post("/checkout", async (req, res) => {
  const { runId } = await req.app.workflow("order").trigger(req.body);
  res.json({ runId });
});

// Original ZenZip context handler — still works unchanged (arity 1).
app.get("/users/:id", (ctx) => ({ id: ctx.params.id }));`;

const signaturesSemantics = `// (req, res, next) handler semantics:
//   res.json(x) / res.send(x)  → explicit response
//   return value (no response) → 200 JSON (convenience)
//   return undefined           → 204
//   next()                     → fall through to 404
//   next(err) / throw          → error middleware (then 500)`;

const errors = `// 4-arg error middleware — exactly like Express. Register it last.
app.use((err, req, res, next) => {
  res.status(err.status ?? 500).json({ error: err.message });
});

// A throw / rejection anywhere — middleware OR route handler — skips
// forward to the next 4-arg error handler. With none registered, ZenZip
// writes 500 { error: message } for you.`;

const routers = `const api = zenzip.Router();

api.get("/users/:id", getUser);
api.post("/users", createUser);
api.use(authMiddleware);          // router-scoped middleware

app.use("/api/v1", api);          // mount, exactly like express.Router()
// → GET /api/v1/users/:id, POST /api/v1/users

// Routers nest:
const v1 = zenzip.Router();
v1.use("/users", api);            // → /api/v1/users/...`;

const builtins = `app.use(zenzip.json());                    // application/json  → req.body
app.use(zenzip.urlencoded());              // form-urlencoded   → req.body
app.use(zenzip.cors({ origin: true }));    // reflect request origin
app.use(zenzip.logger({ log: (line) => myLogger.info(line) }));
app.use(zenzip.static("public"));          // serve files from ./public
app.use(zenzip.static("public", { prefix: "/assets" }));

// Auth guard (P13.1) + request validation (P13.2) — path-scoped:
app.use("/admin", zenzip.auth({ tokens: [process.env.API_KEY!] }));
app.use("/admin", zenzip.auth({ verify: (t) => verifyJwt(t) })); // JWT/OIDC seam
app.use("/users", zenzip.validate({ body: userSchema }));         // → req.user, auto-400`;

const adapters = `await app.start();

// Any raw (req, res) framework — Express, Connect, Fastify, plain node:http.
http.createServer(app.toNodeHandler()).listen(3000);
fastify.all("/*", (req, reply) => app.toNodeHandler()(req.raw, reply.raw));

// Web Fetch (Request → Response) — Next.js, Hono, Bun, Deno, edge.
const handler = app.toFetchHandler();

// Next.js App Router route handler:
export const POST = handler;

// Hono:
hono.all("*", (c) => handler(c.req.raw));`;

export default function Page() {
  return (
    <DocPage
      title="Express & Middleware"
      description="It's Express. app.use(), routers, the (req, res, next) signature, and built-in middleware sit right next to app.queue / app.workflow / app.agent — durability is opt-in depth, with zero new HTTP concepts to learn."
      href="/docs/express"
      toc={toc}
    >
      <P>
        The HTTP layer <Strong>is</Strong> Express-shaped. If you know Express,
        you already know this: <Code>app.use()</Code>, mountable routers, the{" "}
        <Code>(req, res, next)</Code> signature, and 4-arg error middleware all
        behave the way you expect. When you need durability,{" "}
        <Code>app.queue()</Code>, <Code>app.workflow()</Code>, and{" "}
        <Code>app.agent()</Code> are on the same <Code>app</Code>.
      </P>

      <H2 id="middleware">Middleware — app.use()</H2>
      <CodeBlock code={middleware} filename="server.ts" />
      <UL>
        <LI>
          Middleware runs in registration order, before route dispatch.
        </LI>
        <LI>
          <Code>app.use(fn)</Code> is global; <Code>app.use(path, fn)</Code>{" "}
          scopes to a mount path (segment-boundary match — <Code>/api</Code>{" "}
          matches <Code>/api/users</Code>, not <Code>/apixyz</Code>).
        </LI>
        <LI>
          Multiple handlers per call: <Code>app.use(a, b, c)</Code> /{" "}
          <Code>app.use(&quot;/api&quot;, a, b)</Code>.
        </LI>
        <LI>
          Register middleware before <Code>app.start()</Code>.
        </LI>
      </UL>

      <H2 id="signatures">Handler signatures</H2>
      <P>
        Routes accept either shape — chosen automatically by arity. Two-or-more
        args is the Express handler; one arg is the original typed context.
      </P>
      <CodeBlock code={signatures} filename="routes.ts" />
      <CodeBlock code={signaturesSemantics} lang="text" className="mt-4" />

      <H2 id="errors">Error handling</H2>
      <CodeBlock code={errors} filename="errors.ts" />
      <Callout type="info" title="Familiar, not 100% spec">
        <p>
          ZenZip matches Express&apos;s API shape and muscle memory — not every
          internals-poking middleware. Error middleware is identified the
          Express way: any handler with arity ≥ 4.
        </p>
      </Callout>

      <H2 id="routers">Routers &amp; mounting</H2>
      <CodeBlock code={routers} filename="api.ts" />
      <UL>
        <LI>
          <Code>zenzip.Router()</Code> groups routes + middleware; mount with{" "}
          <Code>app.use(path, router)</Code>.
        </LI>
        <LI>
          Router-level <Code>use()</Code> middleware is scoped to the mount
          path. Routers nest to any depth.
        </LI>
      </UL>

      <H2 id="built-ins">Built-in middleware</H2>
      <CodeBlock code={builtins} />
      <Table
        head={["Middleware", "What it does"]}
        rows={[
          [<Code key="1">zenzip.json()</Code>, "parse application/json bodies into req.body"],
          [<Code key="2">zenzip.urlencoded()</Code>, "parse form-urlencoded bodies into req.body"],
          [<Code key="3">zenzip.cors(opts)</Code>, "CORS headers + automatic OPTIONS preflight (origin string | string[] | true)"],
          [<Code key="4">zenzip.logger(opts)</Code>, "METHOD /path STATUS DURms on response finish; pluggable sink"],
          [<Code key="5">zenzip.static(root, opts)</Code>, "serve files from a directory; traversal-safe, falls through to routes; index + prefix options"],
          [<Code key="6">zenzip.auth(opts)</Code>, "auth guard (P13.1): Bearer/x-api-key against static tokens or a verify() callback (JWT/OIDC seam); attaches req.user, 401s otherwise"],
          [<Code key="7">zenzip.validate(opts)</Code>, "request validation (P13.2): body/query Standard Schema → auto-400 with issues, replaces with parsed value"],
          [<Code key="8">zenzip.secureHeaders(opts)</Code>, "security headers (P13.3): nosniff, X-Frame-Options, Referrer-Policy, HSTS; opt-in CSP (helmet-equivalent)"],
          [<Code key="9">zenzip.rateLimit(opts)</Code>, "HTTP rate limit (P13.4): fixed-window per key (default client IP) → 429 + X-RateLimit-* headers"],
        ]}
      />

      <H2 id="augmentation">req / res augmentation</H2>
      <P>
        <Code>req</Code> and <Code>res</Code> are thin augmentations of the{" "}
        <Code>node:http</Code> objects — so most of the Express middleware
        ecosystem is reusable.
      </P>
      <H3 id="req">Request</H3>
      <Table
        head={["Property", "What it is"]}
        rows={[
          [<Code key="1">req.params</Code>, "path parameters from :name segments"],
          [<Code key="2">req.query</Code>, "parsed query (repeated keys → arrays)"],
          [<Code key="3">req.body</Code>, "parsed body (read once, shared with middleware)"],
          [<Code key="4">req.path</Code>, "pathname without the query string"],
          [<Code key="5">req.app</Code>, "the owning app — trigger/push/emit from a handler"],
          [<Code key="6">req.get(name)</Code>, "case-insensitive header lookup"],
        ]}
      />
      <H3 id="res">Response</H3>
      <Table
        head={["Method", "What it does"]}
        rows={[
          [<Code key="1">res.status(code)</Code>, "set status (chainable)"],
          [<Code key="2">res.json(data)</Code>, "send a JSON body"],
          [<Code key="3">res.send(data)</Code>, "object → JSON, string/Buffer → as-is"],
          [<Code key="4">res.sendStatus(code)</Code>, "status + its reason phrase as body"],
          [<Code key="5">res.set(field, value)</Code>, "set a header (or a map)"],
          [<Code key="6">res.redirect([status,] url)</Code>, "redirect (default 302)"],
          [<Code key="7">res.locals</Code>, "per-request scratch space"],
        ]}
      />

      <H2 id="adapters">Mounting &amp; adapters</H2>
      <P>
        Run ZenZip standalone with <Code>app.listen()</Code>, or hand its
        routes to any framework. Two handler shapes cover the field — both run
        the exact same routing + middleware path:
      </P>
      <CodeBlock code={adapters} filename="mount.ts" />
      <UL>
        <LI>
          <Code>app.toNodeHandler()</Code> — a raw{" "}
          <Code>(req, res)</Code> handler for Express, Connect, Fastify
          (via <Code>req.raw</Code>/<Code>reply.raw</Code>), or{" "}
          <Code>http.createServer</Code>.
        </LI>
        <LI>
          <Code>app.toFetchHandler()</Code> — a Web{" "}
          <Code>Request → Response</Code> handler for Next.js route handlers,
          Hono, Bun, Deno, and edge runtimes. (<Code>makeFetchHandler(router)</Code>{" "}
          is the lower-level form over a bare router.)
        </LI>
      </UL>
      <Callout type="info" title="Either way, durability is one call away">
        <p>
          However you mount it, handlers run in the same process as the runtime,
          so <code>queue.push()</code> / <code>workflow.trigger()</code> /{" "}
          <code>app.emit()</code> are local calls — not network hops.
        </p>
      </Callout>

      <H2 id="scope">Scope &amp; positioning</H2>
      <P>
        The Express layer is pure DX sugar over the <A href="/docs/http-dashboard">node:http adapter</A> — it never
        leaks into the engine or changes durability semantics. HTTP stays a Node
        adapter; per the <A href="/docs/benchmarks">Phase 0 verdict</A>, ZenZip
        does not compete with Fastify/Hono on raw HTTP throughput. The point is
        that a small app needs nothing else, and a developer who knows Express
        is productive in minutes. First-class Fastify / Hono / Next.js adapters
        are tracked on the <A href="/docs/roadmap">roadmap</A>.
      </P>
    </DocPage>
  );
}
