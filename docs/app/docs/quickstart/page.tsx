import type { Metadata } from "next";

import { CodeBlock, CommandLine } from "@/components/code-block";
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
  title: "Quickstart",
  description:
    "Install ZenZip and build a durable queue, a persisted cron schedule, and a crash-proof workflow in one file — then kill the process and watch it recover.",
  alternates: { canonical: "/docs/quickstart" },
  openGraph: {
    title: "Quickstart · ZenZip",
    description:
      "Install ZenZip and build a durable queue, a persisted cron schedule, and a crash-proof workflow in one file — then kill the process and watch it recover.",
    url: "/docs/quickstart",
    type: "article",
  },
};

const toc = [
  { id: "install", title: "Install" },
  { id: "first-app", title: "Your first app" },
  { id: "run-it", title: "Run it" },
  { id: "kill-it", title: "Now kill it" },
  { id: "next-steps", title: "Next steps" },
];

const firstApp = `import { zenzip } from "zenzipjs";

const app = zenzip({ dataDir: ".zenzip" });

// 1. A durable queue — retries with backoff, dead-letters when exhausted.
const emails = app.queue<{ to: string; subject: string }>("emails", {
  concurrency: 5,
  retries: 3,
  backoff: { delay: "500ms", maxDelay: "5s" },
});

emails.process(async (job) => {
  console.log(\`sending to \${job.data.to} (attempt \${job.attempt})\`);
  if (Math.random() < 0.25) throw new Error("smtp: connection reset");
});

// 2. A persisted schedule — survives restarts, timezone-aware.
app.schedule("digest", { every: "10s" }, async () => {
  await emails.push({ to: "digest@example.com", subject: "Your digest" });
});

// 3. A durable workflow — every step is journaled.
const onboard = app.workflow<{ email: string }, string>(
  "onboard",
  async ({ step, input }) => {
    await step.run("welcome", () =>
      emails.push({ to: input.email, subject: "Welcome!" }),
    );
    await step.sleep("wait", "5s"); // survives kill -9
    await step.run("follow-up", () =>
      emails.push({ to: input.email, subject: "How's it going?" }),
    );
    return "onboarded";
  },
);

await app.start();

await emails.push({ to: "you@example.com", subject: "Hello from ZenZip" });
await onboard.trigger({ email: "you@example.com" });`;

const stopSnippet = `// Graceful shutdown: stops claiming, drains in-flight handlers.
// SIGINT/SIGTERM handlers are installed automatically (opt out with
// handleSignals: false).
const clean = await app.stop({ timeout: "10s" });`;

export default function Page() {
  return (
    <DocPage
      title="Quickstart"
      description="A durable queue, a cron schedule, and a crash-proof workflow in one file — backed by a single SQLite database."
      href="/docs/quickstart"
      toc={toc}
    >
      <H2 id="install">Install</H2>
      <P>Scaffold a new project (recommended):</P>
      <CommandLine command="npm create zenzipjs-app@latest my-app" />
      <P>Or add ZenZip to an existing project:</P>
      <CommandLine command="npm install zenzipjs" />
      <Callout type="info" title="Package name">
        <p>
          ZenZip publishes to npm as <code>zenzipjs</code> — the{" "}
          <code>zenzip</code> name is reserved on the registry. The import and
          public API are still <code>zenzip</code>:{" "}
          <code>import {"{"} zenzip {"}"} from &quot;zenzipjs&quot;</code>.
          Prebuilt native binaries ship for Windows, macOS (x64 + arm64), and
          Linux (glibc + musl, x64 + arm64), so <code>npm install</code> needs
          no Rust toolchain.
        </p>
      </Callout>
      <P>
        There is nothing else to install. No Redis, no Docker compose, no
        broker. The runtime stores everything in{" "}
        <Code>.zenzip/zenzip.db</Code> — a SQLite database in WAL mode, created
        on first start.
      </P>

      <H2 id="first-app">Your first app</H2>
      <P>
        One file demonstrating all three primitives shipped so far:
      </P>
      <CodeBlock code={firstApp} filename="app.ts" className="mt-6" />
      <P>Three things worth noticing:</P>
      <UL>
        <LI>
          <Strong>Definition before start.</Strong> Queues, schedules, and
          workflows are declared first; <Code>app.start()</Code> boots the
          Rust runtime with everything registered. Pushing or triggering
          before start throws a clear error.
        </LI>
        <LI>
          <Strong>Throw = retry.</Strong> The flaky email handler above will
          be retried with exponential backoff up to its retry budget, then
          dead-lettered — inspect with <Code>emails.deadJobs()</Code>.
        </LI>
        <LI>
          <Strong>Typed payloads.</Strong> <Code>app.queue&lt;T&gt;</Code> and{" "}
          <Code>app.workflow&lt;I, O&gt;</Code> flow types end to end. Add a
          zod schema via the <Code>schema</Code> option for runtime validation
          on push.
        </LI>
      </UL>

      <H2 id="run-it">Run it</H2>
      <CommandLine command="npx tsx app.ts" />
      <P>
        You&apos;ll see the five welcome emails process (some retrying), the
        digest schedule firing every 10 seconds, and the onboarding workflow
        sending its follow-up 5 seconds after the welcome.
      </P>
      <CodeBlock code={stopSnippet} className="mt-6" />

      <H2 id="kill-it">Now kill it</H2>
      <P>
        While it runs, kill the process — not Ctrl-C, actually kill it
        (<Code>taskkill /F</Code> on Windows, <Code>kill -9</Code> elsewhere).
        Then start it again:
      </P>
      <UL>
        <LI>
          In-flight queue jobs are <Strong>redelivered</Strong> after their
          lease expires, with the failed attempt counted against the retry
          budget.
        </LI>
        <LI>
          A workflow mid-sleep <Strong>resumes</Strong> at the right time; its
          completed steps fast-forward from the journal and never re-execute.
        </LI>
        <LI>
          The schedule&apos;s next fire time was persisted — missed ticks
          follow your <Code>catchup</Code> policy.
        </LI>
      </UL>
      <Callout type="tip" title="This is tested, not aspirational">
        <p>
          The repository&apos;s CI includes harnesses that SIGKILL worker
          processes mid-job and mid-workflow (four times in a row, at random
          points) and assert correct recovery. See{" "}
          <a href="/docs/durability" className="underline">
            Durability &amp; Semantics
          </a>
          .
        </p>
      </Callout>

      <H2 id="next-steps">Next steps</H2>
      <UL>
        <LI>
          <A href="/docs/queues">Queues</A> — retries, DLQ, rate limits, batch
          consumers
        </LI>
        <LI>
          <A href="/docs/workflows">Workflows</A> — the full step API:{" "}
          <Code>run</Code>, <Code>sleep</Code>, <Code>waitForEvent</Code>,{" "}
          <Code>invoke</Code>, <Code>all</Code>
        </LI>
        <LI>
          <A href="/docs/durability">Durability &amp; Semantics</A> — the
          guarantees contract
        </LI>
        <LI>
          <A href="/docs/configuration">Configuration</A> — every option on{" "}
          <Code>zenzip()</Code>
        </LI>
      </UL>
    </DocPage>
  );
}
