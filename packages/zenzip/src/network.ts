// Multi-agent networks (P9.6): a coordinator that routes a task among N
// specialist agents. `handoffTool` already gives durable 1:1 delegation (the
// child runs as its own workflow); a Network is the 1:N generalization — a
// router agent whose tools are handoffs to every member, so the LLM picks the
// right specialist (or several, in sequence) and the coordinator composes the
// final answer. Everything is durable for free: each handoff is a child
// workflow with its own journal, retries, and cancellation propagation.
import { Agent, handoffTool, type AgentResult, type AgentRunOptions } from "./agent.js";
import type { Duration } from "./duration.js";
import type { LlmProvider } from "./llm/types.js";
import type { CircuitBreakerOptions } from "./resilience.js";
import type { StandardSchemaV1 } from "./types.js";
import type { ZenzipApp } from "./app.js";

/** A network member: an agent, optionally with a routing description. */
export type NetworkMember = Agent<unknown> | { agent: Agent<unknown>; description: string };

export interface NetworkOptions {
  provider: LlmProvider;
  model: string;
  /** Specialist agents the coordinator can route to. */
  agents: NetworkMember[];
  /**
   * Router system prompt. Defaults to a generated prompt that lists the members
   * and tells the coordinator to delegate, then summarize.
   */
  instructions?: string;
  /** Max routing hops (handoff tool calls) before the coordinator must answer. Default: 4. */
  maxHandoffs?: number;
  maxTokens?: number;
  temperature?: number;
  /** Validate the coordinator's final answer against this schema. */
  output?: StandardSchemaV1;
  concurrency?: number;
  lease?: Duration;
  /** Circuit breaker around the coordinator's own LLM calls (P15.2). */
  circuitBreaker?: CircuitBreakerOptions;
}

function memberAgent(m: NetworkMember): Agent<unknown> {
  return m instanceof Agent ? m : m.agent;
}

function defaultInstructions(members: NetworkMember[]): string {
  const lines = members.map((m) => {
    const a = memberAgent(m);
    const desc =
      m instanceof Agent
        ? (a.options.instructions ?? "").split("\n")[0] || "specialist agent"
        : m.description;
    return `- ${a.name}: ${desc}`;
  });
  return [
    "You are a coordinator routing each request to the most suitable specialist.",
    "Delegate by calling the matching tool; you may consult more than one in",
    "sequence. When you have enough information, write the final answer yourself.",
    "",
    "Specialists:",
    ...lines,
  ].join("\n");
}

/**
 * A coordinator over a set of specialist agents (P9.6). Behaves like an
 * {@link Agent} — `run`/`trigger` — but its tools are durable handoffs to its
 * members. Construct via {@link ZenzipApp.network}.
 */
export class Network<TOutput = unknown> {
  /** The underlying coordinator agent (a normal, durable agent). */
  readonly coordinator: Agent<TOutput>;
  readonly #members: Agent<unknown>[];

  constructor(app: ZenzipApp, readonly name: string, options: NetworkOptions) {
    this.#members = options.agents.map(memberAgent);
    const tools = options.agents.map((m) => {
      const a = memberAgent(m);
      return handoffTool(a, {
        name: `ask_${a.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
        description:
          m instanceof Agent ? undefined : `Delegate to "${a.name}": ${m.description}`,
      });
    });
    this.coordinator = app.agent<TOutput>(name, {
      provider: options.provider,
      model: options.model,
      instructions: options.instructions ?? defaultInstructions(options.agents),
      tools,
      // Each handoff consumes one iteration; leave room for the final answer.
      maxIterations: (options.maxHandoffs ?? 4) + 1,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      output: options.output,
      concurrency: options.concurrency,
      lease: options.lease,
      circuitBreaker: options.circuitBreaker,
    });
  }

  /** The specialist agents in this network. */
  get agents(): readonly Agent<unknown>[] {
    return this.#members;
  }

  /** Route a request through the coordinator and return its composed answer. */
  run(message: string, opts: AgentRunOptions = {}): Promise<AgentResult> {
    return this.coordinator.run(message, opts);
  }

  /** Fire-and-forget durable routing run. */
  trigger(
    message: string,
    opts: { sessionId?: string; idempotencyKey?: string } = {},
  ): Promise<{ runId: string }> {
    return this.coordinator.trigger(message, opts);
  }

  getRun(runId: string) {
    return this.coordinator.getRun(runId);
  }

  cancel(runId: string) {
    return this.coordinator.cancel(runId);
  }
}
