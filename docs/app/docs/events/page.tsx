import type { Metadata } from "next";

import { CodeBlock } from "@/components/code-block";
import { DocPage } from "@/components/docs/doc-page";
import {
  A,
  Callout,
  Code,
  H2,
  LI,
  P,
  Strong,
  Table,
  UL,
} from "@/components/docs/typography";

export const metadata: Metadata = {
  title: "Events",
  description:
    "ZenZip's atomic event outbox: one transaction persists an emit, wakes matching waiters, and durably triggers workflows — plus ephemeral wildcard subscribers.",
  alternates: { canonical: "/docs/events" },
  openGraph: {
    title: "Events · ZenZip",
    description:
      "ZenZip's atomic event outbox: one transaction persists an emit, wakes matching waiters, and durably triggers workflows — plus ephemeral wildcard subscribers.",
    url: "/docs/events",
    type: "article",
  },
};

const toc = [
  { id: "emit", title: "app.emit" },
  { id: "subscribers", title: "app.on subscribers" },
  { id: "triggers", title: "Durable workflow triggers" },
  { id: "match", title: "Match predicates" },
  { id: "patterns", title: "Wildcard patterns" },
  { id: "semantics", title: "Delivery semantics" },
];

const emitCode = `// Anywhere: a route handler, a queue consumer, a REPL.
const { woken, triggered } = app.emit("invoice.paid", {
  invoice: "inv_42",
  amount: 4200,
});
// woken     → waitForEvent waiters released
// triggered → workflow runs created via on: triggers`;

const subscriberCode = `// Ephemeral, this-process, fire-and-forget. Wildcards supported.
const off = app.on("user.*", ({ event, payload }) => {
  analytics.track(event, payload);
});
app.on("billing.**", auditLog);   // matches billing.invoice.paid.eu …

off();                            // unsubscribe`;

const triggerCode = `// DURABLE: created atomically with the event (outbox) — a persisted
// event implies its triggered runs exist. Survives crashes.
app.workflow("onboard", { on: "user.created" }, async ({ step, input }) => {
  // input: { event: "user.created", payload: {...}, emittedAt: 1717... }
  await step.run("welcome", () => emails.push({ to: input.payload.email }));
});

// Multiple patterns:
app.workflow("audit", { on: ["user.**", "billing.**"] }, async ({ input }) => {
  await audit.log(input.event, input.payload);
});`;

const matchCode = `// Wake only the run waiting for THIS invoice:
const wf = app.workflow("collect", async ({ step, input }) => {
  const paid = await step.waitForEvent("paid", "invoice.paid", {
    timeout: "24h",
    match: { invoice: input.invoice },   // shallow equality on the payload
  });
  return paid ? "collected" : "reminder-time";
});

await wf.trigger({ invoice: "inv-a" });
await wf.trigger({ invoice: "inv-b" });

app.emit("invoice.paid", { invoice: "inv-b", amount: 42 });
// → { woken: 1 } — inv-a keeps waiting`;

const machineCode = `// State machine transitions emit through the same bus:
const order = app.machine("order", {
  initial: "created",
  states: { created: { on: { PAY: "paid" } }, paid: {} },
});

app.workflow("on-paid", { on: "order.paid" }, async ({ input }) => {
  // payload: { machine: "order", id, from: "created", event: "PAY", to: "paid" }
});

await order.send("ord_1", "PAY");   // transition + durable trigger`;

export default function Page() {
  return (
    <DocPage
      title="Events"
      description="An atomic event outbox: emits persist the event, wake matching waiters, and durably trigger workflows — all in one transaction. Plus ephemeral wildcard subscribers."
      href="/docs/events"
      toc={toc}
    >
      <H2 id="emit">app.emit</H2>
      <CodeBlock code={emitCode} filename="emit.ts" />
      <P>
        <Code>emit</Code> is synchronous and transactional: by the time it
        returns, the event row is persisted, every matching{" "}
        <Code>waitForEvent</Code> waiter has its step result recorded and its
        run re-enqueued, and every <Code>on:</Code>-triggered run exists with
        its execution job — <Strong>one store transaction</Strong>. There is
        no window where an event happened but its consequences didn&apos;t.
      </P>

      <H2 id="subscribers">app.on — ephemeral subscribers</H2>
      <CodeBlock code={subscriberCode} filename="subscribers.ts" />
      <UL>
        <LI>
          In-process, fire-and-forget: a throwing subscriber is logged, never
          crashes the emitter, and gets no retries.
        </LI>
        <LI>
          Scope: events emitted via <Code>app.emit()</Code> and machine
          transitions <Strong>in this process</Strong>. For anything that must
          not be missed, use a workflow trigger instead.
        </LI>
      </UL>

      <H2 id="triggers">Durable workflow triggers</H2>
      <CodeBlock code={triggerCode} filename="triggers.ts" />
      <P>
        Triggered runs are full workflow runs: journaled steps, retries,
        suspensions, the dashboard — everything in{" "}
        <A href="/docs/workflows">Workflows</A> applies. State machine
        transitions ride the same rails:
      </P>
      <CodeBlock code={machineCode} className="mt-4" />

      <H2 id="match">Match predicates (waitForEvent)</H2>
      <CodeBlock code={matchCode} filename="match.ts" />
      <P>
        <Code>match</Code> is shallow equality on top-level payload keys —
        every key in the predicate must equal the same key in the emitted
        payload. Deeper predicates (JSON-path) are a later extension.
      </P>

      <H2 id="patterns">Wildcard patterns</H2>
      <Table
        head={["Pattern", "Matches", "Doesn't match"]}
        rows={[
          [
            <Code key="1">user.created</Code>,
            "user.created",
            "user.created.eu",
          ],
          [
            <Code key="2">user.*</Code>,
            "user.created · user.deleted",
            "user.created.eu",
          ],
          [
            <Code key="3">user.**</Code>,
            "user.created · user.created.eu",
            "order.created",
          ],
          [<Code key="4">*.created</Code>, "user.created · order.created", "user.deleted"],
        ]}
      />
      <P>
        Patterns apply to <Code>app.on()</Code> subscribers and workflow{" "}
        <Code>on:</Code> triggers. <Code>waitForEvent</Code> uses exact names
        (+ match predicates).
      </P>

      <H2 id="semantics">Delivery semantics</H2>
      <Table
        head={["Consumer", "Guarantee"]}
        rows={[
          [
            <Strong key="1">Workflow `on:` trigger</Strong>,
            "at-least-once, crash-safe (created atomically with the event)",
          ],
          [
            <Strong key="2">waitForEvent waiter</Strong>,
            "at-least-once; step result recorded in the emit transaction",
          ],
          [
            <Strong key="3">app.on() subscriber</Strong>,
            "best-effort, this process, no retries",
          ],
        ]}
      />
      <Callout type="tip" title="Machine transitions are atomic too">
        <p>
          A machine transition, its history entry, its event, and any runs the
          event triggers all commit in the same store transaction — there is
          no transition-without-event crash window.
        </p>
      </Callout>
      <P>
        Cross-process event fan-out (multiple machines) is available with the
        <A href="/docs/production"> Postgres backend</A> via LISTEN/NOTIFY.
      </P>
    </DocPage>
  );
}
