import type { ExecutionPolicy } from "@rea-web/contracts";

export type PolicyDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "approval"; readonly effects: readonly string[] }
  | {
      readonly kind: "reject";
      readonly reason: string;
      readonly effects: readonly string[];
    };

/** Effects that `static_only` never permits, approved or not. */
const STATIC_ONLY_FORBIDDEN = new Set([
  "executesForeignCode",
  "mutatesDevice",
  "changesUiState",
]);

/**
 * Decide whether a tool call with these upstream effects may run under the
 * investigation's policy. Unknown effect sets are treated as unsafe.
 * Upstream effect metadata are hints, not authorization (docs/mcp-contracts.md);
 * this policy is the control-plane authorization layer above them.
 */
export const evaluatePolicy = (
  policy: Pick<
    ExecutionPolicy,
    "mode" | "allowed_effects" | "approval_required_effects"
  >,
  effects: readonly string[],
  origin: "deterministic" | "model" | "operator",
): PolicyDecision => {
  const truthy = effects.filter((e) => e !== "idempotent");
  if (policy.mode === "static_only") {
    const forbidden = truthy.filter((e) => STATIC_ONLY_FORBIDDEN.has(e));
    if (forbidden.length > 0)
      return {
        kind: "reject",
        reason: `policy mode static_only forbids effects: ${forbidden.join(", ")}`,
        effects: forbidden,
      };
  }
  const needsApproval = truthy.filter((e) =>
    (policy.approval_required_effects as readonly string[]).includes(e),
  );
  const notAllowed = truthy.filter(
    (e) =>
      !(policy.allowed_effects as readonly string[]).includes(e) &&
      !(policy.approval_required_effects as readonly string[]).includes(e),
  );
  if (notAllowed.length > 0)
    return {
      kind: "reject",
      reason: `effects not permitted by policy: ${notAllowed.join(", ")}`,
      effects: notAllowed,
    };
  // An operator's explicit follow-up request is itself the approval decision.
  if (needsApproval.length > 0 && origin !== "operator")
    return { kind: "approval", effects: needsApproval };
  return { kind: "allow" };
};
