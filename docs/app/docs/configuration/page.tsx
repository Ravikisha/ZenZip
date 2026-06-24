import type { Metadata } from "next";

import { CodeBlock } from "@/components/code-block";
import { DocPage } from "@/components/docs/doc-page";
import {
  Callout,
  Code,
  H2,
  LI,
  P,
  PropsTable,
  Strong,
  UL,
} from "@/components/docs/typography";

export const metadata: Metadata = { title: "Configuration" };

const toc = [
  { id: "options", title: "zenzip() options" },
  { id: "durations", title: "Duration strings" },
  { id: "logging", title: "Logging" },
  { id: "store", title: "Storage" },
  { id: "retention", title: "Retention & GC" },
  { id: "health", title: "Health & operations" },
  { id: "hardening", title: "Config hardening" },
  { id: "lifecycle", title: "Lifecycle" },
];

const healthCode = `await app.start();
await app.listen({ port: 3000 });

// Probes for orchestrators (Kubernetes, ECS, …):
//   GET /healthz → 200 { status: "alive" }     liveness, zero store I/O
//   GET /readyz  → 200 { status: "ready" }      readiness: store reachable
//                  503 { status: "unavailable" } not ready — hold traffic
app.health();          // { alive, ready } in-process

// Find runs that stopped progressing (lost wakeup / stalled sweep):
const stuck = await app.orphanedRuns({ idle: "10m" });
// [{ runId, workflow, status, idleMs, reason }]`;

const retentionCode = `// Defaults: keep 7 days of runs + events, sweep hourly.
const app = zenzip({
  retention: {
    runs: "30d",     // keep terminal runs (+ their steps) 30 days
    events: "7d",    // keep events 7 days
    sweep: "1h",     // GC sweep cadence
  },
});

// Keep everything forever (e.g. you archive elsewhere):
zenzip({ retention: { runs: "off", events: "off" } });

// Run a GC pass on demand (ops / cron): returns rows removed.
const { runs, steps, events } = app.gc();`;

const fullConfig = `import { zenzip } from "zenzip";

const app = zenzip({
  dataDir: ".zenzip",                  // where the SQLite store lives
  handleSignals: true,                 // SIGINT/SIGTERM → graceful stop
  sweep: "5s",                         // lease-expiry sweep cadence
  schedulerTick: "250ms",              // scheduler loop cadence
  workerThreads: 2,                    // engine tokio worker threads
  encryptionKey: process.env.ZENZIP_KEY, // AES-256-GCM payloads at rest (opt-in)
  logLevel: "info",
  logger: ({ level, target, message }) => {
    myLogger.log({ level, target, message });
  },
});`;

const loggingCode = `// Route engine logs into your logging stack:
const app = zenzip({
  logLevel: "info",
  logger: (e) => pino.info({ target: e.target }, e.message),
});

// Or just stderr — set logLevel without a logger:
const app2 = zenzip({ logLevel: "debug" });

// Example events you'll see:
// INFO  zenzip_core::runtime  zenzip runtime started queues=3 schedules=1
// INFO  zenzip_core::runtime  recovered lease-expired jobs count=2
// DEBUG zenzip_core::workflow step retry scheduled run=… step=charge`;

const lifecycleCode = `const app = zenzip();

// 1. Definition phase — queues, schedules, workflows. No I/O yet.
const q = app.queue("work");
q.process(async (job) => { /* … */ });

// 2. Start: opens the store (creating dataDir), runs migrations,
//    registers everything with the Rust engine, spawns dispatchers.
await app.start();

// 3. Runtime phase — push, trigger, emit from anywhere.
await q.push({ n: 1 });

// 4. Graceful stop: stop claiming → drain in-flight (up to timeout)
//    → release handlers → close the store. Returns true on clean drain.
const clean = await app.stop({ timeout: "30s" });`;

