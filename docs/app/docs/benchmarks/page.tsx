import type { Metadata } from "next";

import { CodeBlock } from "@/components/code-block";
import { DocPage } from "@/components/docs/doc-page";
import {
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
  { id: "sqlite", title: "SQLite throughput" },
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
      description="Phase 0 measured the NAPI boundary, handler dispatch, HTTP, and SQLite before any engine code was written. These numbers shaped — and killed — design decisions."
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
        <Strong>what does crossing the boundary cost?</Strong> Phase 0
        answered it with four benchmarks before Phase 1 wrote a line of engine
        code. The result is a set of hard rules:
      </P>
      <CodeBlock code={rules} lang="text" className="mt-6" />

      <H2 id="boundary">JS ↔ Rust boundary (P0.4)</H2>
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

      <H2 id="tsfn">Handler dispatch — Rust → JS (P0.5)</H2>
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

      <H2 id="http">The HTTP no-go (P0.6)</H2>
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

      <H2 id="sqlite">SQLite throughput (P0.7)</H2>
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
          <Code>pnpm bench:boundary · bench:tsfn · bench:http · bench:sqlite</Code>.
        </LI>
      </UL>
    </DocPage>
  );
}
