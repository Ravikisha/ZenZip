# ZenZip — Implementation Tasks

> Phases are serial gates: do not start a phase until the previous phase's exit criteria pass.
> Conventions: `[ ]` todo · `[~]` in progress · `[x]` done. Keep this file updated as the single source of truth.

---

## Phase 0 — Validation Spike (1–2 weeks)

Goal: hard numbers on the NAPI boundary before committing to architecture claims.

- [x] **P0.1** Scaffold monorepo: cargo workspace (`crates/zenzip-core`, napi crate co-located in `packages/core-native`) + pnpm workspace (`packages/zenzip`, `packages/core-native`, `bench`)
- [x] **P0.2** Set up napi-rs v3 build pipeline; produce a working `.node` binary loadable from TS on Windows (dev box), then mac/linux via CI — *built green on Windows; generated index.js/index.d.ts*
- [x] **P0.3** CI: GitHub Actions matrix (win/mac/linux × rust fmt+clippy+test, native build + TS suite, dedicated postgres-service job) — pushed and green
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
- [x] **P1.1** Define `Store` trait in Rust: queue jobs, schedules, leases (CRUD + atomic claim ops) — *runs/steps tables come with Phase 2*
- [x] **P1.2** SQLite schema v1 + migrations (embedded `user_version` migration runner); WAL mode, busy_timeout, single-writer discipline
- [x] **P1.3** SQLite `Store` impl with atomic batch claim (lease + visibility timeout), ack, nack, per-job lease renewal heartbeat — *found+fixed: UPDATE…RETURNING does not preserve subquery ORDER BY*
- [x] **P1.4** Retry policy engine: max attempts, exponential backoff + jitter, per-job overrides, dead-letter transition
- [x] **P1.5** Crash-safety tests: lease-expiry redelivery + exhausted→dead in Rust tests; kill-process harness (SIGKILL mid-job → redelivery with attempt counted) in test/crash.test.ts; *full chaos suite still scheduled for Phase 2*

### Queue engine
- [x] **P1.6** Rust queue engine on tokio: poll/notify loop, concurrency limits per queue (semaphore), priority ordering, delayed jobs
- [x] **P1.7** NAPI bridge: `ZenRuntime` class; consumer = TSFN returning Promise (resolve=ack, reject=nack); sync push (spike rule: no async NAPI on hot paths)
- [x] **P1.8** TS API: `app.queue(name, opts)` → `.push()`, `.pushBulk()`, `.process(fn)`; Standard Schema (zod-compatible) validation; typed payloads
- [x] **P1.9** Rate limiting (token bucket per queue, `rateLimit: { max, per }`) + batch consumption (`processBatch(fn, { size })`, all-or-nothing retry)
- [x] **P1.10** DLQ: dead status, `deadJobs()`, `requeueDead()` with fresh retry budget
- [x] **P1.11** Graceful shutdown: stop claiming, drain in-flight with timeout, SIGINT/SIGTERM auto-handlers (opt-out)

### Scheduler
- [x] **P1.12** Cron parser (croner) + interval schedules, IANA timezone support, validated at registration
- [x] **P1.13** Persisted schedules: survive restart (spec timing preservation), catch-up (skip | runOnce | all, capped at 100 with logged drop), overlap (skip | queue | allow), per-fire jitter option
- [x] **P1.14** TS API: `app.schedule(name, cronOrEvery, fn)`; fire = enqueue onto hidden internal queue (one engine)

