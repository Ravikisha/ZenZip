import Link from "next/link";
import {
  ArrowRight,
  CalendarClock,
  Check,
  Cpu,
  GitFork,
  Layers,
  ListChecks,
  RefreshCcw,
  ShieldCheck,
  Workflow,
  Zap,
} from "lucide-react";

import { CodeBlock, CommandLine } from "@/components/code-block";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";

const heroCode = `import { zenzip } from "zenzip";

const app = zenzip(); // zero config — embedded SQLite WAL store

const order = app.workflow("order", async ({ step, input }) => {
  const payment = await step.run("charge", () => stripe.charge(input));
  await step.sleep("cooloff", "10m");                       // survives restarts
  const ok = await step.waitForEvent("approved", "order.approved", {
    timeout: "1h",
  });
  await step.run("ship", () => shipping.create(payment));   // memoized forever
  return { shipped: true };
});

await app.start();
await order.trigger({ orderId: "o_42" }, { idempotencyKey: "o_42" });`;

const queueCode = `const emails = app.queue("emails", {
  concurrency: 10,
  retries: 5,
  backoff: { delay: "1s", maxDelay: "60s" },
  rateLimit: { max: 100, per: "1m" },
});

emails.process(async (job) => {
  await smtp.send(job.data);          // throw = retry with backoff → DLQ
});

await emails.push({ to: "a@b.co" }, { delay: "5m", priority: 3 });`;

const scheduleCode = `app.schedule("daily-report", "0 9 * * *", async () => {
  await reports.generate();
});

app.schedule(
  "sync",
  { every: "30s", overlap: "skip", catchup: "runOnce" },
  async () => sync(),
);`;

const durableCode = `// kill -9 the process anywhere in here.
// On restart: completed steps fast-forward from the journal,
// execution resumes exactly where durability last advanced.

const importer = app.workflow("import", async ({ step }) => {
  const rows = await step.run("fetch", () => fetchCsv());
  const parsed = await step.run("parse", () => parse(rows));
  await step.all(
    parsed.map((row, i) => () => step.run(\`upsert-\${i}\`, () => db.upsert(row))),
  );
  return parsed.length;
});`;

const replaced = [
  { tool: "BullMQ + Redis", replacement: "app.queue()" },
  { tool: "Temporal cluster", replacement: "app.workflow()" },
  { tool: "node-cron", replacement: "app.schedule()" },
  { tool: "RabbitMQ", replacement: "app.emit()" },
  { tool: "LangGraph", replacement: "app.agent() — Phase 4" },
  { tool: "Grafana setup", replacement: "dashboard — Phase 3" },
];

const features = [
  {
    icon: Workflow,
    title: "Durable workflows",
    body: "Step-memoized execution: every step.run() result is journaled. Crash, deploy, or sleep for a month — runs resume exactly where they left off. No replay determinism rules.",
    href: "/docs/workflows",
  },
  {
    icon: ListChecks,
    title: "Queues without Redis",
    body: "At-least-once delivery on embedded SQLite WAL: leases, exponential backoff, priorities, delays, rate limits, batch consumers, and a dead-letter queue with requeue.",
    href: "/docs/queues",
  },
  {
    icon: CalendarClock,
    title: "Persisted schedules",
    body: "Cron + intervals with IANA timezones that survive restarts. Overlap policies, missed-tick catch-up (skip / runOnce / all), and per-fire jitter.",
    href: "/docs/schedules",
  },
  {
    icon: Cpu,
    title: "Rust runtime core",
    body: "Timers, leases, retries, cron evaluation, and persistence run on a dedicated tokio runtime. Your event loop only ever executes your handlers.",
    href: "/docs/architecture",
  },
  {
    icon: RefreshCcw,
    title: "Crash-tested recovery",
    body: "SIGKILL harnesses in CI: workers killed mid-job and mid-workflow must redeliver with the attempt counted. 4× random kills mid-run still produce the correct output.",
    href: "/docs/durability",
  },
  {
    icon: GitFork,
    title: "Agents are workflows",
    body: "The Phase 4 agent engine compiles LLM loops to dynamic durable steps: tool failures retry without re-calling the model, approvals are waitForEvent gates.",
    href: "/docs/roadmap",
  },
];

const stats = [
  { value: "409k/s", label: "Rust→JS handler dispatches (pipelined ×256)" },
  { value: "14 ns", label: "sync NAPI boundary call" },
  { value: "209k/s", label: "SQLite WAL job inserts (batched)" },
  { value: "51", label: "tests green across Rust + TS" },
];

