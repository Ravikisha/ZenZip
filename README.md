<div align="center">

# ⚡ ZenZip

**The agent-native backend framework for Node.js.**

Durable workflows, queues, schedules, events, state machines, and AI agents
on a single Rust-powered runtime — with **zero infrastructure**.

No Redis. No Temporal cluster. No RabbitMQ. No cron box.
`npm install` is the entire setup.

*Status: pre-1.0 alpha — phases 0–5 complete, 82 tests green, building in the open.*

</div>

---

## Why

A typical production Node backend accumulates this stack:

| You operate today | ZenZip replaces it with |
|---|---|
| BullMQ + Redis | `app.queue()` |
| Temporal (a cluster) | `app.workflow()` |
| node-cron on a pet server | `app.schedule()` |
| RabbitMQ / SNS | `app.emit()` / `on:` triggers |
| LangGraph + custom glue | `app.agent()` |
| Hand-assembled Grafana | `app.dashboard()` |

Each piece works. Together they are six services to provision, secure, monitor,
and pay for — before you write business logic. ZenZip embeds the runtime in
your process the way SQLite replaced "install a database server": state lives
in one SQLite file in your project folder. Need horizontal scale later?
Point the same API at Postgres with one config line.

**Speed is not the pitch — durability is.** We benchmarked our own Rust HTTP
server idea against Fastify and killed it when the numbers said no
([docs/content/spike-results.md](docs/content/spike-results.md)). What Rust
buys here is an engine where timers, leases, retries, and crash recovery never
depend on your event loop being alive.

## Sixty seconds of ZenZip

```ts
import { zenzip, tool, anthropic } from "zenzip";

const app = zenzip(); // embedded SQLite store, zero config

// ── Durable queue: throw = retry with backoff → dead-letter queue ─────────
const emails = app.queue("emails", { concurrency: 10, retries: 5 });
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

Kill the process anywhere in there — jobs redeliver, the sleeping workflow
wakes on schedule in the new process, the agent resumes mid-conversation
without re-calling the model for completed steps.

## Features

- **Queues** — at-least-once delivery, leases, exponential backoff + jitter,
  priorities, delays, token-bucket rate limits, batch consumers, DLQ with
  one-call requeue, graceful drain.
- **Schedules** — cron + intervals, IANA timezones, persisted next-fire,
  overlap policies (skip/queue/allow), missed-tick catch-up
  (skip/runOnce/all), per-fire jitter.
- **Workflows** — step-memoized durable execution (the Inngest model, not
  Temporal replay — no determinism rules outside steps): `step.run`,
  `step.sleep`, `step.waitForEvent` (+ match predicates), `step.invoke`
  (child workflows), `step.all` (parallel with independent memoization),
  idempotency keys, cancellation trees, content-hash version pinning.
- **Events** — atomic outbox: one transaction persists the event, wakes
  matching waiters, and creates `on:`-triggered runs. Wildcard patterns
  (`user.*`, `billing.**`), ephemeral `app.on()` subscribers.
- **State machines** — persisted, transition-validated; transition + history
  + emitted event + triggered runs commit atomically.
- **Agents** — LLM loops compiled to dynamic workflow steps: tool failures
  retry **without re-prompting the model** (asserted by test), durable
  human-approval gates, session memory, multi-agent handoff, structured
  output, streaming, token accounting. Anthropic + OpenAI-compatible +
  scripted mock providers.
- **HTTP** — minimal adapter (`app.get/post/...` + `listen()`), webhook→workflow
  sugar (`{ http: "POST /hooks/stripe" }`), `app.toNodeHandler()` to mount
  into any existing server.
- **Observability** — embedded live dashboard (SSE): run timelines with step
  graphs, queue health + DLQ requeue, schedules, event feed, engine metrics;
  optional auth token. Structured logs from the Rust core into your logger.
- **Multi-node** — `store: { driver: "postgres", url }`: SKIP LOCKED claims,
  LISTEN/NOTIFY cross-node wakeups, CAS scheduler election, lease-based
  dead-node recovery. Same API.

## Reliability, tested

This repo's CI doesn't just unit-test — it kills things:

- a worker process is **SIGKILLed mid-job**; the job must redeliver with the
  attempt counted
- a workflow worker is SIGKILLed at **four random points mid-run** and
  respawned; the run must complete with the correct output and no lost steps
- a **3-node Postgres cluster** has a node hard-killed mid-burst; all 150
  jobs must complete with duplicates bounded by the dead node's in-flight
- two nodes share one schedule; ticks must fire **exactly once**
- a flaky agent tool fails twice; the LLM must be called **exactly twice**,
  not four times

Delivery semantics, versioning rules, and the idempotency guide live in
[docs/content/workflow-semantics.md](docs/content/workflow-semantics.md).

## Architecture

```text
┌─────────────────────────────────────────────────────┐
│  TypeScript API  (npm: zenzip)                       │
│  queues · schedules · workflows · agents · events    │
│  machines · http · dashboard                         │
└──────────────────────┬──────────────────────────────┘
                       │ napi-rs v3 — sync calls on hot paths (14–34ns),
                       │ pipelined ThreadsafeFunction handler dispatch
