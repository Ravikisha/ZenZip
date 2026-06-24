# ZenZip — Path to Standalone & Production-Ready

> Strategy + roadmap to take ZenZip from "feature-complete against the original
> plan (phases 0–5)" to **the durable-execution framework teams actually pick in
> production** — with an Express-familiar surface that flattens the learning curve.
>
> Companion to `plan.md` (the original D1–D8 decisions) and `tasks.md` (the
> phase ledger). This file defines **Phases 7–10**. Phase numbering continues
> the existing scheme.

---

## 0. Where ZenZip stands today (honest baseline)

Shipped and tested (33 Rust + 49 TS tests, SIGKILL + 3-node Postgres chaos):

- Durable workflows via **step memoization** (Inngest/Trigger.dev model, *not*
  Temporal replay), queues, persisted scheduler, atomic event outbox, state
  machines, durable AI agents, embedded dashboard, SQLite default → Postgres
  multi-node, napi-rs prebuild release pipeline, CLI + scaffolder + test-kit.

The market research (see §1) says ZenZip is **already sitting on the winning
architectural axis of 2026** and accidentally dodging the field's #1 complaint:

1. **Minimal infra** — embedded SQLite default, Postgres for scale. This is the
   axis DBOS/Hatchet/Restate compete on and Temporal loses on. ZenZip is even
   lighter than "just Postgres" for the single-node case.
