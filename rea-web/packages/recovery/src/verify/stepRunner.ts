import { realpath } from "node:fs/promises";
import type { RestoreStep, RestoreStepResult } from "@rea-web/contracts";
import { isInsideOrEqual } from "../fsutil.js";
import {
  type Ctx,
  type NetworkClass,
  childEnvBase,
  ensureAssetsRoot,
} from "./context.js";
import { NON_EMPTY_DATABASE_SQL } from "./database.js";
import { type ExecOutcome, execProcess } from "./exec.js";

const TAIL_BYTES = 16 * 1024;
const RESERVED_ENV = /^(PATH|HOME|TMPDIR|LANG|PGPASSWORD|LD_.*|DYLD_.*)$/u;
const PLACEHOLDER_ROOTS = [
  "{{target}}",
  "{{package_root}}",
  "{{assets_root}}",
] as const;

export const usesDatabaseUrl = (step: RestoreStep): boolean =>
  step.run.some((a) => a.includes("{{database_url}}"));

export const usesAssetsRoot = (step: RestoreStep): boolean =>
  [...step.run, ...(step.cwd === undefined ? [] : [step.cwd])].some((a) =>
    a.includes("{{assets_root}}"),
  );

/** Last 16 KiB (bytes) of redacted output. */
export const redactedTail = (ctx: Ctx, text: string): string => {
  let out = ctx.scrub.text(text);
  if (out.length > TAIL_BYTES) out = out.slice(-TAIL_BYTES);
  while (Buffer.byteLength(out) > TAIL_BYTES) out = out.slice(1);
  return out.replace(/^�+/u, "");
};

export const fill = (ctx: Ctx, text: string): string =>
  text
    .split("{{package_root}}")
    .join(ctx.packageRoot)
    .split("{{target}}")
    .join(ctx.target ?? "")
    .split("{{assets_root}}")
    .join(ctx.assetsRoot ?? "")
    .split("{{database_url}}")
    .join(ctx.db?.urlWithoutPassword ?? "");

export interface NetworkDecision {
  readonly allowed: boolean;
  readonly isolate: boolean;
  readonly why: string;
}

/** How a step with this network class is allowed to run. */
export async function decideNetwork(
  ctx: Ctx,
  networkClass: NetworkClass,
): Promise<NetworkDecision> {
  switch (networkClass) {
    case "none": {
      const iso = await ctx.isolation();
      return {
        allowed: true,
        isolate: iso.available,
        why: iso.available ? "network namespace" : iso.detail,
      };
    }
    case "database": {
      const iso = await ctx.isolation();
      const socket = ctx.db?.viaSocket === true;
      return {
        allowed: true,
        isolate: iso.available && socket,
        why: socket
          ? iso.available
            ? "database reached through a Unix socket inside a network namespace"
            : iso.detail
          : "database reached over TCP, which a network namespace would cut",
      };
    }
    case "registry":
    case "unknown": {
      const allowed = ctx.allow.has(networkClass);
      return {
        allowed,
        isolate: false,
        why: allowed
          ? `--allow-network ${networkClass} was supplied`
          : `requires ${networkClass === "registry" ? "package registry" : "unclassified network"} access; pass --allow-network ${networkClass}`,
      };
    }
  }
}

/** A step result that records no execution; `status` and `reason` say why. */
export const unexecutedStep = (
  ctx: Ctx,
  componentId: string,
  step: RestoreStep,
  status: "blocked" | "skipped",
  reason: string,
): RestoreStepResult => ({
  ...baseResult(ctx, componentId, step, fill(ctx, step.cwd ?? "{{target}}")),
  status,
  reason: ctx.scrub.text(reason),
});

