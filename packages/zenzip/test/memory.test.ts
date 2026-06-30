// P9.3: tiered agent memory — semantic recall, remember, working-memory compression.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentMemory,
  InMemoryVectorStore,
  mockEmbeddings,
  mockProvider,
  mockText,
  zenzip,
  type ZenzipApp,
} from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("AgentMemory (P9.3)", () => {
  it("recalls the most semantically relevant remembered text", async () => {
    const mem = new AgentMemory({ embeddings: mockEmbeddings(), store: new InMemoryVectorStore() });
    await mem.remember("The customer's favorite color is teal.");
    await mem.remember("The invoice total was 4200 dollars.");
    await mem.remember("Shipping is handled by the Berlin warehouse.");

    const hits = await mem.recall("what color does the customer like?");
    expect(hits[0]).toContain("teal");
  });

  it("scopes recall by sessionId", async () => {
    const mem = new AgentMemory({ embeddings: mockEmbeddings() });
    await mem.remember("alpha secret", "s1");
    await mem.remember("alpha secret", "s2");
    const hits = await mem.recall("alpha", "s1");
    expect(hits.length).toBe(1);
  });

  it("compresses older turns into a summary via the provider", async () => {
    const provider = mockProvider([mockText("Summary: discussed refunds.")]);
    const mem = new AgentMemory({ embeddings: mockEmbeddings(), provider, model: "mock" });
    const msgs = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: [{ type: "text" as const, text: `turn ${i}` }],
    }));
    const compressed = await mem.compress(msgs, 4);
    expect(compressed.length).toBe(5); // 1 summary + 4 recent
    expect((compressed[0].content[0] as { text: string }).text).toContain("Summary");
  });
});

describe("agent with memory (P9.3)", () => {
  it("remembers a turn and recalls it on a later run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zenzip-mem-"));
    const app: ZenzipApp = zenzip({ dataDir: dir, handleSignals: false });
    const memory = new AgentMemory({ embeddings: mockEmbeddings(), topK: 3 });
    const provider = mockProvider([mockText("noted")]);
    const agent = app.agent("memo", { provider, model: "mock", memory });
    await app.start();

    await agent.run("My account id is ACME-9000.");
    provider.calls.length = 0; // reset to inspect the next run's prompt
    await agent.run("what is my account id?");

    // The recalled memory was injected into the second run's prompt.
    const sent = JSON.stringify(provider.calls[0].messages);
    expect(sent).toContain("[memory] Relevant context");
    expect(sent).toContain("ACME-9000");

    await app.stop({ timeout: "5s" });
    rmSync(dir, { recursive: true, force: true });
  });
});
