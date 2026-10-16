import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  jobResultSchemas,
  verificationScopeSchema,
  type JobResult,
  type RestoreReport,
} from "@rea-web/contracts";
import {
  restorePackage,
  verifyPackage,
  type RestoreScope,
} from "@rea-web/recovery";
import { runCommand } from "@rea-web/preservation";
import type { JobContext } from "../jobContext.js";
import { RUNNER_VERSION } from "../version.js";
import { downloadPackage } from "./package.js";

/**
 * recovery.verify: download the stored package, then run the standalone
 * verifier/restorer against it in this job's disposable workspace. Restore
 * credentials are separate from capture credentials: data restores use a
 * scratch database created through REA_WEB_VERIFY_DATABASE_ADMIN_URL and
 * dropped afterwards. Without it, data_restore is reported blocked.
 */
export interface VerifyDeps {
  /** Admin URL of a disposable PostgreSQL server used only for restores. */
  readonly databaseAdminUrl: string | null;
  readonly allowNetwork: readonly ("registry" | "unknown")[];
}

const withoutPassword = (url: URL): { url: string; password: string } => {
  const copy = new URL(url.toString());
  const password = decodeURIComponent(copy.password);
  copy.password = "";
  return { url: copy.toString(), password };
};

const psql = async (adminUrl: string, sql: string, signal: AbortSignal) => {
  const { url, password } = withoutPassword(new URL(adminUrl));
  const result = await runCommand(
    ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", url, "-c", sql],
    { env: { PGPASSWORD: password }, timeoutMs: 60_000, signal },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `psql failed (${result.exitCode}): ${result.stderr.slice(0, 400)}`,
    );
};

/** Create an empty scratch database; returns its URL and a dropper. */
const scratchDatabase = async (adminUrl: string, signal: AbortSignal) => {
  const name = `rea_verify_${randomBytes(6).toString("hex")}`;
  await psql(adminUrl, `CREATE DATABASE ${name}`, signal);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () =>
      psql(
        adminUrl,
        `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`,
        AbortSignal.timeout(60_000),
      ),
  };
};

export const runRecoveryVerify = async (
  ctx: JobContext,
  deps: VerifyDeps,
): Promise<JobResult<"recovery.verify">> => {
  const requested = verificationScopeSchema
    .array()
    .min(1)
    .parse(ctx.job.input["scope"]);
  const restoreScopes = requested.filter(
    (s): s is RestoreScope => s !== "integrity",
  );
  const packageDir = join(ctx.workspace, "package");
  const target = join(ctx.workspace, "restore-target");
  const reportPath = join(ctx.workspace, "restore-report.json");
  let database: Awaited<ReturnType<typeof scratchDatabase>> | null = null;
  try {
    const { root } = await downloadPackage(ctx, packageDir);
    await ctx.progress("package verified", {});
    let report: RestoreReport;
    if (restoreScopes.length === 0) {
      report = await verifyPackage(root, {
        verifierVersion: RUNNER_VERSION,
        reportPath,
        signal: ctx.signal,
      });
    } else {
      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true, mode: 0o700 });
      if (restoreScopes.includes("data_restore") && deps.databaseAdminUrl)
        database = await scratchDatabase(deps.databaseAdminUrl, ctx.signal);
      report = await restorePackage(root, {
        verifierVersion: RUNNER_VERSION,
        reportPath,
        signal: ctx.signal,
        scopes: restoreScopes,
        target,
        allowNetwork: deps.allowNetwork,
        ...(database ? { databaseUrl: database.url } : {}),
      });
    }
    // The report never contains the database password (the restorer
    // redacts it); scrub once more with the runner's redactor before upload.
    const body = ctx.redactor.redactText(JSON.stringify(report, null, 2));
    await writeFile(reportPath, body, { mode: 0o600 });
    const uploaded = await ctx.client.uploadArtifact(
      ctx.job.id,
      ctx.fencingToken,
      { kind: "verification_evidence", name: "restore-report.json" },
      { path: reportPath },
    );
    ctx.usage.addArtifactBytes(uploaded.size);
    return jobResultSchemas["recovery.verify"].parse({
      verification: {
        results: report.scopes
          .filter((s) => requested.includes(s.scope))
          .map((s) => ({
            scope: s.scope,
            status: s.status,
            detail: ctx.redactor.redactText(s.detail),
            performed_at: s.performed_at,
            evidence_object_key: uploaded.object_key,
          })),
        network_required: report.network_required,
        overall: report.overall,
      },
    });
  } finally {
    await database?.drop().catch(() => undefined);
    for (const path of [packageDir, target, reportPath])
      await rm(path, { recursive: true, force: true });
  }
};
