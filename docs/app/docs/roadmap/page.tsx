import type { Metadata } from "next";
import { Check, CircleDashed, Loader } from "lucide-react";

import { DocPage } from "@/components/docs/doc-page";
import {
  H2,
  LI,
  P,
  Strong,
  UL,
} from "@/components/docs/typography";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = { title: "Roadmap" };

const toc = [
  { id: "today", title: "Available today" },
  { id: "queues", title: "Durable queues & scheduler" },
  { id: "workflows", title: "Durable workflow engine" },
  { id: "events", title: "Events & state machines" },
  { id: "http", title: "HTTP & Express DX" },
  { id: "dashboard", title: "Live dashboard" },
  { id: "agents", title: "AI agents & networks" },
  { id: "multinode", title: "Postgres & multi-node" },
  { id: "hardening", title: "Production hardening" },
  { id: "in-progress", title: "In progress" },
  { id: "coming-soon", title: "Coming soon" },
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

function SectionHeader({
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
      description="What's available in ZenZip today, what's actively in progress, and what's coming next."
      href="/docs/roadmap"
      toc={toc}
    >
      <H2 id="today">Available today</H2>
      <P>
        The core engine and all primitives are feature-complete and covered by
        230+ tests, including SIGKILL crash-injection and multi-node Postgres
        chaos suites. What remains is launch packaging and a few in-progress
        features listed below.
      </P>

      <SectionHeader id="queues" title="Durable queues & scheduler" badge="shipped" variant="green" />
      <ul className="mt-4">
        <Item status="done">At-least-once delivery with leases, exponential backoff + jitter, and a dead-letter queue</Item>
        <Item status="done">Per-key concurrency limits, round-robin fairness, debounce, throttle, and token-bucket rate limits</Item>
        <Item status="done">Batch consumers, priorities, delayed jobs, backpressure admission control</Item>
        <Item status="done">Persisted cron + intervals: IANA timezones, overlap policies (skip / queue / allow), missed-tick catchup</Item>
        <Item status="done">Graceful drain on shutdown; SIGINT/SIGTERM handlers built in</Item>
        <Item status="done">Pause / resume, bulk purge, dead-letter requeue — full queue control plane</Item>
      </ul>

      <SectionHeader id="workflows" title="Durable workflow engine" badge="shipped" variant="green" />
      <ul className="mt-4">
        <Item status="done">Step memoization model — no Temporal-style determinism rules, no replay constraints</Item>
        <Item status="done">All step primitives: <code>step.run</code>, <code>step.sleep</code>, <code>step.waitForEvent</code>, <code>step.invoke</code>, <code>step.all</code></Item>
        <Item status="done">Per-step timeouts, independent retry budgets, exhaustion with a precise error</Item>
        <Item status="done">Idempotency keys (race-safe), run cancellation with descendant propagation</Item>
        <Item status="done">Content-hash version pinning — in-flight runs finish on old logic while new runs use new code</Item>
        <Item status="done">Realtime run subscription: async-iterable stream of status + step events, pipe to SSE or WebSocket</Item>
        <Item status="done">Large-payload offloading: step results over a threshold go to a blob store; replay rehydrates transparently</Item>
      </ul>

      <SectionHeader id="events" title="Events & state machines" badge="shipped" variant="green" />
      <ul className="mt-4">
        <Item status="done">Atomic event outbox: one transaction persists the event, wakes matching waiters, and creates triggered runs</Item>
        <Item status="done">Wildcard topic patterns (<code>user.*</code>, <code>billing.**</code>), ephemeral subscribers with unsubscribe</Item>
        <Item status="done">Durable workflow triggers (<code>on: "event.name"</code>) with match predicates</Item>
        <Item status="done">Persisted state machines: transitions, history, and triggered runs commit atomically</Item>
      </ul>

      <SectionHeader id="http" title="HTTP & Express DX" badge="shipped" variant="green" />
      <ul className="mt-4">
        <Item status="done">Express-compatible: <code>app.use()</code> middleware (global / path-scoped / 4-arg error), <code>Router()</code> mounting</Item>
        <Item status="done">Dual handler signature: Express <code>(req, res, next)</code> or rich <code>ctx</code> — chosen by arity</Item>
        <Item status="done">Built-in middleware: <code>json()</code>, <code>cors()</code>, <code>logger()</code>, <code>static()</code>, <code>auth()</code>, <code>validate()</code>, <code>secureHeaders()</code>, <code>rateLimit()</code></Item>
        <Item status="done">Adapters: <code>toNodeHandler()</code> for Express / Connect / Fastify, <code>toFetchHandler()</code> for Next.js / Hono / Bun / Deno / edge</Item>
        <Item status="done">Radix-tree router with webhook → workflow sugar</Item>
        <Item status="partial">Dedicated Fastify plugin, Hono middleware, and Nest.js module wrappers (in progress)</Item>
      </ul>

      <SectionHeader id="dashboard" title="Live dashboard" badge="shipped" variant="green" />
      <ul className="mt-4">
        <Item status="done">SSE live updates with polling fallback — run timelines, step graphs, queue health</Item>
        <Item status="done">Dead-letter queue inspection and one-click requeue</Item>
        <Item status="done">Schedule browser, event feed, engine metrics</Item>
        <Item status="done">Operator vs read-only RBAC tokens; optional Bearer auth</Item>
        <Item status="partial">Full React SPA refactor with dedicated agent session browser (in progress)</Item>
      </ul>

      <SectionHeader id="agents" title="AI agents & networks" badge="shipped" variant="green" />
      <ul className="mt-4">
        <Item status="done">Agents compile to durable workflows — every LLM call and tool execution is a journaled step</Item>
        <Item status="done">Tool failures retry without re-calling the LLM; session memory persisted across runs</Item>
        <Item status="done">Human-in-the-loop: <code>requiresApproval</code> → durable <code>waitForEvent</code> pause with approve / deny API</Item>
        <Item status="done">Providers: Anthropic, OpenAI-compatible, Google Gemini, AWS Bedrock (SigV4), and a scripted mock</Item>
        <Item status="done">Multi-agent handoff (<code>handoffTool</code>) and networks (<code>app.network()</code>) with durable routing</Item>
        <Item status="done">Tiered memory: semantic recall (embeddings + vector store) and working-memory compression</Item>
        <Item status="done">Built-in evals: rule-based, statistical, and model-graded (<code>llmJudge</code>) — gate deploys on prompt quality</Item>
        <Item status="done">MCP consume: connect to any MCP server as durable agent tools</Item>
        <Item status="done">MCP author: expose your workflows and agents as an MCP server for other agents to call</Item>
        <Item status="done">Per-model cost accounting; circuit breakers + bulkheads on model calls</Item>
      </ul>

      <SectionHeader id="multinode" title="Postgres & multi-node" badge="shipped" variant="green" />
      <ul className="mt-4">
        <Item status="done">Same API as embedded — one config line switches from SQLite to Postgres</Item>
        <Item status="done"><code>FOR UPDATE SKIP LOCKED</code> claims; <code>LISTEN/NOTIFY</code> cross-node wakeups; advisory-lock scheduler election</Item>
        <Item status="done">Lease-based dead-worker recovery — validated with a 3-node kill-a-node chaos test</Item>
        <Item status="done">Priority-ordered dequeue index and event outbox range partitioning for large-scale deployments</Item>
        <Item status="done">Clock-skew-safe leases: expiry uses the database server clock, not per-node wall clocks</Item>
      </ul>

      <SectionHeader id="hardening" title="Production hardening" badge="shipped" variant="green" />
      <ul className="mt-4">
        <Item status="done">Payload encryption at rest: opt-in AES-256-GCM on all payload columns — transparent to enable</Item>
        <Item status="done">Retention GC: bounded store growth; Postgres event outbox GC drops whole partitions</Item>
        <Item status="done">Health probes: <code>/healthz</code> (liveness, zero I/O) and <code>/readyz</code> (store-checked readiness)</Item>
        <Item status="done">Fencing tokens against zombie workers; SSRF allowlists on user-controlled fetches</Item>
        <Item status="done">Graceful HTTP drain, backpressure admission control, idempotency helpers</Item>
        <Item status="done">Secrets resolution (<code>env:</code> / <code>file:</code>), deep secret redaction, boot-time config validation</Item>
        <Item status="done">Audit log hook for privileged actions; DLQ growth + stuck-run alerting</Item>
        <Item status="done">Multi-tenancy namespacing; GDPR subject-tagged runs and <code>purgeSubject()</code> erasure</Item>
        <Item status="done">Pino / Winston transports and Sentry error reporter</Item>
        <Item status="partial">OTLP span and metric export (in progress)</Item>
        <Item status="partial">SLSA-signed npm releases with build provenance (needs a tagged release to validate)</Item>
        <Item status="partial">Musl / Alpine prebuilds for Docker via zig cross-compile (needs a release run to validate)</Item>
      </ul>

      <H2 id="in-progress">In progress</H2>
      <UL>
        <LI>
          <Strong>OTLP telemetry export</Strong> — span and metric wire export; schedule-to-start latency, trace-context propagation, GenAI semantic conventions
        </LI>
        <LI>
          <Strong>Dashboard React SPA refactor</Strong> — dedicated agent session browser, dollar cost display, richer run graph
        </LI>
        <LI>
          <Strong>Framework-specific plugins</Strong> — dedicated Fastify plugin, Hono middleware, and Nest.js module wrappers
        </LI>
        <LI>
          <Strong>Signed releases</Strong> — SLSA build provenance via OIDC, CycloneDX SBOM, Sigstore signing
        </LI>
        <LI>
          <Strong>Alpine / musl prebuilds</Strong> — zig cross-compile for Docker Alpine images without a build step
        </LI>
      </UL>

      <H2 id="coming-soon">Coming soon</H2>
      <UL>
        <LI>
          <Strong>npm prebuilds for all platforms</Strong> — today ZenZip requires building from source (Rust + Node). Prebuilt binaries for macOS, Linux x64/arm64, Windows, and musl ship with the public alpha.
        </LI>
        <LI>
          <Strong>Modular package split</Strong> — import only the primitives you need; tree-shakeable bundles.
        </LI>
        <LI>
          <Strong>Realtime / WebSocket layer</Strong> — first-class WebSocket support built on the existing run subscription API.
        </LI>
        <LI>
          <Strong>SQLite → Postgres migration tool</Strong> — lift an existing embedded deployment onto the multi-node backend without draining first.
        </LI>
        <LI>
          <Strong>Postgres time/status partitioning</Strong> — further scale improvements for high-volume deployments.
        </LI>
        <LI>
          <Strong>eslint-plugin-zenzip</Strong> — static analysis for side effects outside <code>step.run</code>, per-step retry overrides.
        </LI>
      </UL>

      <H2 id="backlog">Post-1.0 backlog</H2>
      <UL>
        <LI>Visual workflow authoring — the step-graph dashboard view ships first; a drag-and-drop editor comes later</LI>
        <LI>Python SDK on the same Rust core</LI>
        <LI>Redis / NATS event backends; managed vector memory for agents</LI>
        <LI>Hosted cloud — the eventual business model; OSS-first until then</LI>
      </UL>
    </DocPage>
  );
}
