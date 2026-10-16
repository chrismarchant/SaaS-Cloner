import type { RestoreReport } from "@rea-web/contracts";

/** Short per-scope summary for the terminal. Contains no secrets: the report is already redacted. */
export function summarize(command: string, report: RestoreReport): string {
  const lines = [
    `rea-recover ${command}: package ${report.package_id} (manifest sha256 ${report.manifest_sha256.slice(0, 12)})`,
  ];
  for (const scope of report.scopes) {
    lines.push(`  ${scope.scope.padEnd(13)} ${scope.status}`);
    lines.push(`      ${scope.detail}`);
    if (scope.missing_tools.length > 0)
      lines.push(`      missing tools: ${scope.missing_tools.join(", ")}`);
    for (const step of scope.steps)
      if (step.status !== "passed")
        lines.push(
          `      step ${step.step_id}: ${step.status}${step.reason === undefined ? "" : ` (${step.reason})`}`,
        );
    for (const inv of scope.invariants)
      if (!inv.ok)
        lines.push(
          `      invariant ${inv.id}: did not hold${inv.detail === undefined ? "" : ` (${inv.detail})`}`,
        );
  }
  lines.push(`overall: ${report.overall}`);
  lines.push(
    `network required: ${report.network_required.verdict}${report.network_required.reasons.length > 0 ? ` (${report.network_required.reasons.join("; ")})` : ""}`,
  );
  lines.push(
    `network isolation: ${report.network_isolation.mechanism} (${report.network_isolation.detail})`,
  );
  return `${lines.join("\n")}\n`;
}

/** 0 verified, 2 failed, 3 blocked, 4 partial; anything else is an internal error. */
export function exitCodeFor(report: RestoreReport): number {
  switch (report.overall) {
    case "integrity_verified":
    case "clean_build_verified":
    case "data_restore_verified":
    case "behavior_verified":
      return 0;
    case "failed":
      return 2;
    case "blocked":
      return 3;
    case "partial":
      return 4;
    case "captured":
      return 1;
  }
}
