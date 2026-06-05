import type { Metadata } from "next";
import { Check, CircleDashed, Loader } from "lucide-react";

import { DocPage } from "@/components/docs/doc-page";
import {
  Callout,
  Code,
  H2,
  LI,
  Strong,
  UL,
} from "@/components/docs/typography";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = { title: "Roadmap" };

const toc = [
  { id: "principles", title: "How we ship" },
  { id: "phase-0", title: "Phase 0 — Spike" },
  { id: "phase-1", title: "Phase 1 — Queues & scheduler" },
  { id: "phase-2", title: "Phase 2 — Workflows" },
  { id: "phase-3", title: "Phase 3 — Events & dashboard" },
  { id: "phase-4", title: "Phase 4 — Agents" },
  { id: "phase-5", title: "Phase 5 — Multi-node" },
  { id: "backlog", title: "Post-1.0 backlog" },
];

type Status = "done" | "partial" | "todo";

function Item({ status, children }: { status: Status; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 py-1.5">
      {status === "done" ? (
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-400">
          <Check className="size-3" />
        </span>
      ) : status === "partial" ? (
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-amber-500/15 text-amber-400">
          <Loader className="size-3" />
        </span>
      ) : (
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-edge text-zinc-600">
          <CircleDashed className="size-3" />
        </span>
      )}
      <span className="text-[15px] leading-6 text-ink-mid">{children}</span>
    </li>
  );
}

function PhaseHeader({
  id,
  title,
  badge,
  variant,
}: {
  id: string;
  title: string;
  badge: string;
  variant: "green" | "accent" | "outline";
}) {
  return (
    <div className="mt-12 flex items-center gap-3 border-b border-edge-soft pb-2 first:mt-0">
      <h2 id={id} className="scroll-mt-24 text-xl font-semibold tracking-tight text-ink">
        {title}
      </h2>
      <Badge variant={variant}>{badge}</Badge>
    </div>
  );
}