┌──────────────────────▼──────────────────────────────┐
│  Rust core (own tokio runtime — your event loop      │
│  only ever runs YOUR handlers)                       │
│  queue engine · scheduler · workflow engine ·        │
│  event outbox · machines · sweepers · metrics        │
└──────────────────────┬──────────────────────────────┘
                       │ Store trait
        ┌──────────────┴───────────────┐
        ▼                              ▼
  SQLite (WAL)                  PostgreSQL
  embedded default              multi-node: SKIP LOCKED,
  zero config                   LISTEN/NOTIFY, CAS election
```

Every feature is a projection of one engine: a queue job is leased retryable
work; a schedule fires onto a hidden queue; a workflow run is a job whose
handler drives the step journal; an agent is a workflow with dynamic steps.
Crash recovery is implemented once and inherited everywhere.

Design decisions (D1–D8) with the measurements behind them:
[docs/content/plan.md](docs/content/plan.md).

## Project status

| Phase | Scope | Status |
|---|---|---|
| 0 | NAPI boundary + storage benchmarks | ✅ |
| 1 | Queues, scheduler, runtime shell | ✅ |
| 2 | Durable workflow engine (flagship) | ✅ |
| 3 | Events, state machines, HTTP, dashboard | ✅ |
| 4 | Agent engine | ✅ |
| 5 | Postgres multi-node | ✅ |
| 6 | DX & launch: `create-zenzip-app`, npm prebuilds, docs polish | 🔜 |

Full task ledger: [docs/content/tasks.md](docs/content/tasks.md) ·
Roadmap with notes: the docs site (`docs/`, Next.js — `npm run dev`).

## Repository layout

```text
crates/zenzip-core/     Rust engine: store trait, SQLite + Postgres impls,
                        queue/scheduler/workflow engines, event outbox
packages/core-native/   napi-rs bridge crate + npm package (@zenzip/core-native)
packages/zenzip/        Public TypeScript API (npm: zenzip)
bench/                  Phase 0 boundary/throughput benchmarks (reproducible)
examples/               email-queue · demo-dashboard · support-agent
docs/                   Documentation site (Next.js) — guides live in docs/content/
```

## Development

Requires **Rust stable**, **Node 18+**, **pnpm**. Postgres tests need a server
(set `ZENZIP_PG_TEST_URL`; they skip otherwise).

```sh
pnpm install
pnpm build              # cargo + napi build (release) + TypeScript

cargo test --workspace            # 33 Rust tests (incl. PG multi-node if reachable)
pnpm --filter zenzip test         # 49 TS tests (queues/workflows/agents/chaos/…)

pnpm bench:boundary     # JS↔Rust call costs
pnpm bench:sqlite       # store throughput
pnpm bench:http         # the benchmark that killed our Rust HTTP server

pnpm --filter @zenzip/example-demo-dashboard start   # live dashboard demo
pnpm --filter @zenzip/example-support-agent start    # agent demo (offline mock;
                                                     # set ANTHROPIC_API_KEY for Claude)
```

Standing rules: CI green on win/mac/linux before merge; every feature lands
with tests (crash-safety where applicable) and docs; benchmark regressions
>10% block merge; `docs/content/plan.md` follows the code, never silently
diverges.

## License

[MIT](LICENSE)
