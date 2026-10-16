import {
  type ScopeResult,
  type VerificationScope,
  type VerificationStatus,
  VERIFIED_STATUS_BY_SCOPE,
} from "@rea-web/contracts";

export const SCOPE_ORDER: readonly VerificationScope[] = [
  "integrity",
  "clean_build",
  "data_restore",
  "behavior",
];

type StepLike = {
  readonly status: "passed" | "failed" | "skipped" | "blocked";
};
type InvariantLike = { readonly ok: boolean };

/**
 * A scope earns its verified status only when it had something to check and
 * every step passed and every invariant held. `failed`: something ran and did
 * not pass. `blocked`: it could not run.
 */
export const scopeStatus = (
  scope: VerificationScope,
  steps: readonly StepLike[],
  invariants: readonly InvariantLike[],
): VerificationStatus => {
  if (steps.length === 0 && invariants.length === 0) return "blocked";
  if (steps.some((s) => s.status === "failed") || invariants.some((i) => !i.ok))
    return "failed";
  if (steps.some((s) => s.status !== "passed")) return "blocked";
  return VERIFIED_STATUS_BY_SCOPE[scope];
};

const isVerified = (r: Pick<ScopeResult, "scope" | "status">): boolean =>
  r.status === VERIFIED_STATUS_BY_SCOPE[r.scope];

/**
 * One scope: its status. All verified: the most demanding scope's status.
 * Otherwise `failed` if all failed, `blocked` if all blocked, else `partial`.
 */
export const overallStatus = (
  results: readonly Pick<ScopeResult, "scope" | "status">[],
): VerificationStatus => {
  const [only] = results;
  if (results.length === 0) return "blocked";
  if (results.length === 1 && only !== undefined) return only.status;
  if (results.every(isVerified)) {
    const demanding = [...results].sort(
      (a, b) => SCOPE_ORDER.indexOf(b.scope) - SCOPE_ORDER.indexOf(a.scope),
    )[0];
    return demanding?.status ?? "partial";
  }
  if (results.every((r) => r.status === "failed")) return "failed";
  if (results.every((r) => r.status === "blocked")) return "blocked";
  return "partial";
};

export interface NetworkFacts {
  /** Registry or unknown-class steps the requested scopes need, run or not. */
  readonly needed: readonly string[];
  /** Steps that ran, and whether outbound network was denied for each. */
  readonly executed: readonly {
    readonly label: string;
    readonly isolated: boolean;
  }[];
}

/**
 * `yes` if any registry/unknown step was needed. `no` only if steps ran and
 * every one ran with network isolated. `unknown` otherwise.
 */
export const networkVerdict = (
  facts: NetworkFacts,
): { verdict: "yes" | "no" | "unknown"; reasons: string[] } => {
  if (facts.needed.length > 0)
    return { verdict: "yes", reasons: [...facts.needed] };
  const open = facts.executed.filter((e) => !e.isolated);
  if (facts.executed.length === 0)
    return {
      verdict: "unknown",
      reasons: [
        "no restore step was executed, so no network need was observed",
      ],
    };
  if (open.length === 0)
    return {
      verdict: "no",
      reasons: [
        `all ${facts.executed.length} executed step(s) completed with outbound network denied`,
      ],
    };
  return {
    verdict: "unknown",
    reasons: open.map(
      (e) =>
        `${e.label} ran without network isolation, so its need is unobserved`,
    ),
  };
};
