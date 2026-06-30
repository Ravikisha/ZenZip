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
  PropsTable,
  Strong,
  UL,
} from "@/components/docs/typography";

export const metadata: Metadata = { title: "Queues" };

const toc = [
  { id: "basics", title: "Basics" },
  { id: "options", title: "Queue options" },
  { id: "pushing", title: "Pushing jobs" },
  { id: "processing", title: "Processing" },
  { id: "retries-dlq", title: "Retries & the DLQ" },
  { id: "rate-limiting", title: "Rate limiting" },
  { id: "per-key", title: "Per-key concurrency" },
  { id: "throttle", title: "Throttle" },
  { id: "debounce", title: "Debounce" },
  { id: "batch", title: "Batch consumers" },
  { id: "validation", title: "Payload validation" },
  { id: "lifecycle", title: "Crash recovery & shutdown" },
];

const basics = `const emails = app.queue<{ to: string; subject: string }>("emails", {
  concurrency: 10,
  retries: 5,
});

emails.process(async (job) => {
  // job: { id, queue, data, attempt, maxAttempts }
  await smtp.send(job.data);
  // resolve = ack (job deleted) · throw = nack (retry → DLQ)
});

await app.start();
await emails.push({ to: "a@b.co", subject: "Hi" });`;

const pushing = `// Single push — returns the job id.
const id = await emails.push({ to, subject });

// Bulk push — one transaction, one boundary crossing.
const ids = await emails.pushBulk(items);

// Options per push:
await emails.push(data, {
  delay: "5m",        // not claimable before now + 5m
  priority: 3,        // higher runs first (default 0)
  retries: 1,         // override the queue's retry budget for this job
});`;

const dlq = `// Inspect dead jobs (exhausted retry budget):
const dead = await emails.deadJobs();
// → [{ id, queue, data, attempt, lastError, createdAt }]

// Put them back with a fresh retry budget:
await emails.requeueDead();            // all of them
await emails.requeueDead([dead[0].id]); // or specific ids

// …or permanently discard them:
await emails.purgeDead();             // delete all dead jobs, returns the count

// Pause/resume claiming — e.g. during an incident or maintenance:
emails.pause();                       // stop claiming; in-flight jobs finish
emails.isPaused();                    // → true
emails.resume();                      // start claiming again

// Health:
await emails.pendingCount();  // claimable now or scheduled
await emails.activeCount();   // pending + currently running`;

const rateLimit = `const webhooks = app.queue("webhooks", {
  concurrency: 20,
  // Token bucket: at most 100 job starts per minute.
  // Burst capacity = max; refill is continuous.
  rateLimit: { max: 100, per: "1m" },
});`;

const throttle = `// Smooth starts to at most 5 per second per user (every job runs, paced).
const notify = app.queue<{ userId: string }>("notify", {
  throttle: { key: (d) => d.userId, max: 5, per: "1s" },
});
await notify.push({ userId: "u_42" });`;

const debounce = `// Collapse a burst: only the last push per key runs, after a quiet window.
const reindex = app.queue<{ docId: string }>("reindex", {
  debounce: { key: (d) => d.docId, window: "5s" },
});
// 100 edits to doc "42" in 5s → one reindex of "42" runs.
await reindex.push({ docId: "42" });`;

const perKey = `// At most 1 job per user at a time; different users run in parallel.
const sync = app.queue<{ userId: string }>("sync", {
  concurrency: { limit: 1, key: (data) => data.userId },
});
sync.process(async (job) => { await syncUser(job.data.userId); });

// Pushing computes the key from the data automatically.
await sync.push({ userId: "u_42" });`;

const batch = `const indexer = app.queue<Doc>("index", { concurrency: 2 });

// Up to 50 jobs per invocation. All-or-nothing: a throw retries
// every job in the batch (each on its own attempt budget).
indexer.processBatch(
  async (jobs) => {
    await search.bulkIndex(jobs.map((j) => j.data));
  },
  { size: 50 },
);`;

const schemaCode = `import { z } from "zod";

const Email = z.object({ to: z.string().email(), subject: z.string() });

// Any Standard Schema v1 library works (zod 3.24+, valibot, arktype).
const emails = app.queue("emails", { schema: Email });

await emails.push({ to: "not-an-email" });
// → throws: invalid payload for queue "emails": Invalid email`;

