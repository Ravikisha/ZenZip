import type { Metadata } from "next";

import { CodeBlock } from "@/components/code-block";
import { DocPage } from "@/components/docs/doc-page";
import { A, Code, H2, LI, P, Strong, Table, UL } from "@/components/docs/typography";

export const metadata: Metadata = {
  title: "Production & Deployment",
  description:
    "Take a ZenZip app to production: secrets, encryption at rest, health probes, security, observability, multi-tenancy, scaling to Postgres, and Kubernetes.",
  alternates: { canonical: "/docs/production" },
  openGraph: {
    title: "Production & Deployment · ZenZip",
    description:
      "Take a ZenZip app to production: secrets, encryption at rest, health probes, security, observability, multi-tenancy, scaling to Postgres, and Kubernetes.",
    url: "/docs/production",
    type: "article",
  },
};

const toc = [
  { id: "models", title: "Deployment models" },
  { id: "secrets", title: "Secrets & config" },
  { id: "encryption", title: "Encryption & retention" },
  { id: "health", title: "Health & graceful shutdown" },
  { id: "security", title: "App security" },
  { id: "observability", title: "Logs, errors, alerts" },
  { id: "tenancy", title: "Multi-tenancy & PII" },
  { id: "scaling", title: "Scaling to Postgres" },
  { id: "containers", title: "Containers & Kubernetes" },
  { id: "checklist", title: "Production checklist" },
];

const prodConfig = `import { zenzip, sentryReporter, pinoLogger, resolveSecret } from "zenzipjs";
import pino from "pino";
import * as Sentry from "@sentry/node";

const app = zenzip({
  // Storage: embedded SQLite (single node) → Postgres for multi-node.
  store: process.env.DATABASE_URL
    ? { driver: "postgres", url: process.env.DATABASE_URL }
    : { driver: "sqlite" },
  dataDir: "/data",

  // Secrets from the environment / mounted files — never hard-coded.
  encryptionKey: resolveSecret("env:ZENZIP_ENCRYPTION_KEY"),

  // Retention: bound how long durable data lives.
  retention: { runs: "30d", events: "7d", sweep: "1h" },

  // Observability.
  logLevel: "info",
  logger: pinoLogger(pino()),
  onError: sentryReporter(Sentry),
  alerts: { onAlert: (a) => Sentry.captureMessage(a.message), dlqThreshold: 25 },
});`;

const drain = `// SIGTERM (k8s rollout) → app.stop() drains HTTP + in-flight jobs.
// handleSignals: true (default) wires this for you. To drain manually:
process.on("SIGTERM", async () => {
  const clean = await app.stop({ timeout: "30s", httpDrain: "10s" });
  process.exit(clean ? 0 : 1);
});`;

const pii = `// Tag runs with a data subject at trigger time…
await onboarding.trigger({ userId }, { subject: userId });

// …then honor a GDPR erasure request:
const removed = await app.purgeSubject(userId); // deletes that user's runs + steps`;

