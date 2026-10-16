import {
  ApiError,
  exportSignatureSummarySchema,
  uuidv7,
  validateRelativePath,
  verificationSchema,
} from "@rea-web/contracts";
import type {
  BuildRecord,
  CaptureRecord,
  JobRecord,
  PlanRecord,
} from "@rea-web/db";
import type { AppContext } from "../context.js";
import { exportArchiveKey, verificationPrefix } from "./artifacts.js";
import {
  buildView,
  captureView,
  exportView,
  jobSummaryView,
  planView,
  runStatusFromJob,
  verificationView,
} from "./mappers.js";
import { readStoredManifest } from "./storedManifest.js";
import { sendObject } from "./streaming.js";
import type { HandlersFor } from "./types.js";
import { createJob, resolvePreferredRunner } from "./jobsupport.js";

const loadBuild = async (
  ctx: AppContext,
  projectId: string,
  buildId: string,
): Promise<BuildRecord> => {
  const build = await ctx.repos.builds.findById(projectId, buildId);
  if (build === null) throw new ApiError("not_found", "Build not found");
  return build;
};

const loadCapture = async (
  ctx: AppContext,
  projectId: string,
  buildId: string,
  captureId: string,
): Promise<CaptureRecord> => {
  const capture = await ctx.repos.captures.findById(projectId, captureId);
  if (capture === null || capture.build_id !== buildId)
    throw new ApiError("not_found", "Capture not found");
  return capture;
};

const loadPlan = async (
  ctx: AppContext,
  projectId: string,
  buildId: string,
  planId: string,
): Promise<PlanRecord> => {
  const plan = await ctx.repos.plans.findById(projectId, planId);
  if (plan === null || plan.build_id !== buildId)
    throw new ApiError("not_found", "Plan not found");
  return plan;
};

/** The jobs behind a page of resources, in one query. */
const jobsOf = async (
  ctx: AppContext,
  records: readonly { readonly job_id: string }[],
): Promise<(id: string) => JobRecord | null> => {
  const jobs = await ctx.repos.jobs.listByIds(records.map((r) => r.job_id));
  const byId = new Map(jobs.map((job) => [job.id, job]));
  return (id) => byId.get(id) ?? null;
};

const loadVerification = async (
  ctx: AppContext,
  projectId: string,
  captureId: string,
  verificationId: string,
) => {
  const verification = await ctx.repos.verifications.findById(
    projectId,
    verificationId,
  );
  if (verification === null || verification.capture_id !== captureId)
    throw new ApiError("not_found", "Verification not found");
  return verification;
};

const loadExport = async (
  ctx: AppContext,
  projectId: string,
  buildId: string,
  exportId: string,
) => {
  await loadBuild(ctx, projectId, buildId);
  const record = await ctx.repos.exports.findById(projectId, exportId);
  if (record === null) throw new ApiError("not_found", "Export not found");
  await loadCapture(ctx, projectId, buildId, record.capture_id);
  return record;
};

const requireSucceededCapture = async (
  ctx: AppContext,
  capture: CaptureRecord,
): Promise<void> => {
  const job = await ctx.repos.jobs.findById(capture.job_id);
  if (job?.state !== "succeeded")
    throw new ApiError("conflict", "The capture has not completed", {
      reason: "capture_not_completed",
      job_state: job?.state ?? null,
    });
};

export const buildHandlers = (): HandlersFor<
  | "createBuild"
  | "listBuilds"
  | "getBuild"
  | "createPlan"
  | "listPlans"
  | "getPlan"
  | "createCapture"
  | "listCaptures"
  | "getCapture"
  | "getCaptureManifest"
  | "getCaptureCoverage"
  | "createVerification"
  | "listVerifications"
  | "getVerification"
  | "downloadVerificationReport"
  | "createExport"
  | "listExports"
  | "getExport"
  | "downloadExport"
  | "downloadExportSignature"
