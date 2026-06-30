// P9.6: multi-agent network — a coordinator durably routes to a specialist.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { zenzip, mockProvider, mockText, mockToolUse, type ZenzipApp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpApp(): ZenzipApp {
  const dir = mkdtempSync(join(tmpdir(), "zenzip-net-"));
  const app = zenzip({ dataDir: dir, handleSignals: false });
  cleanups.push(async () => {
    try {
      await app.stop({ timeout: "5s" });
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  return app;
}

describe("multi-agent network (P9.6)", () => {
  it("routes a request to the right specialist and composes the answer", async () => {
    const app = tmpApp();

    const billingProvider = mockProvider([mockText("Refund issued for order 42.")]);
    const billing = app.agent("billing", {
      provider: billingProvider,
      model: "mock",
      instructions: "You handle billing and refunds.",
    });

    const techProvider = mockProvider([mockText("Have you tried turning it off and on?")]);
    app.agent("tech", {
      provider: techProvider,
      model: "mock",
      instructions: "You handle technical issues.",
    });

    // Coordinator: route to billing, then summarize.
    const coordinatorProvider = mockProvider([
      mockToolUse("ask_billing", { message: "Refund order 42" }),
      mockText("Done — your refund for order 42 is on its way."),
    ]);
    const support = app.network("support", {
      provider: coordinatorProvider,
      model: "mock",
      agents: [billing, app._listAgents().find((a) => a.name === "tech")!],
    });

    await app.start();
    const res = await support.run("I want a refund for order 42");

    expect(res.text).toContain("refund for order 42");
    // The coordinator delegated to billing (billing's model was called)...
    expect(billingProvider.calls.length).toBe(1);
    // ...and NOT to tech.
    expect(techProvider.calls.length).toBe(0);
    // Coordinator made two LLM calls: route, then summarize.
    expect(coordinatorProvider.calls.length).toBe(2);
  });
});