export default function Page() {
  return (
    <DocPage
      title="Production & Deployment"
      description="Everything to take a ZenZip app to production: secrets, encryption, health probes, security, observability, multi-tenancy, scaling to Postgres, and containers."
      href="/docs/production"
      toc={toc}
    >
      <P>
        ZenZip is a single Node process that embeds the engine — there is no
        broker, scheduler, or worker fleet to run alongside it. A production
        deploy is mostly about <Strong>configuration</Strong>: secrets,
        retention, health, and observability. Here&apos;s the whole picture.
      </P>
      <CodeBlock code={prodConfig} filename="app.ts" />

      <H2 id="models">Deployment models</H2>
      <Table
        head={["Model", "Store", "Notes"]}
        rows={[
          [
            <Strong key="1">Single node</Strong>,
            "embedded SQLite (WAL)",
            "Zero infra. Mount a volume at dataDir so state survives restarts. Vertical scale.",
          ],
          [
            <Strong key="2">Multi node</Strong>,
            "Postgres",
            "N replicas, one config line. Cross-node claims, scheduler election, and recovery are handled by the engine.",
          ],
          [
            <Strong key="3">Embedded</Strong>,
            "either",
            "Mount into an existing server via toNodeHandler() / toFetchHandler() (Next.js, Hono, Bun, edge).",
          ],
        ]}
      />

      <H2 id="secrets">Secrets &amp; config</H2>
      <UL>
        <LI>
          Resolve secrets with <Code>resolveSecret(&quot;env:NAME&quot;)</Code>{" "}
          or <Code>resolveSecret(&quot;file:/run/secrets/key&quot;)</Code>{" "}
          (Docker/k8s secret mounts) — never hard-code keys.
        </LI>
        <LI>
          <Code>redactSecrets(obj)</Code> deep-masks tokens, passwords, and
          connection-URL credentials before you log a config/state dump.
        </LI>
        <LI>
          <Code>validateConfig(options)</Code> runs at <Code>start()</Code> and
          fails fast on misconfiguration.
        </LI>
      </UL>

      <H2 id="encryption">Encryption &amp; retention</H2>
      <UL>
        <LI>
          <Strong>Encrypt at rest:</Strong> set <Code>encryptionKey</Code>{" "}
          and job payloads, run inputs/outputs, step results, and event payloads
          are AES-256-GCM encrypted in the store. Transparent to enable on an
          existing DB.
        </LI>
        <LI>
          <Strong>Retention:</Strong> a background sweep deletes aged
          terminal runs and old events so the store never grows unbounded — set{" "}
          <Code>retention</Code> windows. On Postgres the event outbox is
          range-partitioned, so GC reclaims space by dropping partitions.
        </LI>
      </UL>

      <H2 id="health">Health &amp; graceful shutdown</H2>
      <P>
        <Code>/healthz</Code> (liveness, zero I/O) and <Code>/readyz</Code>{" "}
        (readiness — store reachable, 503 until ready) are auto-registered. Gate
        load balancers and rolling deploys on <Code>/readyz</Code>. On{" "}
        <Code>SIGTERM</Code>, <Code>app.stop()</Code> drains in-flight HTTP and
        jobs:
      </P>
      <CodeBlock code={drain} filename="shutdown.ts" />

      <H2 id="security">App security</H2>
      <Table
        head={["Concern", "Built-in"]}
        rows={[
          [<Strong key="1">AuthN</Strong>, "zenzip.auth() — Bearer / API key, or a verify() JWT/OIDC seam"],
          [<Strong key="2">Validation</Strong>, "zenzip.validate() — Standard Schema body/query → auto-400"],
          [<Strong key="3">Headers</Strong>, "zenzip.secureHeaders() — nosniff, frame-options, HSTS, opt-in CSP"],
          [<Strong key="4">CSRF</Strong>, "zenzip.csrf() — origin/referer guard for state-changing methods"],
          [<Strong key="5">Rate limit</Strong>, "zenzip.rateLimit() — per-IP/key fixed window → 429"],
          [<Strong key="6">SSRF</Strong>, "assertPublicUrl() on user-controlled fetches"],
          [<Strong key="7">Dashboard RBAC</Strong>, "operator vs read-only tokens"],
          [<Strong key="8">Audit</Strong>, "onAudit — privileged actions (trigger/cancel/requeue/approve/purge)"],
        ]}
      />

      <H2 id="observability">Logs, errors, alerts</H2>
      <UL>
        <LI>
          <Strong>Logs:</Strong> pipe engine logs into your stack with{" "}
          <Code>pinoLogger(pino())</Code> or <Code>winstonLogger(w)</Code>.
        </LI>
        <LI>
          <Strong>Errors:</Strong> <Code>onError: sentryReporter(Sentry)</Code>{" "}
          captures background-loop + log errors; mount{" "}
          <Code>captureErrors(reporter)</Code> as error middleware for HTTP.
        </LI>
        <LI>
          <Strong>Alerts:</Strong> <Code>alerts</Code> fires{" "}
          <Code>onAlert</Code> on dead-letter-queue growth and stuck runs — wire
          it to PagerDuty/Slack. Inspect stalls with{" "}
          <Code>app.orphanedRuns()</Code>.
        </LI>
      </UL>

      <H2 id="tenancy">Multi-tenancy &amp; PII</H2>
      <UL>
        <LI>
          <Strong>Namespaces:</Strong>{" "}
          <Code>const t = app.namespace(tenantId)</Code> scopes every queue,
          workflow, schedule, agent, and event with a <Code>tenantId:</Code>{" "}
          prefix — one tenant&apos;s events never wake another&apos;s triggers.
          (Logical isolation within one store; for hard isolation give each
          tenant its own database.)
        </LI>
        <LI>
          <Strong>PII erasure:</Strong> tag runs with a{" "}
          <Code>subject</Code> and erase on request.
        </LI>
      </UL>
      <CodeBlock code={pii} filename="gdpr.ts" />

      <H2 id="scaling">Scaling to Postgres</H2>
      <P>
        Point the same API at Postgres and run N replicas — claims use{" "}
        <Code>SKIP LOCKED</Code>, cross-node wakeups ride{" "}
        <Code>LISTEN/NOTIFY</Code>, and the scheduler elects a leader via an
        advisory lock. Bound the pool and statement timeouts are pre-set for
        fail-fast recovery. Use a separate read replica for the
        dashboard if needed. Validated by a 3-node kill-a-node chaos test.
      </P>

      <H2 id="containers">Containers &amp; Kubernetes</H2>
      <P>
        Reference artifacts live in <Code>deploy/</Code>: a multi-stage{" "}
        <Code>Dockerfile</Code> (Alpine via musl prebuilds, non-root,{" "}
        <Code>HEALTHCHECK</Code>), a Kubernetes <Code>StatefulSet</Code> + Service
        with <Code>/healthz</Code>·<Code>/readyz</Code> probes and a drain{" "}
        <Code>preStop</Code>, and a parameterized Helm chart. Single-node keeps{" "}
        <Code>replicas: 1</Code> with a PVC; multi-node sets Postgres and scales
        out. See <A href="/docs/architecture">Architecture</A>.
      </P>

      <H2 id="checklist">Production checklist</H2>
      <UL>
        <LI>✅ Secrets via env/file, not literals; <Code>encryptionKey</Code> set if you store PII.</LI>
        <LI>✅ <Code>retention</Code> windows set so the store is bounded.</LI>
        <LI>✅ Load balancer / k8s probes gated on <Code>/readyz</Code>; <Code>SIGTERM</Code> drains.</LI>
        <LI>✅ <Code>auth</Code>/<Code>validate</Code>/<Code>secureHeaders</Code>/<Code>csrf</Code>/<Code>rateLimit</Code> on public routes; dashboard behind RBAC tokens.</LI>
        <LI>✅ <Code>logger</Code> + <Code>onError</Code> + <Code>alerts</Code> wired to your stack.</LI>
        <LI>✅ Postgres for &gt;1 replica; SQLite volume mounted otherwise.</LI>
        <LI>✅ A <Code>purgeSubject</Code> path for data-erasure requests.</LI>
      </UL>
    </DocPage>
  );
}
