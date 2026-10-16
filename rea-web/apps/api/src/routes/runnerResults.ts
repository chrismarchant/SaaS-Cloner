import {
  ApiError,
  hasJobResultSchema,
  jobResultSchemas,
  type JobKind,
  type JobResult,
  type JobResultKind,
} from "@rea-web/contracts";
import type { JobRecord, JsonObject } from "@rea-web/db";
import type { AppContext } from "../context.js";

/**
 * Validate a successful completion's result against its job kind's contract
 * before the job is completed. A mismatch is the runner's bug and must not be
 * silently dropped, so the completion is refused with the schema issues.
 */
export const assertJobResult = (
  kind: JobKind,
  outcome: string,
  result: unknown,
): void => {
  if (outcome !== "succeeded" || !hasJobResultSchema(kind)) return;
  const parsed = jobResultSchemas[kind].safeParse(result);
  if (!parsed.success)
    throw new ApiError(
      "validation_failed",
      `Result does not match the ${kind} result contract`,
      {
        issues: parsed.error.issues.slice(0, 20).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    );
};

/** Results were validated by `assertJobResult` when the job completed. */
const parsedResult = <K extends JobResultKind>(
  kind: K,
  job: JobRecord,
): JobResult<K> | null =>
  job.state === "succeeded"
    ? (jobResultSchemas[kind].parse(job.result) as JobResult<K>)
    : null;

const terminalStatus = (
  job: JobRecord,
): "completed" | "failed" | "cancelled" =>
  job.state === "succeeded"
    ? "completed"
    : job.state === "cancelled"
      ? "cancelled"
      : "failed";

/**
 * Copies the structured part of a finished job's result into the resource row
 * the API serves. Storage keys and digests are never taken from the result:
 * they come from the artifact upload endpoint, which derives keys server-side.
 *
 * Result contract (runner side):
 *  - preservation.plan:    `result.plan { components, consistency_strategy, known_omissions }`
 *  - preservation.capture: `result.capture { consistency?, component_statuses? }`
 *  - recovery.verify:      `result.verification { results?, network_required?, overall? }`
 *  - recovery.export:      `result.export { signature?, encryption? }`
 *  - investigation.run:    `result.upstream_identity { ... }`
 */
export const applyJobResult = async (
  ctx: AppContext,
  job: JobRecord,
  runnerId: string,
): Promise<void> => {
  const succeeded = job.state === "succeeded";
  switch (job.kind) {
    case "preservation.plan": {
      const plan = parsedResult("preservation.plan", job)?.plan ?? null;
      const row = await ctx.repos.plans.findByJobId(job.id);
      if (row !== null && plan !== null)
        await ctx.repos.plans.setPlan(row.id, {
          plan: plan as unknown as JsonObject,
          runner_id: runnerId,
        });
      return;
    }
    case "preservation.capture": {
      const row = await ctx.repos.captures.findByJobId(job.id);
      if (row === null) return;
      const parsed = parsedResult("preservation.capture", job)?.capture;
      await ctx.repos.captures.update(row.id, {
        status: terminalStatus(job),
        finished_at: ctx.now(),
        ...(parsed === undefined
          ? {}
          : {
              consistency: parsed.consistency,
              component_statuses: parsed.component_statuses,
            }),
      });
      return;
    }
    case "recovery.verify": {
      const row = await ctx.repos.verifications.findByJobId(job.id);
      const parsed = parsedResult("recovery.verify", job)?.verification;
      if (row !== null && parsed !== undefined)
        await ctx.repos.verifications.update(row.id, {
          results: parsed.results,
          network_required: parsed.network_required,
          overall: parsed.overall,
        });
      return;
    }
    case "recovery.export": {
      const row = await ctx.repos.exports.findByJobId(job.id);
      if (row === null) return;
      const parsed = parsedResult("recovery.export", job)?.export;
      await ctx.repos.exports.update(row.id, {
        status: terminalStatus(job) === "completed" ? "completed" : "failed",
        ...(parsed === undefined
          ? {}
          : { signature: parsed.signature, encryption: parsed.encryption }),
      });
      return;
    }
    case "investigation.run": {
      const identity = job.result?.["upstream_identity"];
      const investigationId = job.input["investigation_id"];
      if (
        succeeded &&
        typeof investigationId === "string" &&
        identity !== null &&
        typeof identity === "object" &&
        !Array.isArray(identity)
      )
        await ctx.repos.investigations.setUpstreamIdentity(
          investigationId,
          identity as JsonObject,
        );
      return;
    }
    default:
      return;
  }
};
