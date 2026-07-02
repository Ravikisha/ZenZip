// ZenZip support agent demo (P4.15): three tools, one approval gate,
// session memory, durable runs visible in the dashboard.
//
// Runs OFFLINE by default (scripted mock provider). Set ANTHROPIC_API_KEY
// to use Claude for real:
//   pnpm --filter @zenzipjs/example-support-agent start
import {
  anthropic,
  mockProvider,
  mockText,
  mockToolUse,
  tool,
  zenzip,
} from "zenzip";

const app = zenzip({ dataDir: ".zenzip-agent", logLevel: "info" });

// --- Tools -----------------------------------------------------------------

const searchDocs = tool({
  name: "search_docs",
  description: "Search the help center for relevant articles.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  execute: async ({ query }) => {
    console.log(`  [tool] search_docs("${query}")`);
    return [
      { title: "Shipping times", snippet: "Standard shipping takes 3-5 business days." },
      { title: "Late orders", snippet: "Orders >7 days late qualify for a refund." },
    ];
  },
});

const createTicket = tool({
  name: "create_ticket",
  description: "Open a support ticket for a human follow-up.",
  parameters: {
    type: "object",
    properties: { subject: { type: "string" }, body: { type: "string" } },
    required: ["subject"],
  },
  execute: async ({ subject }) => {
    console.log(`  [tool] create_ticket("${subject}")`);
    return { ticketId: `T-${Math.floor(Math.random() * 9000) + 1000}` };
  },
});

const sendRefund = tool({
  name: "send_refund",
  description: "Refund the customer's order. Requires operator approval.",
  parameters: {
    type: "object",
    properties: { orderId: { type: "string" }, amount: { type: "number" } },
    required: ["orderId", "amount"],
  },
  requiresApproval: true, // durable human-in-the-loop gate
  execute: async ({ orderId, amount }) => {
    console.log(`  [tool] send_refund(${orderId}, $${amount})`);
    return { refunded: true, orderId, amount };
  },
});

// --- Provider: real Claude if a key is set, scripted mock otherwise --------

const provider = process.env.ANTHROPIC_API_KEY
  ? anthropic()
  : mockProvider([
      mockToolUse("search_docs", { query: "late order refund policy" }, { id: "tu_1" }),
      mockToolUse("send_refund", { orderId: "ord_42", amount: 29.99 }, { id: "tu_2" }),
      mockText(
        "Your order is over a week late, which qualifies for a refund — I've issued $29.99 back to your card.",
      ),
    ]);

const support = app.agent("support", {
  provider,
  model: "claude-sonnet-4-6",
  instructions:
    "You are a support agent for an e-commerce store. Use the tools to help. " +
    "Refunds require the send_refund tool.",
  tools: [searchDocs, createTicket, sendRefund],
  maxIterations: 8,
});

// --- Run -------------------------------------------------------------------

await app.start();
const { port } = await app.dashboard();
console.log(`dashboard → http://127.0.0.1:${port}\n`);

const { runId } = await support.trigger(
  "My order ord_42 is 10 days late. I want my money back.",
  { sessionId: "customer-77" },
);
console.log(`run ${runId} started — watch it in the dashboard`);

// Wait for the approval gate, then approve it like an operator would.
for (;;) {
  const run = await support.getRun(runId);
  if (run?.status === "waitingEvent") {
    console.log("\n⏸  agent paused: send_refund needs approval");
    console.log("   (this pause is durable — kill the process and restart, it holds)");
    await new Promise((r) => setTimeout(r, 1500));
    console.log("✅ operator approves the refund\n");
    support.approve(runId, "tu_2"); // with Claude: read the toolUseId from the dashboard
    break;
  }
  if (run?.status === "completed" || run?.status === "failed") break;
  await new Promise((r) => setTimeout(r, 100));
}

for (;;) {
  const run = await support.getRun(runId);
  if (run?.status === "completed") {
    const out = run.output;
    console.log(`agent: ${out.text}`);
    console.log(
      `\n${out.iterations} iterations · ${out.toolCalls} tool calls · ${out.usage.totalTokens} tokens`,
    );
    break;
  }
  if (run?.status === "failed") {
    console.error(`run failed: ${run.error}`);
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}

console.log("\ndashboard stays up for inspection — Ctrl-C to stop");
