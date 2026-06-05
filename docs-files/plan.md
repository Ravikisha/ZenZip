# ZenZip — Agent-Native Backend Framework for Node.js

> **Working name:** `zenzip` (verify npm availability before launch; alternates: `zenflow`, `flowforge`, `orbitjs`).
>
> **One-liner:** "The agent-native backend framework for Node.js. Build APIs, durable workflows, queues, agents, and automation on a single Rust-powered runtime — with zero infrastructure."

---

## 1. Positioning (Revised)

### What the original plan got right

- Combining Express + BullMQ + Redis + Temporal + OpenTelemetry + LangGraph + cron into one DX is a real, painful gap.
- Rust core + JS API split is the correct architecture.
- "Agent-native" is the right marketing wedge for 2026.

### What needed correction

1. **Speed is not the moat — durability and zero-infra are.**
   Fastify, Hono, and Elysia are already fast enough that nobody migrates frameworks for routing performance. Developers migrate to *delete infrastructure*: no Redis, no Temporal cluster, no RabbitMQ, no separate cron box. The pitch is `npm install zenzip` and you get durable workflows, queues, scheduling, and observability backed by an embedded engine — the way SQLite replaced "install a database server."

2. **The MVP order was wrong.**
   Original plan: Router → Event Bus → Queue → Workflows → Dashboard → Agents.
   A router-first MVP competes with Hono on Hono's turf and loses. The differentiated core is the **durable workflow engine + queue on embedded storage**. HTTP can initially be an adapter over existing servers (Fastify/Hono/Node http) — replace with the Rust HTTP layer later, once the runtime is the reason people adopt.

3. **The NAPI boundary is the central engineering constraint.**
   Every JS↔Rust crossing costs time (object serialization, threadsafe-function dispatch). The architecture must be designed around *coarse-grained* boundary calls: Rust owns scheduling/persistence/timers/state, and calls into JS only to execute user handler code, passing batched, pre-serialized payloads. A naive "Rust router that calls a JS handler per request" can end up *slower* than Fastify. This requires a Phase 0 spike before committing.

4. **Temporal-style deterministic replay is the wrong execution model for JS users.**
   Temporal replays the entire workflow function and requires strict determinism (no `Date.now()`, no `Math.random()`, no plain `fetch`). This is the #1 source of Temporal user pain. Use **step memoization** instead (the Inngest/Trigger.dev model): each `step.run()` result is persisted; on retry/resume, completed steps return cached results instantly and only the failed/next step executes. Same durability guarantees, dramatically simpler mental model, no determinism constraints outside step boundaries.

5. **Agents and workflows are the same engine.**
   An agent loop (LLM call → tool call → LLM call → …) is just a durable workflow with *dynamically generated* steps. Each LLM call and each tool execution is a persisted step. This gives agents retry, resume, human-in-the-loop pauses, full trace history, and cost tracking for free — one Rust engine, two JS API surfaces. This unification is the framework's strongest technical claim.

### Competitive landscape (must be named honestly)

| Product | What it covers | Gap ZenZip exploits |
|---|---|---|
| **Temporal** | Durable workflows | Heavy cluster, replay determinism pain, no agents, not embedded |
| **Inngest** | Step functions, queues | Cloud-first (server is Go, self-host secondary), no embedded mode, agents secondary |
| **Trigger.dev** | Background jobs, agents | Cloud platform, not a framework; you don't own the runtime |
| **Hatchet** | Queues + workflows | Requires Postgres + their engine as separate service |
| **Restate** | Durable execution | Separate sidecar binary, RPC-centric model |
| **Encore.ts** | Rust-powered backend framework | Validates the Rust+TS architecture; no durable workflows, no queues with retries, no agents |
| **Mastra / LangGraph / VoltAgent** | Agent orchestration | No backend framework, no queues/HTTP, durability bolted-on or absent |
| **BullMQ** | Queues | Requires Redis, no workflows/durability beyond flows, no observability UI |

**The unoccupied square:** *embedded* (in-process, zero extra services) + *durable* + *agent-native* + *full backend framework*. That is the position. Encore.ts proves Rust-core/TS-API works; Inngest proves the step API is what developers want; nobody combines both in an embeddable package.

### Target user

- Solo devs / small teams building AI products who currently glue Express + BullMQ + Redis + LangChain and hate it.
- Teams who want Temporal-grade reliability without operating Temporal.
- Automation builders who outgrew n8n but don't want to assemble infra.

---

## 2. Architecture (Revised)

