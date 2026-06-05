import type { Metadata } from "next";

import { CodeBlock } from "@/components/code-block";
import { DocPage } from "@/components/docs/doc-page";
import {
  Callout,
  Code,
  H2,
  LI,
  P,
  PropsTable,
  Strong,
  Table,
  UL,
} from "@/components/docs/typography";

export const metadata: Metadata = { title: "Schedules" };

const toc = [
  { id: "basics", title: "Basics" },
  { id: "specs", title: "Cron & intervals" },
  { id: "options", title: "Options" },
  { id: "overlap", title: "Overlap policy" },
  { id: "catchup", title: "Catch-up policy" },
  { id: "internals", title: "How it works" },
];

const basics = `// Cron string (5-field, optional seconds field supported):
app.schedule("daily-report", "0 9 * * *", async (tick) => {
  // tick: { schedule: "daily-report", firedAt: number }
  await buildReport();
});

// Interval:
app.schedule("heartbeat", { every: "30s" }, async () => ping());

// Full options:
app.schedule(
  "eu-digest",
  {
    cron: "0 8 * * MON-FRI",
    timezone: "Europe/Berlin",
    overlap: "skip",
    catchup: "runOnce",
    jitter: "30s",
  },
  async () => sendDigest(),
);`;

const restartStory = `// Deploy timeline for catchup policies, schedule = every 1h:
//
//   10:00  fires normally
//   10:30  process stops (deploy, crash, laptop lid…)
//   13:45  process starts again — 3 ticks were missed (11:00, 12:00, 13:00)
//
//   catchup: "skip"     → nothing fires; next tick 14:00
//   catchup: "runOnce"  → fires ONCE at 13:45, then 14:00, 15:00, …
//   catchup: "all"      → fires 3 times at 13:45 (capped at 100,
//                          cap is logged, never silent), then 14:00, …`;

export default function Page() {
  return (
    <DocPage
      title="Schedules"
      description="Cron and interval schedules that persist in the store: they survive restarts, respect timezones, and let you choose what happens to missed ticks."
      href="/docs/schedules"
      toc={toc}
    >
      <H2 id="basics">Basics</H2>
      <CodeBlock code={basics} filename="schedules.ts" />
      <P>
        Schedules are validated at <Code>app.start()</Code> — a bad cron
        expression or unknown timezone fails fast with a clear error, not at
        3am when the tick was due.
      </P>

      <H2 id="specs">Cron &amp; intervals</H2>
      <UL>
        <LI>
          <Strong>Cron:</Strong> standard 5-field expressions with an optional
          leading seconds field (<Code>*/10 * * * * *</Code> = every 10s).
          Parsed by the croner engine in Rust.
        </LI>
        <LI>
          <Strong>Timezones:</Strong> any IANA name —{" "}
          <Code>&quot;Asia/Kolkata&quot;</Code>,{" "}
          <Code>&quot;Europe/Berlin&quot;</Code>. Cron evaluation happens in
          that zone, DST handled by the timezone database.
        </LI>
        <LI>
          <Strong>Intervals:</Strong> <Code>{`{ every: "5m" }`}</Code> — next
          fire = previous fire + interval.
        </LI>
      </UL>

      <H2 id="options">Options</H2>
      <PropsTable
        rows={[
          {
            name: "timezone",
            type: "string",
            default: "UTC",
            description: "IANA timezone for cron evaluation.",
          },
          {
            name: "overlap",
            type: `"skip" | "allow" | "queue"`,
            default: `"skip"`,
            description: "What to do when the previous tick is still running.",
          },
          {
            name: "catchup",
            type: `"skip" | "runOnce" | "all"`,
            default: `"skip"`,
            description: "Missed-while-down policy, applied at startup.",
          },
          {
            name: "jitter",
            type: "Duration",
            default: "0",
            description:
              "Random 0..=jitter delivery delay per fire — spreads thundering herds across a fleet of schedules.",
          },
        ]}
      />

      <H2 id="overlap">Overlap policy</H2>
      <Table
        head={["Policy", "Behavior"]}
        rows={[
          [
            <Code key="s">skip</Code>,
            "Don't fire while a previous tick is still pending or running. For idempotent sync-style jobs.",
          ],
          [
            <Code key="q">queue</Code>,
            "Always fire, but execute ticks one at a time in order.",
          ],
          [
            <Code key="a">allow</Code>,
            "Always fire; ticks may run concurrently.",
          ],
        ]}
      />

      <H2 id="catchup">Catch-up policy</H2>
      <P>
        The next fire time is persisted. When a process starts and finds it in
        the past, the catch-up policy decides what happens:
      </P>
      <CodeBlock code={restartStory} lang="text" className="mt-6" />
      <Callout type="warn" title="catchup: 'all' is capped">
        <p>
          A schedule that was down for a month would otherwise flood the
          queue. Replay is capped at 100 fires; hitting the cap logs a warning
          with the number of dropped ticks — never silent.
        </p>
      </Callout>

      <H2 id="internals">How it works</H2>
      <UL>
        <LI>
          Definitions are persisted with a canonical spec string. On restart
          with the <Strong>same spec</Strong>, the stored next-fire time wins
          (continuity); a <Strong>changed spec</Strong> recomputes from now.
        </LI>
        <LI>
          A fire enqueues a job onto a hidden queue{" "}
          (<Code>zenzip.schedule.&lt;name&gt;</Code>) — one engine, so
          schedule execution inherits leases, crash recovery, and graceful
          drain from the <a className="underline" href="/docs/queues">queue engine</a>.
        </LI>
        <LI>
          The overlap policy maps to that queue&apos;s concurrency
          (<Code>skip</Code>/<Code>queue</Code> → 1, <Code>allow</Code> → 8)
          plus an active-count guard for <Code>skip</Code>.
        </LI>
        <LI>
          The scheduler loop ticks in Rust (default 250ms, configurable via{" "}
          <Code>schedulerTick</Code>) — zero JS wakeups between fires.
        </LI>
      </UL>
    </DocPage>
  );
}
