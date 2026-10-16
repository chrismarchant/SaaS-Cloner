import {
  ApiError,
  compareJobInputSchema,
  investigationJobInputSchema,
  type JobState,
  routeFor,
  unmetRequirements,
  uuidv7,
  validateTargetUrl,
} from "@rea-web/contracts";
import {
  decodeCursor,
  encodeCursor,
  type InvestigationRecord,
} from "@rea-web/db";
import type { AppContext } from "../context.js";
import { evidenceArtifactOwner, investigationCounts } from "../db/extra.js";
import {
  evidenceView,
  findingView,
  investigationView,
  jobSummaryView,
  runnerFacts,
  toolCallView,
} from "./mappers.js";
import { computeRouting, targetClassOf } from "./routing.js";
import { sendObject } from "./streaming.js";
import type { HandlersFor } from "./types.js";
import {
  ACTIVE_STATES,
  createJob,
  mergeBudget,
  resolvePreferredRunner,
} from "./jobsupport.js";
import { executionPolicySchema } from "@rea-web/contracts";

const loadInvestigation = async (
  ctx: AppContext,
  projectId: string,
  id: string,
): Promise<InvestigationRecord> => {
  const record = await ctx.repos.investigations.findById(projectId, id);
  if (record === null)
    throw new ApiError("not_found", "Investigation not found");
  return record;
};

export const viewsFor = async (
  ctx: AppContext,
  records: readonly InvestigationRecord[],
) => {
  const counts = await investigationCounts(
    ctx.db,
    records.map((r) => r.id),
  );
  const views = [];
  for (const record of records) {
    const job =
      record.job_id === null
        ? null
        : await ctx.repos.jobs.findById(record.job_id);
    views.push(
      investigationView(record, job, {
        toolCalls: counts.toolCalls.get(record.id) ?? 0,
        findings: counts.findings.get(record.id) ?? {},
      }),
    );
  }
  return views;
};

/** Run-job states in which the executing runner may still hold the session. */
const SESSION_HOLDING_STATES: ReadonlySet<JobState> = new Set([
  "running",
  "awaiting_approval",
  "succeeded",
]);
const NOT_STARTED_STATES: ReadonlySet<JobState> = new Set([
  "queued",
  "preparing",
  "interrupted",
]);

export const investigationHandlers = (): HandlersFor<
  | "createInvestigation"
  | "listInvestigations"
  | "getInvestigation"
  | "listToolCalls"
  | "getToolCallRaw"
  | "listFindings"
  | "listEvidence"
  | "getEvidence"
  | "createFollowUp"
  | "createInvestigationExport"
  | "createComparison"
