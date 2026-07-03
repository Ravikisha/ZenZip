<div align="center">

<img src="docs/public/logo.png" alt="ZenZip" width="128" height="128" />

# ZenZip

**The agent-native backend framework for Node.js.**

Durable workflows, queues, schedules, events, state machines, and AI agents
on a single Rust-powered runtime — with **zero infrastructure**.

No Redis. No Temporal cluster. No RabbitMQ. No cron box.
`npm install` is the entire setup.

[![npm](https://img.shields.io/npm/v/zenzipjs.svg)](https://www.npmjs.com/package/zenzipjs)
[![npm downloads](https://img.shields.io/npm/dm/zenzipjs.svg)](https://www.npmjs.com/package/zenzipjs)
[![license](https://img.shields.io/npm/l/zenzipjs.svg)](LICENSE)
[![CI](https://github.com/Ravikisha/ZenZip/actions/workflows/ci.yml/badge.svg)](https://github.com/Ravikisha/ZenZip/actions/workflows/ci.yml)

[**Docs**](https://zenzip.vercel.app) · [**Quickstart**](https://zenzip.vercel.app/docs/quickstart) · [**Benchmarks**](https://zenzip.vercel.app/docs/benchmarks) · [**Roadmap**](https://zenzip.vercel.app/docs/roadmap)

```bash
# scaffold a new project (recommended)
npm create zenzipjs-app@latest my-app

# or add to an existing project
npm install zenzipjs
```

*Status: pre-1.0, built in the open. **230+ tests green** (179 TypeScript + 54 Rust),
including SIGKILL crash-injection and multi-node Postgres chaos.*

</div>

> **Package name:** ZenZip publishes to npm as **`zenzipjs`** — the `zenzip` name is
> reserved on the registry. The import and public API are still `zenzip`
> (`import { zenzip } from "zenzipjs"`).

---

## Why ZenZip

A typical production Node backend accumulates this stack:

| You operate today | ZenZip replaces it with |
|---|---|
| BullMQ + Redis | `app.queue()` |
| Temporal / a workflow cluster | `app.workflow()` |
| node-cron on a pet server | `app.schedule()` |
| RabbitMQ / SNS / SQS | `app.emit()` + `on:` triggers |
| LangGraph + custom glue | `app.agent()` |
| Express + middleware stack | `app.use()` / `app.get()` (Express-compatible) |
| Hand-assembled Grafana | `app.dashboard()` |

Each piece works. Together they are six services to provision, secure, monitor,
and pay for — before you write a line of business logic. ZenZip embeds the
runtime in your process the way **SQLite replaced "install a database server"**:
state lives in one SQLite file in your project folder. Need horizontal scale
later? Point the same API at Postgres with one config line.

> **Speed is not the pitch — durability is.** We benchmarked our own Rust HTTP
> server idea against Fastify and *killed it* when the numbers said no. What
> Rust buys here is an engine where timers, leases, retries, and crash recovery
> never depend on your event loop being alive. (The HTTP layer is still
> [~2× Express and on par with Fastify](#benchmarks) — see below.)

## Sixty seconds of ZenZip

```ts
import { zenzip, tool, anthropic } from "zenzipjs";

const app = zenzip(); // embedded SQLite store, zero config

// ── Durable queue: throw = retry with backoff → dead-letter queue ─────────
const emails = app.queue("emails", {
  concurrency: { limit: 5, key: (d) => d.tenantId }, // per-tenant fairness
  retries: 5,
});
emails.process(async (job) => smtp.send(job.data));

// ── Persisted schedule: survives restarts, timezone-aware ─────────────────
app.schedule("digest", { cron: "0 9 * * *", timezone: "Asia/Kolkata" }, async () => {
  await emails.push({ to: "everyone@app.io", subject: "Daily digest" });
});

// ── Durable workflow: every step journaled; kill -9 is a test case ────────
const order = app.workflow("order", async ({ step, input }) => {
  const payment = await step.run("charge", () => stripe.charge(input));
  await step.sleep("cooloff", "10m");                          // zero resources held
  const ok = await step.waitForEvent("approved", "order.approved", {
    timeout: "1h",
    match: { orderId: input.orderId },                          // wake THIS run only
  });
  await step.run("ship", () => shipping.create(payment));       // memoized forever
  return { shipped: !!ok };
});

// ── Durable agent: every LLM call + tool execution is a journaled step ────
const support = app.agent("support", {
  provider: anthropic(),            // or openaiCompatible() / mockProvider()
  model: "claude-sonnet-4-6",
  instructions: "You are a support agent.",
  tools: [
    tool({
      name: "send_refund",
      description: "Refund an order",
      parameters: { type: "object", properties: { orderId: { type: "string" } } },
      requiresApproval: true,       // durable human-in-the-loop pause
      execute: ({ orderId }) => payments.refund(orderId),
    }),
  ],
});

await app.start();
await app.dashboard();              // live observability at :4100

await order.trigger({ orderId: "o_42" }, { idempotencyKey: "o_42" });
const reply = await support.run("My order is late!", { sessionId: "cus_7" });
```

**Kill the process anywhere in there** — jobs redeliver, the sleeping workflow
wakes on schedule in the new process, the agent resumes mid-conversation
without re-calling the model for completed steps.

## What makes it different

- **One engine, every primitive.** A queue job is leased retryable work; a
  schedule fires onto a hidden queue; a workflow run is a job whose handler
  drives a step journal; an agent is a workflow with dynamically-generated
  steps. Crash recovery is implemented **once** and inherited everywhere.
- **Step memoization, not replay.** The Inngest model, not Temporal's — there
  are *no determinism rules outside steps*. Write normal code; only `step.run`
  boundaries are journaled. A retried attempt fast-forwards over completed
  steps instead of re-executing them.
- **Durable AI agents that don't re-bill you.** When a tool fails and the loop
  retries, the LLM is **not re-prompted** for already-completed steps — asserted
  by a test that fails a tool twice and proves the model is called exactly twice.
- **Zero infrastructure → Postgres with one line.** Embedded SQLite (WAL) by
  default; flip to `{ store: { driver: "postgres", url } }` for multi-node. Same
  API, same semantics.

## Features

### Core durability
- **Queues** — at-least-once delivery, leases + fencing tokens, exponential
  backoff + jitter, priorities, delays, batch consumers, dead-letter queue with
  one-call requeue/purge, graceful drain.
- **Flow control** — per-key / per-tenant concurrency limits, round-robin
  **fairness** across keys, **debounce** (collapse rapid same-key pushes),
  **throttle** (smooth starts to a steady per-key rate), token-bucket rate
  limits, and **backpressure** (bounded enqueue / admission control).
- **Schedules** — cron + intervals, IANA timezones, persisted next-fire, overlap
  policies (skip/queue/allow), missed-tick catch-up (skip/runOnce/all), jitter.
- **Workflows** — step-memoized durable execution: `step.run` (with per-step
  timeout), `step.sleep`, `step.waitForEvent` (+ match predicates), `step.invoke`
  (child workflows), `step.all` (parallel, independently memoized), idempotency
  keys, cancellation trees, content-hash **version pinning + routing** so
  in-flight runs finish on old logic while new runs use new code.
- **Events** — atomic outbox: one transaction persists the event, wakes matching
  waiters, and creates `on:`-triggered runs. Wildcards (`user.*`, `billing.**`),
  ephemeral `app.on()` subscribers.
- **State machines** — persisted, transition-validated; transition + history +
  emitted event + triggered runs commit atomically.

### AI-native
- **Agents** — LLM loops compiled to dynamic workflow steps: tool failures retry
  **without re-prompting the model**, durable human-approval gates, structured
  output, streaming, token accounting + cost tables, per-agent **circuit
  breakers**. Providers: Anthropic, OpenAI-compatible, **Google Gemini**, **AWS
  Bedrock** (SigV4), and a scripted mock.
- **Multi-agent networks** — `app.network()` routes a request among N specialist
  agents via durable handoff child-workflows (1:N over the 1:1 `handoffTool`).
- **Tiered memory** — `AgentMemory`: semantic recall (embeddings + pluggable
  vector store) and working-memory compression for long sessions.
- **Built-in evals** — rule-based, statistical, and model-graded (`llmJudge`)
  evaluators + a suite runner to gate deploys and regression-test prompts.
- **MCP, both directions** — consume external MCP servers as agent tools
  (`mcp(url)`), and expose your workflows/agents *as* an MCP server
  (`app.mcpServer()`) for other agents to call.
- **Large-payload offload** — step results over a threshold are transparently
  written to a blob store and replaced in the journal by a reference; replay
  rehydrates the real value.

### HTTP & DX (the adoption wedge)
- **Express-compatible** — `app.use()` middleware (global / path-scoped / 4-arg
  error), `Router()` mounting, dual `(req,res,next)` **or** rich-`ctx` handlers
  chosen by arity, built-in middleware (`json`, `cors`, `logger`, `serveStatic`,
  `auth`, `validate`, `secureHeaders`, `rateLimit`). A **radix-tree router** and
  body-read fast path keep it fast (see [benchmarks](#benchmarks)).
- **Adapters** — `app.toNodeHandler()` to mount into any `node:http` server,
  `app.toFetchHandler()` for Next.js route handlers / Hono / Bun / Deno / edge.
- **Webhook → workflow** sugar: `{ http: "POST /hooks/stripe" }`.

### Operations & security
- **Embedded live dashboard** (SSE) — run timelines with step graphs, queue
  health + DLQ requeue, schedules, event feed, engine metrics; operator vs
  read-only **RBAC** tokens.
- **Retention + GC** — terminal runs/steps and old events are swept on a
  schedule so the store never grows unbounded (Postgres reclaims via partition
  drops, not row-by-row deletes).
- **Health** — `/healthz` (liveness, zero I/O) + `/readyz` (DB-checked
  readiness); orphaned-run detection.
- **Payload encryption at rest** — opt-in `encryptionKey` → AES-256-GCM on job
  payloads, run inputs/outputs, step results, and event payloads. Transparent to
  enable on an existing DB.
- **Hardening** — SSRF allowlists on user-controlled fetches, fencing tokens
  against zombie workers, clock-skew-safe leases on multi-node, realtime run
  subscription API, idempotency helpers, graceful HTTP drain, **CSRF**, secrets
  resolution (`env:`/`file:`) + redaction, typed error envelope.
- **Multi-tenancy + PII** — `app.namespace(tenantId)` for logical isolation;
  subject-tagged runs + `app.purgeSubject()` for GDPR erasure.
- **Alerting + integrations** — `alerts` hook on DLQ growth / stuck runs;
  pino/winston log transports + Sentry error reporting (`onError`,
  `captureErrors`).

### Multi-node
- **Postgres backend** — windowed/`SKIP LOCKED` claims, `LISTEN/NOTIFY`
  cross-node wakeups, advisory-lock scheduler election, lease-based dead-node
  recovery, event-outbox **range partitioning** for scale. Same API as embedded.

## Benchmarks

Same-machine numbers (i5-1135G7, Node 22) — **relative signals, not marketing
claims**. Reproduce with `pnpm bench:*`. Full methodology + caveats:
[Benchmarks](https://zenzip.vercel.app/docs/benchmarks).

**HTTP throughput — identical handlers, ZenZip vs Express 5 vs Fastify** (req/s, best-of):

| Scenario | Express 5 | Fastify | ZenZip | vs Express | vs Fastify |
|---|--:|--:|--:|--:|--:|
| `GET /` | 6,344 | 17,554 | **15,749** | 2.48× | 0.90× |
| `GET /json` | 6,144 | 16,527 | **15,002** | 2.44× | 0.91× |
| `GET /users/:id` | 5,977 | 16,600 | **16,216** | 2.71× | 0.98× |
| `POST /echo` | 4,724 | 8,787 | **8,441** | 1.79× | 0.96× |
| `GET /mw + CORS` | 6,266 | 16,615 | **13,932** | 2.22× | 0.84× |

ZenZip's HTTP layer is **1.8–2.7× Express** and **on par with Fastify** — even
though HTTP is a thin `node:http` adapter, not the product. You adopt ZenZip for
the durable engine; the adapter being this fast means migrating costs you
nothing on the request path. `pnpm bench:compare`.

**The engine, measured (these numbers shaped the design):**

| What | Result |
|---|---|
| JS→Rust sync call (push/emit/recordStep) | **14–34 ns** |
| JS→Rust **async** call (banned on hot paths) | 85 µs (~2,500×) |
| Rust→JS handler dispatch, pipelined ×256 | **408k/s** (2.4 µs amortized) |
| SQLite insert (1k/txn) | **209k jobs/s** |
| SQLite claim+ack (worst case, 2 commits/job) | 9.8k jobs/s |
| Postgres dequeue with priority index (80k-row queue) | **53.5 ms → 0.83 ms** (~60×) |

The async-NAPI measurement is why hot-path boundary calls are synchronous; the
HTTP measurement is why there is no Rust HTTP server.

## Reliability, tested

CI doesn't just unit-test — it **kills things**:

- a worker is **SIGKILLed mid-job** → the job redelivers with the attempt counted;
- a workflow worker is SIGKILLed at **four random points mid-run** and respawned
  → the run completes with the correct output and no lost or duplicated steps;
- a **3-node Postgres cluster** has a node hard-killed mid-burst → all jobs
  complete, duplicates bounded by the dead node's in-flight lease;
- two nodes share one schedule → ticks fire **exactly once**;
- a flaky agent tool fails twice → the LLM is called **exactly twice**, not four times;
- a `+1h`-skewed sweeper clock → **does not** expire a valid lease (clock-skew safety);
- a zombie worker's late write after lease loss → **rejected** by its stale fence;
- with `encryptionKey` set → the secret payload appears in **no** on-disk file.

Delivery semantics, versioning rules, and the idempotency guide:
[Durability & Semantics](https://zenzip.vercel.app/docs/durability).

## Architecture

```text
┌─────────────────────────────────────────────────────┐
│  TypeScript API  (npm: zenzipjs)                     │
│  queues · schedules · workflows · agents · events    │
│  machines · http/express · dashboard · MCP           │
└──────────────────────┬──────────────────────────────┘
                       │ napi-rs v3 — sync calls on hot paths (14–34 ns),
                       │ pipelined ThreadsafeFunction handler dispatch
┌──────────────────────▼──────────────────────────────┐
│  Rust core (own tokio runtime — your event loop      │
│  only ever runs YOUR handlers)                       │
│  queue engine · scheduler · workflow engine ·        │
│  event outbox · machines · sweepers · GC · metrics · │
│  AES-256-GCM payload crypto                          │
└──────────────────────┬──────────────────────────────┘
                       │ Store trait
        ┌──────────────┴───────────────┐
        ▼                              ▼
  SQLite (WAL)                  PostgreSQL
  embedded default              multi-node: SKIP LOCKED, LISTEN/NOTIFY,
  zero config                   advisory-lock election, range partitioning
```

Design decisions and architecture:
[Architecture](https://zenzip.vercel.app/docs/architecture).

## Documentation

The docs site (Next.js, in `docs/` — `npm run dev`) covers every feature:
introduction, quickstart, concepts, architecture, durability & semantics,
queues, schedules, workflows, agents, events, state machines, HTTP & dashboard,
Express & middleware, configuration, **production & deployment**, migrating from
Express/Fastify, comparisons, benchmarks, and the roadmap.

**Deploying?** See the [Production & Deployment guide](https://zenzip.vercel.app/docs/production)
and the reference `Dockerfile` + Kubernetes/Helm manifests in [`deploy/`](deploy/).

## Project status

| Phase | Scope | Status |
|---|---|---|
| 0 | NAPI boundary + storage benchmarks | ✅ |
| 1 | Queues, scheduler, runtime shell | ✅ |
| 2 | Durable workflow engine (flagship) | ✅ |
| 3 | Events, state machines, HTTP, dashboard | ✅ |
| 4 | Agent engine | ✅ |
| 5 | Postgres multi-node | ✅ |
| 7 | Production hardening (retention, health, fencing, clock-skew, SSRF, RBAC, **encryption at rest**, idempotency) | ✅ mostly |
| 8 | Express-native DX layer (middleware, routers, adapters) | ✅ |
| 9 | AI depth (large-payload offload, MCP both ways, realtime subscribe) | ✅ |
| 10 | Flow control & scale (per-key concurrency, fairness, debounce, throttle, PG partitioning, radix router, benchmarks) | ✅ |
| 6 / 11+ | Launch packaging, modular split, realtime/WebSocket layer | 🔜 |

Full roadmap: [Roadmap](https://zenzip.vercel.app/docs/roadmap).

## Repository layout

```text
crates/zenzip-core/     Rust engine: store trait, SQLite + Postgres impls,
                        queue/scheduler/workflow engines, event outbox, crypto
packages/core-native/   napi-rs bridge crate + npm package (@zenzipjs/core-native)
packages/zenzip/        Public TypeScript API (npm: zenzipjs)
bench/                  Reproducible benchmarks (boundary, sqlite, http, compare)
examples/               email-queue · demo-dashboard · support-agent
docs/                   Documentation site (Next.js)
```

## Development

Requires **Rust stable**, **Node 18+**, **pnpm**. Postgres tests need a server
(set `ZENZIP_PG_TEST_URL`; they skip otherwise).

```sh
pnpm install
pnpm build              # cargo + napi build (release) + TypeScript

cargo test --workspace            # Rust tests (incl. PG multi-node if reachable)
pnpm --filter zenzipjs test         # TypeScript tests (queues/workflows/agents/chaos/…)

pnpm bench:compare      # ZenZip vs Express vs Fastify, identical handlers
pnpm bench:boundary     # JS↔Rust call costs
pnpm bench:sqlite       # store throughput
pnpm bench:http         # the benchmark that killed our Rust HTTP server

pnpm --filter @zenzipjs/example-demo-dashboard start   # live dashboard demo
pnpm --filter @zenzipjs/example-support-agent start    # agent demo (offline mock;
                                                     # set ANTHROPIC_API_KEY for Claude)
```

Standing rules: CI green on win/mac/linux before merge; every feature lands with
tests (crash-safety where applicable) and docs; benchmark regressions >10% block
merge; the plan follows the code, never silently diverges.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Links

- 📚 **Documentation** — https://zenzip.vercel.app
- 🚀 **Quickstart** — https://zenzip.vercel.app/docs/quickstart
- 📦 **npm** — [`zenzipjs`](https://www.npmjs.com/package/zenzipjs) · scaffold: `npm create zenzipjs-app@latest`
- 🐙 **GitHub** — https://github.com/Ravikisha/ZenZip
- 🐛 **Issues** — https://github.com/Ravikisha/ZenZip/issues

## Author
Ravi Kishan

## License

[MIT](LICENSE)
