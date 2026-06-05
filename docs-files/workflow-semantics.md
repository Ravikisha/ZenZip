# ZenZip Workflow Semantics (P2.17)

The contract behind `app.workflow()`. Read this before relying on durability
guarantees in production code.

## Execution model: step memoization

A workflow is a plain async function. Durability comes from steps:

```ts
const order = app.workflow("order", async ({ step, input }) => {
  const payment = await step.run("charge", () => stripe.charge(input));
  await step.sleep("cooloff", "10m");
  const approval = await step.waitForEvent("approved", "order.approved", { timeout: "1h" });
  await step.run("ship", () => shipping.create(payment));
  return { shipped: true };
});
```

Each execution attempt re-invokes the function from the top. Completed steps
return their **recorded** result instantly (the closure does NOT re-run);
the first unrecorded step executes (or suspends) and the attempt ends or
continues. A crash at any point means the next attempt fast-forwards through
the journal and resumes exactly where durability last advanced.

Consequences:

1. **Code between steps re-executes on every attempt.** Keep it cheap and
   side-effect free. Side effects belong inside `step.run`.
2. **No determinism requirements outside steps** (unlike Temporal replay):
   `Date.now()`, `Math.random()`, `fetch` are fine *between* steps — but their
   values are recomputed each attempt. If a value must be stable across
   attempts, wrap it: `await step.run("now", () => Date.now())`.
3. **Step ids must be unique and stable.** Ids are the journal keys.

## Delivery and effect guarantees (plan.md D7)

- Run execution: **at-least-once**. Step result **recording** is
  effectively-once (a completed journal entry is never overwritten).
- A step's **side effect** can fire more than once: crash after the effect
  but before the record re-runs the closure on the next attempt. Make effects
  idempotent (e.g. pass an idempotency key derived from `runId + stepId` to
  your payment/email provider).
- `trigger(input, { idempotencyKey })` dedupes run creation: same workflow +
  same key → same run, forever (the key is stored with the run).

## Suspension

| API | Suspends until | Holds resources? |
|---|---|---|
| `step.sleep(id, dur)` | wake time (delayed execution job) | none |
| `step.waitForEvent(id, event, { timeout })` | `app.emit(event)` or timeout | none |
| `step.invoke(id, wf, input)` | child run reaches a terminal state | none |

- `waitForEvent` resolves the event payload, or `null` on timeout.
- `step.invoke` returns the child's output; a failed/cancelled child makes
  `step.invoke` **throw** the child's error inside the parent (catchable).
- All suspensions survive restarts and deploys — state lives in the store.

## Failure and retry

- A throw inside `step.run`'s closure fails the **step**: the attempt ends,
  the engine schedules a retry with exponential backoff
  (`stepRetries`, `stepBackoff` — defaults 2 retries, 1s→60s). Already
  completed steps are not re-executed on retry.
- Retries exhausted → the **run** fails with
  `step '<id>' failed after N attempts: <error>`.
- A throw **outside** any step (in between-steps code) fails the run
  immediately, no retry. Wrap risky code in `step.run`.
- Process crash mid-attempt → the execution lease (`lease`, default 60s)
  expires and the run is redelivered. Raise `lease` if a single step can
  legitimately run longer than that, or rely on the lease heartbeat (the
  engine renews leases at lease/3 cadence while the executor runs).

## Parallel steps

`step.all([...thunks])` = `Promise.all` with per-step memoization: if one
parallel step fails, the attempt retries but completed siblings fast-forward.
A suspension inside `step.all` suspends the whole attempt (resumes are
sequential per wake — fine, not optimal; optimize later if needed).

## Cancellation

`workflow.cancel(runId)` cancels the run and **all descendant runs**
(non-terminal only). A cancelled run's pending wake jobs become no-ops; an
in-flight attempt finishes its current JS execution but its outcome is
discarded. `onCancel` cleanup hooks are not implemented yet (backlog).

## Versioning (plan.md D6)

- Definitions are content-hashed at registration; runs pin the version they
  started with. A version mismatch on resume logs a warning.
- Safe changes for in-flight runs: **adding steps after** existing ones,
  changing between-steps code.
- Breaking changes: removing, reordering, or renaming steps that an in-flight
  run already recorded, or changing a step's kind (the engine throws
  `step "<id>" changed kind` on kind mismatch).
- Rule of thumb: deploy additive changes freely; for structural changes,
  drain in-flight runs first or use a new workflow name.

## Events (Phase 2 scope)

`app.emit(name, payload)` wakes `waitForEvent` waiters in this process's
store. The full event bus — wildcard subscribers, durable workflow triggers
(`on: "user.created"`), persisted outbox — lands in Phase 3.

## Verified by tests

- Order demo end-to-end (charge → sleep → waitForEvent → ship), steps
  executed exactly once across attempts (`test/workflow.test.ts`)
- Restart durability: sleeping run resumed by a fresh process
- Chaos: 4× SIGKILL mid-run, run completes with correct output, side effects
  ≥1 and bounded (`test/chaos.test.ts`)
- Engine-level: retries, exhaustion, timeout, invoke, idempotency, cancel
  (`crates/zenzip-core/tests/workflow_test.rs`)
