import {
  DEFAULT_JOB_BUDGET,
  TOOL_EFFECTS,
  executionPolicySchema,
  jobBudgetSchema,
  type JobBudget,
  type ToolEffect,
} from "@rea-web/contracts/browser";

export type PolicyMode = "static_only" | "static_plus_runtime";
export const BUDGET_KEYS = Object.keys(
  jobBudgetSchema.shape,
) as (keyof JobBudget)[];
export const CONTRACT_BUDGET_DEFAULTS: JobBudget = DEFAULT_JOB_BUDGET;

export interface PolicyDraft {
  mode: PolicyMode;
  allowed: ToolEffect[];
  approval: ToolEffect[];
  modelFollowUp: boolean;
  maxRounds: string;
  /** Text per budget key; empty means "no override". */
  budget: Record<string, string>;
}

/** Draft holding the contract's own defaults. */
export const defaultPolicyDraft = (): PolicyDraft => {
  const defaults = executionPolicySchema.parse({});
  return {
    mode: defaults.mode,
    allowed: [...defaults.allowed_effects],
    approval: [...defaults.approval_required_effects],
    modelFollowUp: defaults.model_follow_up,
    maxRounds: String(defaults.max_follow_up_rounds),
    budget: {},
  };
};

export type PolicyResult =
  | { readonly ok: true; readonly policy: Record<string, unknown> }
  | { readonly ok: false; readonly errors: Record<string, string> };

const orderEffects = (effects: readonly ToolEffect[]): ToolEffect[] =>
  TOOL_EFFECTS.filter((effect) => effects.includes(effect));

/** Request `policy` from a draft; every problem is reported by field. */
export const policyFromDraft = (draft: PolicyDraft): PolicyResult => {
  const errors: Record<string, string> = {};
  const rounds = draft.maxRounds.trim();
  const maxRounds = /^\d+$/u.test(rounds) ? Number(rounds) : Number.NaN;
  const budget: Record<string, number> = {};
  for (const key of BUDGET_KEYS) {
    const text = (draft.budget[key] ?? "").trim();
    if (text === "") continue;
    if (!/^\d+$/u.test(text) || !Number.isSafeInteger(Number(text)))
      errors[key] = "must be a whole number";
    else budget[key] = Number(text);
  }
  const parsedBudget = jobBudgetSchema.partial().safeParse(budget);
  if (!parsedBudget.success)
    for (const issue of parsedBudget.error.issues) {
      const key = String(issue.path[0] ?? "budget");
      errors[key] = issue.message;
    }
  const policy = {
    mode: draft.mode,
    allowed_effects: orderEffects(draft.allowed),
    approval_required_effects: orderEffects(draft.approval),
    model_follow_up: draft.modelFollowUp,
    max_follow_up_rounds: maxRounds,
    budget,
  };
  const parsed = executionPolicySchema.safeParse(policy);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "policy");
      if (key !== "budget" && errors[key] === undefined)
        errors[key] = issue.message;
    }
  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, policy };
};
