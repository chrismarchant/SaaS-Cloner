/**
 * Reading a restore report. The runner uploads it as verification evidence;
 * it is parsed once with the contract schema (`restoreReportSchema`) and only
 * ever rendered as text. A report that does not match is not summarised.
 */
import {
  restoreReportSchema,
  type RestoreReport,
} from "@rea-web/contracts/browser";

export type ReportParse =
  | { readonly ok: true; readonly report: RestoreReport }
  | { readonly ok: false; readonly issues: readonly string[] };

export const parseRestoreReport = (value: unknown): ReportParse => {
  const parsed = restoreReportSchema.safeParse(value);
  if (parsed.success) return { ok: true, report: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (issue) =>
        `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
    ),
  };
};

export interface StepSummary {
  readonly scope: string;
  readonly stepId: string;
  readonly status: string;
  /** `null` when the step did not exit (skipped, blocked, killed by a signal). */
  readonly exitCode: number | null;
  readonly networkIsolated: boolean;
}

/** One row per restore step, in report order, with only the fields shown. */
export const stepSummaries = (report: RestoreReport): StepSummary[] =>
  report.scopes.flatMap((scope) =>
    scope.steps.map((step) => ({
      scope: scope.scope,
      stepId: step.step_id,
      status: step.status,
      exitCode: step.exit_code,
      networkIsolated: step.network_isolated,
    })),
  );
