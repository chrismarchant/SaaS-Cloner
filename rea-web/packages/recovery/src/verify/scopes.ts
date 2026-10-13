import type {
  InvariantResult,
  RestoreStep,
  RestoreStepResult,
  ScopeResult,
} from "@rea-web/contracts";
import { validateRestoreStepArguments } from "@rea-web/contracts";
import { sha256Hex } from "../fsutil.js";
import { type Ctx, type RestoreScope, databaseBlockedHost } from "./context.js";
import { readOnlySql } from "./database.js";
import {
  type BehaviorSpec,
  type InvariantSource,
  loadBehaviorSpecs,
  loadInvariants,
} from "./packageSpecs.js";
import { scopeStatus } from "./status.js";
import {
  databaseEmptyGate,
  decideNetwork,
  executeStep,
  runPsql,
  unexecutedStep,
  usesDatabaseUrl,
} from "./stepRunner.js";

interface PlannedStep {
  readonly componentId: string;
  readonly step: RestoreStep;
}

const plannedSteps = (ctx: Ctx, scope: RestoreScope): PlannedStep[] =>
  ctx.manifest.components.flatMap((c) =>
    c.restore.steps
      .filter((s) => s.scope === scope)
      .map((step) => ({ componentId: c.id, step })),
  );

const result = (
  ctx: Ctx,
  scope: RestoreScope,
  parts: {
    status: ScopeResult["status"];
    detail: string;
    missing?: string[];
    steps?: RestoreStepResult[];
    invariants?: InvariantResult[];
  },
): ScopeResult => ({
  scope,
  status: parts.status,
  detail: ctx.scrub.text(parts.detail),
  performed_at: (ctx.opts.now?.() ?? new Date()).toISOString(),
  missing_tools: parts.missing ?? [],
  steps: parts.steps ?? [],
  invariants: parts.invariants ?? [],
});

const blockedScope = (
  ctx: Ctx,
  scope: RestoreScope,
  reason: string,
  extra: { missing?: string[]; steps?: RestoreStepResult[] } = {},
): ScopeResult =>
  result(ctx, scope, {
    status: "blocked",
    detail: `blocked: ${reason}`,
    ...extra,
  });

const networkNeedText = (
  componentId: string,
  step: RestoreStep,
  allowed: boolean,
): string =>
  `step ${step.id} (${componentId}) requires ${step.network === "registry" ? "package registry" : "unclassified network"} access${allowed ? " (permitted by --allow-network)" : " (denied: not permitted)"}`;

/** Tools to look up before a scope runs: declared requirements plus the programs themselves. */
const requiredTools = (
  planned: readonly PlannedStep[],
  needsPsql: boolean,
): string[] => {
  const out: string[] = [];
  for (const { step } of planned) {
    out.push(...step.requires);
    const program = step.run[0] ?? "";
    if (!program.includes("/") && !program.includes("{{")) out.push(program);
  }
  if (needsPsql) out.push("psql");
  return out;
};

async function evaluateInvariants(
  ctx: Ctx,
  sources: readonly InvariantSource[],
): Promise<InvariantResult[]> {
  const results: InvariantResult[] = [];
  for (const source of sources) {
    if ("error" in source) {
      results.push({
        id: source.file,
        sql_sha256: sha256Hex(source.file),
        expected: null,
        actual: null,
        ok: false,
        detail: `invariants file is unusable: ${source.error}`,
      });
      continue;
    }
    for (const inv of source.invariants) {
      ctx.opts.signal?.throwIfAborted();
      const base = {
        id: inv.id,
        sql_sha256: sha256Hex(inv.sql),
        expected: inv.expected,
      };
      const sql = readOnlySql(inv.sql);
      if (!sql.ok) {
        results.push({ ...base, actual: null, ok: false, detail: sql.reason });
        continue;
      }
      const r = await runPsql(ctx, sql.sql, 90_000);
      if ("problem" in r) {
        results.push({ ...base, actual: null, ok: false, detail: r.problem });
        continue;
      }
      ctx.facts.executed.push({
        label: `invariant ${inv.id}`,
        isolated: r.isolated,
      });
      if (r.out.exitCode !== 0 || r.out.timedOut) {
        const why = (r.out.stderr || r.out.spawnError || "psql failed").trim();
        results.push({
          ...base,
          actual: null,
          ok: false,
          detail: ctx.scrub.text(
            r.out.timedOut
              ? "timed out"
              : (why.split("\n")[0] ?? "psql failed"),
          ),
        });
        continue;
      }
      const actual = r.out.stdout.trim();
      results.push({
        ...base,
        actual: ctx.scrub.text(actual),
        ok: inv.expected !== null && actual === inv.expected,
        ...(inv.expected === null
          ? { detail: "capture recorded no value to compare against" }
          : actual === inv.expected
            ? {}
            : { detail: "value differs from the one recorded at capture" }),
      });
    }
  }
  return results;
}