const phases = [
  { name: "Phase 0 — Boundary spike", status: "done" },
  { name: "Phase 1 — Queues + scheduler", status: "done" },
  { name: "Phase 2 — Durable workflows", status: "done" },
  { name: "Phase 3 — Events, machines, dashboard", status: "done" },
  { name: "Phase 4 — Agent engine", status: "done" },
  { name: "Phase 5 — Postgres multi-node", status: "done" },
];

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -top-40 h-[480px] bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,rgba(139,92,246,0.18),transparent)]"
          />
          <div className="mx-auto grid max-w-7xl items-center gap-14 px-5 pb-20 pt-16 lg:grid-cols-2 lg:pt-24">
            <div>
              <Badge variant="accent">
                <Zap className="size-3" /> Rust core · zero infrastructure
              </Badge>
              <h1 className="mt-5 text-4xl font-bold leading-[1.1] tracking-tight text-ink sm:text-5xl">
                The agent-native backend framework{" "}
                <span className="bg-gradient-to-r from-violet-400 via-fuchsia-400 to-violet-300 bg-clip-text text-transparent">
                  for Node.js
                </span>
              </h1>
              <p className="mt-5 max-w-lg text-base leading-7 text-ink-mid">
                Durable workflows, queues, schedules, and agents on a single
                Rust-powered runtime. No Redis. No Temporal cluster. No
                RabbitMQ. <span className="text-ink">npm install</span> is the
                entire setup.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <ButtonLink href="/docs/quickstart" size="lg">
                  Get started <ArrowRight className="size-4" />
                </ButtonLink>
                <ButtonLink href="/docs/introduction" variant="outline" size="lg">
                  Read the docs
                </ButtonLink>
              </div>
              <div className="mt-8 max-w-md">
                <CommandLine command="npm install zenzip" />
                <p className="mt-2 text-xs text-ink-dim">
                  Pre-1.0 alpha — building in the open. Phases 0–2 shipped and
                  tested.
                </p>
              </div>
            </div>
            <CodeBlock code={heroCode} filename="app.ts" />
          </div>
        </section>

        {/* Replace-your-stack */}
        <section className="border-t border-edge-soft bg-surface/40">
          <div className="mx-auto max-w-7xl px-5 py-16">
            <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.2fr]">
              <div>
                <h2 className="text-2xl font-bold tracking-tight text-ink">
                  Delete six pieces of infrastructure
                </h2>
                <p className="mt-3 text-[15px] leading-7 text-ink-mid">
                  Backend teams glue together a queue broker, a workflow
                  cluster, a cron box, a message bus, and an agent framework —
                  then operate all of it. ZenZip embeds the runtime in your
                  process, the way SQLite replaced &ldquo;install a database
                  server.&rdquo;
                </p>
                <p className="mt-3 text-sm text-ink-dim">
                  Scale-out later? Point the same API at Postgres (Phase 5).
                  Nothing else changes.
                </p>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {replaced.map((item) => (
                  <div
                    key={item.tool}
                    className="flex items-center justify-between gap-3 rounded-xl border border-edge bg-surface px-4 py-3"
                  >
                    <span className="text-sm text-ink-dim line-through decoration-zinc-600">
                      {item.tool}
                    </span>
                    <span className="font-mono text-xs text-accent-soft">
                      {item.replacement}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="mx-auto max-w-7xl px-5 py-20">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-bold tracking-tight text-ink">
              One engine underneath everything
            </h2>
            <p className="mt-3 text-[15px] leading-7 text-ink-mid">
              A queue job is a single-step run. A schedule fires onto a hidden
              queue. A workflow run is a job whose handler drives the step
              journal. An agent is a workflow with dynamic steps. One Rust
              engine — every feature inherits leases, retries, and recovery.
            </p>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => (
              <Link
                key={feature.title}
                href={feature.href}
                className="group rounded-2xl border border-edge bg-surface p-6 transition-colors hover:border-accent/40"
              >
                <div className="grid size-10 place-items-center rounded-lg border border-edge bg-surface-2 text-accent-soft">
                  <feature.icon className="size-5" />
                </div>
                <h3 className="mt-4 font-semibold text-ink group-hover:text-accent-soft">
                  {feature.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-ink-mid">
                  {feature.body}
                </p>
              </Link>
            ))}
          </div>
        </section>

        {/* Code tour */}
        <section className="border-t border-edge-soft bg-surface/40">
          <div className="mx-auto max-w-7xl space-y-16 px-5 py-20">
            <CodeTourRow
              eyebrow="Queues"
              title="BullMQ ergonomics, no Redis"
              body="Push from anywhere, process with bounded concurrency. Failures back off exponentially and dead-letter after the retry budget; requeue them with one call. Token-bucket rate limits and batch consumers built in."
              href="/docs/queues"
              code={queueCode}
              filename="queues.ts"
            />
            <CodeTourRow
              eyebrow="Schedules"
              title="Cron that survives deploys"
              body="Schedules persist in the store with their next fire time. Restart a month later and choose what happens to missed ticks: skip them, fire once, or replay all. Timezone-aware via IANA names."
              href="/docs/schedules"
              code={scheduleCode}
              filename="schedules.ts"
              flip
            />
            <CodeTourRow
              eyebrow="Durability"
              title="kill -9 is a test case, not an incident"
              body="Steps are memoized in a journal. Our CI literally SIGKILLs workers mid-step, four times in a row, and asserts the run completes with the correct output and no lost steps."
              href="/docs/durability"
              code={durableCode}
              filename="import.ts"
            />
          </div>
        </section>

        {/* Numbers */}
        <section className="mx-auto max-w-7xl px-5 py-20">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold tracking-tight text-ink">
                Measured, not promised
              </h2>
              <p className="mt-3 max-w-xl text-[15px] leading-7 text-ink-mid">
                Every architecture decision was settled by a benchmark before a
                line of engine code was written — including the one that killed
                our own Rust HTTP server idea.
              </p>
            </div>
            <ButtonLink href="/docs/benchmarks" variant="outline">
              Read the spike results <ArrowRight className="size-4" />
            </ButtonLink>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {stats.map((stat) => (
              <div
                key={stat.label}
                className="rounded-2xl border border-edge bg-surface p-6"
              >
                <div className="font-mono text-3xl font-semibold text-ink">
                  {stat.value}
                </div>
                <p className="mt-2 text-sm leading-6 text-ink-dim">
                  {stat.label}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Roadmap strip */}
        <section className="border-t border-edge-soft bg-surface/40">
          <div className="mx-auto max-w-7xl px-5 py-20">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold tracking-tight text-ink">
                  Built in serial phases, each gated by tests
                </h2>
                <p className="mt-3 max-w-xl text-[15px] leading-7 text-ink-mid">
                  No phase starts until the previous one&apos;s exit criteria
                  pass — chaos suites included.
                </p>
              </div>
              <ButtonLink href="/docs/roadmap" variant="outline">
                Full roadmap <ArrowRight className="size-4" />
              </ButtonLink>
            </div>
            <ol className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {phases.map((phase) => (
                <li
                  key={phase.name}
                  className="flex items-center gap-3 rounded-xl border border-edge bg-surface px-4 py-3.5"
                >
                  {phase.status === "done" ? (
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-400">
                      <Check className="size-3.5" />
                    </span>
                  ) : phase.status === "next" ? (
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/15">
                      <span className="size-2 animate-pulse rounded-full bg-accent" />
                    </span>
                  ) : (
                    <span className="grid size-6 shrink-0 place-items-center rounded-full border border-edge">
                      <span className="size-1.5 rounded-full bg-zinc-600" />
                    </span>
                  )}
                  <span className="text-sm text-ink-mid">{phase.name}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* CTA */}
        <section className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[320px] bg-[radial-gradient(ellipse_50%_60%_at_50%_100%,rgba(139,92,246,0.14),transparent)]"
          />
          <div className="mx-auto max-w-3xl px-5 py-24 text-center">
            <div className="mx-auto grid size-12 place-items-center rounded-2xl border border-edge bg-surface">
              <ShieldCheck className="size-6 text-accent-soft" />
            </div>
            <h2 className="mt-6 text-3xl font-bold tracking-tight text-ink">
              Reliability you can <span className="font-mono">kill -9</span>
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-[15px] leading-7 text-ink-mid">
              Start with the quickstart: a durable workflow, a queue, and a
              cron schedule in one file, backed by a single SQLite database in
              your project folder.
            </p>
            <div className="mt-8 flex justify-center gap-3">
              <ButtonLink href="/docs/quickstart" size="lg">
                Quickstart <ArrowRight className="size-4" />
              </ButtonLink>
              <ButtonLink href="/docs/architecture" variant="outline" size="lg">
                <Layers className="size-4" /> How it works
              </ButtonLink>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

function CodeTourRow({
  eyebrow,
  title,
  body,
  href,
  code,
  filename,
  flip,
}: {
  eyebrow: string;
  title: string;
  body: string;
  href: string;
  code: string;
  filename: string;
  flip?: boolean;
}) {
  return (
    <div className="grid items-center gap-10 lg:grid-cols-2">
      <div className={flip ? "lg:order-2" : undefined}>
        <span className="font-mono text-xs uppercase tracking-widest text-accent-soft">
          {eyebrow}
        </span>
        <h3 className="mt-3 text-xl font-bold tracking-tight text-ink">
          {title}
        </h3>
        <p className="mt-3 text-[15px] leading-7 text-ink-mid">{body}</p>
        <Link
          href={href}
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-accent-soft hover:text-violet-300"
        >
          Learn more <ArrowRight className="size-3.5" />
        </Link>
      </div>
      <CodeBlock
        code={code}
        filename={filename}
        className={flip ? "lg:order-1" : undefined}
      />
    </div>
  );
}
