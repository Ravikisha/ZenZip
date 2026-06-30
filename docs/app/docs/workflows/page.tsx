import type { Metadata } from "next";

import { CodeBlock } from "@/components/code-block";
import { DocPage } from "@/components/docs/doc-page";
import {
  A,
  Callout,
  Code,
  H2,
  H3,
  LI,
  P,
  PropsTable,
  Table,
  UL,
} from "@/components/docs/typography";

export const metadata: Metadata = { title: "Workflows" };

const toc = [
  { id: "defining", title: "Defining a workflow" },
  { id: "step-run", title: "step.run" },
  { id: "step-sleep", title: "step.sleep" },
  { id: "step-wait", title: "step.waitForEvent" },
  { id: "step-invoke", title: "step.invoke" },
  { id: "step-all", title: "step.all" },
  { id: "triggering", title: "Triggering & run handles" },
  { id: "options", title: "Workflow options" },
  { id: "patterns", title: "Patterns" },
];

const defining = `const order = app.workflow<
  { orderId: string },          // input type
  { shipped: boolean }          // output type
>("order", async ({ step, input, runId }) => {
  const payment = await step.run("charge", () => stripe.charge(input));
  await step.sleep("cooloff", "10m");
  const approval = await step.waitForEvent<{ by: string }>(
    "approval",
    "order.approved",
    { timeout: "1h" },
  );
  if (!approval) return { shipped: false };       // timed out
  await step.run("ship", () => shipping.create(payment));
  return { shipped: true };
});`;

const stepRun = `// The closure runs ONCE. The result is journaled (JSON) and every
// later attempt returns it without re-executing.
const user = await step.run("fetch-user", () => db.users.find(id));

// Throw inside the closure = step failure → retry with backoff.
// Completed steps never re-run during those retries.
const charge = await step.run("charge", async () => {
  const res = await stripe.charge(amount, {
    idempotencyKey: ctx.idempotencyKey("charge"),  // guard the side effect
  });
  if (!res.ok) throw new Error(res.reason);
  return res.id;
});

// ctx.idempotencyKey(label) is deterministic across retries + replays —
// derived from the run id — so an effect that succeeds but crashes before
// its result is journaled won't duplicate. One distinct label per effect.`;

const stepSleep = `await step.sleep("cooloff", "10m");   // minutes
await step.sleep("digest-gap", "7d");  // …or days. Zero resources held.`;

const stepWait = `// Suspend until app.emit("invoice.paid", payload) — or 24h pass.
const paid = await step.waitForEvent<{ amount: number }>(
  "payment",
  "invoice.paid",
  { timeout: "24h" },
);

if (paid === null) {
  await step.run("remind", () => emails.push({ to, subject: "Reminder" }));
} else {
  await step.run("receipt", () => emails.push({ to, subject: "Receipt" }));
}

// Somewhere else — a webhook handler, another job, anywhere:
app.emit("invoice.paid", { amount: 4200 });`;

const stepInvoke = `const notify = app.workflow<{ userId: string }, void>("notify", async ({ step, input }) => {
  await step.run("push", () => pushNotification(input.userId));
});

const signup = app.workflow("signup", async ({ step, input }) => {
  await step.run("create", () => accounts.create(input));
  // Child runs durably; parent suspends holding nothing.
  // A failed child makes this THROW the child's error (catchable).
  await step.invoke("welcome", notify, { userId: input.id });
});`;

const stepAll = `// Parallel steps with independent memoization: if upsert-3 fails,
// the retry fast-forwards 0..2 and 4 from the journal and re-runs only 3.
const results = await step.all(
  rows.map((row, i) => () => step.run(\`upsert-\${i}\`, () => db.upsert(row))),
);`;

const triggering = `// Fire and forget — durable from this moment:
const { runId } = await order.trigger(
  { orderId: "o_42" },
  { idempotencyKey: "o_42", delay: "10s" },
);

// Trigger and wait for the output (throws on failure/cancel/timeout):
const result = await order.triggerAndWait({ orderId: "o_43" }, { timeout: "2m" });

// Inspect any run:
const run = await order.getRun(runId);
// → { runId, workflow, status, output?, error? }
// status: running | sleeping | waitingEvent | waitingChild
//       | completed | failed | cancelled

// Cancel a run and all its child runs:
await order.cancel(runId);

// Realtime: stream status + step events until the run finishes.
// Store-backed, so it works across processes — pipe it to SSE/WebSocket.
for await (const u of app.subscribe(runId, { interval: 250 })) {
  console.log(u.status, u.steps.length); // ends when u.terminal
}`;

