# ZenZip — Implementation Tasks

> Phases are serial gates: do not start a phase until the previous phase's exit criteria pass.
> Conventions: `[ ]` todo · `[~]` in progress · `[x]` done. Keep this file updated as the single source of truth.

---

## Phase 0 — Validation Spike (1–2 weeks)

Goal: hard numbers on the NAPI boundary before committing to architecture claims.

- [x] **P0.1** Scaffold monorepo: cargo workspace (`crates/zenzip-core`, napi crate co-located in `packages/core-native`) + pnpm workspace (`packages/zenzip`, `packages/core-native`, `bench`)
- [x] **P0.2** Set up napi-rs v3 build pipeline; produce a working `.node` binary loadable from TS on Windows (dev box), then mac/linux via CI — *built green on Windows; generated index.js/index.d.ts*
- [~] **P0.3** CI: GitHub Actions matrix from napi-rs template (win x64, mac x64/arm64, linux gnu/musl x64/arm64) — green builds from week 1 — *workflow written (.github/workflows/ci.yml); needs repo push to validate*
- [x] **P0.4** Benchmark 1: JS→Rust call round-trip cost (sync fn, async fn, with 1KB / 64KB JSON payload) — *sync 14–34ns, async ~85µs (!), see spike-results.md*
- [x] **P0.5** Benchmark 2: Rust→JS `ThreadsafeFunction` dispatch throughput (single + batched), simulating "Rust engine invokes JS step handler" — *27k/s sequential, 409k/s at 256 in-flight*
- [x] **P0.6** Benchmark 3: minimal hyper server invoking JS handler per request vs raw Fastify hello-world — settles D5 (Rust HTTP go/no-go) — *NO-GO: hyper→JS only 1.17× fastify*
- [~] **P0.7** Benchmark 4: rusqlite WAL insert/claim/ack loop throughput single-process (target: ≥10k jobs/sec) and 4-process contention behavior — *single-process done: 209k/s insert, 9.8k/s worst-case claim+ack; 4-process bench pending*
- [x] **P0.8** Write `docs/spike-results.md`; update plan.md D3/D5 with measured numbers; GO/NO-GO decisions recorded

**Exit criteria:** numbers documented; boundary call patterns chosen; HTTP strategy decided.

---

## Phase 1 — Core Runtime: Storage, Queue, Scheduler (4–6 weeks)

Goal: zero-infra durable queue + cron that survives `kill -9`.

### Storage layer
- [ ] **P1.1** Define `Store` trait in Rust: runs, steps, queue jobs, events, schedules, leases (CRUD + atomic claim ops)
- [ ] **P1.2** SQLite schema v1 + migrations (embedded migration runner); WAL mode, busy_timeout, single-writer discipline
- [ ] **P1.3** SQLite `Store` impl with atomic job claim (lease + visibility timeout), ack, nack, heartbeat/lease-renewal
- [ ] **P1.4** Retry policy engine: max attempts, exponential backoff + jitter, per-job overrides, dead-letter transition
- [ ] **P1.5** Crash-safety tests: kill process mid-claim / mid-execute / pre-ack; job must be re-delivered exactly per at-least-once semantics

### Queue engine
- [ ] **P1.6** Rust queue engine on tokio: poll/notify loop, concurrency limits per queue, priority ordering, delayed jobs
- [ ] **P1.7** NAPI bridge: register consumer (ThreadsafeFunction), push job, ack/nack from JS; payloads as JSON buffers
- [ ] **P1.8** TS API: `app.queue(name, opts)` → `.push()`, `.pushBulk()`, `.process(fn)`; zod input schema option; typed job payloads
- [ ] **P1.9** Rate limiting (token bucket per queue) + batch consumption (`process(fn, { batch: 50 })`)
- [ ] **P1.10** DLQ: storage, inspection API, requeue API
- [ ] **P1.11** Graceful shutdown: drain in-flight jobs, stop claiming, configurable timeout, SIGINT/SIGTERM hooks