```text
┌─────────────────────────────────────────────────────────┐
│  TypeScript API Layer (npm: zenzip)                      │
│  app.workflow() · app.agent() · app.queue() · app.get()  │
│  app.on()/emit() · app.machine() · app.schedule()        │
│  Type-safe builders, Zod/Standard-Schema validation      │
└────────────────────────┬────────────────────────────────┘
                         │  NAPI-RS (coarse-grained calls,
                         │  threadsafe fns, batched payloads,
                         │  serde-bincode/JSON envelopes)
┌────────────────────────▼────────────────────────────────┐
│  Rust Runtime Core (crate: zenzip-core, tokio)           │
│                                                          │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────────┐ │
│  │ Execution  │ │ Scheduler  │ │ Event Bus            │ │
│  │ Engine     │ │ (cron/     │ │ (pub/sub + persisted │ │
│  │ (steps,    │ │  timers/   │ │  outbox)             │ │
│  │  retries,  │ │  delays)   │ └──────────────────────┘ │
│  │  memoize)  │ └────────────┘ ┌──────────────────────┐ │
│  └────────────┘ ┌────────────┐ │ State Machines       │ │
│  ┌────────────┐ │ Queue      │ │ (transition guard)   │ │
│  │ Agent      │ │ Engine     │ └──────────────────────┘ │
│  │ Sessions   │ │ (leases,   │ ┌──────────────────────┐ │
│  │ (dynamic   │ │  backoff,  │ │ Observability        │ │
│  │  steps)    │ │  DLQ)      │ │ (metrics, traces,    │ │
│  └────────────┘ └────────────┘ │  OTLP export)        │ │
│                                └──────────────────────┘ │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  Storage Layer (trait-abstracted)                        │
│  • Embedded: SQLite (WAL mode) — default, zero config    │
│  • Scale-out: PostgreSQL — multi-node, SKIP LOCKED       │
└──────────────────────────────────────────────────────────┘
```

### Key architectural decisions

**D1 — Execution model: step memoization, not replay.**
A workflow run is a journal of `(step_id, status, result)` rows. The JS workflow function executes top-to-bottom; each `step.run(id, fn)` first asks Rust "is this step done?" — if yes, return persisted result; if no, execute `fn`, persist result, continue. Crash/retry re-enters the function and fast-forwards through completed steps. `step.sleep()` and `step.waitForEvent()` suspend the run with zero resources held (persisted wake condition; scheduler resumes it). This is exactly the Inngest/Trigger.dev model — proven, learnable in 10 minutes.

**D2 — Storage: SQLite embedded by default, Postgres for distributed.**
SQLite in WAL mode handles tens of thousands of queue ops/sec on one node — far beyond what most apps need — and means `npm install` is the entire setup. The storage layer is a Rust trait (`Store`) with two implementations; switching is a config line. Multi-node mode requires Postgres (lease claims via `FOR UPDATE SKIP LOCKED`). Do NOT build a custom distributed consensus layer — that path kills the project; Postgres already solved it.

**D3 — Boundary discipline (NAPI-RS).**
- Rust → JS calls only for: executing a user handler (workflow step, queue consumer, HTTP handler, tool fn). Delivered via `ThreadsafeFunction` with batching where possible.
- JS → Rust calls only for: registering definitions at startup, enqueuing/emitting/triggering, and step-journal queries.
- Payloads cross as buffers (JSON now, optional MessagePack later); never deep object marshaling per-field.
- All timers, polling, lease renewal, retry bookkeeping, cron evaluation stay entirely inside Rust/tokio — zero JS wakeups for idle waits.
- *Spike data (2026-06-04):* sync NAPI call ≈ 14–34 ns (free); **async NAPI fn ≈ 85–100 µs — banned on hot paths**; TSFN round-trip 36 µs sequential but 2.4 µs amortized at 256 in-flight → engine must pipeline handler dispatches (≥64 in flight). See docs/spike-results.md.

**D4 — Agents are workflows.**
`app.agent()` compiles to a workflow whose steps are generated at runtime: `llm.call` steps and `tool.<name>` steps. Provider-agnostic LLM adapter (Anthropic first, then OpenAI-compatible). Agent memory = persisted conversation state in the store. Human-in-the-loop = `step.waitForEvent("approval")`. Multi-agent = workflows triggering workflows over the event bus. Token/cost accounting recorded per step → shows up in the dashboard for free.