const producerOnly = `// Producer-only process: define the queue, never call .process().
// Consumers run elsewhere against the same store.
const emails = app.queue("emails");
await app.start();
await emails.push({ to, subject });`;

export default function Page() {
  return (
    <DocPage
      title="Queues"
      description="Durable, at-least-once job queues on embedded SQLite: leases, exponential backoff, priorities, delays, rate limits, batch consumers, and a dead-letter queue."
      href="/docs/queues"
      toc={toc}
    >
      <H2 id="basics">Basics</H2>
      <CodeBlock code={basics} filename="emails.ts" />
      <P>
        Jobs are persisted before <Code>push()</Code> returns. A claimed job
        holds a <Strong>lease</Strong>; if the worker dies without
        acknowledging, the sweeper returns it to pending (or dead-letters it
        if the budget is spent). Delivery is{" "}
        <A href="/docs/durability">at-least-once</A> — design handlers to be
        idempotent.
      </P>

      <H2 id="options">Queue options</H2>
      <PropsTable
        rows={[
          {
            name: "concurrency",
            type: "number | { limit, key }",
            default: "10",
            description:
              "Max handler invocations in flight. A number caps the whole queue; { limit, key: (data) => string } caps in-flight per key — e.g. 1 per user/tenant.",
          },
          {
            name: "retries",
            type: "number",
            default: "2",
            description: (
              <>
                Retries after the first failed attempt — total attempts ={" "}
                <Code>retries + 1</Code>.
              </>
            ),
          },
          {
            name: "backoff",
            type: "{ delay?, maxDelay? }",
            default: `{ delay: "1s", maxDelay: "60s" }`,
            description:
              "Exponential backoff between retries (delay × 2^attempt, capped, ±25% jitter).",
          },
          {
            name: "lease",
            type: "Duration",
            default: `"30s"`,
            description:
              "Crash-redelivery horizon. Renewed automatically at lease/3 while the handler runs.",
          },
          {
            name: "poll",
            type: "Duration",
            default: `"250ms"`,
            description:
              "Poll interval for work pushed by other processes. Same-process pushes wake the dispatcher instantly.",
          },
          {
            name: "batch",
            type: "number",
            default: "32",
            description: "Max jobs claimed per storage round-trip.",
          },
          {
            name: "rateLimit",
            type: "{ max, per }",
            description: "Token-bucket cap on job starts. See below.",
          },
          {
            name: "maxPending",
            type: "number",
            description:
              "Backpressure: push() / pushBulk() throw QueueFullError once this many jobs are pending. Best-effort admission control; omit for unbounded.",
          },
          {
            name: "schema",
            type: "StandardSchemaV1<T>",
            description: "Validated on push. zod 3.24+, valibot, arktype…",
          },
        ]}
      />
      <P>
        Durations everywhere accept <Code>number</Code> (ms) or strings:{" "}
        <Code>&quot;250ms&quot;</Code>, <Code>&quot;30s&quot;</Code>,{" "}
        <Code>&quot;5m&quot;</Code>, <Code>&quot;2h&quot;</Code>,{" "}
        <Code>&quot;1d&quot;</Code>.
      </P>

      <H2 id="pushing">Pushing jobs</H2>
      <CodeBlock code={pushing} />
      <H3>Producer-only processes</H3>
      <CodeBlock code={producerOnly} className="mt-4" />
      <P>
        A queue without a processor never claims — useful for web servers
        that only enqueue while dedicated workers consume.
      </P>

      <H2 id="processing">Processing</H2>
      <UL>
        <LI>
          Attach <Code>.process()</Code> (or <Code>.processBatch()</Code>){" "}
          <Strong>before</Strong> <Code>app.start()</Code> — registration is a
          startup-time act.
        </LI>
        <LI>
          The handler resolving acknowledges the job (it&apos;s deleted).
          Throwing schedules a retry; the thrown message is stored as{" "}
          <Code>lastError</Code>.
        </LI>
        <LI>
          <Code>job.attempt</Code> is 1-based and counts crashes too: if a
          worker dies mid-job, the redelivered job arrives with the failed
          attempt already counted.
        </LI>
        <LI>
          Priority order is <Code>priority DESC</Code>, then FIFO within a
          priority (ids are time-sortable UUIDv7).
        </LI>
      </UL>

      <H2 id="retries-dlq">Retries &amp; the dead-letter queue</H2>
      <P>
        A job that exhausts its attempts moves to the DLQ instead of being
        lost:
      </P>
      <CodeBlock code={dlq} />
      <P>
        <Code>requeueDead()</Code> resets the attempt counter — the job gets a
        full fresh budget.
      </P>

      <H2 id="rate-limiting">Rate limiting</H2>
      <CodeBlock code={rateLimit} />
      <P>
        The token bucket lives in the Rust dispatcher: it caps job{" "}
        <Strong>starts</Strong>, refills continuously, returns unused tokens
        when a claim comes back short, and sleeps precisely until the next
        token instead of spinning. Combine with <Code>concurrency</Code> —
        rate limits cap throughput, concurrency caps parallelism.
      </P>

      <H2 id="per-key">Per-key concurrency</H2>
      <CodeBlock code={perKey} />
      <P>
        The object form caps in-flight jobs <Strong>per key</Strong> — at most{" "}
        <Code>limit</Code> jobs sharing <Code>key(data)</Code> run at once, while
        different keys run in parallel. Enforced in the store at claim time, so
        the cap holds across processes and nodes (on Postgres, keyed claims for
        a queue serialize via an advisory lock to keep the count exact). The key
        is computed at <Code>push</Code> from the job data.
      </P>
      <P>
        <Strong>Fairness:</Strong> add <Code>fair: true</Code> to
        round-robin claims across the concurrency-key groups, so one busy tenant
        can&apos;t starve the others — the claim batch takes one job per key
        before a second from any.
      </P>

      <H2 id="throttle">Throttle</H2>
      <CodeBlock code={throttle} />
      <P>
        Throttle <Strong>spreads</Strong> where debounce <Strong>drops</Strong>:
        each push with a <Code>throttle.key</Code> is scheduled after the key&apos;s
        last slot (spacing = <Code>per / max</Code>), smoothing starts to a steady
        per-key rate — every job runs, just paced. Enforced at push via a
        per-key cursor in the store, so the rate holds across processes.
      </P>

      <H2 id="debounce">Debounce</H2>
      <CodeBlock code={debounce} />
      <P>
        Each push with a <Code>debounce.key</Code> deletes any still-pending job
        with that key and reschedules <Code>window</Code> out — so a burst
        collapses to a single run once it goes quiet. Enforced at push in the
        store (atomic delete-then-insert), so it holds across processes. The key
        is computed from the job data.
      </P>

      <H2 id="batch">Batch consumers</H2>
      <CodeBlock code={batch} />
      <UL>
        <LI>
          <Code>concurrency</Code> counts <Strong>batch invocations</Strong>,
          not individual jobs — the example above can have 100 jobs in flight
          (2 × 50).
        </LI>
        <LI>
          Semantics are all-or-nothing per invocation, but each job tracks its
          own attempt budget, so a poisoned job eventually dead-letters alone.
        </LI>
      </UL>

      <H2 id="validation">Payload validation</H2>
      <CodeBlock code={schemaCode} />

      <H2 id="lifecycle">Crash recovery &amp; shutdown</H2>
      <UL>
        <LI>
          <Strong>Crash:</Strong> leased jobs whose worker died are swept back
          to pending after the lease expires (sweep cadence:{" "}
          <Code>sweep</Code> option, default 5s) — verified by a real SIGKILL
          harness in CI.
        </LI>
        <LI>
          <Strong>Graceful stop:</Strong>{" "}
          <Code>app.stop({"{ timeout: “30s” }"})</Code> stops
          claiming, drains in-flight handlers, and reports whether the drain
          completed cleanly.
        </LI>
        <LI>
          <Strong>Signals:</Strong> SIGINT/SIGTERM handlers are installed by
          default (<Code>handleSignals: false</Code> to opt out).
        </LI>
      </UL>
      <Callout type="info">
        <p>
          Queue throughput numbers and the methodology behind them are on the{" "}
          <a className="underline" href="/docs/benchmarks">
            benchmarks page
          </a>
          .
        </p>
      </Callout>
    </DocPage>
  );
}
