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
  PropsTable,
  Strong,
  Table,
  UL,
} from "@/components/docs/typography";

export const metadata: Metadata = { title: "Agents" };

const toc = [
  { id: "model", title: "Agents are workflows" },
  { id: "defining", title: "Defining an agent" },
  { id: "tools", title: "Tools" },
  { id: "mcp", title: "MCP tools" },
  { id: "approval", title: "Human-in-the-loop" },
  { id: "sessions", title: "Session memory" },
  { id: "memory", title: "Tiered memory" },
  { id: "handoff", title: "Multi-agent handoff" },
  { id: "networks", title: "Multi-agent networks" },
  { id: "resilience", title: "Circuit breakers" },
  { id: "output", title: "Structured output" },
  { id: "evals", title: "Evals" },
  { id: "providers", title: "Providers" },
  { id: "options", title: "Options" },
];

const defining = `import { anthropic, tool, zenzip } from "zenzip";

const app = zenzip();

const searchDocs = tool({
  name: "search_docs",
  description: "Search the help center.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  execute: async ({ query }) => helpCenter.search(query),
});

const support = app.agent("support", {
  provider: anthropic(),               // ANTHROPIC_API_KEY from env
  model: "claude-sonnet-4-6",
  instructions: "You are a support agent. Use the tools.",
  tools: [searchDocs],
  maxIterations: 8,
});

await app.start();

const result = await support.run("My order is late!", { sessionId: "cus_42" });
// → { text, usage: { totalTokens }, iterations, toolCalls }`;

const durability = `// What the journal looks like for one agent run:
//
//   session            (kind: run)    history snapshot
//   llm-0              (kind: run)    full model response, journaled
//   tool-0-tu_abc      (kind: run)    tool result, retried w/ backoff on throw
//   llm-1              (kind: run)    next round-trip
//   save-session       (kind: run)
//
// Crash anywhere → resume fast-forwards through recorded steps.
// A flaky tool retries WITHOUT re-calling the model: llm-0 is already
// journaled. Verified by test: tool fails twice, provider.calls === 2.`;

const approval = `const sendRefund = tool({
  name: "send_refund",
  description: "Refund an order.",
  parameters: { type: "object", properties: { orderId: { type: "string" } } },
  requiresApproval: true,            // ← durable pause before every call
  execute: async ({ orderId }) => payments.refund(orderId),
});

// The run suspends in waitForEvent — zero resources, survives restarts.
// From your admin panel / Slack bot / REPL:
support.approve(runId, toolUseId);
support.deny(runId, toolUseId, "amount too high");
// Timeout (default 1h) resolves as denied; the model is told either way.`;

const sessions = `await support.run("My name is Ada.", { sessionId: "cus_7" });
await support.run("What's my name?", { sessionId: "cus_7" });
// → "Your name is Ada." — history persisted in the store (windowed)

const transcript = await support.session("cus_7");  // LlmMessage[]`;

const mcpCode = `import { mcp } from "zenzip";

// CONSUME — connect to an MCP server and use its tools. Connecting is
// async, so spread the result into the agent's tools:
const app = zenzip();
app.agent("research", {
  model: anthropic(),
  tools: [
    ...(await mcp("https://mcp.example.com/")),   // every MCP tool
    ...(await mcp({ url: "https://other/", prefix: "x_", headers: { authorization }, ssrf: true })),
    searchDocs,                                    // local tools alongside
  ],
});`;

const mcpServerCode = `// AUTHOR — expose this app's workflows + agents AS an MCP server,
// so other agents can call them durably.
await app.start();
await app.mcpServer({ port: 4200, token: process.env.MCP_TOKEN });
//   workflows: true | ["only", "these"]   — what to expose (default: all)
//   agents:    true | ["only", "these"]
//   wait: "60s" | false                   — triggerAndWait, or return { runId }

// Or embed the endpoint in an existing server instead of a standalone one:
http.createServer(app.mcpHandler()).listen(4200);`;

const handoff = `import { handoffTool } from "zenzip";

const researcher = app.agent("researcher", { provider, model, tools: [webSearch] });

const planner = app.agent("planner", {
  provider,
  model,
  tools: [handoffTool(researcher)],   // exposes ask_researcher to the model
});
// The child runs as a durable child workflow (step.invoke): own journal,
// own retries; cancelling the parent cancels it.`;

const output = `import { z } from "zod";

const classifier = app.agent("classifier", {
  provider,
  model: "claude-sonnet-4-6",
  output: z.object({ sentiment: z.enum(["pos", "neg"]), score: z.number() }),
});

const { output } = await classifier.run("Classify: great product!");
// output is parsed + validated; one corrective round on invalid JSON,
// then the run fails with the validation error.`;

