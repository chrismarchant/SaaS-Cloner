/**
 * Server-side model connector contract. The runtime agent's model is a
 * deployment concern configured by REA_WEB_MODEL_* variables; it has no
 * relationship to the development session's model.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    }
  | { readonly type: "thinking"; readonly summary: string };

export type MessageContent =
  | string
  | readonly (
      | { readonly type: "text"; readonly text: string }
      | {
          readonly type: "tool_result";
          readonly tool_use_id: string;
          readonly content: string;
          readonly is_error?: boolean;
        }
      | {
          readonly type: "tool_use";
          readonly id: string;
          readonly name: string;
          readonly input: Record<string, unknown>;
        }
    )[];

export interface Message {
  readonly role: "user" | "assistant";
  readonly content: MessageContent;
}

export interface CompletionRequest {
  readonly system: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
  readonly maxOutputTokens?: number;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "pause_turn"
  | "stop_sequence"
  | "unknown";

export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
}

export interface CompletionResult {
  readonly provider: string;
  readonly model: string;
  readonly content: readonly ContentBlock[];
  readonly stop_reason: StopReason;
  readonly refusal: {
    category: string | null;
    explanation: string | null;
  } | null;
  readonly usage: Usage;
  readonly request_id: string | null;
  readonly duration_ms: number;
}

export interface ModelProvider {
  readonly id: "anthropic" | "scripted" | "disabled";
  readonly model: string;
  readonly available: boolean;
  readonly unavailable_reason: string | null;
  complete(
    request: CompletionRequest,
    signal: AbortSignal,
  ): Promise<CompletionResult>;
}

export class ModelUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`model_unavailable: ${reason}`);
    this.name = "ModelUnavailableError";
  }
}

export class ModelRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "ModelRequestError";
  }
}

export const ZERO_MODEL_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

export const addUsage = (a: Usage, b: Usage): Usage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_read_input_tokens:
    a.cache_read_input_tokens + b.cache_read_input_tokens,
  cache_creation_input_tokens:
    a.cache_creation_input_tokens + b.cache_creation_input_tokens,
});
