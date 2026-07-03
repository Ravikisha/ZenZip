import type { Metadata } from "next";

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

export const metadata: Metadata = {
  title: "Comparisons",
  description:
    "Honest positioning of ZenZip against Temporal, Inngest, Trigger.dev, and BullMQ — including the cases where each of those tools is the better choice.",
  alternates: { canonical: "/docs/comparison" },
  openGraph: {
    title: "Comparisons · ZenZip",
    description:
      "Honest positioning of ZenZip against Temporal, Inngest, Trigger.dev, and BullMQ — including the cases where each of those tools is the better choice.",
    url: "/docs/comparison",
    type: "article",
  },
};

const toc = [
  { id: "summary", title: "The short version" },
  { id: "temporal", title: "vs Temporal" },
  { id: "inngest", title: "vs Inngest / Trigger.dev" },
  { id: "bullmq", title: "vs BullMQ" },
  { id: "when-not", title: "When NOT to use ZenZip" },
];

export default function Page() {
  return (
    <DocPage
      title="Comparisons"
      description="Honest positioning against Temporal, Inngest/Trigger.dev, and BullMQ — including the cases where they're the better choice."
      href="/docs/comparison"
      toc={toc}
    >
      <H2 id="summary">The short version</H2>
      <Table
        head={["", "ZenZip", "Temporal", "Inngest / Trigger.dev", "BullMQ"]}
        rows={[
          [
            <Strong key="1">Infrastructure</Strong>,
            "none (embedded SQLite) → Postgres",
            "server cluster + DB",
            "their cloud (self-host secondary)",
            "Redis",
          ],
          [
            <Strong key="2">Durable workflows</Strong>,
            "✅ step memoization",
            "✅ deterministic replay",
            "✅ step memoization",
            "— (flows ≠ durability)",
          ],
          [
            <Strong key="3">Queues</Strong>,
            "✅ built in",
            "via workflows",
            "✅",
            "✅ (the gold standard API)",
          ],
          [
            <Strong key="4">AI agents</Strong>,
            "✅ durable, first-class",
            "—",
            "partial / SDK add-ons",
            "—",
          ],
          [
            <Strong key="5">Where code runs</Strong>,
            "your process",
            "your workers + their cluster",
            "your handlers, their orchestration",
            "your process",
          ],
          [
            <Strong key="6">Scale ceiling</Strong>,
            "1 box → Postgres multi-node",
            "very high",
            "managed for you",
            "Redis cluster",
          ],
        ]}
      />

      <H2 id="temporal">vs Temporal</H2>
      <P>
        Temporal is the most battle-tested durable-execution system in
        existence, and at massive scale it remains the safer bet. ZenZip
        differs in two deliberate ways:
      </P>
      <UL>
        <LI>
          <Strong>No cluster.</Strong> Temporal means operating (or paying
          for) a server fleet plus its database before your first workflow.
          ZenZip is <Code>npm install</Code>; the engine lives in your
          process.
        </LI>
        <LI>
          <Strong>No replay determinism rules.</Strong> Temporal re-executes
          your whole function on recovery, so <Code>Date.now()</Code>, random
          numbers, and bare I/O corrupt replays — the #1 source of user pain.
          ZenZip journals step results instead: between-steps code is plain
          TypeScript with no special rules (
          <A href="/docs/durability">how it works</A>).
        </LI>
      </UL>
      <P>
        Choose Temporal when you need multi-region failover, years-long run
        retention with strict audit, or polyglot workers today.
      </P>

      <H2 id="inngest">vs Inngest / Trigger.dev</H2>
      <P>
        Closest relatives — both proved that step functions are the right
        developer experience, and ZenZip&apos;s step API deliberately rhymes
        with theirs. The difference is the deployment model:
      </P>
      <UL>
        <LI>
          <Strong>They are platforms; ZenZip is a framework.</Strong> Their
          orchestration state lives in their cloud (self-hosting exists but is
          the second-class path). ZenZip&apos;s state lives in a SQLite file
          you can open, back up, and ship — or your own Postgres.
        </LI>
        <LI>
          <Strong>Offline and air-gapped work.</Strong> Tests, CI, laptops on
          planes, on-prem deployments — no callback URLs, no tunnels, no dev
          servers proxying events.
        </LI>
        <LI>
          <Strong>One runtime, more primitives.</Strong> Queues, schedules,
          state machines, an event outbox, and durable agents share one
          engine and one dashboard instead of being separate products.
        </LI>
      </UL>
      <P>
        Choose them when you want orchestration as a managed service with
        zero servers of your own and a team dashboard out of the box — that
        is genuinely their job, and they do it well.
      </P>

      <H2 id="bullmq">vs BullMQ</H2>
      <UL>
        <LI>
          BullMQ is an excellent <Strong>queue</Strong>. ZenZip&apos;s queues
          cover the same ground (retries, backoff, priorities, delays, rate
          limits, batches, DLQ) <Strong>without Redis</Strong> — and sit
          under workflows and agents that BullMQ doesn&apos;t attempt.
        </LI>
        <LI>
          BullMQ flows chain jobs but don&apos;t give you durable multi-step
          functions with sleeps, event waits, and memoized recovery.
        </LI>
        <LI>
          Raw throughput at extreme scale favors Redis. ZenZip&apos;s embedded
          store handles ~10k jobs/s worst-case on a laptop — beyond most apps,
          but if you&apos;re saturating Redis clusters, you&apos;re not the
          target user yet.
        </LI>
      </UL>

      <H2 id="when-not">When NOT to use ZenZip</H2>
      <Callout type="warn" title="Honesty section">
        <p>Skip ZenZip (for now) if any of these are true:</p>
      </Callout>
      <UL>
        <LI>
          <Strong>You need it battle-proven today.</Strong> This is a pre-1.0
          alpha. The chaos suites are real, but production miles are not yet.
        </LI>
        <LI>
          <Strong>Sustained six-figure jobs/sec.</Strong> Postgres mode
          scales out, but extreme-throughput queueing on dedicated brokers is
          a different design point.
        </LI>
        <LI>
          <Strong>Polyglot workers.</Strong> Node-only until a Python SDK
          lands (post-1.0 backlog).
        </LI>
        <LI>
          <Strong>Serverless-only deployment.</Strong> The engine wants a
          long-lived process; Lambda-style execution is hostile to embedded
          runtimes.
        </LI>
      </UL>
    </DocPage>
  );
}
