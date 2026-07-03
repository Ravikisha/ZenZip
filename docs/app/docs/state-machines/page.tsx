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
  UL,
} from "@/components/docs/typography";

export const metadata: Metadata = {
  title: "State Machines",
  description:
    "Persisted, transition-validated state machines in ZenZip — XState-lite backed by the store, with every transition emitted atomically through the event bus.",
  alternates: { canonical: "/docs/state-machines" },
  openGraph: {
    title: "State Machines · ZenZip",
    description:
      "Persisted, transition-validated state machines in ZenZip — XState-lite backed by the store, with every transition emitted atomically through the event bus.",
    url: "/docs/state-machines",
    type: "article",
  },
};

const toc = [
  { id: "basics", title: "Basics" },
  { id: "transitions", title: "Transitions" },
  { id: "events", title: "Transition events" },
  { id: "queries", title: "Queries & history" },
  { id: "scope", title: "Design scope" },
];

const basics = `const order = app.machine("order", {
  initial: "created",
  states: {
    created:   { on: { PAY: "paid", CANCEL: "cancelled" } },
    paid:      { on: { PACK: "packed", REFUND: "refunded" } },
    packed:    { on: { SHIP: "shipped" } },
    shipped:   { on: { DELIVER: "delivered" } },
    delivered: {},          // terminal: no outgoing transitions
    cancelled: {},
    refunded:  {},
  },
});

await app.start();

await order.create("ord_1");              // → true (false if it existed)
const t = await order.send("ord_1", "PAY"); // → { from: "created", to: "paid" }
await order.state("ord_1");                // → "paid"`;

const invalid = `// Transitions are validated against the definition and applied
// atomically (optimistic UPDATE … WHERE state = expected):
await order.send("ord_1", "PAY");
// → throws: invalid transition: machine 'order' instance 'ord_1'
//           cannot handle 'PAY' in state 'paid'

// Concurrent senders race safely: the loser re-reads and re-validates;
// a still-valid transition retries, an invalidated one throws.`;

const eventsCode = `// Every transition emits "<machine>.<toState>" through the event bus:
app.on("order.*", ({ event, payload }) => {
  // payload: { machine: "order", id: "ord_1", from, event: "PAY", to }
  console.log(event);   // "order.paid"
});

// …including DURABLE workflow triggers:
app.workflow("fulfil", { on: "order.paid" }, async ({ step, input }) => {
  await step.run("allocate", () => warehouse.allocate(input.payload.id));
});`;

const history = `const log = await order.history("ord_1");
// newest first:
// [ { fromState: "paid", event: "PACK", toState: "packed", at: 1717… },
//   { fromState: "created", event: "PAY", toState: "paid", at: 1717… } ]`;

export default function Page() {
  return (
    <DocPage
      title="State Machines"
      description="Persisted, transition-validated state — XState-lite backed by the store, with every transition emitted through the event bus."
      href="/docs/state-machines"
      toc={toc}
    >
      <H2 id="basics">Basics</H2>
      <CodeBlock code={basics} filename="order-machine.ts" />
      <UL>
        <LI>
          State names are inferred — <Code>order.state(id)</Code> is typed as
          the union of your state keys.
        </LI>
        <LI>
          <Code>create()</Code> is idempotent: an existing instance returns{" "}
          <Code>false</Code>, never resets.
        </LI>
        <LI>
          Instances persist in the store — restart-safe like everything else.
        </LI>
      </UL>

      <H2 id="transitions">Transitions</H2>
      <CodeBlock code={invalid} />
      <P>
        Validation happens in Rust against the registered definition; the
        apply is a guarded <Code>UPDATE … WHERE state = expected</Code> plus a
        history append in one transaction. Two processes can&apos;t both win
        the same transition.
      </P>

      <H2 id="events">Transition events</H2>
      <CodeBlock code={eventsCode} filename="hooks.ts" />
      <P>
        This is the integration point: machines turn imperative state changes
        into events, and <A href="/docs/events">the event bus</A> turns events
        into durable workflows. Order fulfilment, notification fan-out, audit
        trails — all hang off transitions without coupling to the caller.
      </P>
      <Callout type="tip" title="Atomic with the event">
        <p>
          The state change, history entry, emitted event, and any
          durably-triggered runs commit in one store transaction — a crash
          can&apos;t produce a transition whose event (or whose triggered
          workflows) went missing.
        </p>
      </Callout>

      <H2 id="queries">Queries &amp; history</H2>
      <CodeBlock code={history} />

      <H2 id="scope">Design scope</H2>
      <P>
        Deliberately <Strong>XState-lite</Strong>: flat states, event-keyed
        transitions, persistence, history, bus integration. Not included (by
        design, for now): nested/parallel states, guards, actions, actors.
        Workflows cover the &ldquo;do things over time&rdquo; half — machines
        only answer &ldquo;what state is this entity in, and what&apos;s
        allowed next.&rdquo;
      </P>
    </DocPage>
  );
}
