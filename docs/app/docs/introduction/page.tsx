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

export const metadata: Metadata = { title: "Introduction" };

const toc = [
  { id: "what-is-zenzip", title: "What is ZenZip?" },
  { id: "why", title: "Why it exists" },
  { id: "the-position", title: "Where it fits" },
  { id: "one-engine", title: "One engine" },
  { id: "status", title: "Project status" },
];

const taste = `import { zenzip } from "zenzip";

const app = zenzip();                       // embedded SQLite store, zero config

const emails = app.queue("emails", { retries: 5 });
emails.process(async (job) => smtp.send(job.data));

app.schedule("digest", "0 9 * * *", () => buildDigest());

const onboard = app.workflow("onboard", async ({ step, input }) => {
  await step.run("create-account", () => accounts.create(input));
  await step.sleep("wait-a-day", "24h");
  await step.run("follow-up", () => emails.push({ to: input.email }));
});

await app.start();`;

export default function Page() {
  return (
    <DocPage
      title="Introduction"
      description="ZenZip is an agent-native backend framework for Node.js: durable workflows, queues, schedules, and (soon) agents on a single embedded Rust runtime."
      href="/docs/introduction"
      toc={toc}
    >
      <H2 id="what-is-zenzip">What is ZenZip?</H2>
      <P>
        ZenZip gives a Node.js process the backend capabilities that normally
        require a small fleet of infrastructure: durable job queues, persisted
        cron schedules, and crash-proof multi-step workflows. The engine is
        written in Rust and embedded into your process via napi-rs — state
        lives in a single SQLite file in your project folder.
      </P>
      <CodeBlock code={taste} filename="app.ts" className="mt-6" />
      <P>
        Everything above survives <Code>kill -9</Code>. Jobs that were
        mid-flight are redelivered. The workflow sleeping for 24 hours wakes up
        on schedule even if you deployed twice in between.
      </P>

      <H2 id="why">Why it exists</H2>
      <P>
        A typical production Node backend accumulates this stack:
      </P>
      <UL>
        <LI>
          <Strong>BullMQ + Redis</Strong> for background jobs
        </LI>
        <LI>
          <Strong>Temporal</Strong> (a cluster you operate) for durable
          workflows
        </LI>
        <LI>
          <Strong>node-cron</Strong> on a box that must never restart at the
          wrong time
        </LI>
        <LI>
          <Strong>RabbitMQ / SNS</Strong> for events
        </LI>
        <LI>
          <Strong>LangGraph + custom glue</Strong> for agents
        </LI>
        <LI>
          <Strong>OpenTelemetry + Grafana</Strong> assembled by hand
        </LI>
      </UL>
      <P>
        Each piece works. Together they are six services to provision, secure,
        monitor, and pay for — before writing a line of business logic. ZenZip
        collapses them into one dependency, the way SQLite replaced
        &ldquo;install a database server&rdquo; for a huge class of
        applications.
      </P>
      <Callout type="info" title="Speed is not the pitch">
        <p>
          The Rust core is fast, but frameworks don&apos;t win on router
          benchmarks — our own <A href="/docs/benchmarks">Phase 0 measurements</A>{" "}
          killed the idea of a Rust HTTP server. The pitch is{" "}
          <strong>deleting infrastructure</strong> and{" "}
          <strong>durability by default</strong>.
        </p>
      </Callout>

      <H2 id="the-position">Where it fits</H2>
      <Table
        head={["Product", "What it covers", "The gap ZenZip fills"]}
        rows={[
          [
            <Strong key="t">Temporal</Strong>,
            "Durable workflows",
            "Heavy cluster, replay-determinism rules, not embeddable",
          ],
          [
            <Strong key="i">Inngest / Trigger.dev</Strong>,
            "Step functions, jobs",
            "Cloud-first platforms — you don't own the runtime",
          ],
          [
            <Strong key="h">Hatchet / Restate</Strong>,
            "Queues + durable execution",
            "Separate engine service / sidecar to operate",
          ],
          [
            <Strong key="e">Encore.ts</Strong>,
            "Rust-powered backend framework",
            "No durable workflows, no retry queues, no agents",
          ],
          [
            <Strong key="b">BullMQ</Strong>,
            "Queues",
            "Requires Redis; no workflows or observability",
          ],
        ]}
      />
      <P>
        The unoccupied square: <Strong>embedded</Strong> (in-process, zero
        extra services) + <Strong>durable</Strong> +{" "}
        <Strong>agent-native</Strong> + <Strong>a full backend framework</Strong>.
        That is the square ZenZip sits in.
      </P>

      <H2 id="one-engine">One engine</H2>
      <P>
        Internally there is exactly one execution engine. Every feature is a
        projection of it:
      </P>
      <UL>
        <LI>
          A <Strong>queue job</Strong> is a single unit of leased, retryable
          work
        </LI>
        <LI>
          A <Strong>schedule</Strong> fires by enqueuing onto a hidden internal
          queue
        </LI>
        <LI>
          A <Strong>workflow run</Strong> is a job whose handler drives the
          step-memoization journal
        </LI>
        <LI>
          An <Strong>agent</Strong> (Phase 4) is a workflow whose steps are
          generated dynamically by an LLM loop
        </LI>
      </UL>
      <P>
        One engine means every feature inherits the same lease-based crash
        recovery, retry backoff, and observability — and the codebase stays
        small enough to audit. See{" "}
        <A href="/docs/architecture">Architecture</A> for the full picture.
      </P>

      <H2 id="status">Project status</H2>
      <P>
        ZenZip is a <Strong>pre-1.0 alpha</Strong> being built in strictly
        serial, test-gated phases:
      </P>
      <Table
        head={["Phase", "Scope", "Status"]}
        rows={[
          ["0", "NAPI boundary + storage benchmarks", "✅ complete"],
          ["1", "Queues, scheduler, runtime shell", "✅ complete — 17 JS + 14 Rust tests"],
          ["2", "Durable workflow engine", "✅ complete — chaos-tested, step API frozen"],
          ["3", "Event bus, state machines, HTTP adapter, dashboard", "🔜 next"],
          ["4", "Agent engine", "planned"],
          ["5", "Postgres multi-node", "planned"],
        ]}
      />
      <P>
        The <A href="/docs/roadmap">roadmap</A> tracks every task. The{" "}
        <A href="/docs/benchmarks">benchmarks page</A> shows the measurements
        behind each architecture decision.
      </P>
    </DocPage>
  );
}