### App shell
- [x] **P1.15** `app = zenzip()` lifecycle: define → `app.start()` boots Rust runtime → `app.stop()` graceful drain
- [x] **P1.16** Config: data dir, sweep/tick cadence, worker threads, logLevel; `store: { driver }` with explicit Phase-5 error for postgres; zero-config defaults
- [x] **P1.17** Structured logging from Rust (tracing) → JS `logger` sink via weak TSFN (doesn't hold event loop) or stderr fmt fallback; subscriber is process-global, first app wins
- [x] **P1.18** Example app: examples/email-queue (flaky SMTP retries + digest schedule), verified live
- [x] **P1.19** Test harness: vitest suite boots app on temp SQLite (10 tests: process/retry/DLQ/delay/drain/schema/schedules) + 7 Rust store tests

**Exit criteria:** Phase 1 success criteria in plan.md §5 pass; API review of queue/schedule surface; tag `v0.1.0-alpha`.

---

## Phase 2 — Durable Workflow Engine (6–8 weeks) ★ flagship

Goal: step-memoized durable execution, frozen step API.

- [x] **P2.1** Run/step journal schema (migration v2): runs (status machine, version, idempotency, parent links, wake conditions), steps (PK run_id+step_id, kind, result, attempts)
- [x] **P2.2** Rust execution engine: run = job on hidden `zenzip.workflow.<name>` queue → invoke JS executor → apply outcome (completed/suspend/stepFailed/failed)
- [x] **P2.3** Step memoization protocol: journal batch-prefetched per attempt (zero per-step reads); `recordStep` = sync NAPI write per completed step
- [x] **P2.4** Per-step retry with backoff (workflow-level policy); step failure → re-enqueue → fast-forward replay; *per-step policy override pending*
- [x] **P2.5** `step.sleep(id, duration)`: suspend = delayed execution job; zero resources held; survives restarts (tested)
- [x] **P2.6** `step.waitForEvent(id, event, { timeout })`: suspend until `app.emit` or timeout sweep; null on timeout; *`match` filter → Phase 3*
- [x] **P2.7** `step.all([...])` parallel steps with independent memoization (flaky sibling retries alone — tested)
- [x] **P2.8** Child workflows: `step.invoke(id, wf, input)` — deterministic child idempotency key, parent woken on terminal state, error propagates as throw
- [x] **P2.9** Cancellation: `wf.cancel(runId)` cancels run + descendant tree; stale wake jobs no-op; in-flight outcome discarded; *`onCancel` cleanup hooks → backlog*
- [x] **P2.10** Idempotency: `trigger(input, { idempotencyKey })` dedupes (unique index + race-safe re-select); effect-level keys documented in workflow-semantics.md
- [x] **P2.11** Versioning: FNV-1a content hash at registration, runs pin version, mismatch warning on resume + step-kind-change detection (D6)
- [x] **P2.12** TS API: `app.workflow(name, optsOrFn, fn?)`, `trigger()`, `triggerAndWait()`, `getRun()`, `cancel()`; typed input/output; duplicate-step-id guard
- [x] **P2.13** Concurrency controls: per-workflow `concurrency` (queue semaphore) + `lease` for long steps; *overflow policy pending*
- [~] **P2.14** Chaos: 4× random SIGKILL mid-run harness (test/chaos.test.ts) — correct output, no lost steps, bounded re-execution; *full 1k-run boundary-injection suite pending*
- [~] **P2.15** Determinism guardrails: docs written (workflow-semantics.md); *eslint-plugin-zenzip lint rule pending*
- [x] **P2.16** Example: order demo (charge → sleep → waitForEvent → ship) as e2e test, steps executed exactly once
- [x] **P2.17** Step API frozen; docs/workflow-semantics.md written (execution model, D7 guarantees, versioning rules, idempotency guide)

**Exit criteria:** chaos suite green; semantics doc reviewed; tag `v0.2.0-alpha`.

---

## Phase 3 — Events, State Machines, HTTP Adapter, Observability + Dashboard (5–7 weeks)

Goal: the demo-able product — dashboard is the launch asset.

### Event bus
- [x] **P3.1** Wildcard topics (`user.*` one segment, `user.**` remainder); ephemeral in-process subscribers via `app.on()` with unsubscribe
- [x] **P3.2** Atomic outbox: emit persists the event + wakes waiters + creates `on:`-triggered runs + inserts their jobs in ONE store transaction — triggered runs can't be lost
- [x] **P3.3** `step.waitForEvent` match predicate (`match: { invoiceId }` shallow equality on payload); wired through suspend → store → wake
- [x] **P3.4** TS API: `app.emit()` → `{ woken, triggered }`, `app.on(pattern, fn)`, workflow `on: string | string[]` option; triggered runs get `{ event, payload, emittedAt }` input
- *Cross-process subscriber delivery → Phase 5 (LISTEN/NOTIFY); local subscribers are this-process by design*

### State machines
- [x] **P3.5** `app.machine(name, { initial, states })` definition; optimistic atomic transitions in store with retry on race
- [x] **P3.6** Transitions emit `<machine>.<toState>` through the outbox (durable workflow triggers can hook); invalid transition → descriptive error; transition + history + event + triggered runs commit in ONE transaction (crash window closed)
- [x] **P3.7** Instance queries: `state()`, `history()` (newest first); idempotent `create()`

### HTTP adapter (minimal — per D5)
- [x] **P3.8** `app.get/post/put/patch/delete` + `app.listen()` on node:http; `:param` routes, query, JSON body, ctx.status/json/text, error → 500 JSON
- [x] **P3.9** `app.toNodeHandler()` — mountable raw (req,res) handler for any node server (Express use(), http.createServer, …); *framework-specific Fastify/Hono plugins → backlog*
- [x] **P3.10** Webhook sugar: `app.workflow(name, { http: "POST /hooks/stripe" }, fn)` → route responds `{ runId }`

### Observability
- [x] **P3.11** Metrics: atomic counters on hot paths (jobs completed/retried/dead, handler avg/max ms, runs, step retries, steps recorded, events, schedule fires) → `app.metrics()`, `/api/metrics`, dashboard cards
- [~] **P3.12** Trace spans exist (tracing crate, per-module targets) and feed the JS log sink; *OTLP wire exporter deliberately deferred — heavy opentelemetry dep tree, exporter reads the same counters/spans when added*
- [x] **P3.13** Dashboard API: `/api/overview`, `/api/stream` (SSE), `/api/metrics`, `/api/runs(/:id)`, `/api/queues/:name/requeue-dead`
- [x] **P3.14** Dashboard UI: live via SSE (1.5s frames, polling fallback), overview + engine-metrics cards, runs table, step graph detail, queue health w/ requeue, schedules, event feed; *React SPA refactor → backlog, embedded HTML is the v1*
- [x] **P3.15** Run step-graph view: connected timeline nodes with kind/attempts/timing deltas/errors; *true DAG needs dependency metadata → with agent engine*
- [x] **P3.16** Dashboard served by the runtime process, zero extra assets; optional `token` auth (Bearer or ?token=, timing-safe compare)
- [~] **P3.17** Demo ready: examples/demo-dashboard (continuous orders through machine→trigger→workflow→approval→ship + flaky queue + heartbeat), verified live; *video recording itself = manual step*

**Exit criteria:** demo video recordable end-to-end; tag `v0.3.0-alpha`; consider first public preview / blog post.

---

## Phase 4 — Agent Engine (5–7 weeks)

Goal: durable agents on the workflow engine (D4).

- [x] **P4.1** LLM provider interface in TS (providers are HTTP/JSON; durability lives below them): JSON-serializable messages/responses by design — journalable
- [x] **P4.2** Anthropic adapter: Messages API, tool use, SSE streaming, prompt caching (cache_control on system + last tool)
- [x] **P4.3** OpenAI-compatible adapter: /chat/completions function calling — OpenAI, Ollama, vLLM, OpenRouter
- [x] **P4.4** `tool({ name, description, parameters (JSON Schema), schema (Standard Schema validation), requiresApproval, execute })`
- [x] **P4.5** Agent = workflow with dynamic steps (`agent:<name>`): llm-i and tool-i-id journaled steps; maxIterations + maxTotalTokens guards fail the run
- [x] **P4.6** Tool failure retries the tool step WITHOUT re-calling the LLM (response journaled first) — asserted: tool fails 2×, provider.calls === 2
- [x] **P4.7** Session memory: agent_sessions table (migration v4), windowed history, journaled snapshot per run, `agent.session(id)`
- [x] **P4.8** Structured output: Standard Schema validation of final JSON + one corrective round, then fail with the validation error
- [x] **P4.9** `requiresApproval` → durable waitForEvent gate matched on (runId, toolUseId); `agent.approve()/deny(reason)`; timeout → denied; *dashboard approve button → backlog*
- [x] **P4.10** Streaming: `run(msg, { onToken })` — live runs stream (Anthropic SSE, mock), memoized replays never re-stream; same-process only (documented)
- [x] **P4.11** Multi-agent: `handoffTool(other)` → child agent runs as durable child workflow via step.invoke; cancellation propagates
- [x] **P4.12** Token accounting: usage journaled per LLM step (visible in dashboard step detail), aggregated in run output; *$ pricing tables → backlog*
- [~] **P4.13** Agent runs visible in dashboard as agent:<name> with full step detail (prompt responses, tool results, usage); *dedicated session-browser view → backlog*
- [x] **P4.14** mockProvider (scripted, records calls for assertions) + mockText/mockToolUse helpers; 9-test agent harness
- [x] **P4.15** Example: examples/support-agent — searchDocs/createTicket/sendRefund w/ approval gate, offline by default (mock), Claude with ANTHROPIC_API_KEY; verified live

**Exit criteria:** Phase 4 success criteria pass; tag `v0.4.0-alpha`.

---

## Phase 5 — Postgres + Multi-Node (4–6 weeks)

Goal: same API, horizontal scale; no consensus code.

- [x] **P5.1** Postgres `Store` impl (sqlx, dedicated `zenzip` schema, advisory-locked migrations): claims via `FOR UPDATE SKIP LOCKED`; scheduler election via CAS tick-claims (simpler than advisory locks, works on sqlite too — boot catchup included)
- [x] **P5.2** Dead-worker recovery: leases ARE the registry — node kill → lease expiry → survivors recover (validated by chaos tests); *explicit worker-registry table for dashboards → backlog*
- [x] **P5.3** Cross-node wakeups: `pg_notify` in the insert transaction + per-node LISTEN task (auto-reconnect) → pushes/emits on node A wake node B instantly (validated: 200 jobs drain across 2 nodes with a 5s poll)
- [x] **P5.4** `store: { driver: "postgres", url }` — everything else unchanged (validated by full TS e2e on PG); *SQLite→Postgres data migration tool → backlog*
- [x] **P5.5** Chaos: 3 nodes + hard kill → 150/150 jobs processed, dups bounded by killed node's in-flight; 2-node workflow kill → all runs complete, step journal effectively-once; cross-node event wake; 2-node scheduler fires ~1× per tick (no doubling)
- [~] **P5.6** Load test on PG + published benchmarks — *pending server-grade hardware run*
- [~] **P5.7** Rolling-deploy: version pinning carries over unchanged (D6); documented in configuration guide; *multi-node deploy exercise under chaos → with P5.6*

**Bonus fix (found by P5.3 test):** dispatcher saturation stall — a single wake claimed until concurrency filled, then slept the full poll interval with backlog remaining (masked by SQLite's 250ms poll). Now wakes on permit-release; one notification drains any burst.

**Exit criteria:** chaos green on 3 nodes; tag `v0.5.0-beta`.

---

## Phase 6 — DX, Docs, Launch (4 weeks, overlaps 5)

- [x] **P6.1** `create-zenzip-app`: ALL THREE templates — basic (queue+schedule+workflow+dashboard), agent (tools, approval gate, offline mock / Claude via env), with-fastify (Fastify HTTP API triggering durable workflows, graceful shutdown ordering, idempotent order endpoint); name stamping, .gitignore, validation — all verified locally
- [x] **P6.2** `zenzip` CLI: `dev <file>` (node --watch restart loop) + `doctor` (binding/store health, queue + DLQ summary with pointers, run status breakdown, workflow version-drift detection across in-flight runs, overdue schedules) — verified against a seeded store
- [x] **P6.3** Docs site complete: landing + 14 guide pages incl. honest comparison page (vs Temporal / Inngest / BullMQ + "when NOT to use ZenZip") + typedoc API reference (`pnpm --filter zenzip docs:api` → docs/public/api, linked from the site header; generated artifact gitignored)
- [x] **P6.4** Test-kit: `zenzip/testing` subpath — createTestApp (temp store, fast cadences, cleanup), waitFor, waitForRunStatus (fails fast on wrong terminal state); mock LLM helpers re-exported; *time-travel timers → backlog (engine clock is Rust-side)*
- [~] **P6.5** Release pipeline written (.github/workflows/release.yml): 5-target prebuild matrix → napi artifacts → npm publish on v* tags; *needs NPM_TOKEN + first tagged run to validate; packages still private:true until then*
- [x] **P6.6** Changesets installed + configured (.changeset/: zenzip + @zenzip/core-native version-fixed — TS API pinned to its native binary; bench/examples ignored); SemVer policy documented in .changeset/README.md; release flow = changeset version → tag → release.yml; public roadmap = docs site roadmap page
- [ ] **P6.7** Launch assets: demo video (P3.17 script ready), benchmark post, "why we built this" post, HN/Reddit/X launch — *content work, manual*
- [~] **P6.8** CONTRIBUTING.md written (standing rules, boundary ground rules, hard-won test-suite lessons); *Discord/discussions/good-first-issues → after public repo settles*

**P0.7b (closed):** 4-process SQLite contention bench (bench/multiproc.mjs): 20,000/20,000 jobs exactly-once across 4 consumer processes + 1 producer on one WAL file; cross-process push 16.3k/s; drain ~830 jobs/s — multi-process is CORRECT but writer contention caps throughput; heavy multi-process = use Postgres (as designed, D8 documented).

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