export default function Page() {
  return (
    <DocPage
      title="Roadmap"
      description="Strictly serial, test-gated phases. The full task list with statuses — including what's deliberately deferred."
      href="/docs/roadmap"
      toc={toc}
    >
      <H2 id="principles">How we ship</H2>
      <UL>
        <LI>
          <Strong>Serial gates:</Strong> a phase doesn&apos;t start until the
          previous one&apos;s exit criteria pass — chaos suites included.
        </LI>
        <LI>
          <Strong>Measure before building:</Strong> architecture claims need
          benchmark numbers (Phase 0 killed the Rust HTTP server idea this
          way).
        </LI>
        <LI>
          <Strong>One engine:</Strong> schedules, workflows, and agents are
          projections of the queue engine — recovery is implemented once.
        </LI>
        <LI>
          <Strong>No silent caps:</Strong> wherever the runtime bounds work
          (catchup replay, retry budgets), the bound is logged.
        </LI>
      </UL>
      <Callout type="info">
        <p>
          The canonical task list with every sub-item lives in the repo at{" "}
          <Code>docs/content/tasks.md</Code>. This page is the summary.
        </p>
      </Callout>

      <PhaseHeader id="phase-0" title="Phase 0 — Validation spike" badge="complete" variant="green" />
      <ul className="mt-4">
        <Item status="done">Monorepo: cargo workspace + pnpm workspace + napi-rs v3 pipeline</Item>
        <Item status="done">Boundary benchmarks: sync 14–34ns, async ~85µs → hot-path rules</Item>
        <Item status="done">TSFN dispatch: 409k/s pipelined → handler protocol validated</Item>
        <Item status="done">HTTP bench: hyper→JS only 1.17× Fastify → Rust HTTP NO-GO</Item>
        <Item status="partial">SQLite: 209k/s insert, 9.8k/s worst-case claim — 4-process contention bench pending</Item>
        <Item status="partial">CI matrix written (win/mac/linux) — validation needs the GitHub push</Item>
      </ul>

      <PhaseHeader id="phase-1" title="Phase 1 — Queues & scheduler" badge="complete" variant="green" />
      <ul className="mt-4">
        <Item status="done">Store trait + SQLite WAL impl: atomic batch claims, leases, migrations</Item>
        <Item status="done">Queue engine: concurrency, priorities, delays, exponential backoff + jitter, DLQ + requeue</Item>
        <Item status="done">Rate limiting (token bucket) + batch consumers (processBatch)</Item>
        <Item status="done">Persisted scheduler: cron + intervals, IANA timezones, overlap (skip/queue/allow), catchup (skip/runOnce/all), jitter</Item>
        <Item status="done">Graceful shutdown with drain; SIGINT/SIGTERM handlers; explicit store close</Item>
        <Item status="done">Structured logging: Rust tracing → JS sink (weak TSFN) or stderr</Item>
        <Item status="done">SIGKILL crash harness: mid-job kill → redelivery with attempt counted</Item>
        <Item status="done">31 tests green (14 Rust + 17 JS) at phase exit</Item>
      </ul>

      <PhaseHeader id="phase-2" title="Phase 2 — Durable workflow engine" badge="complete" variant="green" />
      <ul className="mt-4">
        <Item status="done">Run + step journal schema; step-memoized execution with batch journal prefetch</Item>
        <Item status="done">step.run / step.sleep / step.waitForEvent / step.invoke / step.all</Item>
        <Item status="done">Step retries with backoff; exhaustion fails the run with a precise error</Item>
        <Item status="done">Idempotency keys (race-safe), cancellation with descendant propagation</Item>
        <Item status="done">Versioning: content-hash pinning, mismatch warnings, step-kind-change detection</Item>
        <Item status="done">trigger / triggerAndWait / getRun / cancel; typed input/output</Item>
        <Item status="done">Restart-resume test + 4× SIGKILL chaos harness; step API frozen (workflow-semantics.md)</Item>
        <Item status="partial">Full 1k-run kill-at-every-boundary chaos suite</Item>
        <Item status="partial">eslint-plugin-zenzip (side effects outside step.run); onCancel hooks; per-step retry override</Item>
      </ul>

      <PhaseHeader id="phase-3" title="Phase 3 — Events, state machines, dashboard" badge="complete" variant="green" />
      <ul className="mt-4">
        <Item status="done">Event bus: wildcard topics (* / **), app.on() subscribers with unsubscribe, atomic outbox (event + waiters + triggered runs in one transaction)</Item>
        <Item status="done">Durable workflow triggers (on: &quot;user.*&quot;) + waitForEvent match predicates</Item>
        <Item status="done">State machines: transition + history + event + triggered runs commit atomically; instance queries + history</Item>
        <Item status="done">HTTP adapter: routes + listen() + app.toNodeHandler() for mounting into any node server; webhook→workflow sugar</Item>
        <Item status="done">Engine metrics: hot-path counters (jobs/runs/steps/events/handler timings) → app.metrics(), /api/metrics, dashboard</Item>
        <Item status="done">Dashboard: SSE live updates with polling fallback, step-graph run detail, DLQ requeue, optional token auth</Item>
        <Item status="done">Launch demo app (examples/demo-dashboard): continuous machine→trigger→workflow→approval traffic, kill-and-recover ready</Item>
        <Item status="partial">OTLP wire exporter (spans + counters exist; heavy dep tree deferred) · React SPA refactor · Fastify/Hono-specific plugins</Item>
      </ul>

      <PhaseHeader id="phase-4" title="Phase 4 — Agent engine" badge="complete" variant="green" />
      <ul className="mt-4">
        <Item status="done">Agents compile to workflows with dynamic steps — every LLM call and tool execution journaled</Item>
        <Item status="done">Tool failures retry WITHOUT re-calling the LLM (asserted: tool fails 2×, model called exactly 2×); iteration + token budget guards</Item>
        <Item status="done">Anthropic (tool use, SSE streaming, prompt caching) + OpenAI-compatible adapters; JSON-Schema tools with Standard Schema validation</Item>
        <Item status="done">Human-in-the-loop: requiresApproval → durable waitForEvent gate matched on (runId, toolUseId); approve/deny API with timeout-as-denied</Item>
        <Item status="done">Session memory (persisted, windowed), live token streaming, handoffTool() child agents, per-step token accounting, mock provider test harness</Item>
        <Item status="partial">Dashboard approve button + dedicated session browser; $ cost pricing tables</Item>
      </ul>

      <PhaseHeader id="phase-5" title="Phase 5 — Postgres & multi-node" badge="complete" variant="green" />
      <ul className="mt-4">
        <Item status="done">Postgres Store (sqlx, dedicated schema): FOR UPDATE SKIP LOCKED claims; CAS scheduler election — N nodes fire each tick exactly once (tested)</Item>
        <Item status="done">Dead-worker recovery via leases: 3-node chaos with a hard kill — 150/150 jobs survive, duplicates bounded by the dead node&apos;s in-flight</Item>
        <Item status="done">Cross-node wakeups: pg_notify in the insert transaction + per-node LISTEN — node A&apos;s push wakes node B instantly (proved with a 5s poll)</Item>
        <Item status="done">Workflow node-kill test: runs complete on survivors, step journal effectively-once; same TS API — store: {"{ driver: 'postgres', url }"}</Item>
        <Item status="done">Bonus engine fix the tests forced: dispatcher saturation stall (one wake now drains any burst)</Item>
        <Item status="partial">Server-grade load benchmarks; SQLite→Postgres data migration tool; multi-node rolling-deploy chaos exercise</Item>
      </ul>

      <H2 id="backlog">Post-1.0 backlog (deliberately parked)</H2>
      <UL>
        <LI>Visual workflow authoring (read-only graph view ships with the dashboard first)</LI>
        <LI>Rust HTTP server — only if server-grade benchmarks change the Phase 0 verdict</LI>
        <LI>Python SDK on the same core; Redis/NATS event backends; vector memory for agents</LI>
        <LI>Hosted cloud (the eventual business model — OSS-first until then)</LI>
      </UL>
    </DocPage>
  );
}