export default function Page() {
  return (
    <DocPage
      title="Configuration"
      description="Every option on zenzip(), the duration format, structured logging, and the app lifecycle."
      href="/docs/configuration"
      toc={toc}
    >
      <H2 id="options">zenzip() options</H2>
      <CodeBlock code={fullConfig} filename="config.ts" />
      <PropsTable
        rows={[
          {
            name: "dataDir",
            type: "string",
            default: `".zenzip"`,
            description:
              "Directory for the embedded store (zenzip.db, SQLite WAL). Created on start.",
          },
          {
            name: "store",
            type: `{ driver: "sqlite" } | { driver: "postgres", url }`,
            default: "sqlite",
            description:
              "Storage backend. sqlite is embedded + zero-config (single node); postgres enables multi-node (SKIP LOCKED claims, LISTEN/NOTIFY wakeups, advisory-lock scheduler election) with the same API.",
          },
          {
            name: "handleSignals",
            type: "boolean",
            default: "true",
            description:
              "Install SIGINT/SIGTERM handlers that gracefully stop the app, then exit.",
          },
          {
            name: "sweep",
            type: "Duration",
            default: `"5s"`,
            description:
              "How often lease-expired (crashed) jobs are returned to pending. Lower = faster crash recovery, slightly more idle I/O.",
          },
          {
            name: "schedulerTick",
            type: "Duration",
            default: `"250ms"`,
            description:
              "Scheduler + workflow-timeout sweep cadence. Bounds schedule fire precision.",
          },
          {
            name: "workerThreads",
            type: "number",
            default: "2",
            description:
              "Tokio worker threads for the engine runtime. 2 is plenty — handlers run on your event loop, not these threads.",
          },
          {
            name: "logLevel",
            type: `"error" … "trace" | "off"`,
            default: `"off"`,
            description: `Engine log verbosity. Defaults to "info" when a logger is provided.`,
          },
          {
            name: "logger",
            type: "(event: LogEvent) => void",
            description:
              "Receive structured engine logs ({ level, target, message }). Without it, logs go to stderr.",
          },
          {
            name: "retention",
            type: `{ runs?, events?: Duration | "off"; sweep?: Duration }`,
            default: `runs/events "7d", sweep "1h"`,
            description:
              "Retention GC: a background sweep deletes aged terminal runs (+ steps) and old events so tables don't grow forever. Set a window to \"off\" to keep that category indefinitely.",
          },
          {
            name: "payloads",
            type: "{ threshold?: number; store?: BlobStore }",
            description:
              "Large-payload offloading (P9.1): step results over `threshold` bytes (default 64 KiB) go to a blob store; the journal keeps a reference. Default store is the filesystem; multi-node needs a shared store (e.g. S3).",
          },
          {
            name: "encryptionKey",
            type: "string",
            description:
              "Payload encryption at rest (P7.15): AES-256-GCM on job payloads, run inputs/outputs, step results, and event payloads. Load from an env var or secret manager — never hard-code, never lose it. Transparent to enable on an existing DB (legacy plaintext stays readable).",
          },
        ]}
      />

      <H2 id="durations">Duration strings</H2>
      <P>
        Every duration option accepts a <Code>number</Code> (milliseconds) or
        a string: <Code>&quot;250ms&quot;</Code>, <Code>&quot;30s&quot;</Code>,{" "}
        <Code>&quot;5m&quot;</Code>, <Code>&quot;2h&quot;</Code>,{" "}
        <Code>&quot;1d&quot;</Code>. Fractions work (
        <Code>&quot;1.5h&quot;</Code>). Invalid strings throw at definition
        time, not at runtime.
      </P>

      <H2 id="logging">Logging</H2>
      <CodeBlock code={loggingCode} filename="logging.ts" />
      <UL>
        <LI>
          The bridge from Rust <Code>tracing</Code> into JS uses a{" "}
          <Strong>weak</Strong> threadsafe function — holding a logger never
          keeps the Node event loop alive, so your process still exits
          cleanly.
        </LI>
        <LI>
          The subscriber is <Strong>process-global</Strong>: the first app
          that configures logging wins for the process lifetime. Relevant
          only if you run multiple <Code>zenzip()</Code> apps in one process
          (tests, mostly).
        </LI>
        <LI>
          Targets are Rust module paths (<Code>zenzip_core::queue</Code>,{" "}
          <Code>zenzip_core::workflow</Code>…) — filter on them in your log
          pipeline.
        </LI>
      </UL>

      <H2 id="store">Storage</H2>
      <UL>
        <LI>
          <Strong>SQLite (default):</Strong> WAL mode,{" "}
          <Code>synchronous=NORMAL</Code>, <Code>busy_timeout=5s</Code>,
          migrations embedded. Everything — jobs, schedules, runs, step
          journal — lives in one file you can inspect with any SQLite client.
        </LI>
        <LI>
          <Strong>Backups:</Strong> it&apos;s SQLite — snapshot the file (or
          use <Code>.backup</Code>) while the app runs; WAL keeps readers
          consistent.
        </LI>
        <LI>
          <Strong>Postgres (multi-node):</Strong>{" "}
          <Code>{`store: { driver: "postgres", url }`}</Code> — same API,
          horizontal scale. Claims use <Code>FOR UPDATE SKIP LOCKED</Code>;
          cross-node wakeups ride <Code>LISTEN/NOTIFY</Code> (a push on node A
          wakes node B&apos;s dispatchers instantly); schedule ticks are
          CAS-elected so N nodes fire each tick exactly once; dead nodes are
          recovered by the same lease sweep as dead processes. Tables live in
          a dedicated <Code>zenzip</Code> schema. Keep the database
          network-close — pushes/triggers cost a round-trip.
        </LI>
        <LI>
          <Strong>Rolling deploys:</Strong> in-flight runs pin their workflow
          version; old and new nodes can coexist as long as step ids stay
          stable (see <Code>workflow versioning</Code> rules). SQLite→Postgres
          data migration tooling is on the backlog — today, drain one store
          and point at the other.
        </LI>
      </UL>
      <Callout type="info" title="Multiple processes, one store">
        <p>
          WAL supports concurrent processes on one data dir (producer web
          server + consumer worker is the common split). Heavy multi-process
          write contention is still being characterized — the 4-process
          benchmark is an open task before this becomes a documented
          first-class pattern.
        </p>
      </Callout>

      <H2 id="retention">Retention &amp; GC</H2>
      <P>
        A durable engine persists every run, step, and event — so without
        retention the store grows without bound (and the Postgres queue tables
        degrade past ~100k rows). A background GC sweep deletes aged{" "}
        <Strong>terminal</Strong> runs (completed / failed / cancelled), their
        step journal, and old events. It is on by default.
      </P>
      <CodeBlock code={retentionCode} filename="retention.ts" />
      <UL>
        <LI>
          Only <Strong>terminal</Strong> runs are eligible — an in-flight,
          sleeping, or waiting run is never collected, however old.
        </LI>
        <LI>
          Age is measured from the last update (completion time for runs,
          emit time for events), not creation — a long run that just finished
          is safe.
        </LI>
        <LI>
          Each category is independent: <Code>&quot;off&quot;</Code> keeps it
          forever; a <Code>Duration</Code> sets the window.
        </LI>
        <LI>
          The sweep is index-backed (<Code>runs(status, updated_at)</Code>),
          and rows removed are exposed as{" "}
          <Code>runsGc</Code> / <Code>stepsGc</Code> / <Code>eventsGc</Code> in{" "}
          <Code>app.metrics()</Code>. <Code>app.gc()</Code> triggers a pass
          immediately.
        </LI>
      </UL>

      <H2 id="health">Health &amp; operations</H2>
      <CodeBlock code={healthCode} filename="ops.ts" />
      <UL>
        <LI>
          <Strong>Liveness</Strong> (<Code>/healthz</Code>) = the process is up
          and the engine responds — no store I/O, so a slow database never
          fails it (which would trigger needless restarts).
        </LI>
        <LI>
          <Strong>Readiness</Strong> (<Code>/readyz</Code>) = started{" "}
          <em>and</em> the store answers a ping — gate rolling deploys and load
          balancers on it. Returns <Code>503</Code> until ready. A route you
          define yourself at the same path takes precedence.
        </LI>
        <LI>
          <Code>app.orphanedRuns()</Code> surfaces non-terminal runs idle past
          a window (default 5m) — a sleeping run past its wake, a wait past
          timeout, a lost execution wakeup. They should be rare;{" "}
          <Code>zenzip doctor</Code> reports them too.
        </LI>
      </UL>

      <H2 id="hardening">Config hardening</H2>
      <UL>
        <LI>
          <Strong>Boot-time validation (P13.5):</Strong> <Code>app.start()</Code>{" "}
          validates options first and throws a clear{" "}
          <Code>zenzip config: …</Code> error on misconfig (e.g. a postgres
          store with no <Code>url</Code>, a negative payload threshold) — fail
          fast, not a cryptic runtime crash. Call <Code>validateConfig(opts)</Code>{" "}
          yourself to pre-check.
        </LI>
        <LI>
          <Strong>Secrets:</Strong> load tokens / <Code>encryptionKey</Code> /
          the postgres URL from the environment, never source. <Code>redactUrl(url)</Code>{" "}
          masks the password for safe logging.
        </LI>
        <LI>
          <Strong>Audit log (P13.6):</Strong> pass <Code>onAudit</Code> to
          record privileged actions (workflow trigger / cancel, dead-letter
          requeue, agent approve / deny) — each entry is{" "}
          <Code>&#123; action, target, at, detail &#125;</Code>; wire it to an
          append-only store for a queryable trail. A throwing sink never breaks
          the action.
        </LI>
      </UL>

      <H2 id="lifecycle">Lifecycle</H2>
      <CodeBlock code={lifecycleCode} filename="lifecycle.ts" />
      <UL>
        <LI>
          Definitions after <Code>start()</Code> throw — registration is a
          startup-time act by design (the engine wires queues, schedules, and
          workflow executors once).
        </LI>
        <LI>
          <Code>stop()</Code> is idempotent and resolves <Code>true</Code>{" "}
          when all in-flight handlers drained within the timeout.
        </LI>
        <LI>
          After <Code>stop()</Code>, the SQLite handle is closed — data dirs
          can be deleted immediately (matters on Windows).
        </LI>
      </UL>
    </DocPage>
  );
}