/** Everything that must hold before the first step of a scope runs. */
async function preflight(
  ctx: Ctx,
  scope: RestoreScope,
  planned: readonly PlannedStep[],
  priorCleanBuild: ScopeResult | undefined,
): Promise<ScopeResult | null> {
  const blocked = (
    reason: string,
    extra?: { missing?: string[] },
  ): ScopeResult => blockedScope(ctx, scope, reason, extra);
  if (ctx.globalBlock !== null) return blocked(ctx.globalBlock);
  for (const { step } of planned) {
    const verdict = validateRestoreStepArguments(step);
    if (!verdict.ok) return blocked(verdict.reason);
  }
  const denied: RestoreStepResult[] = [];
  for (const { componentId, step } of planned) {
    if (step.network !== "registry" && step.network !== "unknown") continue;
    const net = await decideNetwork(ctx, step.network);
    if (!net.allowed)
      denied.push(unexecutedStep(ctx, componentId, step, "blocked", net.why));
  }
  if (denied.length > 0)
    return blockedScope(
      ctx,
      scope,
      denied.map((d) => `step ${d.step_id} ${d.reason ?? ""}`).join("; "),
      { steps: denied },
    );
  if (
    scope === "behavior" &&
    priorCleanBuild !== undefined &&
    priorCleanBuild.status !== "clean_build_verified"
  )
    return blocked(
      "clean_build did not complete, so there is no restored source to check",
    );
  const needsDb =
    scope === "data_restore" || planned.some((p) => usesDatabaseUrl(p.step));
  if (needsDb) {
    if (ctx.opts.databaseUrl === undefined)
      return blocked(
        "no disposable database was supplied (--database-url-env)",
      );
    if (ctx.dbProblem !== null || ctx.db === null)
      return blocked(ctx.dbProblem ?? "the database URL is unusable");
    const host = databaseBlockedHost(ctx);
    if (host !== null)
      return blocked(
        `database host ${host} is listed in restore_guards.blocked_hosts`,
      );
  }
  const missing = await ctx.tools.missing(requiredTools(planned, needsDb));
  if (missing.length > 0)
    return blocked(`missing or outdated tools: ${missing.join(", ")}`, {
      missing,
    });
  if (needsDb) {
    const gate = await databaseEmptyGate(ctx);
    if (gate !== null) return blocked(gate);
  }
  return null;
}

const summarise = (
  steps: readonly RestoreStepResult[],
  inv: readonly InvariantResult[],
): string => {
  const passed = steps.filter((s) => s.status === "passed").length;
  const failed = steps.find((s) => s.status === "failed");
  const blocked = steps.find((s) => s.status === "blocked");
  const badInv = inv.filter((i) => !i.ok);
  const parts = [`${passed}/${steps.length} step(s) passed`];
  if (inv.length > 0)
    parts.push(`${inv.length - badInv.length}/${inv.length} invariant(s) held`);
  if (failed !== undefined)
    parts.push(`step ${failed.step_id} failed: ${failed.reason ?? "unknown"}`);
  if (blocked !== undefined)
    parts.push(
      `step ${blocked.step_id} blocked: ${blocked.reason ?? "unknown"}`,
    );
  for (const i of badInv.slice(0, 3))
    parts.push(
      `invariant ${i.id} did not hold${i.detail === undefined ? "" : ` (${i.detail})`}`,
    );
  return parts.join("; ");
};

export async function runScope(
  ctx: Ctx,
  scope: RestoreScope,
  prior: readonly ScopeResult[],
): Promise<ScopeResult> {
  const planned = plannedSteps(ctx, scope);
  const sources =
    scope === "data_restore"
      ? await loadInvariants(ctx.packageRoot, ctx.manifest)
      : [];
  if (planned.length === 0 && sources.length === 0)
    return blockedScope(ctx, scope, `the package declares no ${scope} steps`);

  for (const { componentId, step } of planned)
    if (step.network === "registry" || step.network === "unknown")
      ctx.facts.needed.push(
        networkNeedText(componentId, step, ctx.allow.has(step.network)),
      );

  const stop = await preflight(
    ctx,
    scope,
    planned,
    prior.find((r) => r.scope === "clean_build"),
  );
  if (stop !== null) return stop;

  const behavior: Map<string, BehaviorSpec> =
    scope === "behavior"
      ? await loadBehaviorSpecs(ctx.packageRoot, ctx.manifest)
      : new Map();
  const steps: RestoreStepResult[] = [];
  let halted: string | null = null;
  for (const { componentId, step } of planned) {
    ctx.opts.signal?.throwIfAborted();
    if (halted !== null) {
      steps.push(unexecutedStep(ctx, componentId, step, "skipped", halted));
      continue;
    }
    const spec = behavior.get(step.id);
    const matches =
      spec !== undefined &&
      spec.run.length === step.run.length &&
      spec.run.every((a, i) => a === step.run[i]);
    const r = await executeStep(ctx, componentId, step, {
      exit: matches ? spec.expectExit : 0,
      timeoutMs: (matches ? spec.timeoutMs : null) ?? ctx.timeoutMs,
    });
    steps.push(r);
    if (r.status !== "passed" && scope !== "behavior")
      halted = `skipped after step ${step.id} ${r.status === "failed" ? "failed" : "was blocked"}`;
  }

  const failedSteps = steps.some(
    (s) => s.status === "failed" || s.status === "blocked",
  );
  const invariants = failedSteps ? [] : await evaluateInvariants(ctx, sources);
  const detailSuffix =
    scope === "data_restore" && sources.length === 0
      ? "; the package declares no invariants"
      : "";
  return result(ctx, scope, {
    status: scopeStatus(scope, steps, invariants),
    detail: `${summarise(steps, invariants)}${detailSuffix}`,
    steps,
    invariants,
  });
}