> => ({
  async createInvestigation({ ctx, req, user, params, body }) {
    const target = await ctx.repos.targets.findById(params.p, body.target_id);
    if (target === null) throw new ApiError("not_found", "Target not found");
    if (target.kind === "url") {
      const checked = validateTargetUrl(target.url ?? "");
      if (!checked.ok)
        throw new ApiError("unsafe_url", "URL target rejected", {
          rejection: checked.rejection,
        });
    }
    let preferred = await resolvePreferredRunner(ctx, params.p, body.runner_id);
    if (target.runner_id !== null) {
      // A runner-local target exists only on the runner that registered it.
      if (preferred !== null && preferred !== target.runner_id)
        throw new ApiError(
          "validation_failed",
          "runner_id conflicts with the runner-local target's runner",
        );
      preferred = target.runner_id;
    }
    const klass = targetClassOf(target);
    const route = routeFor(klass);
    const routing = await computeRouting(ctx, params.p, target);
    const policy = executionPolicySchema.parse(body.policy);
    const investigationId = uuidv7();
    const jobId = uuidv7();
    await ctx.db.withTransaction(async (client) => {
      await ctx.repos.investigations.create(
        {
          id: investigationId,
          project_id: params.p,
          target_id: target.id,
          question: body.question,
          policy,
          created_by: user.user.id,
        },
        client,
      );
      await createJob(
        ctx,
        req,
        user,
        {
          id: jobId,
          project_id: params.p,
          kind: "investigation.run",
          requirements: {
            tools: [...route.required_tools],
            providers: [],
            os: [...route.required_os],
            labels: [],
            effects: [],
          },
          budget: mergeBudget(policy.budget),
          input: investigationJobInputSchema.parse({
            investigation_id: investigationId,
            target_id: target.id,
            target: {
              kind: target.kind,
              class: klass,
              name: target.name,
              sha256: target.sha256,
              size: target.size,
              url: target.url,
              // Runner-local targets are resolved by the runner itself.
              path_hash:
                target.kind === "runner_local" ? target.runner_path_hash : null,
            },
            question: body.question,
            policy,
            route,
          }),
          preferred_runner_id: preferred,
        },
        client,
      );
      await ctx.repos.investigations.setJob(investigationId, jobId, client);
    });
    await ctx.repos.investigations.setRouting(investigationId, routing);
    const record = await loadInvestigation(ctx, params.p, investigationId);
    const [view] = await viewsFor(ctx, [record]);
    return view as NonNullable<typeof view>;
  },

  async listInvestigations({ ctx, params, query }) {
    const page = await ctx.repos.investigations.list(params.p, {
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: await viewsFor(ctx, page.items),
      next_cursor: page.next_cursor,
    };
  },

  async getInvestigation({ ctx, params }) {
    const record = await loadInvestigation(ctx, params.p, params.i);
    const [view] = await viewsFor(ctx, [record]);
    return view as NonNullable<typeof view>;
  },

  async listToolCalls({ ctx, params, query }) {
    await loadInvestigation(ctx, params.p, params.i);
    let afterSeq = 0;
    if (query.cursor !== undefined) {
      const [seq] = decodeCursor(query.cursor, 1);
      afterSeq = Number(seq);
      if (!Number.isInteger(afterSeq) || afterSeq < 0)
        throw new ApiError("validation_failed", "invalid cursor");
    }
    const rows = await ctx.repos.toolCalls.listByInvestigation(params.i, {
      afterSeq,
      limit: query.limit + 1,
    });
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items: items.map(toolCallView),
      next_cursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor([last.seq])
          : null,
    };
  },

  async getToolCallRaw({ ctx, params, reply }) {
    await loadInvestigation(ctx, params.p, params.i);
    const call = await ctx.repos.toolCalls.findById(params.c);
    if (call === null || call.investigation_id !== params.i)
      throw new ApiError("not_found", "Tool call not found");
    return sendObject(ctx, reply, call.raw_result_object_key, {
      contentType: "application/json; charset=utf-8",
      sha256: call.raw_result_sha256,
      size: call.raw_result_bytes,
    });
  },

  async listFindings({ ctx, params }) {
    await loadInvestigation(ctx, params.p, params.i);
    const findings = await ctx.repos.findings.listByInvestigation(params.i);
    return { items: findings.map(findingView) };
  },

  async listEvidence({ ctx, params }) {
    await loadInvestigation(ctx, params.p, params.i);
    const artifacts = await ctx.repos.evidenceArtifacts.listByInvestigation(
      params.i,
    );
    return { items: artifacts.map(evidenceView) };
  },

  async getEvidence({ ctx, params, reply }) {
    await loadInvestigation(ctx, params.p, params.i);
    const artifact = await ctx.repos.evidenceArtifacts.findById(
      params.i,
      params.a,
    );
    if (artifact === null)
      throw new ApiError("not_found", "Artifact not found");
    return sendObject(ctx, reply, artifact.object_key, {
      contentType: "application/octet-stream",
      filename: artifact.name,
      sha256: artifact.sha256,
      size: artifact.size,
    });
  },

  async createFollowUp({ ctx, req, user, params, body }) {
    const investigation = await loadInvestigation(ctx, params.p, params.i);
    const runJob =
      investigation.job_id === null
        ? null
        : await ctx.repos.jobs.findById(investigation.job_id);
    // The runner that executed the run job holds the REA session and keeps it
    // after the job succeeds (until its idle timeout); it alone knows whether
    // the session is still live and fails the follow-up with session_closed
    // if not. A run that failed or was cancelled had its session closed; one
    // that has not been executed yet has no session.
    const ownerId =
      runJob === null
        ? null
        : (runJob.lease?.runner_id ?? runJob.last_runner_id);
    if (
      runJob === null ||
      ownerId === null ||
      !SESSION_HOLDING_STATES.has(runJob.state)
    )
      throw new ApiError(
        "capability_unavailable",
        "The investigation has no live upstream session",
        {
          reason:
            runJob !== null && NOT_STARTED_STATES.has(runJob.state)
              ? "session_not_started"
              : "session_closed",
          job_state: runJob?.state ?? null,
          hint: "Re-run the investigation to continue from a fresh session.",
        },
      );
    const owner = await ctx.repos.runners.findById(params.p, ownerId);
    const { report, digest } =
      owner === null ? { report: null, digest: null } : runnerFacts(owner);
    if (owner === null || report === null || digest === null)
      throw new ApiError(
        "capability_unavailable",
        "The owning runner has no capability report",
        { reason: "runner_unavailable", runner_id: ownerId },
      );
    if (!report.tools_list.some((tool) => tool.name === body.tool))
      throw new ApiError(
        "capability_unavailable",
        `The owning runner does not advertise ${body.tool}`,
        { reason: "tool_not_advertised", tool: body.tool, runner_id: owner.id },
      );
    const unmet = unmetRequirements(digest, {
      tools: [body.tool],
      providers: [],
      os: [],
      labels: [],
    });
    if (unmet.length > 0)
      throw new ApiError(
        "capability_unavailable",
        `${body.tool} is not available on the owning runner`,
        {
          reason: "tool_unavailable",
          tool: body.tool,
          runner_id: owner.id,
          unmet,
        },
      );
    const policy = executionPolicySchema.parse(investigation.policy);
    const job = await createJob(ctx, req, user, {
      project_id: params.p,
      kind: "investigation.follow_up",
      requirements: {
        tools: [body.tool],
        providers: [],
        os: [],
        labels: [],
        effects: [],
      },
      budget: mergeBudget(policy.budget),
      input: {
        investigation_id: investigation.id,
        run_job_id: runJob.id,
        tool: body.tool,
        arguments: body.arguments,
      },
      preferred_runner_id: owner.id,
    });
    return { ...jobSummaryView(job), investigation_id: investigation.id };
  },

  async createInvestigationExport({ ctx, req, user, params }) {
    const investigation = await loadInvestigation(ctx, params.p, params.i);
    const job = await createJob(ctx, req, user, {
      project_id: params.p,
      kind: "investigation.export",
      input: { investigation_id: investigation.id },
    });
    return { ...jobSummaryView(job), investigation_id: investigation.id };
  },

  async createComparison({ ctx, req, user, params, body }) {
    // Each side resolves to the investigation that owns it; the left one is the
    // anchor the runner's tool calls and findings are recorded against.
    const owners: string[] = [];
    for (const side of [body.left, body.right]) {
      if (side.kind === "retained-evidence") {
        owners.push(
          (await loadInvestigation(ctx, params.p, side.investigation_id)).id,
        );
      } else {
        const owner = await evidenceArtifactOwner(ctx.db, side.artifact_id);
        if (owner === null || owner.project_id !== params.p)
          throw new ApiError("not_found", "Artifact not found");
        owners.push(owner.investigation_id);
      }
    }
    const [leftInvestigation, rightInvestigation] = owners as [string, string];
    const preferred = await resolvePreferredRunner(
      ctx,
      params.p,
      body.runner_id,
    );
    const job = await createJob(ctx, req, user, {
      project_id: params.p,
      kind: "investigation.compare",
      requirements: {
        tools: [body.tool],
        providers: [],
        os: [],
        labels: [],
        effects: [],
      },
      input: compareJobInputSchema.parse({
        investigation_id: leftInvestigation,
        left_investigation_id: leftInvestigation,
        right_investigation_id: rightInvestigation,
        tool: body.tool,
        left: body.left,
        right: body.right,
      }),
      preferred_runner_id: preferred,
    });
    return jobSummaryView(job);
  },
});