const baseResult = (
  ctx: Ctx,
  componentId: string,
  step: RestoreStep,
  cwd: string,
): RestoreStepResult => ({
  component_id: componentId,
  step_id: step.id,
  title: ctx.scrub.text(step.title),
  argv: step.run.map((a) => ctx.scrub.text(fill(ctx, a))),
  cwd: ctx.scrub.text(cwd),
  network: step.network,
  network_isolated: false,
  status: "blocked",
  exit_code: null,
  signal: null,
  timed_out: false,
  duration_ms: 0,
  stdout_tail: "",
  stderr_tail: "",
});

/** Resolve the step's cwd and require it to stay inside its declared root. */
async function confineCwd(
  ctx: Ctx,
  step: RestoreStep,
): Promise<
  { ok: true; cwd: string } | { ok: false; cwd: string; reason: string }
> {
  const template = step.cwd ?? "{{target}}";
  const rootTemplate = PLACEHOLDER_ROOTS.find(
    (r) => template === r || template.startsWith(`${r}/`),
  );
  const cwd = fill(ctx, template);
  if (rootTemplate === undefined)
    return { ok: false, cwd, reason: "cwd is not under a permitted root" };
  try {
    const [real, root] = await Promise.all([
      realpath(cwd),
      realpath(fill(ctx, rootTemplate)),
    ]);
    if (!isInsideOrEqual(root, real))
      return {
        ok: false,
        cwd,
        reason: `cwd resolves to ${real}, outside ${rootTemplate}`,
      };
    return { ok: true, cwd: real };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      cwd,
      reason:
        code === "ENOENT"
          ? "the working directory does not exist (an earlier scope or step must create it)"
          : `the working directory cannot be resolved (${code ?? "error"})`,
    };
  }
}

export interface StepExpectation {
  readonly exit: number;
  readonly timeoutMs: number;
}

/** Child environment for a step: minimal, plus the database password and declared names. */
export function stepEnvironment(
  ctx: Ctx,
  step: RestoreStep,
): { ok: true; env: Record<string, string> } | { ok: false; reason: string } {
  const env = childEnvBase(
    ctx.pathVar,
    ctx.dirs ?? { home: "/nonexistent", tmp: "/nonexistent" },
  );
  if (
    ctx.db !== null &&
    ctx.db.password !== "" &&
    (usesDatabaseUrl(step) || step.network === "database")
  )
    env["PGPASSWORD"] = ctx.db.password;
  for (const name of step.env_names) {
    if (RESERVED_ENV.test(name))
      return {
        ok: false,
        reason: `step ${step.id} declares reserved environment name ${name}`,
      };
    const value = ctx.opts.stepEnv?.[name];
    if (value !== undefined) env[name] = value;
  }
  return { ok: true, env };
}

const describeOutcome = (
  out: ExecOutcome,
  expected: StepExpectation,
): { passed: boolean; reason?: string } => {
  if (out.spawnError !== null)
    return { passed: false, reason: `could not start: ${out.spawnError}` };
  if (out.timedOut)
    return {
      passed: false,
      reason: `timed out after ${expected.timeoutMs} ms`,
    };
  if (out.aborted) return { passed: false, reason: "aborted" };
  if (out.signal !== null)
    return { passed: false, reason: `terminated by ${out.signal}` };
  if (out.exitCode !== expected.exit)
    return {
      passed: false,
      reason: `exit code ${out.exitCode ?? "none"}, expected ${expected.exit}`,
    };
  return { passed: true };
};

/** Run argv, wrapped in a network namespace when `isolate` is set. */
export async function spawnStep(
  ctx: Ctx,
  argv: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    isolate: boolean;
  },
): Promise<ExecOutcome> {
  const iso = options.isolate ? await ctx.isolation() : null;
  const full =
    iso?.unsharePath != null
      ? [iso.unsharePath, "-rn", "--", ...argv]
      : [...argv];
  return execProcess(full, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    signal: ctx.opts.signal,
  });
}