### Scheduler
- [ ] **P1.12** Rust timer wheel + cron parser (croner/cron crate), timezone support
- [ ] **P1.13** Persisted schedules: survive restart, catch-up policy (skip | runOnce | all), overlap policy (skip | queue | allow), jitter option
- [ ] **P1.14** TS API: `app.schedule(name, cronOrEvery, fn)`; schedule fires = enqueue internal job (reuse queue engine)

### App shell
- [ ] **P1.15** `app = zenzip()` lifecycle: definition registration phase → `app.start()` boots Rust runtime → `app.stop()` graceful
- [ ] **P1.16** Config: data dir, store selection (sqlite path | postgres URL placeholder), log level; sane zero-config defaults
- [ ] **P1.17** Structured logging from Rust (tracing crate) surfaced to JS-configurable sink
- [ ] **P1.18** Example app: email queue + daily cron, README walkthrough
- [ ] **P1.19** Test harness: integration test util that boots app on temp SQLite, drives jobs, asserts journal state

**Exit criteria:** Phase 1 success criteria in plan.md §5 pass; API review of queue/schedule surface; tag `v0.1.0-alpha`.

---

## Phase 2 — Durable Workflow Engine (6–8 weeks) ★ flagship

Goal: step-memoized durable execution, frozen step API.

- [ ] **P2.1** Run/step journal schema: run (id, workflow, version-hash, status, input, output), step (run_id, step_id, attempt, status, result, timings)
- [ ] **P2.2** Rust execution engine: start run → invoke JS workflow fn → serve step-journal queries → persist step results → complete/fail run
- [ ] **P2.3** Step memoization protocol over NAPI: `step.run(id, fn)` checks journal (fast path: batched prefetch of completed steps at run start)
- [ ] **P2.4** Per-step retry policies (inherit run default, per-step override); step failure → run retry → fast-forward replay through memoized steps
- [ ] **P2.5** `step.sleep(id, duration)`: suspend run, persist wake time, Rust timer resumes — zero JS resources held while sleeping
- [ ] **P2.6** `step.waitForEvent(id, eventName, { timeout, match })`: suspend until event or timeout
- [ ] **P2.7** `step.all([...])` parallel steps with independent memoization; concurrency-safe journal writes
- [ ] **P2.8** Child workflows: `step.invoke(otherWorkflow, input)` — parent suspends, child run links to parent, result memoized
- [ ] **P2.9** Cancellation: `run.cancel()`, cooperative cancellation signal into JS, cancel propagates to children, cleanup steps (`onCancel`)
- [ ] **P2.10** Idempotency: `trigger(input, { idempotencyKey })` dedupes run creation; `step.run` docs + helper for effect-level idempotency keys
- [ ] **P2.11** Workflow versioning: content-hash definitions at registration; in-flight runs pin version; mismatch detection + warning (D6)
- [ ] **P2.12** TS API: `app.workflow(name, optsOrFn, fn?)` with typed input/output (zod), `trigger()`, `triggerAndWait()`, run handle (status/result/cancel)
- [ ] **P2.13** Concurrency controls: max concurrent runs per workflow, queue overflow policy
- [ ] **P2.14** Chaos test suite: random `kill -9` injection at every step boundary across 1k runs → zero lost/duplicated step results
- [ ] **P2.15** Determinism guardrails: docs + lint rule (`eslint-plugin-zenzip`: side effects outside `step.run` warning)
- [ ] **P2.16** Example: order-processing workflow demo (charge → sleep → waitForEvent → ship) used in plan §5
- [ ] **P2.17** Freeze step API; write `docs/workflow-semantics.md` (delivery guarantees, versioning rules, idempotency guide)

**Exit criteria:** chaos suite green; semantics doc reviewed; tag `v0.2.0-alpha`.

---

## Phase 3 — Events, State Machines, HTTP Adapter, Observability + Dashboard (5–7 weeks)

