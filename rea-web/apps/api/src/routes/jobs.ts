import { ApiError, jobKindSchema, jobStateSchema } from "@rea-web/contracts";
import type { JobRecord } from "@rea-web/db";
import type { AppContext } from "../context.js";
import { approvalView, jobView } from "./mappers.js";
import {
  eventView,
  parseLastEventId,
  streamJobEvents,
  wantsEventStream,
} from "./sse.js";
import type { HandlersFor } from "./types.js";

export const loadProjectJob = async (
  ctx: AppContext,
  projectId: string,
  jobId: string,
): Promise<JobRecord> => {
  const job = await ctx.repos.jobs.findById(jobId);
  if (job === null || job.project_id !== projectId)
    throw new ApiError("not_found", "Job not found");
  return job;
};

const parseFilter = <T>(
  schema: {
    safeParse(v: unknown): { success: true; data: T } | { success: false };
  },
  value: string | undefined,
  name: string,
): T | undefined => {
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError("validation_failed", `Invalid ${name} filter`);
  return parsed.data;
};

export const jobHandlers = (): HandlersFor<
  | "listJobs"
  | "getJob"
  | "jobEvents"
  | "cancelJob"
  | "listApprovals"
  | "approveJob"
  | "rejectJob"
> => {
  const decide = async (
    ctx: AppContext,
    projectId: string,
    jobId: string,
    approvalId: string,
    decision: "approved" | "rejected",
    userId: string,
  ): Promise<JobRecord> => {
    const job = await loadProjectJob(ctx, projectId, jobId);
    const approval = await ctx.repos.approvals.find(approvalId);
    if (approval === null || approval.job_id !== job.id)
      throw new ApiError("not_found", "Approval not found");
    if (approval.decision !== null)
      throw new ApiError("conflict", "Approval was already decided", {
        decision: approval.decision,
      });
    if (job.state !== "awaiting_approval")
      throw new ApiError("conflict", "Job is not awaiting approval", {
        state: job.state,
      });
    const decided = await ctx.repos.approvals.decide(approvalId, {
      decision,
      decided_by: userId,
    });
    if (decided === null)
      throw new ApiError("conflict", "Approval was already decided");
    await ctx.repos.jobEvents.append(
      undefined,
      job.id,
      "job.approval_decided",
      {
        approval_id: approvalId,
        decision,
        decided_by: userId,
        tool: approval.tool,
      },
    );
    // Rejection cancels through the runner (its next heartbeat sees the flag);
    // approval needs no state change here: the runner resumes itself.
    if (decision === "rejected") return ctx.repos.jobs.requestCancel(job.id);
    return (await ctx.repos.jobs.findById(job.id)) ?? job;
  };

  return {
    async listJobs({ ctx, params, query }) {
      const page = await ctx.repos.jobs.list(params.p, {
        cursor: query.cursor,
        limit: query.limit,
        ...optional("state", parseFilter(jobStateSchema, query.state, "state")),
        ...optional("kind", parseFilter(jobKindSchema, query.kind, "kind")),
      });
      return { items: page.items.map(jobView), next_cursor: page.next_cursor };
    },

    async getJob({ ctx, params }) {
      return jobView(await loadProjectJob(ctx, params.p, params.j));
    },

    async jobEvents({ ctx, req, reply, params, query }) {
      const job = await loadProjectJob(ctx, params.p, params.j);
      const header = parseLastEventId(req.headers["last-event-id"]);
      if (wantsEventStream(req.headers.accept, query.after)) {
        return streamJobEvents(
          ctx,
          req,
          reply,
          job,
          header ?? query.after ?? 0,
        );
      }
      const events = await ctx.repos.jobEvents.listAfter(
        job.id,
        query.after ?? header ?? 0,
        query.limit ?? 200,
      );
      return { items: events.map(eventView) };
    },

    async cancelJob({ ctx, params }) {
      await loadProjectJob(ctx, params.p, params.j);
      return jobView(await ctx.repos.jobs.requestCancel(params.j));
    },

    async listApprovals({ ctx, params }) {
      const job = await loadProjectJob(ctx, params.p, params.j);
      const pending = await ctx.repos.approvals.pendingForJob(job.id);
      return { items: pending.map(approvalView) };
    },

    async approveJob({ ctx, params, body, user }) {
      return jobView(
        await decide(
          ctx,
          params.p,
          params.j,
          body.approval_id,
          "approved",
          user.user.id,
        ),
      );
    },

    async rejectJob({ ctx, params, body, user }) {
      return jobView(
        await decide(
          ctx,
          params.p,
          params.j,
          body.approval_id,
          "rejected",
          user.user.id,
        ),
      );
    },
  };
};

const optional = <K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]?: V } =>
  value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