const providers = `import { anthropic, openaiCompatible, mockProvider, mockText, mockToolUse } from "zenzip";

anthropic({ apiKey })                       // Messages API, tool use, SSE
                                            // streaming, prompt caching on
                                            // system + tools

openaiCompatible({ baseUrl, apiKey })       // OpenAI / Ollama / vLLM /
                                            // OpenRouter — function calling

googleGemini({ apiKey })                    // Gemini generateContent +
                                            // function calling

bedrock({ region, accessKeyId,             // Anthropic Claude on AWS Bedrock,
          secretAccessKey })               // SigV4-signed

mockProvider([                              // deterministic tests, offline dev
  mockToolUse("search", { q: "x" }, { id: "tu_1" }),
  mockText("final answer"),
])`;

export default function Page() {
  return (
    <DocPage
      title="Agents"
      description="Durable LLM agents: every model call and tool execution is a journaled workflow step — crash recovery, retries without re-prompting, human approval gates, and dashboard traces for free."
      href="/docs/agents"
      toc={toc}
    >
      <H2 id="model">Agents are workflows</H2>
      <P>
        An agent loop — model call → tool calls → model call → answer — is a{" "}
        <A href="/docs/workflows">durable workflow</A> whose steps are
        generated dynamically. That single design decision is where every
        guarantee comes from:
      </P>
      <CodeBlock code={durability} lang="text" className="mt-6" />
      <UL>
        <LI>
          <Strong>Tool failures never re-prompt.</Strong> The model response
          is journaled before tools run; retries replay it.
        </LI>
        <LI>
          <Strong>Crashes resume.</Strong> A deploy mid-conversation continues
          at the exact step durability last advanced.
        </LI>
        <LI>
          <Strong>Everything is observable.</Strong> Agent runs appear in the{" "}
          <A href="/docs/http-dashboard">dashboard</A> as{" "}
          <Code>agent:&lt;name&gt;</Code> workflows — every prompt, tool call,
          and token count in the step detail.
        </LI>
      </UL>

      <H2 id="defining">Defining an agent</H2>
      <CodeBlock code={defining} filename="support.ts" />

      <H2 id="tools">Tools</H2>
      <P>
        <Code>tool()</Code> takes JSON-Schema <Code>parameters</Code> (what the
        model sees) and an optional Standard Schema <Code>schema</Code>{" "}
        (runtime validation of the model&apos;s arguments — invalid input
        throws into the retry path). Results are JSON-serialized back to the
        model. Throwing marks the step failed: retried with backoff per{" "}
        <Code>stepRetries</Code>, then the run fails with a precise error.
      </P>
      <P>
        If a tool fetches a model- or user-supplied URL, guard it with{" "}
        <Code>assertPublicUrl(url)</Code> before fetching — it
        resolve-then-validates the host and rejects private / loopback /
        link-local / cloud-metadata targets (SSRF). The built-in{" "}
        <Code>mcp(url)</Code> takes <Code>ssrf: true</Code> to apply the same
        guard.
      </P>

      <H2 id="mcp">MCP tools</H2>
      <P>
        <Code>mcp(url)</Code> connects to a Model Context Protocol server over
        Streamable HTTP, lists its tools, and returns them as ZenZip agent
        tools. Each call runs inside the agent&apos;s journaled tool step — so
        an MCP call is durable and retried like any other step. Connecting is
        async; spread the result into <Code>tools</Code>.
      </P>
      <CodeBlock code={mcpCode} filename="mcp.ts" />
      <P>
        The reverse direction works too: <Code>app.mcpServer()</Code> exposes
        your own workflows and agents <Strong>as</Strong> an MCP server, so
        other agents can call them durably — a workflow tool triggers a run, an
        agent tool runs the agent.
      </P>
      <CodeBlock code={mcpServerCode} filename="mcp-server.ts" />

      <H2 id="approval">Human-in-the-loop</H2>
      <CodeBlock code={approval} filename="approval.ts" />
      <P>
        The pause is a <Code>waitForEvent</Code> with a match predicate on{" "}
        <Code>(runId, toolUseId)</Code> — it holds across restarts and
        deploys, and the operator decision arrives as a normal event.
      </P>

      <H2 id="sessions">Session memory</H2>
      <CodeBlock code={sessions} filename="sessions.ts" />
      <P>
        Sessions persist in the embedded store (<Code>historyWindow</Code>{" "}
        most-recent messages, default 20). The history snapshot is itself a
        journaled step, so resumed runs see the conversation exactly as it was
        when the run started.
      </P>

      <H2 id="memory">Tiered memory</H2>
      <P>
        Session memory is the recent window. <Strong>Tiered memory</Strong> adds
        two more tiers, opt-in via <Code>memory</Code>: <Strong>semantic
        recall</Strong> (embed + retrieve the most relevant past facts and inject
        them into the prompt) and <Strong>working memory</Strong> (compress old
        turns into a summary so long sessions keep fitting the context window).
        Recall + remember run inside durable steps, so they&apos;re journaled and
        never re-run on replay.
      </P>
      <CodeBlock
        code={`import { AgentMemory, openaiEmbeddings } from "zenzip";

const memory = new AgentMemory({
  embeddings: openaiEmbeddings({ apiKey: process.env.OPENAI_API_KEY }),
  // store: new PgVectorStore(...),  // default is in-memory (process-local)
  topK: 4,
  provider, model,                  // enables working-memory compression
});

const agent = app.agent("support", { provider, model, memory });`}
        filename="memory.ts"
      />
      <Callout type="warn" title="Durable recall needs a shared store">
        <p>
          The default <Code>InMemoryVectorStore</Code> is process-local and lost
          on restart. For production durable, cross-node recall, implement the{" "}
          <Code>MemoryStore</Code> interface over pgvector or a vector database.
        </p>
      </Callout>

      <H2 id="handoff">Multi-agent handoff</H2>
      <CodeBlock code={handoff} filename="handoff.ts" />

      <H2 id="networks">Multi-agent networks</H2>
      <P>
        <Code>handoffTool</Code> is 1:1 delegation. A <Strong>network</Strong>{" "}
        is the 1:N generalization: a <Strong>coordinator</Strong> that routes
        each request to the right specialist — and may consult several in
        sequence — then composes the final answer. The coordinator is itself a
        durable agent whose tools are handoffs to every member, so each
        delegation runs as a child workflow with its own journal, retries, and
        cancellation propagation.
      </P>
      <CodeBlock
        code={`import { zenzip } from "zenzip";

const app = zenzip();

const billing = app.agent("billing", { provider, model, instructions: "Refunds + invoices." });
const tech    = app.agent("tech",    { provider, model, instructions: "Troubleshooting." });

const support = app.network("support", {
  provider, model,
  agents: [billing, tech],            // or { agent, description } for richer routing
  maxHandoffs: 4,                     // routing hops before it must answer
});

await app.start();
const res = await support.run("I was double-charged and the app crashes");
// → coordinator delegates to billing (and/or tech), then summarizes`}
        filename="network.ts"
      />
      <P>
        <Code>network.run()</Code> / <Code>network.trigger()</Code> behave like
        an agent&apos;s. Routing is one-way (coordinator → specialist); the
        per-run iteration cap bounds hops, so a misrouting can&apos;t loop
        forever.
      </P>

      <H2 id="resilience">Circuit breakers</H2>
      <P>
        When an LLM provider (or any external dependency) starts failing,
        retrying just piles load onto a service that is already down. A{" "}
        <Strong>circuit breaker</Strong> opens after a threshold of failures and
        makes subsequent calls <Strong>fail fast</Strong>, then probes for
        recovery (half-open → closed). Set one on an agent to guard its model
        calls:
      </P>
      <CodeBlock
        code={`const agent = app.agent("support", {
  provider, model,
  circuitBreaker: {
    failureThreshold: 5,    // consecutive failures trip it open
    resetTimeout: "30s",    // then allow a probe (half-open)
    maxConcurrent: 20,      // bulkhead: cap in-flight calls
  },
});`}
        filename="agent.ts"
      />
      <P>
        The breaker is process-local and shared across the agent&apos;s runs —
        it protects the live process, so it is deliberately not journaled (a
        retried step re-evaluates the live circuit). The same primitive is
        exported for wrapping <em>your</em> external calls — third-party HTTP in
        a tool, a webhook fan-out, anything:
      </P>
      <CodeBlock
        code={`import { circuitBreaker, CircuitOpenError } from "zenzip";

const payments = circuitBreaker({ failureThreshold: 3, resetTimeout: "10s" });

try {
  const res = await payments.run(() => fetch("https://payments.example/charge"));
} catch (e) {
  if (e instanceof CircuitOpenError) {
    // fail fast — Stripe is down, don't hammer it
  }
}`}
        filename="breaker.ts"
      />

      <H2 id="output">Structured output</H2>
      <CodeBlock code={output} filename="classifier.ts" />

      <H2 id="evals">Evals</H2>
      <P>
        Score outputs to gate deploys and regression-test prompts the way you
        unit-test code. Evaluators are pure functions over a sample —{" "}
        <Strong>rule-based</Strong> (<Code>contains</Code>, <Code>matches</Code>,{" "}
        <Code>equals</Code>, <Code>jsonValid</Code>), <Strong>statistical</Strong>{" "}
        (<Code>similarity</Code>), or <Strong>model-graded</Strong>{" "}
        (<Code>llmJudge</Code>, a separate LLM scores against a rubric).
        Aggregate one sample with <Code>evaluate()</Code> or a whole suite with{" "}
        <Code>runEvals()</Code>.
      </P>
      <CodeBlock
        code={`import { runEvals, contains, jsonValid, llmJudge, anthropic } from "zenzip";

const judge = llmJudge({
  provider: anthropic(), model: "claude-sonnet-4-6",
  rubric: "Answers the question accurately and politely.",
  threshold: 0.7,
});

const report = await runEvals(
  cases.map((c) => ({ input: c.q, output: await agent.run(c.q).then((r) => r.text) })),
  [contains("sorry", { ignoreCase: true }), jsonValid(), judge],
);

if (!report.passed) throw new Error(\`eval gate failed: \${report.passRate * 100}% passed\`);`}
        filename="evals.ts"
      />

      <H2 id="providers">Providers</H2>
      <CodeBlock code={providers} filename="providers.ts" />
      <P>
        Providers are ~150 lines of fetch each — the durability machinery
        lives below them, so adding one means mapping messages, not rebuilding
        reliability. Streaming: pass <Code>onToken</Code> to{" "}
        <Code>agent.run()</Code>; live runs stream (Anthropic SSE), memoized
        replays never re-stream.
      </P>
      <P>
        <Strong>Cost accounting:</Strong> every <Code>agent.run()</Code>{" "}
        result carries <Code>usage</Code> (token counts) and{" "}
        <Code>costUsd</Code> — an estimate from a built-in per-model price table.
        Prices drift; override with{" "}
        <Code>registerPricing(&quot;model-prefix&quot;, &#123; input, output &#125;)</Code>{" "}
        (USD per 1M tokens), or compute directly via{" "}
        <Code>costOf(model, usage)</Code>.
      </P>

      <H2 id="options">Options</H2>
      <PropsTable
        rows={[
          { name: "provider", type: "LlmProvider", description: "anthropic() / openaiCompatible() / mockProvider() / yours." },
          { name: "model", type: "string", description: "Passed through to the provider." },
          { name: "instructions", type: "string", description: "System prompt (cached on Anthropic)." },
          { name: "tools", type: "AgentTool[]", description: "Available tools, incl. handoffTool()." },
          { name: "maxIterations", type: "number", default: "10", description: "Hard cap on model round-trips; exceeding fails the run." },
          { name: "maxTotalTokens", type: "number", description: "Token budget across the run; exceeding fails the run." },
          { name: "maxTokens", type: "number", default: "4096", description: "Per-call output cap." },
          { name: "historyWindow", type: "number", default: "20", description: "Session messages kept." },
          { name: "approvalTimeout", type: "Duration", default: `"1h"`, description: "Approval gates resolve as denied after this." },
          { name: "output", type: "StandardSchemaV1", description: "Validate the final answer as JSON (one corrective round)." },
          { name: "stepRetries", type: "number", default: "2", description: "Retries per step (tools, model calls)." },
          { name: "lease", type: "Duration", default: `"5m"`, description: "Crash-redelivery horizon — covers slow model calls." },
          { name: "circuitBreaker", type: "CircuitBreakerOptions", description: "Fail-fast guard around model calls: failureThreshold, resetTimeout, halfOpenMax, maxConcurrent." },
        ]}
      />
      <Table
        head={["Run API", "What it does"]}
        rows={[
          [<Code key="1">agent.run(msg, opts)</Code>, "trigger + wait; throws on failure; onToken streams"],
          [<Code key="2">agent.trigger(msg, opts)</Code>, "fire-and-forget durable run (idempotencyKey supported)"],
          [<Code key="3">agent.approve / deny</Code>, "resolve a pending approval gate"],
          [<Code key="4">agent.getRun / cancel</Code>, "inspect / cancel (children included)"],
          [<Code key="5">agent.session(id)</Code>, "stored conversation"],
        ]}
      />
      <Callout type="info" title="Try it offline">
        <p>
          <code>examples/support-agent</code> runs the full search → approval →
          refund flow with a scripted mock provider — no API key — and shows it
          live in the dashboard. Set <code>ANTHROPIC_API_KEY</code> to run the
          same demo on Claude.
        </p>
      </Callout>
    </DocPage>
  );
}