**D5 — HTTP strategy: adapter first, Rust server later.** *(SETTLED by Phase 0 spike — see docs/spike-results.md.)*
Phase 1 ships `app.get/post/...` as a thin layer that can mount on Node's http / Fastify / Hono — the value is that route handlers can `ctx.trigger(workflow)`, `ctx.queue.push()`, `ctx.emit()` with one import. **Spike verdict (2026-06-04): NO-GO on a Rust HTTP server for 1.0** — measured hyper→JS-handler was only 1.17× Fastify (below the 1.3× bar); pure-Rust hyper was 1.35×. The Rust front-end buys nothing once real JS handlers are in the path. HTTP stays a Node adapter; revisit post-1.0 only for tail-latency demand (p99 14→9 ms was the one real win).

**D6 — Versioning and migration semantics (decide early, painful later).**
- Workflow definitions are content-hashed; in-flight runs pin to the version they started with (step journal makes old runs completable as long as step IDs are stable).
- Document the rule: *adding* steps after existing ones is safe; *reordering/renaming* step IDs of in-flight runs is a breaking change → tooling warns via `zenzip doctor`.

**D7 — Delivery semantics: at-least-once everywhere, exactly-once step effects.**
Queues and events are at-least-once (leases + acks + visibility timeout + DLQ). Step memoization gives effectively-once *recording* of step results, but side effects inside a step can still double-fire on crash-after-effect-before-persist; docs must teach idempotency keys, and `step.run` exposes an `idempotencyKey` helper.

**D8 — Node process model.**
Default: single Node process, Rust runtime multiplexes via tokio + libuv-friendly callbacks. `cluster`/multi-process on one box: all workers share one SQLite file via WAL (Rust side serializes writers) or point at Postgres. Document this explicitly — it's the first question every production user asks.

---

## 3. Modules (Revised Scope)

### M1 — Core Runtime + Storage (the foundation everything sits on)
Rust crate with the `Store` trait, SQLite impl, run/step/queue/event/schedule tables, lease manager, retry policy engine (exponential backoff + jitter, max attempts, DLQ), and the NAPI bridge. No user-visible API of its own.

### M2 — Durable Workflow Engine (the flagship)
```ts
const orderFlow = app.workflow("order", async ({ step, input }) => {
  const payment = await step.run("charge", () => stripe.charge(input));
  await step.sleep("cooloff", "10m");
  const ok = await step.waitForEvent("inventory.reserved", { timeout: "1h" });
  await step.run("ship", () => shipping.create(payment));
});
await orderFlow.trigger({ orderId: 123 });
```
Steps, retries per-step, sleep, waitForEvent, parallel steps (`step.all`), child workflows (`step.invoke`), cancellation, run history. *Note: the original plan's `.step("extract").step("validate")` string-chaining API was dropped — real handlers need closures, inputs, and types; the function-with-`step` API is what every successful durable-execution product converged on.*

### M3 — Queues
```ts
const emails = app.queue("emails", { concurrency: 10, retries: 5 });
await emails.push({ to, subject });
emails.process(async (job) => { ... });
```
Priorities, delays, rate limits, batching, DLQ + dashboard requeue. Backed by the same store; a queue job is a single-step run internally — one engine.

### M4 — Scheduler
```ts
app.schedule("daily-report", "0 9 * * *", async ({ step }) => { ... });
```
Cron + `every("5m")`, timezone-aware, persisted (survives restarts), overlap policy (skip/queue/concurrent), catch-up policy for missed ticks, jitter. A scheduled job is just a workflow triggered by the Rust timer wheel.

### M5 — Event Bus
```ts
app.emit("user.created", { id });
app.on("user.created", handler);              // ephemeral subscriber
app.workflow("onboard", { on: "user.created" }, fn); // durable trigger
```
In-process pub/sub plus a persisted outbox so workflow triggers never lose events. Wildcards (`user.*`). Events are also how `step.waitForEvent` resolves.

### M6 — Agent Engine
```ts
const support = app.agent("support", {
  model: "claude-sonnet-4-6",
  instructions: "...",
  tools: [searchDocs, createTicket, sendEmail],  // zod-typed tools
  memory: { history: 20 },
});
const reply = await support.run("My order is late");
```
Tool loop as dynamic durable steps (D4), streaming, human-approval gates per tool, structured output (zod schema), session persistence, cost/token tracking, multi-agent handoff via events. Provider adapters: Anthropic → OpenAI-compatible → local.

### M7 — State Machines
```ts
const order = app.machine("order", {
  initial: "created",
  states: { created: { on: { PAY: "paid" } }, paid: { on: { PACK: "packed" } }, ... },
});
await order.create("ord_1");
await order.send("ord_1", "PAY");   // invalid transition → typed error
```
Rust validates transitions atomically against the store; transitions emit events (`order.paid`) that can trigger workflows. Deliberately small — XState-lite persisted, not actor theater.

