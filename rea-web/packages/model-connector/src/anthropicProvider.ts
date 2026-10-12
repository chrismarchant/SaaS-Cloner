import Anthropic from "@anthropic-ai/sdk";
import type {
  CompletionRequest,
  CompletionResult,
  ContentBlock,
  ModelProvider,
  StopReason,
} from "./types.js";
import { ModelRequestError } from "./types.js";

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly baseUrl?: string;
  /** Server-side refusal fallbacks (beta). "default" routes by refusal category. */
  readonly fallbacks: "default" | "none";
  readonly timeoutMs?: number;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

const mapStopReason = (reason: string | null): StopReason => {
  switch (reason) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "refusal":
    case "pause_turn":
    case "stop_sequence":
      return reason;
    default:
      return "unknown";
  }
};

/**
 * Anthropic Messages API provider. Streaming is used so long outputs never
 * hit HTTP timeouts; `finalMessage()` yields the complete message. Thinking is
 * left at the model default (always on for Claude Opus 5.5); forced tool
 * choice is never used (rejected by current models) — the system prompt steers.
 */
export const createAnthropicProvider = (
  options: AnthropicProviderOptions,
): ModelProvider => {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    timeout: options.timeoutMs ?? 10 * 60_000,
    maxRetries: 2,
  });
  return {
    id: "anthropic",
    model: options.model,
    available: true,
    unavailable_reason: null,
    async complete(
      request: CompletionRequest,
      signal: AbortSignal,
    ): Promise<CompletionResult> {
      const started = Date.now();
      const tools: Anthropic.Beta.BetaToolUnion[] = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Beta.BetaTool.InputSchema,
      }));
      const messages: Anthropic.Beta.BetaMessageParam[] = request.messages.map(
        (m) => ({
          role: m.role,
          content:
            typeof m.content === "string"
              ? m.content
              : (m.content.map((block) =>
                  block.type === "tool_result"
                    ? {
                        type: "tool_result" as const,
                        tool_use_id: block.tool_use_id,
                        content: block.content,
                        ...(block.is_error ? { is_error: true } : {}),
                      }
                    : block.type === "tool_use"
                      ? {
                          type: "tool_use" as const,
                          id: block.id,
                          name: block.name,
                          input: block.input,
                        }
                      : { type: "text" as const, text: block.text },
                ) as Anthropic.Beta.BetaContentBlockParam[]),
        }),
      );
      const betas: Anthropic.AnthropicBeta[] =
        options.fallbacks === "default"
          ? ["server-side-fallback-2026-07-01"]
          : [];
      try {
        const stream = client.beta.messages.stream(
          {
            model: options.model,
            max_tokens: request.maxOutputTokens ?? options.maxOutputTokens,
            system: [
              {
                type: "text",
                text: request.system,
                cache_control: { type: "ephemeral" },
              },
            ],
            messages,
            ...(tools.length > 0
              ? { tools, tool_choice: { type: "auto" } }
              : {}),
            ...(betas.length > 0 ? { betas, fallbacks: "default" } : {}),
          },
          { signal },
        );
        const message = await stream.finalMessage();
        const content: ContentBlock[] = [];
        for (const block of message.content) {
          if (block.type === "text")
            content.push({ type: "text", text: block.text });
          else if (block.type === "tool_use")
            content.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: (block.input ?? {}) as Record<string, unknown>,
            });
          else if (block.type === "thinking")
            content.push({ type: "thinking", summary: block.thinking ?? "" });
        }
        const stopDetails = message.stop_details;
        return {
          provider: "anthropic",
          model: message.model,
          content,
          stop_reason: mapStopReason(message.stop_reason),
          refusal:
            message.stop_reason === "refusal"
              ? {
                  category: stopDetails?.category ?? null,
                  explanation: stopDetails?.explanation ?? null,
                }
              : null,
          usage: {
            input_tokens: message.usage.input_tokens,
            output_tokens: message.usage.output_tokens,
            cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens:
              message.usage.cache_creation_input_tokens ?? 0,
          },
          request_id: stream.request_id ?? null,
          duration_ms: Date.now() - started,
        };
      } catch (error) {
        if (error instanceof Anthropic.RateLimitError)
          throw new ModelRequestError(
            "rate limited",
            error.status,
            true,
            error.requestID ?? null,
          );
        if (error instanceof Anthropic.AuthenticationError)
          throw new ModelRequestError(
            "authentication failed",
            error.status,
            false,
            error.requestID ?? null,
          );
        if (error instanceof Anthropic.BadRequestError)
          throw new ModelRequestError(
            error.message,
            error.status,
            false,
            error.requestID ?? null,
          );
        if (error instanceof Anthropic.APIError)
          throw new ModelRequestError(
            error.message,
            error.status ?? null,
            error.status === undefined || error.status >= 500,
            error.requestID ?? null,
          );
        if (error instanceof Anthropic.APIConnectionError)
          throw new ModelRequestError(error.message, null, true, null);
        throw error;
      }
    },
  };
};
