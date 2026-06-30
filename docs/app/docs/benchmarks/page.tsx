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

export const metadata: Metadata = { title: "Benchmarks" };

const toc = [
  { id: "why", title: "Why benchmark first" },
  { id: "boundary", title: "JS ↔ Rust boundary" },
  { id: "tsfn", title: "Handler dispatch" },
  { id: "http", title: "The HTTP no-go" },
  { id: "compare", title: "vs Express & Fastify" },
  { id: "sqlite", title: "SQLite throughput" },
  { id: "pg-scale", title: "Postgres at scale" },
  { id: "method", title: "Methodology notes" },
];

const rules = `// Rules the engine is built on (all spike-derived, all enforced):
//
// 1. Hot-path JS→Rust calls are SYNC.
//    push / trigger / emit / recordStep — 14–34 ns each.
//
// 2. Async NAPI functions are BANNED on hot paths (~85 µs each).
//    Only cold calls: stop(), waitForRun().
//
// 3. Rust→JS handler dispatch is PIPELINED ThreadsafeFunctions.
//    36 µs alone → 2.4 µs amortized with 256 in flight.
//
// 4. The workflow journal is BATCH-PREFETCHED per attempt —
//    step memoization hits never cross the boundary at all.`;

export default function Page() {
  return (
    <DocPage
      title="Benchmarks"
      description="ZenZip measured the NAPI boundary, handler dispatch, HTTP, and SQLite before writing engine code. These numbers shaped — and killed — design decisions."
      href="/docs/benchmarks"
      toc={toc}
    >
      <Callout type="warn" title="Read the caveat first">
        <p>
          All numbers from a thermally-limited laptop (i5-1135G7, Windows 10,
          Node 23.6, Rust 1.95) with same-machine load generation. They are{" "}
          <strong>relative signals for architecture decisions</strong>, not
          marketing claims. Server-grade re-runs are tracked as a follow-up.
        </p>
      </Callout>

      <H2 id="why">Why benchmark first</H2>
      <P>
        ZenZip embeds Rust in Node, so every design hinges on one question:{" "}
        <Strong>what does crossing the boundary cost?</Strong> ZenZip ran
        four benchmarks before writing a line of engine code. The result is a
        set of hard rules:
      </P>
      <CodeBlock code={rules} lang="text" className="mt-6" />

      <H2 id="boundary">JS ↔ Rust boundary</H2>
      <Table
        head={["Call", "Cost"]}
        rows={[
          [<Code key="1">sync noop()</Code>, "13.9 ns"],
          [<Code key="2">sync add(a, b)</Code>, "33.7 ns"],
          [<Code key="3">sync echo 1KB buffer</Code>, "151 ns (no copy)"],
          [<Code key="4">sync echo 64KB buffer</Code>, "165 ns (size-independent)"],
          [
            <Code key="5">async add(a, b)</Code>,
            <Strong key="5b">85.6 µs — ~2,500× the sync cost</Strong>,
          ],
        ]}
      />
      <P>
        The async row is the headline: tokio dispatch + promise resolution +
        event-loop wakeup make every async NAPI call cost what ~2,500 sync
        calls do. That single measurement dictated the entire boundary
        protocol.
      </P>

      <H2 id="tsfn">Handler dispatch — Rust → JS</H2>
      <P>
        100,000 round-trips: Rust calls a JS callback and awaits the returned
        value (the shape of every queue/workflow handler invocation):
      </P>
      <Table
        head={["Pipelining", "Throughput", "Amortized cost"]}
        rows={[
          ["1 in flight", "27,400/s", "36 µs"],
          ["×16", "291,600/s", "3.4 µs"],
          ["×64", "351,200/s", "2.8 µs"],
          [<Strong key="x">×256</Strong>, <Strong key="y">408,600/s</Strong>, "2.4 µs"],
        ]}
      />
      <P>
        Pipelining hides the wakeup cost almost entirely — and a queue/workflow
        runtime is naturally pipelined (many jobs and runs in flight). At 400k
        dispatches/s, the boundary will never be the bottleneck; storage and
        your own handler code saturate far earlier.
      </P>

      <H2 id="http">The HTTP no-go</H2>
      <P>
        The original idea included a Rust HTTP server (&ldquo;faster than
        Fastify&rdquo;). We benchmarked hello-world with the load generator in
        a separate process:
      </P>
      <Table
        head={["Server", "req/s", "p99"]}
        rows={[
          ["Express 5", "5,200–6,200", "40–57 ms"],
          ["Fastify", "19,800", "14 ms"],
          ["hyper (pure Rust)", "26,800", "10 ms"],
          ["hyper → JS handler", "23,100", "9 ms"],
        ]}
      />
      <UL>
        <LI>
          hyper with real JS handlers: only <Strong>1.09–1.17×</Strong>{" "}
          Fastify across stable runs — far below the 1.3× bar we set for
          justifying the complexity.
        </LI>
        <LI>
          Everything beats Express 4–5× — including plain Fastify. &ldquo;Faster
          than Express&rdquo; is table stakes, not a differentiator.
        </LI>
        <LI>
          <Strong>Verdict: NO-GO.</Strong> HTTP stays a Node adapter; the
          framework leads with durability, never router benchmarks. Killing
          our own feature with our own benchmark is the point of measuring
          first.
        </LI>
      </UL>

      <H2 id="compare">Feature-for-feature: vs Express &amp; Fastify</H2>
      <P>
        Early benchmarks killed the Rust HTTP server idea — ZenZip&apos;s HTTP is a thin{" "}
        <Code>node:http</Code> adapter, not a speed play. So the fair question
        isn&apos;t &ldquo;is it the fastest router&rdquo; but &ldquo;what does
        the adapter cost you against the two frameworks people actually
        migrate from?&rdquo; Identical handlers, same machine, load gen in a
        child process, best-of 3 interleaved rounds:
      </P>
      <Table
        head={["Scenario", "Express 5", "Fastify", "ZenZip", "vs Express", "vs Fastify"]}
        rows={[
          [<Code key="t">GET /</Code>, "6,344", "17,554", <Strong key="tz">15,749</Strong>, "2.48×", "0.90×"],
          [<Code key="j">GET /json</Code>, "6,144", "16,527", <Strong key="jz">15,002</Strong>, "2.44×", "0.91×"],
          [<Code key="p">GET /users/:id</Code>, "5,977", "16,600", <Strong key="pz">16,216</Strong>, "2.71×", "0.98×"],
          [
            <Code key="e">POST /echo</Code>,
            "4,724",
            "8,787",
            <Strong key="ez">8,441</Strong>,
            "1.79×",
            "0.96×",
          ],
          [<Code key="m">GET /mw + CORS</Code>, "6,266", "16,615", <Strong key="mz">13,932</Strong>, "2.22×", "0.84×"],
        ]}
      />
      <P>
        Numbers are req/s, best-of. Read-out:
      </P>
      <UL>
        <LI>
          <Strong>ZenZip is 1.8–2.7× Express on every scenario</Strong> and
          now within <Strong>0.84–0.98× of Fastify</Strong> — effectively even
          on routing and param extraction (0.98×), a hair behind on the
          middleware chain.
        </LI>
        <LI>
          <Strong>What closed the early gap:</Strong> the adapter used
          to parse the request body on <em>every</em> request, so a body-less
          GET still paid for an <Code>await</Code> over the request stream (an
          extra event-loop turn each). Skipping the read for GET/HEAD/OPTIONS
          and declared-empty bodies, plus reusing the parsed URL instead of
          re-parsing it for <Code>ctx.query</Code>, lifted GET throughput
          50–130%.
        </LI>
        <LI>
          <Strong>The router is now a radix trie</Strong> — O(path
          depth) match with no per-request route-array allocation, replacing
          the old linear scan. On this 5-route microbench it&apos;s within
          noise of the linear version; the win grows with route count, and it
          closed the routing/param scenarios to ~1.0× Fastify.
        </LI>
        <LI>
          <Strong>What we tried and reverted:</Strong> swapping each
          request/response onto a shared prototype (Fastify&apos;s trick) to
          kill per-request closure allocation. Measured: it{" "}
          <em>halved</em> GET throughput. Per-request{" "}
          <Code>Object.setPrototypeOf</Code> is a V8 deopt that costs far more
          than the closures it removes. Plain closures stay — a benchmark
          killing our own &ldquo;optimization&rdquo; is the point of measuring.
          See <A href="/docs/roadmap">the roadmap</A>.
        </LI>
        <LI>
          <Strong>Takeaway:</Strong> the HTTP layer is on par with Fastify and
          far ahead of Express — but you don&apos;t adopt ZenZip for router
          req/s, you adopt it for durable queues, workflows, and agents Express
          and Fastify don&apos;t have. The adapter being this competitive means
          migrating costs you nothing on the request path.
        </LI>
      </UL>
      <CodeBlock
        code={`# reproduce — all three frameworks, identical handlers
cd bench && node compare.mjs
DURATION=5 ROUNDS=3 CONNECTIONS=64 node compare.mjs`}
        lang="bash"
        className="mt-6"
      />

      <H2 id="sqlite">SQLite throughput</H2>
      <Table
        head={["Operation", "Throughput"]}
        rows={[
          ["Insert (1,000/transaction)", "209,600 jobs/s"],
          [
            "Claim + ack (1 job/claim, 2 commits/job — deliberate worst case)",
            "9,800 jobs/s",
          ],
        ]}
      />
      <P>
        Worst-case single-job claiming lands at ~10k/s on a laptop with zero
        optimization; the shipped engine claims in batches of 32. SQLite WAL
        comfortably covers the embedded, single-node target — Postgres exists
        for the multi-node story, not for throughput.
      </P>

      <H2 id="pg-scale">Postgres at scale</H2>
      <P>
        Two changes lift the multi-node scale ceiling, both measured against a
        live Postgres rather than asserted:
      </P>
      <UL>
        <LI>
          <Strong>Partitioned event outbox.</Strong> The <Code>events</Code>{" "}
          table is RANGE-partitioned by <Code>emitted_at</Code> into fixed
          one-day buckets. Retention GC now <Strong>drops a whole aged
          partition</Strong> — an instant <Code>DROP TABLE</Code> — instead of
          a row-by-row <Code>DELETE</Code> that scans and bloats at scale; a
          DEFAULT partition catches any un-bucketed row so correctness never
          depends on partition upkeep. Per-partition indexes also stay small.
          The current and next partitions are pre-created at startup and before
          each sweep.
        </LI>
        <LI>
          <Strong>Priority-ordered dequeue index.</Strong> A partial index{" "}
          <Code>(queue, priority DESC, id) WHERE status = 0</Code> lets the
          claim walk ready jobs in dispatch order and stop at the batch{" "}
          <Code>LIMIT</Code> — no sort. <Code>EXPLAIN ANALYZE</Code> on an
          80,000-row queue:
        </LI>
      </UL>
      <Table
        head={["Claim of 32 jobs (80k-row queue)", "Plan", "Time"]}
        rows={[
          ["Before", "Bitmap scan of 20k rows → Sort (priority, id)", "53.5 ms"],
          [
            "After",
            <span key="a">
              Index Scan on <Code>idx_jobs_ready</Code>, no sort
            </span>,
            <Strong key="b">0.83 ms</Strong>,
          ],
        ]}
      />
      <P>
        ~60× on the hot claim path once a queue&apos;s backlog is deep enough to
        matter. Both changes are Postgres-only — the embedded SQLite path is
        single-node and already fast (above); partitioning exists for the
        multi-node scale story, exactly like Postgres itself.
      </P>

      <H2 id="method">Methodology notes</H2>
      <UL>
        <LI>
          <Strong>Load gen in a child process.</Strong> The first HTTP run had
          autocannon sharing the server&apos;s event loop and overstated the
          Rust ratio by ~2×. Caught, fixed, kept as a rule.
        </LI>
        <LI>
          <Strong>Thermal throttling is real.</Strong> Sequential bench order
          penalized later targets (one server swung 12.7k→26.8k req/s between
          runs). The harness now runs interleaved rounds and reports best-of
          per target.
        </LI>
        <LI>
          <Strong>Reproducible.</Strong> Every benchmark lives in{" "}
          <Code>bench/</Code> in the repo:{" "}
          <Code>pnpm bench:boundary · bench:tsfn · bench:http · bench:sqlite · bench:compare</Code>.
        </LI>
      </UL>
    </DocPage>
  );
}
