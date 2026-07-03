import type { Metadata } from "next";

import { CodeBlock } from "@/components/code-block";
import { DocPage } from "@/components/docs/doc-page";
import { A, Callout, Code, H2, H3, LI, P, Table, UL } from "@/components/docs/typography";

export const metadata: Metadata = {
  title: "Migrating to ZenZip",
  description:
    "Side-by-side migration guides to ZenZip from the tools it replaces — Express for HTTP, and BullMQ, Inngest, and Temporal for durable background work.",
  alternates: { canonical: "/docs/migrating" },
  openGraph: {
    title: "Migrating to ZenZip · ZenZip",
    description:
      "Side-by-side migration guides to ZenZip from the tools it replaces — Express for HTTP, and BullMQ, Inngest, and Temporal for durable background work.",
    url: "/docs/migrating",
    type: "article",
  },
};

const toc = [
  { id: "express", title: "Coming from Express" },
  { id: "bullmq", title: "From BullMQ" },
  { id: "inngest", title: "From Inngest" },
  { id: "temporal", title: "From Temporal" },
];

const expressBefore = `import express from "express";
const app = express();

app.use(express.json());
app.use(cors());

const api = express.Router();
api.get("/users/:id", (req, res) => res.json({ id: req.params.id }));
app.use("/api", api);

app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
app.listen(3000);`;

const expressAfter = `import { zenzip } from "zenzipjs";
const app = zenzip();

app.use(zenzip.json());
app.use(zenzip.cors());

const api = zenzip.Router();
api.get("/users/:id", (req, res) => res.json({ id: req.params.id }));
app.use("/api", api);

app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

await app.start();              // ← the one new line: boot the runtime
await app.listen({ port: 3000 });`;

const bullmqBefore = `import { Queue, Worker } from "bullmq";
const connection = { host: "localhost", port: 6379 };   // Redis required

const emails = new Queue("emails", { connection });
new Worker("emails", async (job) => {
  await sendEmail(job.data);
}, { connection, concurrency: 5 });

await emails.add("welcome", { to: "a@b.com" }, { attempts: 3 });`;

const bullmqAfter = `import { zenzip } from "zenzipjs";
const app = zenzip();                       // no Redis — embedded store

const emails = app.queue("emails", { concurrency: 5, retries: 2 });
emails.process(async (job) => {
  await sendEmail(job.data);                // job.data, job.attempt, …
});

await app.start();
await emails.push({ to: "a@b.com" });       // delay/priority/retries opts`;

const inngestBefore = `import { Inngest } from "inngest";
const inngest = new Inngest({ id: "app" });

export const onSignup = inngest.createFunction(
  { id: "welcome" },
  { event: "user.created" },
  async ({ event, step }) => {
    await step.run("email", () => sendWelcome(event.data));
    await step.sleep("wait", "1d");
    await step.run("nudge", () => sendNudge(event.data));
  },
);

await inngest.send({ name: "user.created", data: { id: 1 } });`;

const inngestAfter = `import { zenzip } from "zenzipjs";
const app = zenzip();

app.workflow("welcome", { on: "user.created" }, async ({ step, input }) => {
  // triggered runs receive { event, payload, emittedAt }
  await step.run("email", () => sendWelcome(input.payload));
  await step.sleep("wait", "1d");           // durable, holds no resources
  await step.run("nudge", () => sendNudge(input.payload));
});

await app.start();
app.emit("user.created", { id: 1 });`;

const temporalBefore = `// activities.ts + workflow.ts + worker.ts + client.ts — 4 files,
// determinism rules, versioning/patching, a Temporal cluster to run.
export async function order(input) {
  const a = proxyActivities({ startToCloseTimeout: "1m" });
  await a.charge(input);
  await a.ship(input);
}
// Worker.create({ taskQueue, workflows, activities }) + cluster + UI`;

const temporalAfter = `import { zenzip } from "zenzipjs";
const app = zenzip();                       // no cluster, no separate worker

app.workflow("order", async ({ step, input }) => {
  await step.run("charge", () => charge(input));   // activities → step.run
  await step.run("ship", () => ship(input));
});

await app.start();                          // worker + dashboard in-process
// between-step code is plain TypeScript — no determinism constraints`;

