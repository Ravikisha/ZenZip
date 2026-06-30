<div align="center">

<img src="https://raw.githubusercontent.com/Ravikisha/ZenZip/main/docs/public/logo.png" alt="ZenZip" width="120" height="120" />

# ZenZip

**The agent-native backend framework for Node.js.**

Durable workflows, queues, schedules, events, state machines, and AI agents on a
single Rust-powered runtime — with **zero infrastructure**. No Redis, no Temporal
cluster, no RabbitMQ. `npm install` is the entire setup.

</div>

---

```bash
npm install zenzip
```

```ts
import { zenzip } from "zenzip";

const app = zenzip(); // embedded SQLite store, zero config

// Durable queue — throw = retry with backoff → dead-letter queue
const emails = app.queue("emails", { concurrency: 10, retries: 5 });
emails.process(async (job) => smtp.send(job.data));

// Durable workflow — every step journaled; kill -9 is a test case
const order = app.workflow("order", async ({ step, input }) => {
  const payment = await step.run("charge", () => stripe.charge(input));
  await step.sleep("cooloff", "10m");                       // survives restarts
  await step.run("ship", () => shipping.create(payment));   // memoized forever
});

await app.start();
await order.trigger({ orderId: "o_42" }, { idempotencyKey: "o_42" });
```

Kill the process anywhere — jobs redeliver, the sleeping workflow wakes on
schedule in the new process, agents resume mid-conversation without re-calling
the model for completed steps.

## What's inside

- **Queues** — at-least-once delivery, leases + fencing, backoff, priorities,
  per-key concurrency, fairness, debounce, throttle, rate limits, DLQ.
- **Workflows** — step-memoized durable execution (Inngest model, not Temporal
  replay), `sleep` / `waitForEvent` / child workflows / version routing.
- **Schedules** — cron + intervals, timezones, overlap + catch-up policies.
- **Events & state machines** — atomic outbox, wildcard patterns, persisted FSMs.
- **AI agents** — durable LLM loops (retry without re-prompting), tools, human
  approval, memory, multi-agent networks, evals; Anthropic / OpenAI / Gemini /
  Bedrock.
- **HTTP** — Express-compatible middleware + router + adapters.
- **Production** — encryption at rest, retention/GC, health probes, RBAC, CSRF,
  rate limiting, alerting, multi-tenancy, PII purge.
- **Multi-node** — point the same API at Postgres.

## Documentation

Full guides, the deployment guide, and benchmarks:
**[github.com/Ravikisha/ZenZip](https://github.com/Ravikisha/ZenZip)**

## License

[MIT](https://github.com/Ravikisha/ZenZip/blob/main/LICENSE)
