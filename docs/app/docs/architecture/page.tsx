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

export const metadata: Metadata = {
  title: "Architecture",
  description:
    "How ZenZip embeds a Rust engine in your Node process: the napi-rs boundary, one engine behind every feature, SQLite and Postgres storage, and the decision log.",
  alternates: { canonical: "/docs/architecture" },
  openGraph: {
    title: "Architecture · ZenZip",
    description:
      "How ZenZip embeds a Rust engine in your Node process: the napi-rs boundary, one engine behind every feature, SQLite and Postgres storage, and the decision log.",
    url: "/docs/architecture",
    type: "article",
  },
};

const toc = [
  { id: "overview", title: "Overview" },
  { id: "boundary", title: "The NAPI boundary" },
  { id: "one-engine", title: "One engine, four surfaces" },
  { id: "storage", title: "Storage" },
  { id: "process-model", title: "Process & threading model" },
  { id: "decisions", title: "Decision log" },
];

const diagram = `┌─────────────────────────────────────────────────────┐
│  TypeScript API  (npm: zenzipjs)                     │
│  app.queue() · app.schedule() · app.workflow()       │
│  app.emit() · typed payloads · Standard Schema       │
└──────────────────────┬──────────────────────────────┘
                       │ napi-rs v3
                       │ sync calls (registration, push,
                       │ trigger, emit, recordStep)
                       │ ThreadsafeFunction dispatch
                       │ (Rust → JS handler invocation)
┌──────────────────────▼──────────────────────────────┐
│  Rust Runtime Core  (zenzip-core · own tokio rt)     │
│                                                      │
│   Queue Engine        Scheduler        Workflow      │
│   leases, backoff,    cron + every,    Engine        │
│   DLQ, rate limits,   tz, catchup,     step journal, │
│   batch dispatch      jitter           suspensions   │
│                                                      │
│   Sweepers: lease expiry · event timeouts            │
└──────────────────────┬──────────────────────────────┘
                       │ Store trait
┌──────────────────────▼──────────────────────────────┐
│  SQLite (WAL) — default, zero config                 │
│  PostgreSQL — multi-node via SKIP LOCKED              │
└──────────────────────────────────────────────────────┘`;

const handlerFlow = `// What actually happens when a job is processed:
//
// 1. [Rust]  dispatcher claims a batch:
//            UPDATE jobs SET status=1, attempt=attempt+1, lease_until=...
//            WHERE id IN (SELECT ... ORDER BY priority DESC LIMIT n)
// 2. [Rust]  spawns a task per job group; renews leases at lease/3 cadence
// 3. [Rust→JS] ThreadsafeFunction call with the job payload (pipelined —
//            hundreds can be in flight)
// 4. [JS]    your handler runs; resolve = ack, reject = nack
// 5. [Rust]  ack deletes the row; nack schedules retry with backoff,
//            or dead-letters when attempts are exhausted`;