### M8 — Observability + Dashboard
Embedded web dashboard (`app.dashboard()` → `localhost:4000/zen`): run timelines with step waterfalls, queue depth/age/throughput, agent traces with prompts/tool-calls/token-costs, cron history, DLQ browser with retry button, event stream. Plus OTLP export (traces/metrics) for teams with existing Grafana — the dashboard is for day one, OTLP for day 100. *The dashboard is the demo. This is what the launch video shows.*

### M9 — HTTP Layer
Phase 1: adapter (`app.listen()` on Node http; mountable into Fastify/Hono) so handlers share `ctx` with the runtime. Phase later: optional Rust hyper server behind the same API, gated on the Phase 0 spike results.

### M10 — Visual Workflow Builder *(explicitly deferred — post-1.0)*
The dashboard's read-only graph view of workflows ships early (cheap, from step metadata). Drag-and-drop *authoring* is a separate product-sized effort; do not let it leak into the runtime roadmap.

---

## 4. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| NAPI boundary overhead erases performance story | High | Phase 0 spike with hard numbers before any public claims; design coarse-grained calls (D3) |
| Scope explosion (10 modules) kills momentum | High | Phases are strictly serial gates; M10 deferred; M9 minimal; "one engine" reuse (queue=1-step run, schedule=triggered run, agent=dynamic run) |
| Prebuild matrix pain (mac x64/arm64, linux gnu/musl x64/arm64, win x64) | Medium | napi-rs GitHub Actions templates solve this; set up CI in week 1, not at release |
| SQLite multi-process writer contention | Medium | WAL + single Rust writer thread; document limits; Postgres path for scale |
| Workflow versioning corrupts in-flight runs | Medium | Content-hash pinning + stable step IDs + `zenzip doctor` warnings (D6) |
| "Yet another framework" skepticism | Medium | Lead marketing with workflows/agents/dashboard demo, never with router benchmarks |
| LLM provider API churn | Low | Thin adapter trait; agents work without any LLM (tools-only) for testing |
| Windows dev support (your dev box is Windows) | Low | napi-rs is solid on Windows; keep CI green on all three OSes from day 1 |

---

## 5. Success Criteria per Phase

- **Phase 0:** Measured NAPI round-trip + threadsafe-fn throughput numbers; go/no-go on Rust HTTP; architecture doc updated with real data.
- **Phase 1:** A queue + cron app runs with zero external services, survives `kill -9` mid-job, and resumes. 10k jobs/sec single-node SQLite.
- **Phase 2:** The order-workflow demo (charge → sleep 10m → waitForEvent → ship) survives process restarts at every point. Step API frozen.
- **Phase 3:** Dashboard demo video-ready: trigger a workflow, watch steps light up live, kill the process, watch it resume.
- **Phase 4:** A support agent with 3 tools runs durably; a tool-failure retries without re-calling the LLM; human-approval gate works.
- **Phase 5:** Two nodes on Postgres share queues/workflows with no duplicate step execution under chaos testing.
- **Launch:** `npx create-zenzip-app` → working app with workflow + queue + cron + agent + dashboard in under 2 minutes.

---

## 6. Tech Stack Summary

| Layer | Choice | Why |
|---|---|---|
| Rust async runtime | tokio | Ecosystem default |
| Bridge | napi-rs v3 | Best-in-class Node bindings, prebuild tooling |
| Embedded store | rusqlite (SQLite, WAL) | Zero-infra default |
| Scale-out store | sqlx + PostgreSQL | SKIP LOCKED leasing, boring and proven |
| Serialization | serde_json now; bincode/msgpack later | Debuggability first |
| HTTP (later) | hyper | If spike passes |
| JS API | TypeScript, tsup build, Standard Schema (zod-compatible) validation | Type-safe DX is non-negotiable |
| Dashboard | Embedded static SPA (Vite + React or Solid) served by runtime | Single-package story |
| Telemetry | tracing + opentelemetry crates, OTLP export | Industry standard |
| Monorepo | pnpm workspaces + cargo workspace; packages: `zenzip`, `@zenzip/core` (native), `@zenzip/dashboard`, `create-zenzip-app` | Standard napi-rs layout |

---

## 7. What We Are NOT Building (anti-scope)

- Not a Temporal-compatible API or migration path.
- Not a custom raft/consensus distributed store — Postgres is the distributed story.
- Not an ORM, auth library, or frontend framework — stay in the automation/runtime lane.
- Not drag-and-drop workflow authoring before 1.0 (M10 deferred).
- Not multi-language SDKs (Python etc.) before the Node story is complete.
- Not a hosted cloud before the open-source framework has adoption (cloud is the *eventual* business model — same playbook as Inngest/Trigger.dev — but OSS-first).