export default function Page() {
  return (
    <DocPage
      title="Migrating to ZenZip"
      description="Side-by-side guides from the tools ZenZip replaces — Express for HTTP, BullMQ/Inngest/Temporal for durable work. The shapes are deliberately familiar."
      href="/docs/migrating"
      toc={toc}
    >
      <H2 id="express">Coming from Express</H2>
      <P>
        The HTTP layer is Express-shaped on purpose (see{" "}
        <A href="/docs/express">Express &amp; Middleware</A>). Most apps move
        over by renaming the import and adding <Code>await app.start()</Code>{" "}
        before <Code>listen()</Code>.
      </P>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <CodeBlock code={expressBefore} filename="express.ts" />
        <CodeBlock code={expressAfter} filename="zenzip.ts" />
      </div>
      <H3 id="express-map">What maps directly</H3>
      <Table
        head={["Express", "ZenZip"]}
        rows={[
          [<Code key="1">express()</Code>, <Code key="1b">zenzip()</Code>],
          [<Code key="2">app.use / get / post / …</Code>, <Code key="2b">identical</Code>],
          [<Code key="3">express.Router()</Code>, <Code key="3b">zenzip.Router()</Code>],
          [<Code key="4">express.json() / urlencoded()</Code>, <Code key="4b">zenzip.json() / urlencoded()</Code>],
          [<Code key="5">express.static()</Code>, <Code key="5b">zenzip.static()</Code>],
          [<Code key="6">cors() / morgan()</Code>, <Code key="6b">zenzip.cors() / zenzip.logger()</Code>],
          [<Code key="7">(req, res, next)</Code>, <Code key="7b">identical (+ optional ctx handlers)</Code>],
        ]}
      />
      <Callout type="info" title="The upgrade path">
        <p>
          Once you&apos;re on <code>app</code>, durability is right there:{" "}
          <code>app.queue()</code>, <code>app.workflow()</code>,{" "}
          <code>app.agent()</code> — call <code>trigger</code>/<code>push</code>{" "}
          from any route handler. No new service, no broker.
        </p>
      </Callout>

      <H2 id="bullmq">From BullMQ</H2>
      <P>
        Same queue/worker mental model — minus Redis. The embedded store is the
        broker; multi-node uses Postgres, never a separate Redis.
      </P>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <CodeBlock code={bullmqBefore} filename="bullmq.ts" />
        <CodeBlock code={bullmqAfter} filename="zenzip.ts" />
      </div>
      <UL>
        <LI>
          <Code>new Queue(name)</Code> + <Code>new Worker(name, fn)</Code> →{" "}
          <Code>app.queue(name)</Code> + <Code>.process(fn)</Code>.
        </LI>
        <LI>
          <Code>queue.add(jobName, data, opts)</Code> →{" "}
          <Code>queue.push(data, opts)</Code> (<Code>delay</Code>,{" "}
          <Code>priority</Code>, <Code>retries</Code>).
        </LI>
        <LI>
          <Code>attempts</Code> → <Code>retries</Code>; concurrency, backoff,
          and rate limit are <A href="/docs/queues">queue options</A>.
        </LI>
        <LI>No connection config — nothing to provision in dev.</LI>
      </UL>

      <H2 id="inngest">From Inngest</H2>
      <P>
        The step model is nearly identical — ZenZip uses the same{" "}
        memoization approach (steps are journaled and replayed-by-result, not
        re-executed). The big difference: it runs in your process, on your
        store, with no SaaS.
      </P>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <CodeBlock code={inngestBefore} filename="inngest.ts" />
        <CodeBlock code={inngestAfter} filename="zenzip.ts" />
      </div>
      <UL>
        <LI>
          <Code>createFunction(&#123; event &#125;, fn)</Code> →{" "}
          <Code>app.workflow(name, &#123; on: &quot;evt&quot; &#125;, fn)</Code>.
        </LI>
        <LI>
          <Code>step.run / step.sleep</Code> map 1:1;{" "}
          <Code>step.waitForEvent</Code>, <Code>step.invoke</Code>,{" "}
          <Code>step.all</Code> are all there.
        </LI>
        <LI>
          <Code>inngest.send(event)</Code> → <Code>app.emit(event, payload)</Code>;{" "}
          triggered runs get <Code>&#123; event, payload, emittedAt &#125;</Code> as{" "}
          <Code>input</Code>.
        </LI>
      </UL>

      <H2 id="temporal">From Temporal</H2>
      <P>
        ZenZip targets the same guarantee — work that survives crashes — without
        the heaviest costs: no cluster, no separate worker fleet, and{" "}
        <strong>no determinism tax</strong>. Steps are memoized by result, so
        between-step code is ordinary TypeScript; there are no replay
        constraints, no <Code>patched()</Code> versioning gymnastics.
      </P>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <CodeBlock code={temporalBefore} filename="temporal.ts" />
        <CodeBlock code={temporalAfter} filename="zenzip.ts" />
      </div>
      <Table
        head={["Temporal", "ZenZip"]}
        rows={[
          [<Code key="1">Activity / proxyActivities</Code>, <Code key="1b">step.run(id, fn)</Code>],
          [<Code key="2">workflow.sleep</Code>, <Code key="2b">step.sleep(id, dur)</Code>],
          [<Code key="3">signals / await condition</Code>, <Code key="3b">step.waitForEvent(...)</Code>],
          [<Code key="4">child workflows</Code>, <Code key="4b">step.invoke(id, wf, input)</Code>],
          [<Code key="5">Worker + cluster + UI</Code>, <Code key="5b">app.start() + embedded dashboard</Code>],
          [<Code key="6">determinism + versioning rules</Code>, <Code key="6b">none — plain TS between steps</Code>],
        ]}
      />
      <Callout type="warn" title="What you give up">
        <p>
          Temporal&apos;s strict event-sourced replay enables features ZenZip
          intentionally does not (e.g. arbitrarily long history with full
          deterministic re-execution). For the vast majority of durable backends
          and agents, memoization is the better trade — see{" "}
          <A href="/docs/durability">Durability &amp; Semantics</A>.
        </p>
      </Callout>
    </DocPage>
  );
}
