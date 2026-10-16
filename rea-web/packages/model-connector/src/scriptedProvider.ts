import type {
  CompletionRequest,
  CompletionResult,
  ContentBlock,
  ModelProvider,
  StopReason,
} from "./types.js";

/**
 * Deterministic test provider: replays a scripted list of turns. Each turn may
 * assert on the incoming request. Mocked provider tests are contract checks
 * and never establish live-provider support.
 */
export interface ScriptedTurn {
  readonly content: readonly ContentBlock[];
  readonly stop_reason?: StopReason;
  readonly usage?: { input_tokens: number; output_tokens: number };
  readonly expect?: (request: CompletionRequest) => void;
}

export const createScriptedProvider = (
  turns: readonly ScriptedTurn[],
  options: { model?: string } = {},
): ModelProvider & { readonly calls: CompletionRequest[] } => {
  const calls: CompletionRequest[] = [];
  let index = 0;
  return {
    id: "scripted",
    model: options.model ?? "scripted-model",
    available: true,
    unavailable_reason: null,
    calls,
    complete(
      request: CompletionRequest,
      signal: AbortSignal,
    ): Promise<CompletionResult> {
      if (signal.aborted)
        return Promise.reject(signal.reason ?? new Error("aborted"));
      calls.push(request);
      const turn = turns[index];
      index += 1;
      if (!turn)
        return Promise.resolve({
          provider: "scripted",
          model: options.model ?? "scripted-model",
          content: [{ type: "text", text: "script exhausted" }],
          stop_reason: "end_turn",
          refusal: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          request_id: null,
          duration_ms: 0,
        });
      turn.expect?.(request);
      return Promise.resolve({
        provider: "scripted",
        model: options.model ?? "scripted-model",
        content: turn.content,
        stop_reason:
          turn.stop_reason ??
          (turn.content.some((c) => c.type === "tool_use")
            ? "tool_use"
            : "end_turn"),
        refusal: null,
        usage: {
          input_tokens: turn.usage?.input_tokens ?? 100,
          output_tokens: turn.usage?.output_tokens ?? 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        request_id: `scripted-${index}`,
        duration_ms: 1,
      });
    },
  };
};

export const createDisabledProvider = (reason: string): ModelProvider => ({
  id: "disabled",
  model: "none",
  available: false,
  unavailable_reason: reason,
  complete(): Promise<CompletionResult> {
    return Promise.reject(new Error(`model_unavailable: ${reason}`));
  },
});