export default function Page() {
  return (
    <DocPage
      title="Architecture"
      description="A Rust engine embedded in your Node process: how the boundary works, why there's exactly one engine, and where state lives."
      href="/docs/architecture"
      toc={toc}
    >
      <H2 id="overview">Overview</H2>
      <P>
        ZenZip is two layers joined by napi-rs. TypeScript owns the developer
        experience: typed APIs, validation, your handler code. Rust owns
        everything that must not depend on the event loop being alive and
        responsive: timers, leases, retries, cron evaluation, persistence,
        crash recovery.
      </P>
      <CodeBlock code={diagram} lang="text" className="mt-6" />

      <H2 id="boundary">The NAPI boundary</H2>
      <P>
        Every JS↔Rust crossing has a cost, and we measured it before designing
        the protocol (<A href="/docs/benchmarks">benchmarks</A>). The rules
        that fell out of those numbers are hard rules:
      </P>
      <Table
        head={["Crossing", "Measured cost", "Rule"]}
        rows={[
          [
            <Code key="1">sync fn</Code>,
            "14–34 ns",
            "Use freely: push, trigger, emit, recordStep are all sync",
          ],
          [
            <Code key="2">async fn</Code>,
            "~85–100 µs (!)",
            <>
              <Strong>Banned on hot paths.</Strong> Only cold calls like{" "}
              <Code>stop()</Code> and <Code>waitForRun()</Code>
            </>,
          ],
          [
            <Code key="3">TSFN round-trip</Code>,
            "36 µs solo → 2.4 µs pipelined ×256",
            "All handler dispatch; the engine keeps many in flight",
          ],
        ]}
      />
      <P>Concretely, the queue dispatch loop:</P>
      <CodeBlock code={handlerFlow} lang="text" className="mt-6" />
      <P>
        The workflow engine adds one more boundary optimization: the entire
        journal of completed steps is <Strong>batch-prefetched</Strong> into JS
        at the start of each execution attempt, so <Code>step.run()</Code>{" "}
        memoization hits never cross the boundary at all. Only recording a
        newly completed step does (one sync call, ~tens of µs of SQLite).
      </P>

      <H2 id="one-engine">One engine, four surfaces</H2>
      <P>
        There is a single execution engine — the queue engine — and everything
        else is expressed through it:
      </P>
      <UL>
        <LI>
          <Strong>Queues</Strong> are the engine directly: leased claims,
          per-group concurrency permits, token-bucket rate limits, exponential
          backoff, DLQ.
        </LI>
        <LI>
          <Strong>Schedules</Strong> persist their next fire time; the
          scheduler loop enqueues a job onto a hidden queue{" "}
          (<Code>zenzip.schedule.&lt;name&gt;</Code>) whose concurrency
          encodes the overlap policy.
        </LI>
        <LI>
          <Strong>Workflow runs</Strong> are jobs on{" "}
          <Code>zenzip.workflow.&lt;name&gt;</Code>. The handler loads the
          run, prefetches the journal, invokes the JS executor, and applies
          the outcome. A <Code>step.sleep()</Code> is just a delayed job; a
          crashed attempt is recovered by the same lease sweep that recovers
          queue jobs.
        </LI>
        <LI>
          <Strong>Agents</Strong> are workflows whose steps are generated
          dynamically — every LLM call and tool execution a journaled step,
          inheriting retry, resume, and human-in-the-loop for free.
        </LI>
      </UL>
      <Callout type="tip" title="Why this matters">
        <p>
          Crash recovery, retries, backoff, and observability are implemented
          once and tested once. The SIGKILL chaos harness that validates queue
          recovery is the same machinery that makes workflows durable.
        </p>
      </Callout>

      <H2 id="storage">Storage</H2>
      <P>
        The store is a Rust trait with pluggable backends:
      </P>
      <UL>
        <LI>
          <Strong>SQLite (default).</Strong> WAL mode,{" "}
          <Code>synchronous=NORMAL</Code>, embedded migrations via{" "}
          <Code>user_version</Code>. Measured at 209k inserts/s and ~10k
          worst-case claim+ack/s on a laptop — far beyond most apps&apos;
          needs. Zero configuration: the file lives in <Code>dataDir</Code>.
        </LI>
        <LI>
          <Strong>PostgreSQL (multi-node).</Strong> Same trait, claims via{" "}
          <Code>FOR UPDATE SKIP LOCKED</Code>, for multi-node deployments. No
          custom consensus — Postgres already solved distributed state.
        </LI>
      </UL>
      <P>
        Atomicity rules worth knowing: job claims increment the attempt counter
        and set the lease in one statement; run-state transitions are guarded
        (<Code>UPDATE … WHERE status = expected</Code>) so a wake can never be
        applied twice; completed journal entries are never overwritten.
      </P>

      <H2 id="process-model">Process &amp; threading model</H2>
      <P>
        The engine runs on its <Strong>own tokio runtime</Strong> (2 worker
        threads by default), fully independent of Node&apos;s event loop and of
        napi&apos;s internal runtime. Idle waits — poll timers, lease renewal,
        cron ticks, sweepers — never wake your event loop. The only JS
        execution ZenZip causes is your own handler code.
      </P>
      <UL>
        <LI>
          <Strong>Graceful shutdown:</Strong> <Code>app.stop()</Code> cancels
          claiming, drains in-flight handlers up to a timeout, releases the
          ThreadsafeFunctions (so the event loop can exit), shuts the runtime
          down in the background, and closes the SQLite handle.
        </LI>
        <LI>
          <Strong>Multiple processes, one box:</Strong> WAL supports it;
          producers and consumers can be separate processes sharing the data
          dir — a common pattern for producer web servers with dedicated worker processes.
        </LI>
        <LI>
          <Strong>Multiple machines:</Strong> via Postgres — same API, horizontal scale.
        </LI>
      </UL>

      <H2 id="decisions">Decision log</H2>
      <P>
        The plan records eight numbered decisions (D1–D8) with the reasoning
        and, where applicable, the measurements that settled them:
      </P>
      <Table
        head={["ID", "Decision", "Status"]}
        rows={[
          ["D1", "Step memoization, not Temporal-style replay", "shipped"],
          ["D2", "SQLite embedded default; Postgres for scale-out", "shipped"],
          ["D3", "Coarse boundary: sync calls + pipelined TSFN", "shipped, benchmark-verified"],
          ["D4", "Agents are workflows with dynamic steps", "shipped"],
          ["D5", "HTTP stays a Node adapter (Rust server: NO-GO by benchmark)", "settled"],
          ["D6", "Content-hash workflow versioning, stable step ids", "shipped"],
          ["D7", "At-least-once delivery; effectively-once step recording", "shipped"],
          ["D8", "Own tokio runtime; producer/consumer multi-process model", "shipped"],
        ]}
      />
      <P>
        Benchmark methodology and raw numbers behind each decision:{" "}
        <A href="/docs/benchmarks">Benchmarks</A>.
      </P>
    </DocPage>
  );
}