2. **Step memoization, not strict-replay determinism** — the single most-cited
   developer pain across Temporal users ("debugging non-determinism is almost
   impossible," "bad versioning spikes CPU across the fleet") **does not exist
   in ZenZip's model**. Between-step code is plain TypeScript. This is a wedge
   we under-sell today.
3. **One engine, AI-native from the core** — agents are workflows with dynamic
   steps. The whole market is racing to bolt "durable agents" on; ZenZip had it
   in the foundation.

**The gap is not features-vs-the-plan. It's production hardening, AI-native
depth, and adoption ergonomics.** This plan closes all three.

---

## 1. Competitive position (research-grounded)

| Axis | Market leader | ZenZip today | Verdict |
|---|---|---|---|
| Infra footprint | Restate (1 binary), DBOS/Hatchet (just PG) | embedded SQLite → PG | **best-in-class** |
| Determinism pain | Temporal worst; Inngest/Trigger best | none (memoization) | **best-in-class** |
| Durable steps + retries + sleep + wait | all of them | ✅ | parity |
| Human-in-the-loop | Trigger waitpoints, LangGraph interrupts | ✅ approval gates | parity |
| **Flow control depth** | Inngest (per-key/throttle/debounce) | per-queue concurrency + rate limit only | **gap** |
| **Observability / OTel** | Trigger, BullMQ, Hatchet all export OTel | counters only, no OTLP wire | **gap (blocks 1.0)** |
| **Run retention / GC** | all mature engines | none — tables grow forever | **gap (blocks 1.0)** |
| **MCP / agent memory / evals** | Mastra, LangGraph, Inngest AgentKit | conversation window only | **gap (AI white space)** |
| **Large LLM payload handling** | underserved everywhere | none | **white space** |
| Realtime → frontend | Trigger Realtime, LangGraph streams | dashboard SSE only | **gap** |
| Security (encryption/RBAC/SSRF) | enterprise tiers | encryption/RBAC in progress | **closing (P7D)** |
| **App auth + request validation** | Nest/Fastify plugins, Express middleware | dashboard token only | **gap (P13)** |
| **Timeouts / circuit breakers** | mature engines bound every call | lease-expiry recovery only | **gap (P15)** |
| **Deploy story (Docker/Helm/recipes)** | mature engines ship images + charts | none yet | **gap (P16)** |
| **Express-familiar DX** | nobody owns this | full middleware + Router + adapters | **wedge held (P8 ✅)** |

**Three places to win (unclaimed white space):**
1. **"Durability without the determinism tax, on zero infra"** — already true,
   needs to be the headline + backed by safe-versioning tooling.
2. **Large LLM payload handling + AI-native depth** (MCP, memory tiers, evals)
   on a durable core — nobody combines all of it.
3. **The Express on-ramp** — the entire cohort assumes you'll learn new
   orchestration vocabulary. ZenZip can say *"it's Express; `app.queue` and
   `app.workflow` are just there too."* No competitor owns the
   "zero-new-concepts HTTP layer" position.

---

## 2. Phase 7 — Production Hardening (gates v1.0)

These are the research-confirmed **must-haves** to be credible infra. Nothing
in §3–§5 ships to a "1.0" claim until Phase 7 is done.

### 7A. Observability (close P3.12)
- **P7.1 OTel trace export.** Engine emits spans per run / step / job / queue
  poll / LLM call / tool call, with parent-child links, exported via OTLP.
  **Critical discipline (from research):** instrument the *non-replayed* units
  (steps, activities), keep span creation out of code that re-executes on
  attempt replay — otherwise spans double-emit. Span creation lives in the Rust
  engine at step boundaries, not in user JS.
- **P7.2 Canonical engine metrics** (the set Temporal proved you need):
  `schedule_to_start_latency` (the #1 backlog signal), worker slot
  used/available gauges, run/step started/completed/failed/retried/timed-out
  counters, duration histograms. Export via OTLP **and** a Prometheus
  `/metrics` pull endpoint (self-hosters scrape).
- **P7.3 Trace-context propagation across nodes** — inject context into job
  payloads so a run traces across processes/hosts; clock-skew-tolerant
  span joining.
- **P7.4 Structured JSON logs with trace/span id injected** (extend the existing
  Rust→JS log sink) for log↔trace correlation. Adopt OTel semantic conventions.
- **P7.5 GenAI semantic conventions** for agent spans/metrics
  (`gen_ai.client.token.usage`, `time_to_first_chunk`, operation duration) —
  this is *also* a differentiator; gate behind the semconv stability opt-in.

### 7B. Operations
- **P7.6 Run/step retention + GC.** *Hard 1.0 blocker.* Today runs, steps, and
  events accumulate forever; PG queue tables degrade past ~100k rows. Ship a
  configurable retention policy (completed/failed runs older than N, events
  older than N) with a background GC sweep, plus **time/status table
  partitioning** for the Postgres backend. Cold-archive-to-object-storage is
  nice-to-have.
- **P7.7 Liveness/readiness split.** Liveness = process up, zero I/O.
  Readiness = store reachable + accepting work. `app.health()` /
  `/healthz` + `/readyz` on the dashboard or a dedicated tiny server. Drives
  correct rolling deploys.
- **P7.8 Backpressure / admission control.** Bounded enqueue + producer-side
  signal when a queue is saturated (today push always succeeds and can bloat).
- **P7.9 Expand/contract migration discipline** documented + enforced: schema
  changes must keep old and new workers interoperable through a rolling deploy.
  Migration runner already exists; add the *policy* + a CI check.
- **P7.10 Orphaned-run observability.** Surface "stuck" runs (leased past
  expected, or sleeping past wake) in `zenzip doctor` and the dashboard.

### 7C. Reliability hardening
- **P7.11 Fencing tokens** on leases. Today recovery is lease-expiry based;
  add a monotonically increasing fence token per lease so a paused/zombie
  worker's late write is rejected (prevents the rare double-execution-after-GC
  corruption). Strengthens the existing at-least-once story.
- **P7.12 Clock-skew handling** for multi-node Postgres: don't trust wall
  clocks for lease/ordering decisions; bound max skew (500ms default) or move
  to hybrid-logical-clock timestamps for cross-node ordering.
- **P7.13 Effect-level idempotency helper.** `step.run` already memoizes; add a
  first-class `ctx.idempotencyKey(stepId)` and document the transactional-outbox
  pattern (ZenZip *already has* the outbox for events — extend the same
  guarantee to user enqueues from inside steps).
- **P7.14 Deterministic simulation / fault-injection harness** in the Rust core
  (kill workers, delay store, drop wakeups) run in CI — converts the existing
  ad-hoc chaos tests into a standardized suite; the Rust core makes this
  feasible.

### 7D. Security
- **P7.15 Payload encryption at rest** (AES-256) — opt-in `encryptionKey`
  config; encrypt job/run/step/event payloads before write, decrypt on read.
  A durable engine persists every input/output, so this is load-bearing for
  any team with PII.
- **P7.16 SSRF allowlist** for every feature that fetches a user-controlled URL
  (webhook routes, agent HTTP tools, future blob fetch): host allowlists,
  resolve-then-validate against link-local/internal ranges (DNS-rebind safe).
- **P7.17 Dashboard RBAC** beyond the single token: read-only vs operator
  roles, scoped tokens. (Basic auth already exists — this is the maturity step.)
- **P7.18 Supply chain ≈ SLSA L2:** Sigstore-signed releases, build provenance
  attestations, SBOM (Syft/CycloneDX), npm publish provenance + 2FA, `cargo
  audit` + `npm audit` in CI. Doubly important — Rust + Node dual supply chain.

### 7E. Packaging (close P6.5 properly)
- **P7.19 Full prebuild matrix** as `optionalDependencies` platform packages
  incl. **musl** (Alpine/Docker) — missing musl is the top install failure.
- **P7.20 WASM/WASI fallback package** (napi-rs v3) so installs degrade
  gracefully and enable a browser/StackBlitz "try it" demo.
- **P7.21 Bundler/serverless docs**: mark the native addon `external` in
  esbuild/webpack, Lambda-layer recipe, `--ignore-scripts` clean install.

**Phase 7 exit = the defensible "1.0 production-ready" claim.**

---

## 3. Phase 8 — The Express-Native DX Layer (the adoption wedge)

**Goal:** a developer who knows Express is productive in ZenZip in minutes,
because the HTTP layer *is* Express-shaped — and durability primitives sit
right next to it with no new HTTP concepts to learn.

### Why this wins
Every competitor makes you learn their orchestration vocabulary first. ZenZip's
pitch becomes: **"It's Express. `app.get()` works exactly how you expect. When
you need durability, `app.queue()` / `app.workflow()` / `app.agent()` are on the
same `app`."** The on-ramp is zero-new-concepts; durability is opt-in depth.

### 8.1 Middleware — `app.use()` (the missing Express core)
Today there's a router with `ctx` but no middleware chain. Add Express's model:

```ts
const app = zenzip();

// Global middleware — Express (req, res, next) signature.
app.use((req, res, next) => {
  req.startedAt = Date.now();
  next();
});

// Path-scoped middleware.
app.use("/api", authMiddleware);

// Built-in middleware shipped with the framework.
app.use(zenzip.json());          // body parsing (already implicit; now explicit + opt-out)
app.use(zenzip.cors({ origin: "*" }));
app.use(zenzip.logger());        // wired to the structured log sink + traces

// Error-handling middleware — 4-arg, exactly like Express.
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message });
});
```

### 8.2 Dual handler signature (Express-compat + the richer ctx)
Support **both** so Express muscle memory works *and* power users get typed
access to the runtime:

```ts
// Express-familiar: (req, res) — req.params/query/body, res.json/send/status.
app.post("/orders", (req, res) => {
  res.status(201).json({ id: req.body.id });
});

// Runtime-aware: durability primitives are on req (or a typed ctx).
app.post("/orders", async (req, res) => {
  const { runId } = await req.app.workflow("order").trigger(req.body);
  res.json({ runId });
});
```

`req`/`res` are thin augmentations of `node:http` IncomingMessage/ServerResponse
(like Express), so existing Express middleware ecosystems are largely reusable.

### 8.3 Routers — `app.router()` + mounting
```ts
const api = zenzip.Router();
api.get("/users/:id", getUser);
api.post("/users", createUser);
app.use("/api/v1", api);          // mount, exactly like express.Router()
```

### 8.4 Webhook → workflow, the Express way
Today: `app.workflow(name, { http: "POST /hooks/x" }, fn)`. Keep it, **and**
let any route trigger durable work naturally — the route handler is just
Express, and triggering is one call:

```ts
app.post("/hooks/stripe", async (req, res) => {
  await orderFlow.trigger(req.body, { idempotencyKey: req.body.id });
  res.sendStatus(202);
});
```

### 8.5 Framework adapters (meet users where they are)
- **P8.x** `toNodeHandler()` exists → ship **first-class plugins**: Fastify
  plugin, Hono middleware, **Next.js route-handler adapter** (`export const POST
  = app.handler()`), Nest module. Research: the cohort competes hard on
  framework ergonomics; this is the adoption multiplier.

### 8.6 Express-parity checklist (P8 task list)
- `app.use(fn)` / `app.use(path, fn)` global + scoped middleware
- 4-arg error middleware
- `zenzip.Router()` with mounting + nested routers
- `(req, res, next)` handler signature alongside the typed ctx
- `res.send / res.json / res.status / res.redirect / res.sendStatus / res.set`
- `req.params / req.query / req.body / req.headers / req.app`
- Built-in middleware: `json()`, `urlencoded()`, `cors()`, `logger()`, `static()`
- Framework adapters: Fastify, Hono, Next.js, Nest
- **A "Coming from Express" doc page** + a side-by-side migration table
- **Migration guides FROM BullMQ / Inngest / Temporal** (separate but same goal:
  meet users where they are)

> **Design rule:** the Express layer is pure DX sugar over the existing
> `node:http` adapter. It must NOT leak into the engine or change durability
> semantics. HTTP stays a Node adapter (D5 holds).

---

## 4. Phase 9 — AI-Native Depth (the standout differentiator)

The research is blunt: durable-execution + agent-loop convergence is *the* 2026
theme, and the unserved corners are **large-payload handling, agent memory
tiers, MCP, and evals**. ZenZip's durable agent core is the right foundation —
make it the best AI-agent runtime that also happens to be crash-proof.

- **P9.1 Large LLM payload offloading.** *Genuine white space.* Big prompts/
  responses bloat the step journal (Temporal users build blob codecs by hand).
  Auto-offload step payloads over a size threshold to a blob store
  (filesystem/S3), keep a reference in the journal. Native, transparent.
- **P9.2 MCP integration** — both directions, now table-stakes for agent
  frameworks: (a) **consume** MCP servers as agent tools (`tools: [mcp(url)]`),
  (b) **author** — expose a ZenZip app's workflows/agents as an MCP server so
  other agents can call them durably.
- **P9.3 Tiered agent memory.** Today: conversation window only. Add Mastra-style
  tiers — **semantic recall** (embedding retrieval over past turns; embedded
  vector store, ties to the post-1.0 backlog item), **working memory**
  (structured durable facts/preferences per session), **observational memory**
  (compress old conversations). Sessions already persist; this is the depth.
- **P9.4 Realtime run subscription API** (Trigger.dev Realtime parity): a public
  `app.subscribe(runId)` / SSE/WebSocket stream of run status + step events +
  **LLM token + tool-call streaming to the frontend**. The dashboard already
  has SSE internally — promote it to a first-class user API.
- **P9.5 Built-in evals.** Model-graded / rule-based / statistical evaluators as
  a framework primitive (`app.eval(...)`), run as durable workflows, results in
  the dashboard. Still rare outside Mastra/LangSmith → differentiator.
- **P9.6 Multi-agent networks.** `handoffTool` exists (1:1). Add network routing
  (deterministic + LLM-based) with shared typed state and handoff — AgentKit
  parity, on a durable substrate.
- **P9.7 Provider breadth + cost tables.** Add Google/Bedrock adapters; attach
  per-model pricing so token accounting becomes **dollar** accounting in the
  dashboard.

---

## 5. Phase 10 — Flow Control & Scale Depth

Match Inngest's flow-control depth (the one parity gap among table-stakes) and
document/extend scale.

- **P10.1 Per-key / per-tenant concurrency.** `concurrency: { limit: 5, key:
  (job) => job.data.userId }` — the most-requested flow-control feature; today
  only per-queue. Applies to queues, workflows, agents.
- **P10.2 Throttling & debouncing.** Throttle (smooth rate over key), debounce
  (collapse bursts) — Inngest-parity primitives, engine-side.
- **P10.3 Priority + fairness queues** across tenants (Temporal Fairness /
  BullMQ Pro Groups parity) so one noisy tenant can't starve others.
- **P10.4 Postgres partitioning + index-only dequeue path** for the scale
  ceiling (pairs with P7.6 retention).
- **P10.5 Published, reproducible benchmark repo** — saturated-queue
  methodology, p50/p95/p99 `schedule_to_start` + throughput, disclosed
  hardware/config. Calibrate claims against River's ~66k jobs/s reference.
  Trust signal for the infra audience (closes P5.6).
- **P10.6 Safe workflow versioning ergonomics** — lean into the wedge. Today:
  content-hash pinning + `doctor` drift warning. Add explicit version routing
  (run old in-flight on old logic, new on new) and a documented
  evolve-safely guide. Turn "no determinism tax" from an accident into a
  marketed, tooled guarantee.

---

## 5b. Phase 11 — Drop-in Migration & Modular Packaging (the adoption multiplier)

> **Goal:** (a) an existing Express/Fastify app moves to ZenZip with *near-zero*
> diff and keeps its performance, and (b) ZenZip stops being one fat dependency
> — it becomes a set of small libraries you install only as needed, usable
> standalone inside *other* projects. Lowers both the switching cost and the
> install/footprint cost.

### Why this wins
Two friction points block adoption today: "I already have an Express/Fastify
app — porting is a rewrite" and "installing `zenzip` pulls the whole world
(HTTP + queues + workflows + LLM providers + native addon) even if I only want
durable workflows." Phase 11 removes both. The pitch becomes: **"Point your
existing app at ZenZip and it just runs — then add only the pieces you want."**

### 11A. Express drop-in migration
- **P11.1 Express compat entrypoint.** Ship `@zenzip/http` exporting an
  Express-shaped default: `import express from "@zenzip/http"` (or `zenzip/express`)
  is a one-line import swap. The existing P8 layer (middleware chain, Router,
  `(req,res,next)`, `res.json/send/...`, built-ins) is already ~Express; close
  the remaining gaps so common apps run unmodified.
- **P11.2 Express API surface audit + shims.** Enumerate the real Express
  surface apps depend on (`app.set`/`app.locals`, `res.render`/view engines,
  `req.cookies`, `express.static` parity, `app.engine`, mount events, sub-app
  mounting) and either implement or explicitly document as unsupported. A
  compatibility matrix page is the deliverable — "familiar, not 100% spec" still
  holds, but the *list* must be honest.
- **P11.3 `zenzip migrate` codemod.** A CLI command that rewrites imports
  (`express` → `@zenzip/http`), flags unsupported API usage with file:line, and
  prints a migration report. Static, reversible, no behavior change beyond the
  import.
- **P11.4 Performance parity gate.** A benchmark proving a migrated Express app
  matches or beats the original (the layer is sugar over `node:http`, so the
  ceiling is the same — *prove it*, don't assert it). p50/p99 + throughput on
  the same routes, published. Migration must not cost performance; durability is
  opt-in on top.

### 11B. Fastify migration
- **P11.5 Fastify adapter + guide.** Fastify's plugin/encapsulation/schema model
  is not Express-shaped, so a true drop-in is harder. Ship `@zenzip/fastify`:
  (a) mount a ZenZip app inside Fastify (`fastify.register(zenzipPlugin)`), and
  (b) call `app.queue/workflow/agent` from Fastify handlers. Document the
  "run Fastify for HTTP, ZenZip for durability" path as the supported migration —
  full Fastify→ZenZip HTTP port is a non-goal (respect their ecosystem).

### 11C. Modular package architecture (un-bundle the monolith)
- **P11.6 Split `zenzip` into a workspace of focused packages.** Today one
  package ships everything. Re-cut along capability seams, each independently
  installable:
  - `@zenzip/core-native` — the Rust addon (engine binding). *exists*
  - `@zenzip/core` — durable engine: queues, workflows, scheduler, events,
    state machines, store, retention/GC, health. The crash-proof substrate.
  - `@zenzip/http` — Express-style HTTP, middleware, Router, adapters
    (depends on `@zenzip/core`).
  - `@zenzip/ai` — agents + LLM providers + MCP (consume/author) + memory tiers
    + evals (depends on `@zenzip/core`; **not** on `@zenzip/http`).
  - `@zenzip/realtime` — the WebSocket layer (Phase 12; depends core + http).
  - `@zenzip/testing` — test kit. *exists as a subpath today*
  - `zenzip` — **meta-package** that re-exports all of the above, so today's
    single `import { zenzip } from "zenzip"` keeps working (back-compat,
    zero-break). Installing the meta-package pulls everything; installing a
    sub-package pulls only its slice.
- **P11.7 Dependency-graph discipline.** Enforce the layering (`core` has no
  HTTP/LLM deps; `ai` has no HTTP dep; native addon is a peer/optional) with a
  CI check, so a workflows-only user never downloads LLM SDKs or the HTTP layer.
  The native addon stays a single shared dependency across packages.
- **P11.8 Versioning + release.** All `@zenzip/*` packages version in lockstep
  (changesets fixed group, already configured) so cross-package compatibility is
  trivial; the meta-package pins exact sub-versions.

### 11D. CLI capability-based setup
- **P11.9 `create-zenzip-app` capability prompt.** On init, ask which
  capabilities the project needs — **HTTP/Express**, **Queues**, **Workflows**,
  **AI Agents**, **Realtime/WebSocket** — and install *only* the matching
  `@zenzip/*` packages, scaffolding a template wired for that subset. Minimal
  projects start tiny; capabilities are `npm i @zenzip/ai` away later. Replaces
  the all-or-nothing template set with a composable one.
- **P11.10 `zenzip add <capability>`.** A CLI helper that installs the right
  package(s) and prints the wiring snippet, so growing a project mid-stream is
  one command (mirrors the init prompt).

### 11E. Embed ZenZip libraries in other projects
- **P11.11 Standalone usage docs + guarantees.** Each sub-package must be usable
  *inside someone else's app* with no ZenZip HTTP server required: e.g. drop
  `@zenzip/ai` into an existing Next.js/Express/Fastify app for durable agents,
  or `@zenzip/core` for durable workflows behind your own HTTP. Document the
  minimal bootstrap per package (start the engine, no `app.listen`), the
  lifecycle (start/stop), and the data-dir/store config. This is the
  "ZenZip as a library, not a framework" mode — a major reach expansion.

---

## 5c. Phase 12 — Realtime / WebSocket Layer (build socket apps on a durable core)

> **Goal:** first-class, horizontally-scalable WebSocket support so users build
> socket-based applications (chat, presence, live dashboards, collaborative
> apps, game lobbies) on ZenZip — with the durable engine and *zero extra infra*
> for multi-node fan-out.

### Why this wins
The realtime/socket space forces a Redis (or dedicated pub/sub) dependency for
multi-node fan-out (Socket.IO Redis adapter, etc.). ZenZip already runs a
cross-node backplane — **Postgres `LISTEN/NOTIFY`** (used for queue wakeups) —
so it can offer scalable WebSockets **with no Redis**, matching the framework's
"zero extra infrastructure" promise. Combined with `app.subscribe()` (P9.4),
socket clients get durable run/agent streaming for free.

- **P12.1 WebSocket server.** `@zenzip/realtime`: `app.ws(path, handler)` over
  the existing `node:http` upgrade (consistent with D5 — HTTP/WS stay a Node
  adapter, never moved into the Rust core). Connection lifecycle, message
  framing, heartbeats/ping-pong, graceful close on `app.stop()`.
- **P12.2 Rooms + pub/sub.** `socket.join(room)`, `app.broadcast(room, msg)`,
  channel subscriptions — the Socket.IO mental model, no new vocabulary.
- **P12.3 Multi-node fan-out with no extra infra.** Cross-node broadcast rides
  **Postgres LISTEN/NOTIFY** (sqlite single-node = in-process; postgres =
  cluster-wide), reusing the existing backplane. Pluggable adapter interface so
  a Redis/NATS backplane can be swapped in for very high fan-out (opt-in, not
  required).
- **P12.4 Socket ↔ durability bridge.** Socket events can `trigger`/`emit`
  durable work; `app.subscribe(runId)` (P9.4) and agent token streams pipe
  straight to sockets — one line to stream a durable agent's tokens to a
  browser. This is the differentiator: realtime *and* crash-proof.
- **P12.5 Presence, auth, backpressure.** Presence tracking per room, a
  connection-auth hook (token/handshake), and per-socket send backpressure so a
  slow client can't bloat memory. Reuse the P7.8 admission-control thinking.
- **P12.6 Performance + scale proof.** Pick the socket engine deliberately
  (`ws` for portability vs `uWebSockets.js` for throughput — benchmark, then
  decide, like D5 did for HTTP). Publish connection-count + message-rate
  benchmarks with the LISTEN/NOTIFY backplane; disclose the fan-out ceiling and
  when to switch to a dedicated adapter.
- **P12.7 Client SDK (thin).** A small browser/Node client for connect +
  room + subscribe + reconnect-with-backoff, so the frontend story is complete
  (parity with Socket.IO client ergonomics).

> **Design rule (extends D5):** WebSockets are a Node adapter on `node:http`
> upgrade. The Rust core never owns the socket; it owns durability. The backplane
> reuses Postgres — no mandatory Redis.

---

## 5d. Additional production-readiness gaps (Phases 13–16)

> Gap analysis: what a team needs to run ZenZip in production **beyond** Phases
> 7–12. Phase 7 hardens the *engine*; these harden the *application and the
> operation around it* — app security, ops tooling, bounded reliability, and
> deployment. Each item cross-references related work; most land naturally in
> the Phase 11 package seams (`@zenzip/http`, `@zenzip/core`). Honest framing:
> these are real "production-ready" requirements that the current plan does not
> yet cover. Prioritize by user demand — none is a v1.0 blocker, but several
> (auth, validation, timeouts, graceful HTTP drain, Docker) are early asks.

### Phase 13 — Application security, auth & validation (the *app*, not just the dashboard)
Today only the dashboard has a token; an app built on ZenZip has no first-class
auth/validation story. That is the biggest production gap after Phase 7.
- **P13.1 App auth primitives.** API keys, JWT/session middleware, `zenzip.auth()`
  + route guards, and an OIDC/SSO helper (for both the app and the dashboard).
  Composable, opt-in middleware — not baked into the engine.
- **P13.2 Request validation.** Per-route schema for body/query/params via
  Standard Schema (reuse the queue/agent validation mechanism); auto-`400` on
  invalid input, typed handlers. Validation is table-stakes for any HTTP API.
- **P13.3 Security headers + CSRF + proxy.** Built-in `zenzip.secureHeaders()`
  (helmet-equivalent: HSTS, CSP, X-Frame-Options, etc.), CSRF token middleware,
  and `trust proxy` handling so client IP / protocol are correct behind LBs.
- **P13.4 HTTP rate limiting + abuse guards.** Per-IP/key limiter middleware
  (distinct from the *queue* rate limit), plus max-body-size, header limits, and
  request timeout to blunt slow-loris / payload-bomb basics.
- **P13.5 Secrets & config hardening.** Load `encryptionKey`/tokens from
  env/KMS (never code), validate config at boot (fail fast on misconfig), and
  redact secrets from logs. Pairs with P7.15.
- **P13.6 Audit log.** Append-only record of privileged actions
  (trigger / cancel / approve / requeue, dashboard logins): who, what, when —
  queryable. Required for any regulated deployment.

### Phase 14 — Operations, control plane & data governance
- **P14.1 Control-plane API + CLI.** Pause / resume / drain a queue, bulk
  cancel-by-filter, bulk requeue / purge DLQ — programmatic, in `zenzip` CLI,
  and as dashboard actions. Today there is only single-queue requeue-dead.
- **P14.2 Alerting hooks.** Emit on DLQ growth / stuck runs (P7.10) /
  readiness-fail / lease-storm → webhook / Slack / PagerDuty; a first-class
  Sentry error-tracking integration. Operators need to be paged, not to poll.
- **P14.3 Backup / restore / DR.** Documented snapshot+restore (SQLite file;
  Postgres `pg_dump` + PITR guidance) and a **tested SQLite↔Postgres data
  migration tool** (promote from backlog) so teams can start embedded and grow.
- **P14.4 Config management.** A typed config surface with env binding +
  boot-time validation, full config documentation, and hot-reload of
  safe-to-change settings (log level, retention windows) without a restart.
- **P14.5 Multi-tenancy / namespaces.** Tenant-scoped queues / runs / data +
  tenant-scoped RBAC, so one deployment serves many tenants with isolation
  (pairs with P10.3 fairness). The SaaS-on-ZenZip enabler.
- **P14.6 Data governance / PII.** Purge-by-subject (delete a user's
  runs / steps / events / payloads + offloaded blobs), data export, and
  per-tenant retention — turning encryption (P7.15) + retention (P7.6) into a
  GDPR/CCPA "right to be forgotten" story.

### Phase 15 — Reliability completeness (bound everything, fail fast)
- **P15.1 Timeouts everywhere.** Per-`step.run` timeout, agent-tool timeout,
  HTTP request timeout, LLM-call timeout — no unbounded `await` can wedge a
  worker slot indefinitely. Today only lease expiry recovers a stuck attempt;
  a per-effect timeout fails fast and frees the slot.
- **P15.2 Circuit breakers + bulkheads.** For external calls (LLM providers,
  agent HTTP tools, webhooks): trip on sustained failure, shed load, and isolate
  a failing dependency so it can't starve healthy queues.
- **P15.3 HTTP graceful drain.** On `stop()`, stop accepting new connections and
  drain in-flight HTTP requests within a deadline (complements the queue drain in
  P7.7) — the other half of true zero-downtime deploys.
- **P15.4 Postgres resilience.** Statement timeouts, pool-sizing guidance, and
  reconnect/failover handling (re-establish the pool on PG restart/failover),
  with a defined "PG unreachable" degradation behavior.
- **P15.5 Poison-message handling.** Distinguish a payload that crashes the
  worker *every* time from a transient error, and quarantine it (straight to DLQ
  with a poison marker) instead of burning the queue on infinite redelivery.

### Phase 16 — Deployment & ecosystem (trivial to run + integrate)
- **P16.1 Official container images.** Minimal multi-stage Dockerfile (incl.
  musl/Alpine, P7.19), published images, and a `docker-compose` for dev
  (app + Postgres). "Works in a container" is the first thing ops checks.
- **P16.2 Orchestrator recipes.** Helm chart + k8s manifests with `/healthz`
  /`/readyz` probes (P7.7) wired and HPA signals (P7.2 metrics); one-click
  templates for Fly / Railway / Render / ECS; a Lambda/serverless recipe
  (pairs with P7.21).
- **P16.3 Multi-core on one host.** Support + document Node `cluster` (several
  worker processes on one machine sharing the store) and the WAL-contention
  ceiling → when to graduate to Postgres. Closes the open 4-process bench item.
- **P16.4 Integrations.** Log-shipping adapters (pino/winston transports), error
  tracking (Sentry), Prometheus scrape (P7.2), and an outbound webhooks/events
  bridge to external systems.
- **P16.5 DX completeness.** A typed error envelope + error→HTTP mapping,
  OpenAPI generation from routes + schemas, multipart/file-upload middleware,
  and a production-starter template + examples gallery.

> **Anti-scope reminders for 13–16:** no hosted cloud, no multi-region/geo
> replication, no custom consensus (Postgres remains the multi-node story).
> Auth/validation/headers ship as composable middleware in `@zenzip/http`, never
> in the engine. Multi-tenancy is namespacing on the existing store, not a new
> data plane.

---

## 6. Sequencing & rationale

```
Phase 7  Production Hardening   ← gates the "1.0 / production-ready" claim. Do first.
  └ 7A Observability, 7B Ops (retention!), 7C Reliability, 7D Security, 7E Packaging
Phase 8  Express DX Layer       ← parallelizable with 7; the adoption wedge. Ship for launch.
Phase 9  AI-Native Depth        ← the standout story; sequence after 7 so it's durable+observable.
Phase 10 Flow Control & Scale   ← closes the last table-stakes parity gap + scale proof.
Phase 11 Migration & Modularity ← post-1.0 (v1.1): adoption multiplier — drop-in port + un-bundle.
Phase 12 Realtime / WebSocket   ← post-1.0 (v1.1+): new app class (sockets) on the durable core.
Phase 13 App Security & Auth    ← gap-analysis (§5d): demand-driven; auth/validation often an early ask.
Phase 14 Ops & Data Governance  ← gap-analysis: control plane, alerting, backup/DR, multi-tenancy, PII.
Phase 15 Reliability Complete   ← gap-analysis: timeouts, circuit breakers, HTTP drain, PG failover.
Phase 16 Deployment & Ecosystem ← gap-analysis: Docker/Helm/recipes, clustering, integrations, OpenAPI.
```

Phases 13–16 are not strictly ordered — they are a backlog of production
requirements pulled by real usage. Likely first-pulled: P13.1/13.2 (app auth +
request validation), P15.1/15.3 (timeouts + HTTP drain), P16.1 (Docker image).

**Implementation status (updated):**
- **Phase 8 — COMPLETE** (middleware, dual-sig, Router, built-ins incl. static,
  node + fetch adapters, migration guides). Remaining sugar: dedicated
  Fastify-plugin / Hono / Nest wrappers (universal `toNodeHandler`/`toFetchHandler`
  already cover them).
- **Phase 7 — SHIPPED:** 7.6 retention/GC, 7.7 health, 7.8 backpressure, 7.10
  orphaned-runs, 7.11 fencing tokens, 7.13 idempotency, 7.14 fault-injection,
  7.16 SSRF, 7.17 RBAC. **REMAINING:** 7.1–7.5 (OTel/observability), 7.9
  (migration discipline), 7.12 (clock-skew), 7.15 (payload encryption), 7.18
  (SLSA/supply-chain), 7.19–7.21 (packaging: prebuild matrix/musl, WASM, docs).
- **Phase 9 — SHIPPED:** 9.1 payload offload, 9.2 MCP (consume + author), 9.4
  realtime subscription. **REMAINING:** 9.3 memory, 9.5 evals, 9.6 networks,
  9.7 cost-tables.
- **Phase 10 — SHIPPED:** 10.1 per-key concurrency. **REMAINING:** 10.2
  throttle/debounce, 10.3 priority/fairness, 10.4 PG partitioning, 10.5
  benchmark repo, 10.6 versioning ergonomics.
- **Phases 11, 12, 13, 14, 15, 16 — NOT STARTED** (all open; 11–12 net-new from
  the prior revision, 13–16 are the §5d gap-analysis backlog).

- **7 before everything** because "production-ready" is a claim you can't make
  without OTel, retention/GC, encryption, and signed releases — and they're
  table-stakes, not differentiators. Retention/GC (P7.6) is the most urgent:
  it's a *correctness-over-time* bug today, not a feature.
- **8 in parallel** — pure DX layer over the existing HTTP adapter, no engine
  risk, and it's the single biggest adoption lever (zero-new-concepts on-ramp).
- **9 is the headline** but only credible once runs are observable (7A) and
  retained sanely (7B) — a durable agent you can't trace or whose journal grows
  unbounded isn't a story.
- **10 last** — the concurrency-key gap is real but it's catch-up to Inngest;
  do it once the differentiators (8, 9) are landing.
- **11 after 1.0** — drop-in migration and un-bundling are adoption multipliers,
  not 1.0 blockers. The modular split (P11.6) is the load-bearing prerequisite
  for both "install only what you need" and "embed ZenZip in another app"; do it
  before the migration codemod so `@zenzip/http` is the migration target.
- **12 after the split** — `@zenzip/realtime` is a new package that depends on
  the Phase 11 package boundaries; build it once those seams exist. WebSockets
  are a new *application class*, additive — never on the 1.0 critical path.

### v1.0 "definition of done"
Phase 7 complete **+** Phase 8 Express parity shipped **+** at least
P9.1 (payloads), P9.2 (MCP), P9.4 (realtime) from the AI story **+** P10.1
(per-key concurrency) **+** a real first npm release with prebuilds.
External beta users running real workloads.

---

## 7. Marketing one-liner (post-plan)

> **ZenZip — durable backends without the tax.**
> Queues, workflows, and AI agents that survive `kill -9`, on zero
> infrastructure. It's Express — with durability built in. No Redis, no Temporal
> cluster, no determinism rules, no vendor lock-in.

---

## 8. Anti-scope (hold the line — consistent with plan.md)

- **No Rust HTTP server.** D5 settled by benchmark. The Express layer is sugar
  over `node:http`; it never moves HTTP into the core.
- **No strict-replay determinism model.** Step memoization is the moat — never
  trade it for "more Temporal-like."
- **No custom distributed consensus.** Postgres remains the multi-node story.
- **No hosted cloud before OSS adoption.** Cloud is the eventual business model
  (the Inngest/Trigger playbook) — earn the community first.
- **Don't let Phase 9 (AI) bloat the core.** MCP/memory/evals ship as
  composable modules on the agent engine, not engine rewrites.
- **Express compatibility is "familiar," not "100% spec."** Match the API
  shape and muscle memory; do not promise drop-in compatibility with every
  Express middleware that pokes at internals.
- **Modular split keeps `zenzip` working.** The meta-package re-exports every
  sub-package — un-bundling must be a non-breaking change for existing imports.
- **WebSockets stay a Node adapter (extends D5).** The Rust core never owns the
  socket. Multi-node fan-out reuses Postgres LISTEN/NOTIFY — no mandatory Redis.
- **Migration never costs performance.** A ported Express app must match or beat
  the original (P11.4); durability is opt-in on top, not a tax on the HTTP path.

---

## 9. Documentation plan (keep docs in lockstep with features)

Docs live in `docs/app/docs/*/page.tsx` (Next.js site) with the nav in
`docs/lib/docs-nav.ts`; the roadmap page mirrors phase status. **Rule: every
shipped feature updates its doc page + the roadmap item in the same change**
(this cycle already did so for Phases 7–9). Outstanding + upcoming doc work:

**Backfill / polish (shipped features):**
- Observability page once 7A lands (OTel/Prometheus/trace-context).
- Security page: encryption-at-rest + SSRF allowlist when 7D lands; RBAC is done.
- Realtime: promote `app.subscribe()` from the Workflows page into a dedicated
  **Realtime** page; add LLM-token-streaming example.
- AI depth: expand the Agents page as 9.3 memory / 9.5 evals / 9.6 networks /
  9.7 cost-tables land; cost/dollar accounting screenshot in the dashboard page.

**New pages for Phases 11–12:**
- **"Migrating from Express"** — import-swap, the `zenzip migrate` codemod, the
  compatibility matrix (P11.2), and the performance-parity benchmark (P11.4).
- **"Migrating from Fastify"** — the adapter/plugin path and its boundaries.
- **"Packages & modularity"** — the `@zenzip/*` map, dependency graph, the
  capability-based `create-zenzip-app` flow, `zenzip add`, and **"ZenZip as a
  library"** (embedding `@zenzip/ai` / `@zenzip/core` in an existing app).
- **"Realtime & WebSockets"** — `app.ws`, rooms/broadcast, the LISTEN/NOTIFY
  backplane + multi-node story, socket↔durability bridge, the client SDK,
  and the scale benchmark.
- Update **Getting Started / Quickstart** for the capability-prompt init flow,
  and **Comparisons** for the realtime + migration positioning.

**New pages for Phases 13–16 (production operations):**
- **"Authentication & validation"** — `zenzip.auth()`, route guards, JWT/API
  keys/OIDC, per-route schema validation, security headers, CSRF, HTTP rate
  limiting (P13).
- **"Operations"** — control-plane API/CLI, alerting hooks, backup/restore/DR,
  config management, multi-tenancy, PII purge/export (P14).
- **"Reliability"** — timeouts, circuit breakers, graceful HTTP drain, Postgres
  failover, poison-message handling (P15).
- **"Deploying ZenZip"** — Docker/compose, Helm/k8s probes, platform recipes
  (Fly/Railway/Render/ECS/Lambda), multi-core clustering, integrations (P16).

**Cross-cutting:**
- A **migration table** (Express/Fastify/BullMQ/Inngest/Temporal → ZenZip) as a
  single reference (extends the existing `/docs/migrating` page).
- Keep the **roadmap page** phase blocks (7–12) as the canonical status surface.

---

## 10. Execution order — remaining tasks (sequenced backlog)

Ordered by: (1) what gates the v1.0 cut, (2) hard dependencies, (3) value/effort.
**Already shipped** (skip): all of Phase 8; P7.6, 7.7, 7.8, 7.10, 7.11, 7.13,
7.14, 7.17; P9.1, 9.2, 9.4. Everything below is open, in the order to build it.

### Milestone A — Close the v1.0 gate (finish Phase 7 + P10.1 + first release)
Nothing ships as "1.0" until this milestone is done.
1. **P7.19 + P7.20 + P7.21 — packaging.** Full prebuild matrix (incl. musl),
   WASM/WASI fallback, bundler/serverless docs. *First* — it unblocks the npm
   release **and** the Docker work (P16.1), and de-risks installs early.
2. **P7.15 — payload encryption at rest.** Opt-in `encryptionKey`; encrypt
   job/run/step/event payloads. ⚠ Design constraint: event payloads are read by
   the `waitForEvent` match predicate — encrypt selectively or add a plaintext
   match index. Highest-value security item.
3. **P7.16 — SSRF allowlist.** Guard every user-controlled-URL fetch (agent HTTP
   tools, webhook fetch, blob fetch). Build the resolve-then-validate helper now;
   wire it into agent tools.
4. **P7.1–P7.5 — observability / OTel (7A).** Spans at step boundaries (not
   replayed code), canonical metrics + Prometheus `/metrics`, trace-context
   propagation, structured logs w/ trace ids, GenAI semconv. Largest chunk;
   credibility-critical. (Heavy dep tree — was deferred; now required for 1.0.)
5. **P7.12 — clock-skew handling.** Bound max skew / HLC for multi-node PG
   ordering decisions.
6. **P7.9 — expand/contract migration discipline.** Policy + CI check that schema
   changes keep old/new workers interoperable. Mostly docs + a lint/CI gate.
7. **P7.18 — supply chain (SLSA L2).** Sigstore signing, SBOM, provenance,
   `cargo audit` + `npm audit` in CI. Release-pipeline work.
8. **P10.1 — per-key / per-tenant concurrency.** The one flow-control item in the
   DoD. `concurrency: { limit, key }` for queues/workflows/agents (engine-side).
9. **First npm release w/ prebuilds.** Tag, `NPM_TOKEN`, flip `private:false`,
   publish-provenance. The actual v1.0 cut. → **v1.0 DONE.**

### Milestone B — Differentiator depth (rest of Phase 9 + rest of Phase 10)
10. **P9.7 — provider breadth + cost tables.** Google/Bedrock adapters +
    per-model pricing → dollar accounting in the dashboard. Small, high-visibility;
    do first in this milestone.
11. **P9.3 — tiered agent memory.** Working memory + observational compression
    first; semantic recall needs the embedded vector store (ties to backlog).
12. **P9.5 — built-in evals.** `app.eval(...)` as durable workflows + dashboard.
13. **P9.6 — multi-agent networks.** Network routing (deterministic + LLM) with
    shared typed state, on the durable substrate.
14. **P10.2 — throttling & debouncing** (engine-side, Inngest parity).
15. **P10.3 — priority + fairness queues** across tenants.
16. **P10.4 — Postgres partitioning + index-only dequeue.** Pairs with P7.6;
    the scale-ceiling lift.
17. **P10.5 — published benchmark repo.** Reproducible p50/p95/p99 + throughput.
18. **P10.6 — safe versioning ergonomics.** Explicit version routing + guide.

### Milestone C — Modular split (Phase 11; prerequisite for 12 + ecosystem)
19. **P11.6 — split into `@zenzip/*` packages.** Load-bearing; do *first* in 11.
    `core-native` / `core` / `http` / `ai` / `testing` + the `zenzip`
    meta-package (non-breaking re-export).
20. **P11.7 + P11.8 — dep-graph CI check + lockstep versioning.**
21. **P11.1–P11.4 — Express drop-in.** `@zenzip/http` compat entry, API-surface
    audit + shims, `zenzip migrate` codemod, performance-parity benchmark.
22. **P11.5 — Fastify adapter + guide.**
23. **P11.9 + P11.10 — CLI capability prompt + `zenzip add`.**
24. **P11.11 — "ZenZip as a library" standalone-usage docs.**

### Milestone D — Realtime / WebSocket (Phase 12; after the split)
25. **P12.1 → P12.2 → P12.3** — `app.ws` server, rooms/broadcast, then multi-node
    fan-out over Postgres LISTEN/NOTIFY (the no-Redis differentiator).
26. **P12.4** — socket ↔ durability bridge (pipe `app.subscribe` + agent tokens).
27. **P12.5 → P12.6 → P12.7** — presence/auth/backpressure, scale benchmark +
    engine choice (`ws` vs `uWebSockets.js`), thin client SDK.

### Milestone E — Production-ops backlog (Phases 13–16; demand-pulled)
Order within is by likely first-asked; pull forward on real user need.
28. **P13.2 — request validation** (small, high value) → **P13.1 — app auth** →
    **P13.3 — security headers/CSRF/proxy** → **P13.4 — HTTP rate limiting**.
29. **P15.1 — timeouts everywhere** → **P15.3 — HTTP graceful drain** (the two
    most-requested reliability gaps).
30. **P16.1 — Docker images + compose** (first ops ask once installable).
31. **P13.5 — secrets/config hardening** + **P13.6 — audit log**.
32. **P14.1 — control-plane API/CLI** + **P14.2 — alerting hooks**.
33. **P15.2 — circuit breakers** + **P15.4 — PG resilience** + **P15.5 — poison
    messages**.
34. **P16.2 — orchestrator recipes** + **P16.3 — clustering** + **P16.4 —
    integrations** + **P16.5 — DX completeness** (typed errors, OpenAPI, uploads).
35. **P14.3 — backup/DR + SQLite↔PG migration** → **P14.4 — config mgmt** →
    **P14.5 — multi-tenancy** → **P14.6 — PII purge/export**.

> **Per-task definition of done (every item above):** code + tests (Rust `cargo
> test` and/or TS vitest) green, typecheck + build clean, the matching doc page
> updated, and the roadmap phase item flipped — in the same change. This is the
> rhythm the current cycle already follows.
