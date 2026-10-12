import { ApiError, uuidv7 } from "@rea-web/contracts";
import type { BuildRecord, CaptureRecord, PlanRecord } from "@rea-web/db";
import type { AppContext } from "../context.js";
import {
  buildView,
  captureView,
  exportView,
  jobSummaryView,
  planView,
  verificationView,
} from "./mappers.js";
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

/** Accepts the plan id or the id of the job that produces it (what createPlan returns). */
const loadPlan = async (
  ctx: AppContext,
  projectId: string,
  buildId: string,
  idOrJobId: string,
): Promise<PlanRecord> => {
  let plan = await ctx.repos.plans.findById(projectId, idOrJobId);
  if (plan === null) {
    const byJob = await ctx.repos.plans.findByJobId(idOrJobId);
    if (
      byJob !== null &&
      (await ctx.repos.builds.findById(projectId, byJob.build_id)) !== null
    )
      plan = byJob;
  }
  if (plan === null || plan.build_id !== buildId)
    throw new ApiError("not_found", "Plan not found");
  return plan;
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
  | "getPlan"
  | "createCapture"
  | "getCapture"
  | "getCaptureManifest"
  | "getCaptureCoverage"
  | "createVerification"
  | "getVerification"
  | "createExport"
  | "getExport"
  | "downloadExport"
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
    return { ...jobSummaryView(job), plan_id: planId };
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
    return planView(plan);
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
    const components: Record<string, string> = {};
    const missing: Array<Record<string, unknown>> = [];
    for (const [id, status] of Object.entries(capture.component_statuses)) {
      const value = String(status);
      components[id] = value;
      if (value !== "captured")
        missing.push({ component_id: id, status: value });
    }
    return {
      components,
      missing_or_blocked: missing,
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
    const verification = await ctx.db.withTransaction(async (client) => {
      await createJob(
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
      return ctx.repos.verifications.create(
        {
          id: verificationId,
          capture_id: capture.id,
          job_id: jobId,
          scope: { scopes: body.scope },
        },
        client,
      );
    });
    return verificationView(verification);
  },

  async getVerification({ ctx, params }) {
    const capture = await loadCapture(ctx, params.p, params.b, params.c);
    const verification = await ctx.repos.verifications.findById(
      params.p,
      params.v,
    );
    if (verification === null || verification.capture_id !== capture.id)
      throw new ApiError("not_found", "Verification not found");
    return verificationView(verification);
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

  async getExport({ ctx, params }) {
    await loadBuild(ctx, params.p, params.b);
    const record = await ctx.repos.exports.findById(params.p, params.e);
    if (record === null) throw new ApiError("not_found", "Export not found");
    await loadCapture(ctx, params.p, params.b, record.capture_id);
    return exportView(record, await ctx.repos.jobs.findById(record.job_id));
  },

  async downloadExport({ ctx, params, reply }) {
    await loadBuild(ctx, params.p, params.b);
    const record = await ctx.repos.exports.findById(params.p, params.e);
    if (record === null) throw new ApiError("not_found", "Export not found");
    await loadCapture(ctx, params.p, params.b, record.capture_id);
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
