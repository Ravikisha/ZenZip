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

export const metadata: Metadata = { title: "Durability & Semantics" };

const toc = [
  { id: "model", title: "Execution model" },
  { id: "guarantees", title: "Delivery guarantees" },
  { id: "suspension", title: "Suspension" },
  { id: "failure", title: "Failure & retry" },
  { id: "versioning", title: "Versioning" },
  { id: "encryption", title: "Encryption at rest" },
  { id: "tested", title: "How it's tested" },
];

const modelCode = `const order = app.workflow("order", async ({ step, input }) => {
  // Attempt 1 executes this closure, journals the result.
  // Every later attempt returns the journaled value WITHOUT re-running it.
  const payment = await step.run("charge", () => stripe.charge(input));

  // Suspends the run. Zero resources held. Survives restarts.
  await step.sleep("cooloff", "10m");

  // Crash here? Next attempt fast-forwards: "charge" returns instantly
  // from the journal, "cooloff" is already recorded, execution resumes
  // exactly at this line.
  await step.run("ship", () => shipping.create(payment));
  return { shipped: true };
});`;

const stableValue = `// Between-steps code re-executes on EVERY attempt — keep it pure.
// Need a stable value across attempts? Journal it:
const startedAt = await step.run("now", () => Date.now());
const token = await step.run("token", () => crypto.randomUUID());`;

const versionRouting = `// v2 is the current logic; v1 in-flight runs keep running v1.
const orderV1 = async ({ step, input }) => { /* old steps */ };
const order = app.workflow("order", async ({ step, input }) => {
  /* new steps */
});
order.version(orderV1);   // self-hashed; old pinned runs route here`;

const idempotency = `// Run-level dedup: same workflow + same key = same run, forever.
await order.trigger(input, { idempotencyKey: \`order-\${input.orderId}\` });

// Effect-level idempotency: derive a key from runId + stepId so a
// crash-after-effect-before-record can't double-charge.
await step.run("charge", () =>
  stripe.charge(input, { idempotencyKey: \`\${runId}:charge\` }),
);`;

