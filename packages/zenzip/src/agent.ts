// Agent engine (P4.4–P4.12): an agent IS a workflow whose steps are
// generated dynamically by the LLM loop (plan.md D4). Every LLM call and
// every tool execution is a journaled step — so agents inherit crash
// recovery, retries-without-re-prompting, suspensions, cancellation, and
// dashboard visibility from the Phase 2 engine for free.

import { randomUUID } from "node:crypto";

import { ms, type Duration } from "./duration.js";
import {
  textContent,
  toolUses,
  type LlmMessage,
  type LlmProvider,
  type LlmResponse,
  type LlmToolDef,
  type LlmUsage,
} from "./llm/types.js";
import { costOf } from "./llm/pricing.js";
import type { Step, Workflow } from "./workflow.js";
import type { StandardSchemaV1 } from "./types.js";
import type { ZenzipApp } from "./app.js";

// ---------------------------------------------------------------------------
// Tools (P4.4)
// ---------------------------------------------------------------------------

export interface ToolContext {
  runId: string;
  agent: string;
}

export interface AgentTool<I = any, O = any> {
  name: string;
  description: string;
  /** JSON Schema the model sees. Default: unconstrained object. */
  parameters: object;
  /** Optional runtime validation (zod 3.24+/valibot/arktype). */
  schema?: StandardSchemaV1<I>;
  /** Human-in-the-loop gate (P4.9): pause until approve()/deny(). */
  requiresApproval?: boolean;
  execute: (input: I, ctx: ToolContext) => O | Promise<O>;
  /** @internal set by handoffTool */
  _handoff?: Agent<any>;
}

export function tool<I = unknown, O = unknown>(def: {
  name: string;
  description: string;
  parameters?: object;
  schema?: StandardSchemaV1<I>;
  requiresApproval?: boolean;
  execute: (input: I, ctx: ToolContext) => O | Promise<O>;
}): AgentTool<I, O> {
  return {
    parameters: { type: "object" },
    ...def,
  } as AgentTool<I, O>;
}

/**
 * Multi-agent handoff (P4.11): expose another agent as a tool. The child
 * agent runs as a durable child workflow (step.invoke) — its own journal,
 * its own retries, cancellation propagates from the parent.
 */