Goal: the demo-able product — dashboard is the launch asset.

### Event bus
- [ ] **P3.1** Rust pub/sub with wildcard topics (`user.*`); ephemeral in-process subscribers
- [ ] **P3.2** Persisted outbox for durable consumers: workflow triggers (`on: "user.created"`) never lose events; at-least-once delivery
- [ ] **P3.3** Wire `step.waitForEvent` to bus; event matching filters (JSON path predicate)
- [ ] **P3.4** TS API: `app.emit()`, `app.on()`, workflow `on:` trigger option

### State machines
- [ ] **P3.5** Machine definition API (`app.machine`) with typed states/events; Rust-side atomic transition validation against store
- [ ] **P3.6** Transitions emit events (`order.paid`) into the bus; invalid transition → typed error
- [ ] **P3.7** Instance queries: current state, history

### HTTP adapter (minimal — per D5)
- [ ] **P3.8** `app.get/post/put/delete` on Node http server with `ctx` exposing trigger/queue/emit/machines; route params + JSON body parsing
- [ ] **P3.9** Mount adapters: plug zenzip context into existing Fastify/Hono apps (`toFastifyPlugin()`, `toHonoMiddleware()`)
- [ ] **P3.10** Webhook → workflow sugar: `app.workflow(..., { on: { http: "POST /hooks/stripe" } })`

### Observability
- [ ] **P3.11** Metrics in Rust core: queue depth/age/throughput, run states, step durations, scheduler ticks (metrics crate)
- [ ] **P3.12** Trace spans per run/step/job with parent-child links (tracing crate); OTLP exporter config
- [ ] **P3.13** Dashboard API: HTTP+SSE endpoints serving runs, steps, queues, schedules, events, DLQ from the store
- [ ] **P3.14** Dashboard SPA: runs list + run detail with step waterfall (live via SSE), queue health page, cron history, DLQ browser with retry, event stream
- [ ] **P3.15** Workflow graph view (read-only DAG from step metadata) — seed of M10
- [ ] **P3.16** Package dashboard as static assets served by runtime (`app.dashboard()` / auto in dev); auth token option for non-dev
- [ ] **P3.17** Record the demo: trigger workflow → steps light up → kill process → resume live

**Exit criteria:** demo video recordable end-to-end; tag `v0.3.0-alpha`; consider first public preview / blog post.

---

## Phase 4 — Agent Engine (5–7 weeks)

Goal: durable agents on the workflow engine (D4).

- [ ] **P4.1** LLM provider adapter trait (Rust or TS layer — decide: TS simpler, providers are HTTP/JSON): messages, tool defs, streaming, usage
- [ ] **P4.2** Anthropic adapter (Messages API, tool use, streaming); prompt caching support
- [ ] **P4.3** OpenAI-compatible adapter (covers OpenAI, local servers, OpenRouter)
- [ ] **P4.4** Tool definition API: zod-typed `tool({ name, description, input, execute })`
- [ ] **P4.5** Agent loop compiled to dynamic durable steps: each LLM call = step, each tool exec = step; loop limit + budget guard (max tokens/cost/iterations)
- [ ] **P4.6** Retry semantics: tool failure retries tool step WITHOUT re-calling LLM; LLM transient errors retry with backoff
- [ ] **P4.7** Session memory: persisted conversation per session id, window/summary strategies (`memory: { history: N }`)
- [ ] **P4.8** Structured output: final-response zod schema enforcement
- [ ] **P4.9** Human-in-the-loop: per-tool `requiresApproval` → `step.waitForEvent("approval.<id>")`; approve/deny API + dashboard button
- [ ] **P4.10** Streaming: token stream to caller (SSE/iterator) while steps persist in background
- [ ] **P4.11** Multi-agent: `agent.handoff(other)`, agents triggering agents via events; shared-context rules documented
- [ ] **P4.12** Cost/token accounting per step → store → dashboard agent trace view (prompts, tool calls, costs)
- [ ] **P4.13** Dashboard: agent session browser with full conversation + tool call inspection
- [ ] **P4.14** Mock LLM adapter for deterministic tests; agent test harness
- [ ] **P4.15** Example: support agent (searchDocs/createTicket/sendEmail) with approval gate — plan §5 demo

