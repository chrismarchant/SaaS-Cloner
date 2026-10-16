import {
  addUsage,
  ModelUnavailableError,
  ZERO_MODEL_USAGE,
  type CompletionRequest,
  type ContentBlock,
  type Message,
  type ModelProvider,
  type ToolDefinition,
  type Usage,
} from "./types.js";

/**
 * Bounded model-driven follow-up loop. The loop owns no tool semantics: the
 * caller supplies `executeTool`, which validates against the live schema and
 * policy, may return `awaiting_approval`, and returns the derived summary that
 * is fed back to the model. Every proposed call is checked before execution
 * and every token is accounted against the budget.
 */
export interface FollowUpBudget {
  readonly maxRounds: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxToolCalls: number;
}

export type ToolExecution =
  | {
      readonly kind: "result";
      readonly summary: string;
      readonly is_error: boolean;
    }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "awaiting_approval"; readonly approval_id: string };

export interface FollowUpHooks {
  readonly executeTool: (
    call: { id: string; name: string; input: Record<string, unknown> },
    round: number,
  ) => Promise<ToolExecution>;
  readonly onRound?: (
    round: number,
    result: { content: readonly ContentBlock[]; usage: Usage },
  ) => void;
  /** Redaction applied to every string that leaves the runner for the model. */
  readonly redact: (text: string) => string;
}

export type FollowUpStop =
  | "end_turn"
  | "budget_rounds"
  | "budget_tokens"
  | "budget_tool_calls"
  | "refusal"
  | "awaiting_approval"
  | "cancelled"
  | "model_unavailable"
  | "max_tokens";

export interface FollowUpOutcome {
  readonly stop: FollowUpStop;
  readonly rounds: number;
  readonly tool_calls: number;
  readonly usage: Usage;
  readonly final_text: string;
  readonly transcript: readonly Message[];
  readonly refusal: {
    category: string | null;
    explanation: string | null;
  } | null;
  readonly pending_approval_id: string | null;
}

export const runFollowUpLoop = async (input: {
  provider: ModelProvider;
  system: string;
  initialUserMessage: string;
  tools: readonly ToolDefinition[];
  budget: FollowUpBudget;
  hooks: FollowUpHooks;
  signal: AbortSignal;
  /** Resume from a prior transcript (e.g. after approval). */
  transcript?: readonly Message[];
}): Promise<FollowUpOutcome> => {
  const { provider, hooks, budget, signal } = input;
  if (!provider.available)
    throw new ModelUnavailableError(
      provider.unavailable_reason ?? "unavailable",
    );
  const transcript: Message[] = input.transcript
    ? [...input.transcript]
    : [{ role: "user", content: hooks.redact(input.initialUserMessage) }];
  let usage = ZERO_MODEL_USAGE;
  let toolCalls = 0;
  let finalText = "";
  let rounds = 0;
  const finish = (
    stop: FollowUpStop,
    extra: Partial<
      Pick<FollowUpOutcome, "refusal" | "pending_approval_id">
    > = {},
  ): FollowUpOutcome => ({
    stop,
    rounds,
    tool_calls: toolCalls,
    usage,
    final_text: finalText,
    transcript,
    refusal: extra.refusal ?? null,
    pending_approval_id: extra.pending_approval_id ?? null,
  });

  while (rounds < budget.maxRounds) {
    if (signal.aborted) return finish("cancelled");
    rounds += 1;
    const request: CompletionRequest = {
      system: input.system,
      messages: transcript,
      tools: input.tools,
    };
    let result;
    try {
      result = await provider.complete(request, signal);
    } catch (error) {
      if (signal.aborted) return finish("cancelled");
      throw error;
    }
    usage = addUsage(usage, result.usage);
    hooks.onRound?.(rounds, { content: result.content, usage });
    transcript.push({
      role: "assistant",
      content: result.content
        .filter((b) => b.type !== "thinking")
        .map((b) =>
          b.type === "text"
            ? { type: "text" as const, text: b.text }
            : {
                type: "tool_use" as const,
                id: b.id,
                name: b.name,
                input: b.input,
              },
        ),
    });
    finalText = result.content
      .filter(
        (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
      )
      .map((b) => b.text)
      .join("\n");
    if (result.stop_reason === "refusal")
      return finish("refusal", { refusal: result.refusal });
    if (
      usage.input_tokens > budget.maxInputTokens ||
      usage.output_tokens > budget.maxOutputTokens
    )
      return finish("budget_tokens");
    if (result.stop_reason === "max_tokens") return finish("max_tokens");
    const calls = result.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
        b.type === "tool_use",
    );
    if (calls.length === 0 || result.stop_reason === "end_turn")
      return finish("end_turn");

    const results: {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }[] = [];
    for (const call of calls) {
      if (signal.aborted) return finish("cancelled");
      if (toolCalls >= budget.maxToolCalls) {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: "tool call budget exhausted",
          is_error: true,
        });
        continue;
      }
      toolCalls += 1;
      const execution = await hooks.executeTool(call, rounds);
      if (execution.kind === "awaiting_approval") {
        // Keep the transcript consistent: record the pending state so a resume
        // can append the real result for this tool_use id.
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: `awaiting operator approval (${execution.approval_id})`,
        });
        transcript.push({ role: "user", content: results });
        return finish("awaiting_approval", {
          pending_approval_id: execution.approval_id,
        });
      }
      results.push(
        execution.kind === "rejected"
          ? {
              type: "tool_result",
              tool_use_id: call.id,
              content: hooks.redact(execution.reason),
              is_error: true,
            }
          : {
              type: "tool_result",
              tool_use_id: call.id,
              content: hooks.redact(execution.summary),
              ...(execution.is_error ? { is_error: true } : {}),
            },
      );
    }
    transcript.push({ role: "user", content: results });
    if (toolCalls >= budget.maxToolCalls) return finish("budget_tool_calls");
  }
  return finish("budget_rounds");
};