export default function Page() {
  return (
    <DocPage
      title="Durability & Semantics"
      description="The contract behind app.workflow(): what is guaranteed, what is at-least-once, and exactly what happens when a process dies."
      href="/docs/durability"
      toc={toc}
    >
      <H2 id="model">Execution model: step memoization</H2>
      <P>
        A workflow is a plain async function. Durability comes from steps:
        every <Code>step.run()</Code> result is persisted to a journal keyed
        by <Code>(runId, stepId)</Code>. Each execution attempt re-invokes the
        function from the top; completed steps return their{" "}
        <Strong>recorded</Strong> result instantly, and execution resumes at
        the first unrecorded step.
      </P>
      <CodeBlock code={modelCode} filename="order.ts" className="mt-6" />
      <P>Three consequences to internalize:</P>
      <UL>
        <LI>
          <Strong>Code between steps re-executes on every attempt.</Strong>{" "}
          Keep it cheap and side-effect free; side effects belong inside{" "}
          <Code>step.run</Code>.
        </LI>
        <LI>
          <Strong>No determinism rules outside steps</Strong> — unlike
          Temporal replay, <Code>Date.now()</Code>, <Code>Math.random()</Code>,
          and <Code>fetch</Code> are fine between steps. But their values are
          recomputed per attempt:
        </LI>
      </UL>
      <CodeBlock code={stableValue} className="mt-4" />
      <UL>
        <LI>
          <Strong>Step ids are journal keys</Strong> — unique within a run,
          stable across deploys. The runtime throws on duplicate ids.
        </LI>
      </UL>

      <H2 id="guarantees">Delivery guarantees</H2>
      <Table
        head={["Thing", "Guarantee"]}
        rows={[
          ["Queue job delivery", "at-least-once (lease + ack/nack + DLQ)"],
          ["Run execution attempts", "at-least-once"],
          [
            "Step result recording",
            "effectively-once — a completed journal entry is never overwritten",
          ],
          [
            "Step side effects",
            "at-least-once — can re-fire on crash-after-effect-before-record",
          ],
          ["Run creation with idempotencyKey", "exactly-once per key"],
        ]}
      />
      <P>
        The side-effect row is the one that bites people. Make external
        effects idempotent:
      </P>
      <CodeBlock code={idempotency} className="mt-4" />

      <H2 id="suspension">Suspension</H2>
      <P>
        All three suspension primitives hold <Strong>zero resources</Strong>{" "}
        while suspended — no open handles, no JS timers, no memory beyond the
        database row. They survive restarts and deploys.
      </P>
      <Table
        head={["API", "Suspends until", "Mechanism"]}
        rows={[
          [
            <Code key="1">step.sleep(id, dur)</Code>,
            "wake time",
            "delayed execution job in the store",
          ],
          [
            <Code key="2">step.waitForEvent(id, event, {"{ timeout }"})</Code>,
            "app.emit(event) or timeout",
            "persisted wake condition; timeout sweep",
          ],
          [
            <Code key="3">step.invoke(id, wf, input)</Code>,
            "child run terminal state",
            "child created with a deterministic idempotency key",
          ],
        ]}
      />
      <UL>
        <LI>
          <Code>waitForEvent</Code> resolves the event payload, or{" "}
          <Code>null</Code> on timeout.
        </LI>
        <LI>
          <Code>step.invoke</Code> returns the child&apos;s output; a
          failed/cancelled child makes it <Strong>throw</Strong> the
          child&apos;s error in the parent (catchable).
        </LI>
        <LI>
          <Code>step.all([...])</Code> runs thunks in parallel with{" "}
          <Strong>independent memoization</Strong>: if one fails, the retry
          fast-forwards its completed siblings and re-runs only the failure.
        </LI>
      </UL>

      <H2 id="failure">Failure &amp; retry</H2>
      <UL>
        <LI>
          A throw <Strong>inside</Strong> <Code>step.run</Code> fails the
          step: the attempt ends and the engine schedules a retry with
          exponential backoff (<Code>stepRetries</Code>, default 2;{" "}
          <Code>stepBackoff</Code>, default 1s→60s). Completed steps never
          re-execute on retry.
        </LI>
        <LI>
          Retries exhausted → the run fails with{" "}
          <Code>step &apos;id&apos; failed after N attempts: …</Code>
        </LI>
        <LI>
          A throw <Strong>outside</Strong> any step fails the run immediately,
          no retry. Wrap risky code in <Code>step.run</Code>.
        </LI>
        <LI>
          Process crash mid-attempt → the execution lease (default 60s,
          configurable via <Code>lease</Code>) expires and the run is
          redelivered. While a handler runs, the engine renews its lease at
          lease/3 cadence, so long steps don&apos;t need a long lease.
        </LI>
        <LI>
          <Strong>Clock-skew safety:</Strong> on Postgres, lease
          set/renew/expiry use the <Strong>database</Strong> server clock, not
          per-node wall clocks — so a node whose clock drifts can&apos;t
          prematurely expire another node&apos;s lease. One authority, no skew.
        </LI>
        <LI>
          <Strong>Fencing tokens:</Strong> every claim bumps a monotonic token.
          A paused/zombie worker that wakes after its lease expired (and the job
          was re-claimed elsewhere) carries a stale token, so its ack / fail /
          renew is rejected — the late write can&apos;t clobber the new owner or
          double-execute.
        </LI>
        <LI>
          <Code>workflow.cancel(runId)</Code> cancels the run and all
          descendant runs; pending wake jobs become no-ops, and an in-flight
          attempt&apos;s outcome is discarded.
        </LI>
      </UL>

      <H2 id="versioning">Versioning</H2>
      <P>
        Workflow definitions are content-hashed at registration (FNV-1a of the
        function source). Runs pin the version they started with; a mismatch
        on resume logs a warning, and changing a recorded step&apos;s{" "}
        <Strong>kind</Strong> throws.
      </P>
      <Table
        head={["Change to in-flight runs", "Safe?"]}
        rows={[
          ["Adding steps after existing ones", "✅ safe"],
          ["Changing between-steps code", "✅ safe"],
          ["Removing / reordering / renaming recorded steps", "❌ breaking"],
          ["Changing a step's kind (run → sleep, …)", "❌ throws on resume"],
        ]}
      />
      <P>
        <Strong>Version routing:</Strong> for a structural change, keep
        the old function and register it with{" "}
        <Code>wf.version(oldFn)</Code> — in-flight runs pinned to the old
        content hash keep executing the old logic, while new runs use the
        current function. No determinism tax, no forced drain:
      </P>
      <CodeBlock code={versionRouting} filename="evolve.ts" />
      <Callout type="warn" title="Rule of thumb">
        <p>
          Deploy additive changes freely. For structural changes, route with{" "}
          <Code>wf.version(oldFn)</Code>, drain in-flight runs first, or ship
          the new structure under a new workflow name.
        </p>
      </Callout>

      <H2 id="encryption">Encryption at rest</H2>
      <P>
        A durable engine persists every input and output, so for teams handling
        PII that data sits in the store indefinitely. Set an{" "}
        <Code>encryptionKey</Code> and ZenZip AES-256-GCM encrypts the four
        payload columns — job payloads, run inputs/outputs, step results, and
        event payloads — before they touch storage, decrypting on read. The
        engine only ever holds plaintext in memory.
      </P>
      <CodeBlock
        code={`const app = zenzip({
  // Any-length secret. Load it from the environment or a secret
  // manager — never hard-code it, and never lose it (encrypted
  // payloads are unrecoverable without it).
  encryptionKey: process.env.ZENZIP_ENCRYPTION_KEY,
});`}
        filename="app.ts"
      />
      <UL>
        <LI>
          <Strong>Transparent to enable.</Strong> Each value is tagged with an{" "}
          <Code>enc:1:</Code> sentinel, so turning encryption on over an
          existing database keeps legacy plaintext rows readable while new
          writes are encrypted — no migration, no downtime.
        </LI>
        <LI>
          <Strong>Authenticated.</Strong> GCM detects tampering and a wrong
          key; a per-value random nonce means identical payloads never produce
          identical ciphertext.
        </LI>
        <LI>
          <Strong>Indexed/control fields stay clear.</Strong> Queue names,
          event names, status, timestamps, and <Code>waitForEvent</Code> match
          predicates are not encrypted — event matching runs against the
          in-memory plaintext, so suspension/resume semantics are unchanged.
        </LI>
        <LI>
          <Strong>Scope.</Strong> Covers the durable payload columns. It is not
          a substitute for disk/volume encryption or TLS to Postgres — it
          protects the payloads specifically, including in the dashboard and
          DLQ views.
        </LI>
      </UL>

      <H2 id="tested">How it&apos;s tested</H2>
      <UL>
        <LI>
          <Strong>Order demo e2e:</Strong> charge → sleep → waitForEvent →
          ship, asserting each step executed exactly once across attempts.
        </LI>
        <LI>
          <Strong>Restart durability:</Strong> the app is stopped while a run
          sleeps; a fresh process on the same data dir completes it.
        </LI>
        <LI>
          <Strong>SIGKILL chaos harness:</Strong> a worker process is killed
          at four random points mid-workflow and respawned; the run must
          complete with the correct output, every step executed ≥1 time, and
          re-execution bounded by the kill count.
        </LI>
        <LI>
          <Strong>Engine-level Rust tests:</Strong> retries, exhaustion, event
          timeout, child invoke, idempotency races, cancel-while-sleeping.
        </LI>
      </UL>
      <P>
        See the test files: <Code>packages/zenzip/test/workflow.test.ts</Code>,{" "}
        <Code>test/chaos.test.ts</Code>, and{" "}
        <Code>crates/zenzip-core/tests/workflow_test.rs</Code>. A comprehensive
        kill-at-every-step-boundary suite is tracked on the{" "}
        <A href="/docs/roadmap">roadmap</A>.
      </P>
    </DocPage>
  );
}