**Exit criteria:** Phase 4 success criteria pass; tag `v0.4.0-alpha`.

---

## Phase 5 — Postgres + Multi-Node (4–6 weeks)

Goal: same API, horizontal scale; no consensus code.

- [ ] **P5.1** Postgres `Store` impl (sqlx): schema, migrations, claim via `FOR UPDATE SKIP LOCKED`, advisory-lock scheduler election
- [ ] **P5.2** Lease/heartbeat tuning for multi-node: worker registry, dead-worker detection, orphaned-run recovery
- [ ] **P5.3** Cross-node event bus via Postgres LISTEN/NOTIFY (+ outbox fallback polling)
- [ ] **P5.4** Config: `store: { postgres: url }` — everything else unchanged; document SQLite→Postgres migration path/tool
- [ ] **P5.5** Chaos test: 3 nodes, random node kills, zero duplicate step execution, zero lost jobs
- [ ] **P5.6** Load test + published benchmarks (honest, reproducible repo)
- [ ] **P5.7** Rolling-deploy story: old+new workflow versions coexisting across nodes (exercise D6 under deploys)

**Exit criteria:** chaos green on 3 nodes; tag `v0.5.0-beta`.

---

## Phase 6 — DX, Docs, Launch (4 weeks, overlaps 5)

- [ ] **P6.1** `create-zenzip-app` scaffolder: templates (basic, agent-app, with-fastify); under-2-min target
- [ ] **P6.2** `zenzip dev`: watch mode, auto-dashboard, pretty logs; `zenzip doctor`: version-drift + config checks
- [ ] **P6.3** Docs site: getting started, concepts (durability/idempotency/versioning), API reference (typedoc), guides per module, comparison pages (vs Temporal / Inngest / BullMQ — honest)
- [ ] **P6.4** Test-kit package: time-travel (advance timers), step mocking, run assertions
- [ ] **P6.5** Prebuild publishing: napi-rs npm prebuilds for full platform matrix; optional-deps install pattern; smoke-test installs on all platforms
- [ ] **P6.6** Versioning/release automation (changesets), SemVer policy, public roadmap
- [ ] **P6.7** Launch assets: demo video (P3.17 + agent demo), benchmark post, "why we built this" post, HN/Reddit/X launch
- [ ] **P6.8** Community: GitHub discussions, Discord, CONTRIBUTING.md, good-first-issues

**Exit criteria:** `v1.0.0-rc`; external beta users running real workloads.

---

## Post-1.0 Backlog (parked — do not start early)

- [ ] Rust hyper HTTP server behind `app.get()` (only if Phase 0 numbers justify)
- [ ] M10 visual workflow *authoring* (drag-and-drop) on top of P3.15 graph view
- [ ] MessagePack/bincode boundary serialization (if profiling shows JSON cost)
- [ ] Redis/NATS event-bus backends for very high fan-out
- [ ] Python SDK against the same Rust core
- [ ] Hosted cloud (managed Postgres + dashboard + metrics) — the business model
- [ ] Workflow migration tooling (journal rewrite for breaking step changes)
- [ ] Vector memory for agents (embedded vector store)

---

## Standing Rules (apply every phase)

- CI green on win/mac/linux before merge; native build is never "fix later"
- Every feature lands with: integration test, crash-safety test where applicable, docs page, dashboard surface if user-visible
- Benchmark regressions >10% block merge (criterion benches in Rust, mitata in TS)
- API changes after a freeze require an RFC note in `docs/rfcs/`
- Keep `plan.md` decisions (D1–D8) updated when reality disagrees — the doc follows the code, never silently diverges
