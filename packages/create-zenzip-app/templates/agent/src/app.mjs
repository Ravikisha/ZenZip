// A durable AI agent: every model call and tool execution is a journaled
// workflow step. Tool failures retry WITHOUT re-prompting the model; the
// refund tool pauses durably for human approval.
//
// Runs offline out of the box (scripted mock provider).
// Set ANTHROPIC_API_KEY to use Claude for real.
import {
  anthropic,
  mockProvider,
  mockText,
  mockToolUse,
  tool,
  zenzip,
} from "zenzip";

const app = zenzip();

const lookupOrder = tool({
  name: "lookup_order",
  description: "Fetch an order's status and total.",
  parameters: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
  },
  execute: async ({ orderId }) => {
    console.log(`  [tool] lookup_order(${orderId})`);
    return { orderId, status: "delayed", total: 29.99, daysLate: 9 };
  },
});

const sendRefund = tool({
  name: "send_refund",
  description: "Refund an order. Requires operator approval.",
  parameters: {
    type: "object",
    properties: { orderId: { type: "string" }, amount: { type: "number" } },
    required: ["orderId", "amount"],
  },
  requiresApproval: true, // durable human-in-the-loop pause
  execute: async ({ orderId, amount }) => {
    console.log(`  [tool] send_refund(${orderId}, $${amount})`);
    return { refunded: true };
  },
});

const provider = process.env.ANTHROPIC_API_KEY
  ? anthropic()
  : mockProvider([
      mockToolUse("lookup_order", { orderId: "ord_42" }, { id: "tu_1" }),
      mockToolUse("send_refund", { orderId: "ord_42", amount: 29.99 }, { id: "tu_2" }),
      mockText("Your order was 9 days late, so I've refunded $29.99 to your card."),
    ]);

const support = app.agent("support", {
  provider,
  model: "claude-sonnet-4-6",
  instructions:
    "You are a support agent for an online store. Use the tools. " +
    "Orders more than 7 days late qualify for a refund.",
  tools: [lookupOrder, sendRefund],
  maxIterations: 8,
});

await app.start();
await app.dashboard(); // watch every step at http://127.0.0.1:4100

const { runId } = await support.trigger(
  "My order ord_42 still hasn't arrived. I want a refund.",
  { sessionId: "customer-1" },
);
console.log(`agent run ${runId} started — dashboard: http://127.0.0.1:4100`);

// Play the operator: approve the refund when the agent pauses for it.
for (;;) {
  const run = await support.getRun(runId);
  if (run?.status === "waitingEvent") {
    console.log("\n⏸  send_refund needs approval (durable — survives restarts)");
    console.log("✅ approving in 2s…\n");
    await new Promise((r) => setTimeout(r, 2000));
    support.approve(runId, "tu_2"); // with Claude: read the toolUseId in the dashboard
  }
  if (run?.status === "completed") {
    console.log(`agent: ${run.output.text}`);
    console.log(`(${run.output.usage.totalTokens} tokens, ${run.output.toolCalls} tool calls)`);
    break;
  }
  if (run?.status === "failed") {
    console.error(`run failed: ${run.error}`);
    break;
  }
  await new Promise((r) => setTimeout(r, 150));
}
console.log("\ndashboard stays up — Ctrl-C to stop");
