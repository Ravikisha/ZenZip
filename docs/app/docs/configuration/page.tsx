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
  { id: "lifecycle", title: "Lifecycle" },
];

const fullConfig = `import { zenzip } from "zenzip";

const app = zenzip({
  dataDir: ".zenzip",                  // where the SQLite store lives
  handleSignals: true,                 // SIGINT/SIGTERM → graceful stop
  sweep: "5s",                         // lease-expiry sweep cadence
  schedulerTick: "250ms",              // scheduler loop cadence
  workerThreads: 2,                    // engine tokio worker threads
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
              "Storage backend. postgres throws today with a pointer to Phase 5 — the option exists so the config shape is stable.",
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
