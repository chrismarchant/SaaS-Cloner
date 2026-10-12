import { describe, expect, it } from "vitest";
import { runFollowUpLoop } from "./followUpLoop.js";
import { createModelProviderFromEnv } from "./index.js";
import {
  createDisabledProvider,
  createScriptedProvider,
} from "./scriptedProvider.js";
import { ModelUnavailableError } from "./types.js";

const tools = [
  {
    name: "inspect_go_binary",
    description: "d",
    input_schema: { type: "object" },
  },
];
const budget = {
  maxRounds: 5,
  maxInputTokens: 10_000,
  maxOutputTokens: 5_000,
  maxToolCalls: 3,
};
const redact = (t: string) => t.replaceAll("SECRET", "[REDACTED]");

describe("runFollowUpLoop", () => {
  it("executes validated tool calls, feeds redacted summaries back, and stops on end_turn", async () => {
    const provider = createScriptedProvider([
      {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "inspect_go_binary",
            input: { path: "/x" },
          },
        ],
      },
      { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
    ]);
    const executed: string[] = [];
    const outcome = await runFollowUpLoop({
      provider,
      system: "sys",
      initialUserMessage: "question with SECRET",
      tools,
      budget,
      hooks: {
        redact,
        executeTool: (call) => {
          executed.push(call.name);
          return Promise.resolve({
            kind: "result",
            summary: "ok SECRET",
            is_error: false,
          });
        },
      },
      signal: new AbortController().signal,
    });
    expect(outcome.stop).toBe("end_turn");
    expect(executed).toEqual(["inspect_go_binary"]);
    expect(outcome.final_text).toBe("done");
    expect(outcome.rounds).toBe(2);
    expect(outcome.usage.input_tokens).toBe(200);
    expect(JSON.stringify(outcome.transcript)).not.toContain("SECRET");
    expect(JSON.stringify(provider.calls)).not.toContain("SECRET");
  });

  it("stops at the round budget and the tool-call budget", async () => {
    const call = {
      type: "tool_use" as const,
      id: "t",
      name: "inspect_go_binary",
      input: {},
    };
    const provider = createScriptedProvider(
      Array.from({ length: 10 }, () => ({ content: [call] })),
    );
    const outcome = await runFollowUpLoop({
      provider,
      system: "sys",
      initialUserMessage: "q",
      tools,
      budget: { ...budget, maxRounds: 10 },
      hooks: {
        redact,
        executeTool: () =>
          Promise.resolve({ kind: "result", summary: "r", is_error: false }),
      },
      signal: new AbortController().signal,
    });
    expect(outcome.stop).toBe("budget_tool_calls");
    expect(outcome.tool_calls).toBe(3);
    const rounds = await runFollowUpLoop({
      provider: createScriptedProvider(
        Array.from({ length: 10 }, () => ({ content: [call] })),
      ),
      system: "sys",
      initialUserMessage: "q",
      tools,
      budget: { ...budget, maxRounds: 2, maxToolCalls: 100 },
      hooks: {
        redact,
        executeTool: () =>
          Promise.resolve({ kind: "result", summary: "r", is_error: false }),
      },
      signal: new AbortController().signal,
    });
    expect(rounds.stop).toBe("budget_rounds");
  });

  it("pauses for approval with a resumable transcript", async () => {
    const provider = createScriptedProvider([
      {
        content: [
          { type: "tool_use", id: "t1", name: "inspect_go_binary", input: {} },
        ],
      },
    ]);
    const outcome = await runFollowUpLoop({
      provider,
      system: "sys",
      initialUserMessage: "q",
      tools,
      budget,
      hooks: {
        redact,
        executeTool: () =>
          Promise.resolve({ kind: "awaiting_approval", approval_id: "ap_1" }),
      },
      signal: new AbortController().signal,
    });
    expect(outcome.stop).toBe("awaiting_approval");
    expect(outcome.pending_approval_id).toBe("ap_1");
    expect(outcome.transcript.at(-1)?.role).toBe("user");
  });

  it("surfaces refusals and cancellation explicitly", async () => {
    const refused = await runFollowUpLoop({
      provider: createScriptedProvider([
        { content: [], stop_reason: "refusal" },
      ]),
      system: "sys",
      initialUserMessage: "q",
      tools,
      budget,
      hooks: {
        redact,
        executeTool: () => Promise.reject(new Error("unreachable")),
      },
      signal: new AbortController().signal,
    });
    expect(refused.stop).toBe("refusal");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runFollowUpLoop({
      provider: createScriptedProvider([
        { content: [{ type: "text", text: "x" }] },
      ]),
      system: "sys",
      initialUserMessage: "q",
      tools,
      budget,
      hooks: {
        redact,
        executeTool: () => Promise.reject(new Error("unreachable")),
      },
      signal: controller.signal,
    });
    expect(cancelled.stop).toBe("cancelled");
  });

  it("refuses to run with a disabled provider and names the reason", async () => {
    await expect(
      runFollowUpLoop({
        provider: createDisabledProvider("not configured"),
        system: "sys",
        initialUserMessage: "q",
        tools,
        budget,
        hooks: {
          redact,
          executeTool: () => Promise.reject(new Error("unreachable")),
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });
});

describe("createModelProviderFromEnv", () => {
  it("is disabled by default and when credentials are missing, without echoing values", () => {
    expect(createModelProviderFromEnv({}).available).toBe(false);
    const missing = createModelProviderFromEnv({
      REA_WEB_MODEL_PROVIDER: "anthropic",
    });
    expect(missing.available).toBe(false);
    expect(missing.unavailable_reason).toContain("REA_WEB_ANTHROPIC_API_KEY");
  });
  it("constructs the anthropic provider with the configured model id", () => {
    const provider = createModelProviderFromEnv({
      REA_WEB_MODEL_PROVIDER: "anthropic",
      REA_WEB_ANTHROPIC_API_KEY: "sk-ant-test-not-a-real-key",
      REA_WEB_MODEL_ID: "claude-opus-5-5",
    });
    expect(provider.id).toBe("anthropic");
    expect(provider.model).toBe("claude-opus-5-5");
    expect(JSON.stringify(provider)).not.toContain("sk-ant-test");
  });
});