/** Execute one validated step. Never throws for step-level problems. */
export async function executeStep(
  ctx: Ctx,
  componentId: string,
  step: RestoreStep,
  expected: StepExpectation,
): Promise<RestoreStepResult> {
  const blocked = (
    cwd: string,
    reason: string,
    isolated = false,
  ): RestoreStepResult => ({
    ...baseResult(ctx, componentId, step, cwd),
    network_isolated: isolated,
    reason: ctx.scrub.text(reason),
  });
  if (usesAssetsRoot(step)) await ensureAssetsRoot(ctx);
  const dir = await confineCwd(ctx, step);
  if (!dir.ok) return blocked(dir.cwd, dir.reason);
  const env = stepEnvironment(ctx, step);
  if (!env.ok) return blocked(dir.cwd, env.reason);
  const net = await decideNetwork(ctx, step.network);
  if (!net.allowed) return blocked(dir.cwd, net.why);

  const argv = step.run.map((a) => fill(ctx, a));
  const out = await spawnStep(ctx, argv, {
    cwd: dir.cwd,
    env: env.env,
    timeoutMs: expected.timeoutMs,
    isolate: net.isolate,
  });
  ctx.opts.signal?.throwIfAborted();
  const verdict = describeOutcome(out, expected);
  ctx.facts.executed.push({
    label: `step ${step.id} (${componentId})`,
    isolated: net.isolate,
  });
  return {
    ...baseResult(ctx, componentId, step, dir.cwd),
    network_isolated: net.isolate,
    status: verdict.passed ? "passed" : "failed",
    exit_code: out.exitCode,
    signal: out.signal,
    timed_out: out.timedOut,
    duration_ms: Math.round(out.durationMs),
    stdout_tail: redactedTail(ctx, out.stdout),
    stderr_tail: redactedTail(ctx, out.stderr),
    ...(verdict.reason === undefined
      ? {}
      : { reason: ctx.scrub.text(verdict.reason) }),
  };
}

/** Run one psql query against the disposable database (read-only session). */
export async function runPsql(
  ctx: Ctx,
  sql: string,
  timeoutMs: number,
): Promise<{ out: ExecOutcome; isolated: boolean } | { problem: string }> {
  if (ctx.db === null || ctx.dirs === null || ctx.target === null)
    return { problem: "no disposable database or target is available" };
  const env = childEnvBase(ctx.pathVar, ctx.dirs);
  if (ctx.db.password !== "") env["PGPASSWORD"] = ctx.db.password;
  env["PGOPTIONS"] =
    "-c default_transaction_read_only=on -c statement_timeout=60000";
  const net = await decideNetwork(ctx, "database");
  const out = await spawnStep(
    ctx,
    [
      "psql",
      "-X",
      "-A",
      "-t",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "--dbname",
      ctx.db.urlWithoutPassword,
      "-c",
      sql,
    ],
    { cwd: ctx.target, env, timeoutMs, isolate: net.isolate },
  );
  return { out, isolated: net.isolate };
}

const firstLine = (ctx: Ctx, text: string): string =>
  ctx.scrub.text(text.trim().split("\n")[0] ?? "");

/**
 * Refuse a database that already holds relations. Evaluated once per run,
 * before anything is restored into it.
 */
export function databaseEmptyGate(ctx: Ctx): Promise<string | null> {
  ctx.databaseGate ??= (async () => {
    const r = await runPsql(ctx, NON_EMPTY_DATABASE_SQL, 60_000);
    if ("problem" in r) return r.problem;
    if (r.out.exitCode !== 0)
      return `the disposable database could not be inspected: ${firstLine(ctx, r.out.stderr || r.out.spawnError || "psql failed")}`;
    const count = Number(r.out.stdout.trim());
    if (!Number.isInteger(count))
      return "the disposable database could not be inspected: unexpected psql output";
    return count === 0
      ? null
      : `the disposable database is not empty: ${count} relation(s) outside pg_catalog and information_schema`;
  })();
  return ctx.databaseGate;
}
