import {
  EvidenceOwnershipError,
  ToolArgumentsRejectedError,
  UnknownToolError,
  type ReaSession,
  type ToolCallOutcome,
} from "@rea-web/rea-adapter";
import type { ExecutionPolicy } from "@rea-web/contracts";
import { ApprovalRejectedError, type JobContext } from "../jobContext.js";
import type { AvailabilityView } from "./availability.js";
import { evaluatePolicy } from "./policy.js";

export type GuardedCall =
  | { readonly kind: "ran"; readonly outcome: ToolCallOutcome }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      readonly remediation: string;
    }
  | { readonly kind: "policy_rejected"; readonly reason: string }
  | { readonly kind: "approval_rejected"; readonly approvalId: string }
  | { readonly kind: "invalid_arguments"; readonly message: string }
  | { readonly kind: "budget_exhausted" };

/**
 * Single choke point for every upstream call made by a job: availability from
 * upstream, execution policy, approval pause, budget, schema validation (in
 * the adapter), evidence ownership (in the adapter), raw-result recording.
 */
export const guardedCall = async (input: {
  ctx: JobContext;
  session: ReaSession;
  availability: AvailabilityView;
  policy: Pick<
    ExecutionPolicy,
    "mode" | "allowed_effects" | "approval_required_effects"
  >;
  investigationId: string;
  tool: string;
  args: Record<string, unknown>;
  origin: "deterministic" | "model" | "operator";
  timeoutMs?: number;
}): Promise<GuardedCall> => {
  const { ctx, session, availability, tool, args } = input;
  const status = availability.status(tool);
  if (!status.available)
    return {
      kind: "unavailable",
      reason: status.reason,
      remediation: status.remediation,
    };
  if (ctx.usage.remainingToolCalls <= 0) return { kind: "budget_exhausted" };
  const decision = evaluatePolicy(input.policy, status.effects, input.origin);
  if (decision.kind === "reject")
    return { kind: "policy_rejected", reason: decision.reason };
  if (decision.kind === "approval") {
    try {
      await ctx.awaitApproval({
        tool,
        arguments: args,
        effects: decision.effects,
        reason: `${input.origin} request for ${tool} has effects requiring approval: ${decision.effects.join(", ")}`,
      });
    } catch (error) {
      if (error instanceof ApprovalRejectedError)
        return { kind: "approval_rejected", approvalId: error.approvalId };
      throw error;
    }
  }
  try {
    ctx.usage.addToolCall();
    const outcome = await session.callTool(tool, args, {
      signal: ctx.signal,
      timeoutMs: input.timeoutMs ?? 300_000,
      onProgress: (p) => {
        void ctx.emit("job.progress", {
          tool,
          progress: p.progress,
          ...(p.message !== undefined ? { message: p.message } : {}),
        });
      },
    });
    await ctx.recordOutcome(input.investigationId, outcome);
    return { kind: "ran", outcome };
  } catch (error) {
    if (
      error instanceof ToolArgumentsRejectedError ||
      error instanceof UnknownToolError ||
      error instanceof EvidenceOwnershipError
    )
      return { kind: "invalid_arguments", message: error.message };
    throw error;
  }
};
