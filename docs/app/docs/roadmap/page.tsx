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
  { id: "phase-7", title: "Phase 7 — Hardening" },
  { id: "phase-8", title: "Phase 8 — Express DX" },
  { id: "phase-9", title: "Phase 9 — AI depth" },
  { id: "phase-10", title: "Phase 10 — Flow control" },
  { id: "phase-13", title: "Phase 13+ — Production ops" },
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

      <PhaseHeader id="phase-7" title="Phase 7 — Production hardening" badge="in progress" variant="accent" />
      <ul className="mt-4">
        <Item status="done">Retention / GC (P7.6): background sweep deletes aged terminal runs (+ step journal) and old events; index-backed (runs status, updated_at); configurable per-category windows or &quot;off&quot;; app.gc() manual trigger; runsGc/stepsGc/eventsGc metrics — SQLite + Postgres</Item>
        <Item status="todo">Observability (7A): OTLP span/metric export, schedule_to_start latency, trace-context propagation, GenAI semconv</Item>
        <Item status="done">Liveness/readiness split (P7.7): /healthz (zero-I/O) + /readyz (store ping) + app.health(); user routes override</Item>
        <Item status="done">Orphaned-run observability (P7.10): app.orphanedRuns() + zenzip doctor surface non-terminal runs idle past a window</Item>
        <Item status="done">Backpressure / admission control (P7.8): queue maxPending → push/pushBulk throw QueueFullError when saturated</Item>
        <Item status="todo">Ops (7B): Postgres time/status partitioning</Item>
        <Item status="done">Effect-level idempotency helper (P7.13): ctx.idempotencyKey(label) — deterministic across retries/replays for deduping enqueues + external side effects</Item>
        <Item status="done">Fencing tokens (P7.11): monotonic per-job token bumped on claim; ack/fail/renew fence-guarded → a zombie worker&apos;s late write is rejected (SQLite + Postgres)</Item>
        <Item status="done">Deterministic fault-injection harness (P7.14): FaultStore wraps any store to inject fail-next-N / slow-store faults — repeatable chaos in cargo test, no spawned processes</Item>
        <Item status="todo">Reliability (7C): clock-skew bounds for multi-node ordering</Item>
        <Item status="done">Dashboard RBAC (P7.17): operator vs read-only viewer tokens — viewers get 403 on mutating endpoints; timing-safe</Item>
        <Item status="done">SSRF allowlist (P7.16): assertPublicUrl resolve-then-validate (blocks private/loopback/link-local/metadata + v4-mapped); wired into mcp(), exported for tool authors</Item>
        <Item status="done">Payload encryption at rest (P7.15): opt-in encryptionKey → AES-256-GCM on job payloads, run input/output, step results, event payloads; transparent enable (enc:1: sentinel keeps legacy plaintext readable); validated SQLite + Postgres + JS</Item>
        <Item status="partial">Security (7D): release CI writes npm build provenance (SLSA-aligned, OIDC) + CycloneDX SBOM — needs a tagged release to validate; Sigstore signing remains</Item>
        <Item status="partial">Packaging (7E): prebuild matrix now includes musl (zig cross-compile) for Alpine/Docker — needs a release run; WASM/WASI fallback + bundler/serverless recipes remain</Item>
      </ul>

      <PhaseHeader id="phase-8" title="Phase 8 — Express-native DX layer" badge="in progress" variant="accent" />
      <ul className="mt-4">
        <Item status="done">app.use() middleware — global + path-scoped, multiple handlers per call, registration-order chain</Item>
        <Item status="done">4-arg error middleware (arity ≥ 4); throws/rejections from middleware OR route handlers route to it, else 500</Item>
        <Item status="done">Dual handler signature: Express (req, res, next) alongside the original (ctx); chosen by arity</Item>
        <Item status="done">req/res augmentation: req.params/query/body/path/app/get(); res.status/json/send/sendStatus/set/redirect/locals</Item>
        <Item status="done">zenzip.Router() with mounting + nested routers + router-scoped middleware</Item>
        <Item status="done">Built-in middleware: json(), urlencoded(), cors() (+ OPTIONS preflight), logger(), static() (traversal-safe)</Item>
        <Item status="done">Adapters: toNodeHandler() (Express/Connect/Fastify) + toFetchHandler() (Next.js/Hono/Bun/Deno/edge — Request→Response)</Item>
        <Item status="done">Migration guides: Coming-from-Express + BullMQ / Inngest / Temporal side-by-side</Item>
        <Item status="partial">Framework-specific sugar: dedicated Fastify plugin / Hono middleware / Nest module wrappers</Item>
      </ul>

      <PhaseHeader id="phase-9" title="Phase 9 — AI-native depth" badge="in progress" variant="accent" />
      <ul className="mt-4">
        <Item status="done">Realtime run subscription (P9.4): app.subscribe(runId) — async-iterable stream of run status + step events, store-backed (cross-process), pipe to SSE/WebSocket</Item>
        <Item status="done">Large LLM payload offloading (P9.1): over-threshold step results written to a blob store (pluggable; fs default), journal keeps a reference, replay rehydrates transparently</Item>
        <Item status="done">MCP consume (P9.2a): mcp(url) connects over Streamable HTTP, lists tools, exposes them as durable agent tools (prefix, headers, session)</Item>
        <Item status="done">MCP author (P9.2b): app.mcpServer() / app.mcpHandler() expose workflows + agents as an MCP server (allowlists, token auth, sync-wait or fire-and-forget)</Item>
        <Item status="done">Provider cost tables (P9.7): per-model pricing registry → result.costUsd dollar accounting; registerPricing override; openaiCompatible covers OpenAI-compatible providers</Item>
        <Item status="done">Tiered agent memory (P9.3): semantic recall (embeddings + vector store) + working-memory compression; AgentMemory + openaiEmbeddings/mockEmbeddings + pluggable MemoryStore</Item>
        <Item status="done">Multi-agent networks (P9.6): app.network() — a durable coordinator routes among N specialist agents via handoff child-workflows</Item>
        <Item status="done">Built-in evals (P9.5): rule-based (contains/matches/equals/jsonValid) + statistical (similarity) + model-graded (llmJudge) evaluators; evaluate() + runEvals() suite runner to gate deploys / regression-test prompts</Item>
        <Item status="done">Provider breadth (P9.7): googleGemini() (generateContent) + bedrock() (Anthropic-on-Bedrock, SigV4-signed, no AWS SDK)</Item>
      </ul>

      <PhaseHeader id="phase-10" title="Phase 10 — Flow control & scale" badge="in progress" variant="accent" />
      <ul className="mt-4">
        <Item status="done">Per-key / per-tenant concurrency (P10.1): concurrency: &#123; limit, key &#125; — cap in-flight per key, enforced in the store at claim time (SQLite + Postgres), cross-node-correct</Item>
        <Item status="done">Step timeouts (P15.1 start): step.run(id, fn, &#123; timeout &#125;) fails an overrunning step instead of wedging a worker slot</Item>
        <Item status="done">Safe versioning ergonomics (P10.6): wf.version(oldFn) routes in-flight runs pinned to an old content hash to the old logic; new runs use the current fn</Item>
        <Item status="done">Debounce (P10.2): queue debounce: &#123; key, window &#125; collapses a burst to the last push, store-enforced (delete-then-insert)</Item>
        <Item status="done">Fairness (P10.3): queue fair:true round-robins claims across concurrency-key groups (priority already supported) so no tenant starves others</Item>
        <Item status="done">Postgres resilience (P15.4): pool acquire-timeout + connection recycling + statement_timeout bound (fail-fast / post-failover recovery)</Item>
        <Item status="done">Clock-skew safety (P7.12): Postgres lease set/renew/expiry use DB server time, not node wall clocks (skew test: a +1h-skewed sweeper won&apos;t expire a valid lease)</Item>
        <Item status="done">Throttle (P10.2): queue throttle: &#123; key, max, per &#125; spaces starts to a steady per-key rate via a store cursor (every job runs, paced)</Item>
        <Item status="done">Benchmark suite (P10.5): bench/compare.mjs runs ZenZip vs Express vs Fastify on identical handlers</Item>
        <Item status="done">HTTP adapter fast path (P10.7): skip body read for GET/HEAD/OPTIONS &amp; declared-empty bodies + reuse the parsed URL for ctx.query &mdash; lifted GET throughput 50&ndash;130%, now 1.8&ndash;2.7x Express and 0.84&ndash;0.98x Fastify (was ~0.5x)</Item>
        <Item status="done">HTTP adapter router (P10.8): radix-tree route match (O(path-depth), no per-request array alloc) replaces the linear scan; first-match-wins preserved so user routes still override built-ins. Prototype-swap req/res was tried and reverted &mdash; per-request Object.setPrototypeOf is a V8 deopt that halved GET throughput</Item>
        <Item status="done">Postgres scale (P10.4): event outbox RANGE-partitioned by emitted_at (daily buckets) so retention GC DROPs whole aged partitions instead of row-DELETE; priority-ordered partial dequeue index removes the claim Sort (EXPLAIN: 53.5ms&rarr;0.83ms on an 80k-row queue). Validated on live Postgres</Item>
      </ul>

      <PhaseHeader id="phase-13" title="Phase 13+ — Production ops (gap-analysis, demand-pulled)" badge="in progress" variant="accent" />
      <ul className="mt-4">
        <Item status="done">App auth (P13.1): zenzip.auth() — Bearer/x-api-key vs static tokens or a verify() callback (JWT/OIDC seam), attaches req.user, route-guard via path mount</Item>
        <Item status="done">Request validation (P13.2): zenzip.validate(&#123; body, query &#125;) — Standard Schema, auto-400 with issues, parses into the handler</Item>
        <Item status="done">Graceful HTTP drain (P15.3): stop() drains in-flight requests, frees idle keep-alive, force-closes stragglers at httpDrain deadline</Item>
        <Item status="done">Security headers (P13.3): zenzip.secureHeaders() helmet-equivalent defaults + opt-in CSP</Item>
        <Item status="done">HTTP rate limiting (P13.4): zenzip.rateLimit() fixed-window per key → 429 + X-RateLimit headers</Item>
        <Item status="done">Config hardening (P13.5): boot-time validateConfig() fail-fast + redactUrl() secret masking</Item>
        <Item status="done">Audit log (P13.6): onAudit sink records workflow trigger/cancel, requeue-dead, agent approve/deny — &#123; action, target, at, detail &#125;</Item>
        <Item status="done">Control plane (P14.1): queue.purgeDead() + pause()/resume()/isPaused() + app.cancelRuns(&#123; workflow, status, olderThan &#125;) bulk cancel-by-filter</Item>
        <Item status="done">CSRF (P13.3): zenzip.csrf() origin/referer guard on state-changing methods (SameSite-compatible)</Item>
        <Item status="done">Alerting (P14.2): app alerts hook fires on DLQ growth + stuck runs; typed error envelope + error&rarr;HTTP mapping + HttpError (P16.5)</Item>
        <Item status="done">Poison messages (P15.5): crash-looping jobs are quarantined to the DLQ by the lease + attempt-counter path (and surfaced via the DLQ alert)</Item>
        <Item status="done">Circuit breakers + bulkheads (P15.2): circuitBreaker() primitive (open/half-open/closed + concurrency cap) wired into agent LLM calls; exported for wrapping any external call</Item>
        <Item status="partial">Deploy (P16.1/16.2): reference Dockerfile (musl/Alpine, non-root, healthcheck) + k8s StatefulSet + Helm chart with /healthz·/readyz probes shipped in deploy/ — needs a real cluster to validate</Item>
        <Item status="done">Secrets hardening (P13.5): resolveSecret(env:/file:) + redactSecrets() deep masking</Item>
        <Item status="done">Multi-tenancy (P14.5): app.namespace() scopes queues/workflows/agents/events with a tenant prefix</Item>
        <Item status="done">PII purge (P14.6): subject-tagged runs (wf.trigger with a subject) erased via app.purgeSubject() — runs + steps, SQLite + Postgres</Item>
        <Item status="done">Log/error integrations (P16.4): pinoLogger/winstonLogger transports + sentryReporter + captureErrors middleware + onError hook</Item>
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