> => ({
  async createBuild({ ctx, user, params, body }) {
    const preferred = await resolvePreferredRunner(
      ctx,
      params.p,
      body.runner_id,
    );
    const build = await ctx.repos.builds.create({
      project_id: params.p,
      name: body.name,
      description: body.description,
      source: body.source,
      components: body.components,
      preferred_runner_id: preferred,
      created_by: user.user.id,
    });
    return buildView(build);
  },

  async listBuilds({ ctx, params, query }) {
    const page = await ctx.repos.builds.list(params.p, {
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map(buildView), next_cursor: page.next_cursor };
  },

  async getBuild({ ctx, params }) {
    return buildView(await loadBuild(ctx, params.p, params.b));
  },

  async createPlan({ ctx, req, user, params, body }) {
    const build = await loadBuild(ctx, params.p, params.b);
    const preferred =
      (await resolvePreferredRunner(ctx, params.p, body.runner_id)) ??
      build.preferred_runner_id;
    const planId = uuidv7();
    const jobId = uuidv7();
    const job = await ctx.db.withTransaction(async (client) => {
      const created = await createJob(
        ctx,
        req,
        user,
        {
          id: jobId,
          project_id: params.p,
          kind: "preservation.plan",
          input: { build_id: build.id, plan_id: planId },
          preferred_runner_id: preferred,
        },
        client,
      );
      await ctx.repos.plans.create(
        { id: planId, build_id: build.id, job_id: jobId, runner_id: preferred },
        client,
      );
      return created;
    });
    return { ...jobSummaryView(job), plan_id: planId, job_id: job.id };
  },

  async listPlans({ ctx, params, query }) {
    await loadBuild(ctx, params.p, params.b);
    const page = await ctx.repos.plans.listByBuild(params.b, {
      cursor: query.cursor,
      limit: query.limit,
    });
    const job = await jobsOf(ctx, page.items);
    return {
      items: page.items.map((plan) => planView(plan, job(plan.job_id))),
      next_cursor: page.next_cursor,
    };
  },

  async getPlan({ ctx, params }) {
    await loadBuild(ctx, params.p, params.b);
    const plan = await loadPlan(ctx, params.p, params.b, params.pl);
    if (plan.plan === null) {
      const job = await ctx.repos.jobs.findById(plan.job_id);
      throw new ApiError("conflict", "The plan has not been produced yet", {
        reason: "plan_not_ready",
        job_id: plan.job_id,
        job_state: job?.state ?? null,
      });
    }
    return planView(plan, await ctx.repos.jobs.findById(plan.job_id));
  },

  async createCapture({ ctx, req, user, params, body }) {
    const build = await loadBuild(ctx, params.p, params.b);
    const plan = await loadPlan(ctx, params.p, params.b, body.plan_id);
    if (plan.plan === null)
      throw new ApiError("conflict", "The plan has not been produced yet", {
        reason: "plan_not_ready",
        job_id: plan.job_id,
      });
    const preferred =
      (await resolvePreferredRunner(ctx, params.p, body.runner_id)) ??
      plan.runner_id ??
      build.preferred_runner_id;
    const captureId = uuidv7();
    const jobId = uuidv7();
    const { capture, job } = await ctx.db.withTransaction(async (client) => {
      const created = await createJob(
        ctx,
        req,
        user,
        {
          id: jobId,
          project_id: params.p,
          kind: "preservation.capture",
          input: {
            build_id: build.id,
            plan_id: plan.id,
            capture_id: captureId,
          },
          preferred_runner_id: preferred,
        },
        client,
      );
      const row = await ctx.repos.captures.create(
        { id: captureId, build_id: build.id, plan_id: plan.id, job_id: jobId },
        client,
      );
      return { capture: row, job: created };
    });
    return captureView(capture, job);
  },

  async listCaptures({ ctx, params, query }) {
    await loadBuild(ctx, params.p, params.b);
    const page = await ctx.repos.captures.pageByBuild(params.b, {
      cursor: query.cursor,
      limit: query.limit,
    });
    const job = await jobsOf(ctx, page.items);
    return {
      items: page.items.map((capture) =>
        captureView(capture, job(capture.job_id)),
      ),
      next_cursor: page.next_cursor,
    };
  },

  async getCapture({ ctx, params }) {
    const capture = await loadCapture(ctx, params.p, params.b, params.c);
    return captureView(capture, await ctx.repos.jobs.findById(capture.job_id));
  },

  async getCaptureManifest({ ctx, params, reply }) {
    const capture = await loadCapture(ctx, params.p, params.b, params.c);
    if (capture.manifest_object_key === null)
      throw new ApiError("conflict", "The capture has no manifest yet", {
        reason: "manifest_not_ready",
      });
    return sendObject(ctx, reply, capture.manifest_object_key, {
      contentType: "application/json; charset=utf-8",
      sha256: capture.manifest_sha256,
    });
  },

  async getCaptureCoverage({ ctx, params }) {
    const capture = await loadCapture(ctx, params.p, params.b, params.c);
    // Reasons and remediation belong to the stored manifest; without it the
    // list of what is missing is unknown, not empty.
    if (capture.manifest_object_key === null)
      throw new ApiError("conflict", "The capture has no manifest yet", {
        reason: "manifest_not_ready",
      });
    const manifest = await readStoredManifest(ctx, capture.manifest_object_key);
    const components: Record<string, string> = {};
    for (const [id, status] of Object.entries(capture.component_statuses))
      components[id] = String(status);
    return {
      components,
      missing_or_blocked: manifest.missing_or_blocked,
      consistency: capture.consistency,
    };
  },

  async createVerification({ ctx, req, user, params, body }) {
    const build = await loadBuild(ctx, params.p, params.b);
    const capture = await loadCapture(ctx, params.p, params.b, params.c);
    await requireSucceededCapture(ctx, capture);
    const preferred =
      (await resolvePreferredRunner(ctx, params.p, body.runner_id)) ??
      build.preferred_runner_id;
    const verificationId = uuidv7();
    const jobId = uuidv7();
    const { verification, job } = await ctx.db.withTransaction(
      async (client) => {
        const created = await createJob(
          ctx,
          req,
          user,
          {
            id: jobId,
            project_id: params.p,
            kind: "recovery.verify",
            input: {
              build_id: build.id,
              capture_id: capture.id,
              verification_id: verificationId,
              scope: body.scope,
            },
            preferred_runner_id: preferred,
          },
          client,
        );
        const row = await ctx.repos.verifications.create(
          {
            id: verificationId,
            capture_id: capture.id,
            job_id: jobId,
            scope: { scopes: body.scope },
          },
          client,
        );
        return { verification: row, job: created };
      },
    );
    return verificationView(verification, job);
  },

  async listVerifications({ ctx, params, query }) {
    await loadBuild(ctx, params.p, params.b);
    const capture = await loadCapture(ctx, params.p, params.b, params.c);
    const page = await ctx.repos.verifications.listByCapture(capture.id, {
      cursor: query.cursor,
      limit: query.limit,
    });
    const job = await jobsOf(ctx, page.items);
    return {
      items: page.items.map((v) => verificationView(v, job(v.job_id))),
      next_cursor: page.next_cursor,
    };
  },

  async getVerification({ ctx, params }) {
    const capture = await loadCapture(ctx, params.p, params.b, params.c);
    const verification = await loadVerification(
      ctx,
      params.p,
      capture.id,
      params.v,
    );
    return verificationView(
      verification,
      await ctx.repos.jobs.findById(verification.job_id),
    );
  },

  async downloadVerificationReport({ ctx, params, reply }) {
    const capture = await loadCapture(ctx, params.p, params.b, params.c);
    const verification = await loadVerification(
      ctx,
      params.p,
      capture.id,
      params.v,
    );
    const status = runStatusFromJob(
      await ctx.repos.jobs.findById(verification.job_id),
    );
    if (status === "pending" || status === "running")
      throw new ApiError("conflict", "The verification has not finished", {
        reason: "report_not_ready",
        job_id: verification.job_id,
        status,
      });
    // The runner records where it uploaded the report on each result.
    const keys = new Set(
      verificationSchema.shape.results
        .parse(verification.results)
        .flatMap((result) =>
          result.evidence_object_key === null
            ? []
            : [result.evidence_object_key],
        ),
    );
    if (keys.size === 0)
      throw new ApiError("not_found", "The verification has no report", {
        reason: "report_not_found",
        status,
      });
    const prefix = `${verificationPrefix(params.p, params.b, capture.id, verification.id)}/`;
    const [key] = [...keys];
    const relative = key?.startsWith(prefix) ? key.slice(prefix.length) : null;
    if (
      keys.size !== 1 ||
      key === undefined ||
      relative === null ||
      !validateRelativePath(relative).ok
    )
      throw new ApiError("not_found", "The verification has no report", {
        reason: "report_not_found",
        status,
      });
    return sendObject(ctx, reply, key, {
      contentType: "application/json; charset=utf-8",
      filename: `restore-report-${verification.id}.json`,
    });
  },

  async createExport({ ctx, req, user, params, body }) {
    const build = await loadBuild(ctx, params.p, params.b);
    const capture = await loadCapture(ctx, params.p, params.b, params.c);
    await requireSucceededCapture(ctx, capture);
    const exportId = uuidv7();
    const jobId = uuidv7();
    const { record, job } = await ctx.db.withTransaction(async (client) => {
      const created = await createJob(
        ctx,
        req,
        user,
        {
          id: jobId,
          project_id: params.p,
          kind: "recovery.export",
          input: {
            build_id: build.id,
            capture_id: capture.id,
            export_id: exportId,
            sign_with_key_id: body.sign_with_key_id ?? null,
            encrypt_to_recipients: body.encrypt_to_recipients ?? [],
            include_secret_escrow: body.include_secret_escrow,
          },
          preferred_runner_id: build.preferred_runner_id,
        },
        client,
      );
      const row = await ctx.repos.exports.create(
        { id: exportId, capture_id: capture.id, job_id: jobId },
        client,
      );
      return { record: row, job: created };
    });
    return exportView(record, job);
  },

  async listExports({ ctx, params, query }) {
    await loadBuild(ctx, params.p, params.b);
    if (query.capture_id !== undefined)
      await loadCapture(ctx, params.p, params.b, query.capture_id);
    const page = await ctx.repos.exports.listByBuild(params.b, {
      cursor: query.cursor,
      limit: query.limit,
      capture_id: query.capture_id,
    });
    const job = await jobsOf(ctx, page.items);
    return {
      items: page.items.map((e) => exportView(e, job(e.job_id))),
      next_cursor: page.next_cursor,
    };
  },

  async getExport({ ctx, params }) {
    const record = await loadExport(ctx, params.p, params.b, params.e);
    return exportView(record, await ctx.repos.jobs.findById(record.job_id));
  },

  async downloadExportSignature({ ctx, params, reply }) {
    const record = await loadExport(ctx, params.p, params.b, params.e);
    const status = exportView(
      record,
      await ctx.repos.jobs.findById(record.job_id),
    ).status;
    if (status === "pending" || status === "running")
      throw new ApiError("conflict", "The export has not finished", {
        reason: "signature_not_ready",
        job_id: record.job_id,
        status,
      });
    const stored = exportSignatureSummarySchema
      .pick({ object_key: true, sha256: true, size: true })
      .safeParse(record.signature);
    // Only the object the API itself recorded beside this export's archive.
    const expected = `${exportArchiveKey(params.p, params.b, record.id)}.sig`;
    if (!stored.success || stored.data.object_key !== expected)
      throw new ApiError("not_found", "The export is not signed", {
        reason: "not_signed",
        status,
      });
    return sendObject(ctx, reply, expected, {
      contentType: "application/json; charset=utf-8",
      filename: `${record.id}.tar.sig.json`,
      sha256: stored.data.sha256,
      size: stored.data.size,
    });
  },

  async downloadExport({ ctx, params, reply }) {
    const record = await loadExport(ctx, params.p, params.b, params.e);
    if (record.object_key === null)
      throw new ApiError("conflict", "The export is not ready", {
        reason: "export_not_ready",
      });
    return sendObject(ctx, reply, record.object_key, {
      contentType: "application/x-tar",
      filename: `${record.id}.tar`,
      sha256: record.sha256,
      size: record.size,
    });
  },
});
