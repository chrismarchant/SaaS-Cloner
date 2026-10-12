import {
  createAnthropicProvider,
  DEFAULT_ANTHROPIC_MODEL,
} from "./anthropicProvider.js";
import {
  createDisabledProvider,
  createScriptedProvider,
} from "./scriptedProvider.js";
import type { ModelProvider } from "./types.js";

export * from "./types.js";
export * from "./anthropicProvider.js";
export * from "./scriptedProvider.js";
export * from "./followUpLoop.js";

/**
 * Build the runtime model provider from environment variable NAMES. Values are
 * never logged or returned. Missing credentials yield a disabled provider with
 * an explicit reason rather than a silent fallback.
 */
export const createModelProviderFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): ModelProvider => {
  const kind = (env["REA_WEB_MODEL_PROVIDER"] ?? "disabled").toLowerCase();
  if (kind === "disabled")
    return createDisabledProvider("REA_WEB_MODEL_PROVIDER is disabled");
  if (kind === "scripted") return createScriptedProvider([]);
  if (kind === "anthropic") {
    const apiKey = env["REA_WEB_ANTHROPIC_API_KEY"];
    if (!apiKey)
      return createDisabledProvider(
        "REA_WEB_MODEL_PROVIDER=anthropic but REA_WEB_ANTHROPIC_API_KEY is not set",
      );
    const maxTokens = Number(env["REA_WEB_MODEL_MAX_OUTPUT_TOKENS"] ?? 16_000);
    const fallbacks =
      (env["REA_WEB_MODEL_FALLBACKS"] ?? "default") === "none"
        ? "none"
        : "default";
    return createAnthropicProvider({
      apiKey,
      model: env["REA_WEB_MODEL_ID"] ?? DEFAULT_ANTHROPIC_MODEL,
      maxOutputTokens:
        Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 16_000,
      ...(env["REA_WEB_ANTHROPIC_BASE_URL"]
        ? { baseUrl: env["REA_WEB_ANTHROPIC_BASE_URL"] }
        : {}),
      fallbacks,
    });
  }
  return createDisabledProvider(`unknown REA_WEB_MODEL_PROVIDER value`);
};
