import type { Metadata } from "next";

import { CodeBlock } from "@/components/code-block";
import { DocPage } from "@/components/docs/doc-page";
import {
  A,
  Callout,
  Code,
  H2,
  LI,
  P,
  Strong,
  Table,
  UL,
} from "@/components/docs/typography";

export const metadata: Metadata = { title: "HTTP & Dashboard" };

const toc = [
  { id: "routes", title: "Routes" },
  { id: "context", title: "The request context" },
  { id: "webhooks", title: "Webhook → workflow" },
  { id: "dashboard", title: "The dashboard" },
  { id: "scope", title: "Scope & positioning" },
];

const routes = `app.get("/users/:id", (ctx) => ({
  id: ctx.params.id,                  // ":id" segment
  verbose: ctx.query.get("verbose"),  // ?verbose=1
}));

app.post("/orders", async (ctx) => {
  const order = ctx.body as NewOrder;        // parsed JSON body
  const { runId } = await orderFlow.trigger(order);
  return ctx.status(201).json({ runId });    // explicit response
});

await app.start();
const { port, close } = await app.listen({ port: 3000 });`;

const semantics = `// Handler semantics:
//   return value        → 200 JSON
//   ctx.status(201).json(x) → explicit status + body
//   return undefined    → 204
//   throw               → 500 { error: message }
//   no route            → 404 { error: "not found" }`;

const webhook = `// One line: an HTTP endpoint that durably triggers a workflow.
app.workflow(
  "stripe-events",
  { http: "POST /hooks/stripe", stepRetries: 5 },
  async ({ step, input }) => {
    // input = the webhook request body
    await step.run("verify", () => verifySignature(input));
    await step.run("apply", () => applyEvent(input));
  },
);

await app.listen({ port: 3000 });
// POST /hooks/stripe → { runId: "…" } — retried webhooks are cheap to
// dedupe by triggering with an idempotency key derived from the body.`;

const dashboard = `await app.start();
await app.dashboard();           // → http://127.0.0.1:4100
await app.dashboard({ port: 5000, host: "0.0.0.0" });   // or configure`;

export default function Page() {
  return (
    <DocPage
      title="HTTP & Dashboard"
      description="A minimal HTTP adapter that shares the runtime with your handlers, webhook-to-workflow sugar, and the embedded observability dashboard."
      href="/docs/http-dashboard"
      toc={toc}
    >
      <H2 id="routes">Routes</H2>
      <CodeBlock code={routes} filename="server.ts" />
      <CodeBlock code={semantics} lang="text" className="mt-4" />
      <Callout type="info" title="Prefer Express?">
        <p>
          Handlers also accept the Express <code>(req, res, next)</code>{" "}
          signature, and the app has <code>app.use()</code> middleware, routers,
          and built-ins. See <a className="underline" href="/docs/express">Express &amp; Middleware</a>.
        </p>
      </Callout>
      <UL>
        <LI>
          <Code>app.get/post/put/patch/delete</Code> register before start;{" "}
          <Code>app.listen()</Code> serves after start (port 0 picks a free
          one).
        </LI>
        <LI>
          Servers close automatically in <Code>app.stop()</Code> — intake
          stops before the queue drain begins.
        </LI>
      </UL>

      <H2 id="context">The request context</H2>
      <Table
        head={["Field", "What it is"]}
        rows={[
          [<Code key="1">params</Code>, "path parameters from :name segments"],
          [<Code key="2">query</Code>, "URLSearchParams"],
          [<Code key="3">body</Code>, "parsed JSON (string for non-JSON, undefined for empty)"],
          [<Code key="4">headers</Code>, "raw request headers"],
          [<Code key="5">status / json / text</Code>, "response helpers"],
          [<Code key="6">req / res</Code>, "the underlying node:http objects"],
        ]}
      />
      <P>
        The real value: handlers live in the same process as the runtime, so{" "}
        <Code>queue.push()</Code>, <Code>workflow.trigger()</Code>,{" "}
        <Code>app.emit()</Code>, and <Code>machine.send()</Code> are
        nanosecond-cheap sync boundary calls away.
      </P>

      <H2 id="webhooks">Webhook → workflow</H2>
      <CodeBlock code={webhook} filename="webhooks.ts" />

      <H2 id="dashboard">The dashboard</H2>
      <CodeBlock code={dashboard} />
      <P>What it shows, live (2s polling):</P>
      <UL>
        <LI>
          <Strong>Overview cards</Strong> — active runs, pending/running jobs,
          dead letters, schedules
        </LI>
        <LI>
          <Strong>Workflow runs</Strong> — status chips; click a run for the
          step-by-step detail (kind, attempts, errors, results)
        </LI>
        <LI>
          <Strong>Queues</Strong> — pending/running/dead per queue, with a
          one-click <Code>requeue dead</Code> button
        </LI>
        <LI>
          <Strong>Schedules</Strong> — spec, policies, next fire time
        </LI>
        <LI>
          <Strong>Event feed</Strong> — the outbox, newest first
        </LI>
      </UL>
      <P>
        It&apos;s served by your own process from embedded HTML — no build
        step, no separate deployment, nothing to install. The JSON API
        underneath (<Code>/api/overview</Code>, <Code>/api/runs/:id</Code>, …)
        is yours to script against.
      </P>
      <Callout type="info" title="Auth & roles">
        <p>
          Bind to 127.0.0.1 by default. Set <Code>token</Code> for full
          (operator) access, and <Code>viewerToken</Code> for read-only access
          — a viewer can watch every view but is rejected (403) on mutations
          like requeue-dead. Tokens ride <Code>Authorization: Bearer …</Code>{" "}
          or <Code>?token=</Code>; comparison is timing-safe.
        </p>
      </Callout>

      <H2 id="scope">Scope &amp; positioning</H2>
      <P>
        Per the <A href="/docs/benchmarks">benchmark verdict</A>, ZenZip does
        not compete with Fastify/Hono on HTTP performance — this adapter
        exists so small apps need nothing else, and webhook-driven workflows
        get one-line ergonomics. For serious HTTP surface, run your favorite
        framework alongside and call <Code>trigger/push/emit</Code> from its
        handlers; dedicated Fastify/Hono mount helpers are tracked on the
        roadmap.
      </P>
    </DocPage>
  );
}