export default function Page() {
  return (
    <DocPage
      title="Workflows"
      description="Durable, step-memoized execution: write a plain async function, get crash-proof multi-step orchestration with retries, sleeps, event waits, and child workflows."
      href="/docs/workflows"
      toc={toc}
    >
      <H2 id="defining">Defining a workflow</H2>
      <CodeBlock code={defining} filename="order.ts" />
      <P>
        The function receives <Code>{`{ step, input, runId }`}</Code>. Every
        durable operation goes through <Code>step</Code>; everything else is
        ordinary TypeScript. Read{" "}
        <A href="/docs/durability">Durability &amp; Semantics</A> for the
        exact guarantees — the one-paragraph version: each step&apos;s result
        is journaled, attempts re-invoke the function and fast-forward through
        the journal, and suspensions hold zero resources.
      </P>
      <Callout type="info" title="Step ids">
        <p>
          Ids are the journal keys: unique within a run, stable across
          deploys. Duplicate ids throw immediately. Dynamic ids (like{" "}
          <code>upsert-3</code> above) are fine as long as they&apos;re
          deterministic for a given input.
        </p>
      </Callout>

      <H2 id="step-run">step.run — durable computation</H2>
      <CodeBlock code={stepRun} />
      <UL>
        <LI>
          Results are JSON-serialized; return plain data, not class instances.
        </LI>
        <LI>
          Retries are configured per workflow (<Code>stepRetries</Code>,{" "}
          <Code>stepBackoff</Code>); exhaustion fails the run.
        </LI>
        <LI>
          Side effects are at-least-once — pass effect-level idempotency keys
          to external systems.
        </LI>
        <LI>
          Bound a slow step with{" "}
          <Code>step.run(&quot;x&quot;, fn, &#123; timeout: &quot;30s&quot; &#125;)</Code>{" "}: overrunning fails the step (then retries) instead of wedging a
          worker slot. Pass an AbortSignal-aware <Code>fn</Code> to also cancel
          the underlying I/O.
        </LI>
      </UL>

      <H2 id="step-sleep">step.sleep — durable timers</H2>
      <CodeBlock code={stepSleep} />
      <P>
        Internally a delayed execution job: nothing in memory, nothing on the
        event loop. Deploy mid-sleep and the run wakes in the new process —
        this exact scenario is a test.
      </P>

      <H2 id="step-wait">step.waitForEvent — human-in-the-loop &amp; webhooks</H2>
      <CodeBlock code={stepWait} />
      <UL>
        <LI>
          Resolves the emitted payload, or <Code>null</Code> on timeout — make
          the timeout branch explicit.
        </LI>
        <LI>
          <Code>app.emit()</Code> wakes every run currently waiting on that
          event name. Payload filters (match expressions) are supported —
          see the <A href="/docs/events">Events</A> page.
        </LI>
      </UL>

      <H2 id="step-invoke">step.invoke — child workflows</H2>
      <CodeBlock code={stepInvoke} />
      <UL>
        <LI>
          The child is created with a deterministic idempotency key derived
          from the parent run + step id — crash-replays of the suspension
          can&apos;t spawn duplicates.
        </LI>
        <LI>
          Cancelling a parent cancels its descendants.
        </LI>
        <LI>
          Accepts the <Code>Workflow</Code> handle or its string name.
        </LI>
      </UL>

      <H2 id="step-all">step.all — parallelism</H2>
      <CodeBlock code={stepAll} />

      <H2 id="triggering">Triggering &amp; run handles</H2>
      <CodeBlock code={triggering} />
      <Table
        head={["Status", "Meaning"]}
        rows={[
          [<Code key="1">running</Code>, "claimable / executing an attempt"],
          [<Code key="2">sleeping</Code>, "suspended in step.sleep"],
          [<Code key="3">waitingEvent</Code>, "suspended in step.waitForEvent"],
          [<Code key="4">waitingChild</Code>, "suspended in step.invoke"],
          [<Code key="5">completed</Code>, "terminal — output available"],
          [<Code key="6">failed</Code>, "terminal — error available"],
          [<Code key="7">cancelled</Code>, "terminal — via cancel()"],
        ]}
      />

      <H2 id="options">Workflow options</H2>
      <PropsTable
        rows={[
          {
            name: "concurrency",
            type: "number",
            default: "10",
            description: "Max run executions in flight for this workflow.",
          },
          {
            name: "stepRetries",
            type: "number",
            default: "2",
            description: "Step retries after the first failed attempt.",
          },
          {
            name: "stepBackoff",
            type: "{ delay?, maxDelay? }",
            default: `{ delay: "1s", maxDelay: "60s" }`,
            description: "Exponential backoff between step retries.",
          },
          {
            name: "lease",
            type: "Duration",
            default: `"60s"`,
            description:
              "Crash-redelivery horizon per execution attempt. Auto-renewed at lease/3 while the executor runs.",
          },
        ]}
      />

      <H2 id="patterns">Patterns</H2>
      <H3>Webhook-gated fulfillment</H3>
      <P>
        Trigger on checkout with{" "}
        <Code>idempotencyKey: orderId</Code> (webhook retries can&apos;t
        double-run), charge in a step, then{" "}
        <Code>waitForEvent(&quot;payment.confirmed&quot;)</Code> with a
        timeout branch that voids the order.
      </P>
      <H3>Drip campaigns</H3>
      <P>
        A loop of <Code>step.run(`send-${"{i}"}`)</Code> +{" "}
        <Code>step.sleep(`gap-${"{i}"}`, &quot;3d&quot;)</Code>. Unsubscribe
        by emitting an event the workflow checks between sends — or just{" "}
        <Code>cancel(runId)</Code>.
      </P>
      <H3>Fan-out imports</H3>
      <P>
        Fetch + parse in steps, then <Code>step.all</Code> over per-row
        upserts. A flaky row retries alone; a poisoned row fails the run with
        a precise error naming the step.
      </P>
    </DocPage>
  );
}