export function handoffTool(
  target: Agent<any>,
  opts: { name?: string; description?: string } = {},
): AgentTool<{ message: string }, string> {
  return {
    name: opts.name ?? `ask_${target.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
    description:
      opts.description ??
      `Hand the task to the "${target.name}" agent and return its answer.`,
    parameters: {
      type: "object",
      properties: { message: { type: "string", description: "The task or question." } },
      required: ["message"],
    },
    execute: () => {
      throw new Error("handoff tools are executed by the agent loop");
    },
    _handoff: target,
  };
}

// ---------------------------------------------------------------------------
// Agent definition
// ---------------------------------------------------------------------------

export interface AgentOptions {
  provider: LlmProvider;
  model: string;
  /** System prompt. */
  instructions?: string;
  tools?: AgentTool[];
  /** Hard cap on LLM round-trips per run. Default: 10 */
  maxIterations?: number;
  /** max_tokens per LLM call. Default: 4096 */
  maxTokens?: number;
  temperature?: number;
  /** Fail the run when total tokens (in+out) exceed this. */
  maxTotalTokens?: number;
  /** Keep this many most-recent messages of session history. Default: 20 */
  historyWindow?: number;
  /** How long an approval gate waits before resolving as denied. Default: 1h */
  approvalTimeout?: Duration;
  /** Validate the final answer (parsed as JSON) against this schema (P4.8). */
  output?: StandardSchemaV1;
  /** Max concurrent runs. Default: 10 */
  concurrency?: number;
  /** Retries per step (tool executions, LLM calls). Default: 2 */
  stepRetries?: number;
  /** Execution lease — raise for slow models. Default: 5m */
  lease?: Duration;
}

export interface AgentRunInput {
  message: string;
  sessionId?: string;
  /** @internal live-streaming key */
  __streamKey?: string;
}

export interface AgentResult {
  text: string;
  /** Parsed + validated only when `output` schema is set. */
  output?: unknown;
  usage: LlmUsage & { totalTokens: number };
  /** Estimated USD cost from per-model pricing (P9.7); undefined if unpriced. */
  costUsd?: number;
  iterations: number;
  toolCalls: number;
}

export interface AgentRunOptions {
  sessionId?: string;
  timeout?: Duration;
  /** Live token stream (same-process runs only; replays never re-stream). */
  onToken?: (token: string) => void;
}

const APPROVAL_EVENT = "zenzip.agent.approval";

export class Agent<TOutput = unknown> {
  /** @internal */
  readonly _workflow: Workflow<AgentRunInput, AgentResult>;
  readonly #app: ZenzipApp;
  readonly #streams = new Map<string, (token: string) => void>();

  constructor(
    app: ZenzipApp,
    readonly name: string,
    readonly options: AgentOptions,
  ) {
    this.#app = app;
    const streams = this.#streams;
    this._workflow = app.workflow<AgentRunInput, AgentResult>(
      `agent:${name}`,
      {
        concurrency: options.concurrency,
        stepRetries: options.stepRetries ?? 2,
        lease: options.lease ?? "5m",
      },
      (ctx) => runAgentLoop(app, name, options, streams, ctx),
    );
  }

  /** Run to completion and return the result (throws on failure). */
  async run(message: string, opts: AgentRunOptions = {}): Promise<AgentResult> {
    const streamKey = opts.onToken ? randomUUID() : undefined;
    if (streamKey && opts.onToken) this.#streams.set(streamKey, opts.onToken);
    try {
      return await this._workflow.triggerAndWait(
        { message, sessionId: opts.sessionId, __streamKey: streamKey },
        { timeout: opts.timeout ?? "5m" },
      );
    } finally {
      if (streamKey) this.#streams.delete(streamKey);
    }
  }

  /** Fire-and-forget durable run. */
  async trigger(
    message: string,
    opts: { sessionId?: string; idempotencyKey?: string } = {},
  ): Promise<{ runId: string }> {
    return this._workflow.trigger(
      { message, sessionId: opts.sessionId },
      { idempotencyKey: opts.idempotencyKey },
    );
  }

  getRun(runId: string) {
    return this._workflow.getRun(runId);
  }

  cancel(runId: string) {
    return this._workflow.cancel(runId);
  }

  /** Resolve a pending approval gate (P4.9). */
  approve(runId: string, toolUseId: string): void {
    this.#app.emit(APPROVAL_EVENT, { runId, toolUseId, approved: true });
    this.#app._audit("agent.approve", this.name, { runId, toolUseId });
  }

  deny(runId: string, toolUseId: string, reason?: string): void {
    this.#app.emit(APPROVAL_EVENT, { runId, toolUseId, approved: false, reason });
    this.#app._audit("agent.deny", this.name, { runId, toolUseId, reason });
  }

  /** Stored conversation for a session (P4.7). */
  async session(sessionId: string): Promise<LlmMessage[]> {
    const raw = this.#app._native.agentSessionGet(this.name, sessionId);
    return raw ? (JSON.parse(raw) as LlmMessage[]) : [];
  }
}

// ---------------------------------------------------------------------------
// The durable loop (P4.5, P4.6, P4.9, P4.12)
// ---------------------------------------------------------------------------

async function runAgentLoop(
  app: ZenzipApp,
  agentName: string,
  options: AgentOptions,
  streams: Map<string, (token: string) => void>,
  ctx: { step: Step; input: AgentRunInput; runId: string },
): Promise<AgentResult> {
  const { step, input, runId } = ctx;
  const provider = options.provider;
  const toolDefs: LlmToolDef[] = (options.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  const toolByName = new Map((options.tools ?? []).map((t) => [t.name, t]));
  const onToken = input.__streamKey ? streams.get(input.__streamKey) : undefined;

  // Session history snapshot — journaled, so every attempt sees the same
  // starting conversation (P4.7).
  const history = await step.run("session", () => {
    if (!input.sessionId) return [] as LlmMessage[];
    const raw = app._native.agentSessionGet(agentName, input.sessionId);
    const messages = raw ? (JSON.parse(raw) as LlmMessage[]) : [];
    const window = options.historyWindow ?? 20;
    return messages.slice(-window);
  });

  const messages: LlmMessage[] = [
    ...history,
    { role: "user", content: [{ type: "text", text: input.message }] },
  ];

  const usage = { inputTokens: 0, outputTokens: 0 };
  let iterations = 0;
  let toolCalls = 0;
  let finalText = "";
  const maxIterations = options.maxIterations ?? 10;

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;

    // One LLM round-trip = one journaled step. Crash, deploy, or tool retry
    // NEVER re-calls the model — the recorded response replays (P4.6).
    const response = await step.run(`llm-${i}`, (): Promise<LlmResponse> => {
      const request = {
        model: options.model,
        system: options.instructions,
        messages,
        tools: toolDefs.length ? toolDefs : undefined,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
      };
      return onToken && provider.stream
        ? provider.stream(request, onToken)
        : provider.complete(request);
    });

    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    if (
      options.maxTotalTokens !== undefined &&
      usage.inputTokens + usage.outputTokens > options.maxTotalTokens
    ) {
      throw new Error(
        `agent "${agentName}" exceeded the token budget (${options.maxTotalTokens})`,
      );
    }

    const calls = toolUses(response);
    if (calls.length === 0) {
      finalText = textContent(response);
      break;
    }

    messages.push({ role: "assistant", content: response.content });
    const results: LlmMessage["content"] = [];

    for (const call of calls) {
      toolCalls++;
      const toolDef = toolByName.get(call.name);
      if (!toolDef) {
        results.push({
          type: "toolResult",
          toolUseId: call.id,
          content: `unknown tool "${call.name}"`,
          isError: true,
        });
        continue;
      }

      // Approval gate (P4.9): durable pause — survives restarts, resolved by
      // agent.approve()/deny() from anywhere, or denied on timeout.
      if (toolDef.requiresApproval) {
        const decision = await step.waitForEvent<{ approved: boolean; reason?: string }>(
          `approval-${i}-${call.id}`,
          APPROVAL_EVENT,
          {
            timeout: options.approvalTimeout ?? "1h",
            match: { runId, toolUseId: call.id },
          },
        );
        if (!decision?.approved) {
          results.push({
            type: "toolResult",
            toolUseId: call.id,
            content: decision
              ? `denied by operator${decision.reason ? `: ${decision.reason}` : ""}`
              : "approval timed out",
            isError: true,
          });
          continue;
        }
      }

      if (toolDef._handoff) {
        // Durable child agent (P4.11).
        const child = await step.invoke<AgentResult>(
          `handoff-${i}-${call.id}`,
          toolDef._handoff._workflow,
          { message: (call.input as { message?: string })?.message ?? "" },
        );
        results.push({ type: "toolResult", toolUseId: call.id, content: child.text });
        continue;
      }

      // Tool execution = journaled step: a flaky tool retries with backoff
      // while the LLM response above stays memoized (P4.6).
      const result = await step.run(`tool-${i}-${call.id}`, async () => {
        let parsed: unknown = call.input ?? {};
        if (toolDef.schema) {
          let validation = toolDef.schema["~standard"].validate(parsed);
          if (validation instanceof Promise) validation = await validation;
          if (validation.issues) {
            throw new Error(
              `invalid input for tool "${call.name}": ${validation.issues
                .map((issue) => issue.message)
                .join("; ")}`,
            );
          }
          parsed = validation.value;
        }
        const out = await toolDef.execute(parsed, { runId, agent: agentName });
        return out === undefined ? null : out;
      });
      results.push({
        type: "toolResult",
        toolUseId: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }

    messages.push({ role: "user", content: results });

    if (i === maxIterations - 1) {
      throw new Error(
        `agent "${agentName}" exceeded ${maxIterations} iterations without a final answer`,
      );
    }
  }

  // Structured output (P4.8): parse + validate; one corrective round.
  let output: unknown;
  if (options.output) {
    const validateText = async (text: string) => {
      const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripped);
      } catch (e) {
        return { ok: false as const, error: `not valid JSON: ${(e as Error).message}` };
      }
      let validation = options.output!["~standard"].validate(parsed);
      if (validation instanceof Promise) validation = await validation;
      if (validation.issues) {
        return {
          ok: false as const,
          error: validation.issues.map((issue) => issue.message).join("; "),
        };
      }
      return { ok: true as const, value: validation.value };
    };

    let check = await validateText(finalText);
    if (!check.ok) {
      messages.push({ role: "assistant", content: [{ type: "text", text: finalText }] });
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Your answer must be ONLY valid JSON matching the required schema. Problem: ${check.error}. Respond again with only the JSON.`,
          },
        ],
      });
      const fix = await step.run("llm-output-fix", () =>
        provider.complete({
          model: options.model,
          system: options.instructions,
          messages,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
        }),
      );
      usage.inputTokens += fix.usage.inputTokens;
      usage.outputTokens += fix.usage.outputTokens;
      finalText = textContent(fix);
      check = await validateText(finalText);
      if (!check.ok) {
        throw new Error(`agent "${agentName}" output failed validation: ${check.error}`);
      }
    }
    output = check.value;
  }

  // Persist the conversation (P4.7) — journaled, effectively-once.
  if (input.sessionId) {
    await step.run("save-session", () => {
      const full: LlmMessage[] = [
        ...messages,
        { role: "assistant", content: [{ type: "text", text: finalText }] },
      ];
      const window = options.historyWindow ?? 20;
      app._native.agentSessionPut(
        agentName,
        input.sessionId!,
        JSON.stringify(full.slice(-window)),
      );
      return null;
    });
  }

  const costUsd = costOf(options.model, usage);
  return {
    text: finalText,
    ...(options.output ? { output } : {}),
    usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens },
    ...(costUsd !== undefined ? { costUsd } : {}),
    iterations,
    toolCalls,
  };
}
