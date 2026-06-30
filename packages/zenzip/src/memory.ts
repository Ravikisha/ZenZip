// Tiered agent memory (P9.3). Three tiers, all opt-in via AgentOptions.memory:
//   1. Working memory  — compress old conversation turns into a running summary
//                        so long sessions stay within the context window.
//   2. Semantic recall — embed + retrieve the most relevant past facts/turns,
//                        injected back into the prompt (long-term memory).
//   3. Storage         — pluggable vector store (in-memory default; back it with
//                        pgvector/a vector DB for durable, cross-node recall).
//
// Recall/remember run inside durable workflow steps in the agent loop, so they
// are journaled and never re-execute on replay.
import { randomUUID } from "node:crypto";

import type { LlmMessage, LlmProvider } from "./llm/types.js";

/** Turn text into vectors. Bring OpenAI, a local model, or the mock. */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

export interface MemoryRecord {
  id: string;
  text: string;
  embedding?: number[];
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

/** Vector storage + nearest-neighbor search. Swap for a persistent backend. */
export interface MemoryStore {
  add(records: MemoryRecord[]): Promise<void> | void;
  search(
    embedding: number[],
    k: number,
    filter?: { sessionId?: string },
  ): Promise<MemoryRecord[]> | MemoryRecord[];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Process-local cosine-similarity store — the zero-config default. Lost on
 * restart and not shared across nodes; for production durable recall, implement
 * MemoryStore over pgvector / a vector DB.
 */
export class InMemoryVectorStore implements MemoryStore {
  #records: MemoryRecord[] = [];

  add(records: MemoryRecord[]): void {
    this.#records.push(...records);
  }

  search(embedding: number[], k: number, filter?: { sessionId?: string }): MemoryRecord[] {
    const pool = filter?.sessionId
      ? this.#records.filter((r) => r.sessionId === filter.sessionId)
      : this.#records;
    return pool
      .filter((r) => r.embedding)
      .map((r) => ({ r, score: cosine(embedding, r.embedding!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.r);
  }
}

export interface AgentMemoryOptions {
  /** Embedding model for semantic recall (required for recall/remember). */
  embeddings: EmbeddingProvider;
  /** Vector backend. Default: in-memory (process-local). */
  store?: MemoryStore;
  /** How many memories to recall per turn. Default: 4. */
  topK?: number;
  /** LLM used to compress working memory (required for `compress`). */
  provider?: LlmProvider;
  model?: string;
}

/** Long-term + working memory for an agent. */
export class AgentMemory {
  readonly #embeddings: EmbeddingProvider;
  readonly #store: MemoryStore;
  readonly #topK: number;
  readonly #provider?: LlmProvider;
  readonly #model?: string;

  constructor(opts: AgentMemoryOptions) {
    this.#embeddings = opts.embeddings;
    this.#store = opts.store ?? new InMemoryVectorStore();
    this.#topK = opts.topK ?? 4;
    this.#provider = opts.provider;
    this.#model = opts.model;
  }

  /** Store a fact/turn for later semantic recall. */
  async remember(
    text: string,
    sessionId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const [embedding] = await this.#embeddings.embed([text]);
    await this.#store.add([{ id: randomUUID(), text, embedding, sessionId, metadata }]);
  }

  /** Retrieve the most relevant remembered texts for a query. */
  async recall(query: string, sessionId?: string): Promise<string[]> {
    const [embedding] = await this.#embeddings.embed([query]);
    const hits = await this.#store.search(embedding, this.#topK, { sessionId });
    return hits.map((h) => h.text);
  }

  /**
   * Working memory: collapse all but the last `keepRecent` messages into a
   * single summary message, so a long session keeps fitting the context window.
   * Returns the messages unchanged when no provider is configured or there's
   * nothing to compress.
   */
  async compress(messages: LlmMessage[], keepRecent = 6): Promise<LlmMessage[]> {
    if (!this.#provider || !this.#model || messages.length <= keepRecent) return messages;
    const older = messages.slice(0, -keepRecent);
    const recent = messages.slice(-keepRecent);
    const transcript = older
      .map((m) => `${m.role}: ${m.content.map((c) => ("text" in c ? c.text : "")).join(" ")}`)
      .join("\n");
    const res = await this.#provider.complete({
      model: this.#model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Summarize this conversation so far, preserving facts, decisions, and open threads:\n\n${transcript}`,
            },
          ],
        },
      ],
      maxTokens: 512,
    });
    const summary = res.content.map((c) => ("text" in c ? c.text : "")).join("");
    return [
      { role: "user", content: [{ type: "text", text: `[memory] Earlier context: ${summary}` }] },
      ...recent,
    ];
  }
}

// ── Embedding providers ──────────────────────────────────────────────────────

export interface OpenAiEmbeddingOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** OpenAI-compatible /embeddings adapter (OpenAI, Together, local servers). */
export function openaiEmbeddings(opts: OpenAiEmbeddingOptions = {}): EmbeddingProvider {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = opts.model ?? "text-embedding-3-small";
  return {
    async embed(texts: string[]): Promise<number[][]> {
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) {
        throw new Error(`openai embeddings: ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
      const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
      return data.data.map((d) => d.embedding);
    },
  };
}

/**
 * Deterministic offline embeddings for tests/dev: a bag-of-tokens vector, so
 * texts sharing words land near each other in cosine space. Not for production
 * recall quality — use a real embedding model there.
 */
export function mockEmbeddings(dims = 64): EmbeddingProvider {
  const bucket = (token: string): number => {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % dims;
  };
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const v = new Array<number>(dims).fill(0);
        for (const token of t.toLowerCase().split(/\W+/).filter(Boolean)) v[bucket(token)] += 1;
        return v;
      });
    },
  };
}
