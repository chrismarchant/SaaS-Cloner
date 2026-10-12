import { z } from "zod";
import {
  captureSchema,
  componentStatusSchema,
  preservationPlanSchema,
  verificationSchema,
} from "@rea-web/contracts";
import type { JobRecord, JsonObject } from "@rea-web/db";
import type { AppContext } from "../context.js";

const planResult = preservationPlanSchema.pick({
  components: true,
  consistency_strategy: true,
  known_omissions: true,
});
const captureResult = z.object({
  consistency: captureSchema.shape.consistency.optional(),
  component_statuses: z.record(z.string(), componentStatusSchema).optional(),
});
const verificationResult = z.object({
  results: verificationSchema.shape.results.optional(),
  network_required: verificationSchema.shape.network_required.optional(),
  overall: verificationSchema.shape.overall.optional(),
});
const exportResult = z.object({
  signature: z.record(z.string(), z.unknown()).nullable().optional(),
  encryption: z.record(z.string(), z.unknown()).nullable().optional(),
});

const section = <S extends z.ZodType>(
  result: JsonObject | null,
  field: string,
  schema: S,
): z.output<S> | null => {
  const raw = result?.[field];
  if (raw === undefined || raw === null) return null;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

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
      const plan = succeeded ? section(job.result, "plan", planResult) : null;
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
      const parsed = succeeded
        ? section(job.result, "capture", captureResult)
        : null;
      await ctx.repos.captures.update(row.id, {
        status: terminalStatus(job),
        finished_at: ctx.now(),
        ...(parsed?.consistency === undefined
          ? {}
          : { consistency: parsed.consistency }),
        ...(parsed?.component_statuses === undefined
          ? {}
          : { component_statuses: parsed.component_statuses }),
      });
      return;
    }
    case "recovery.verify": {
      const row = await ctx.repos.verifications.findByJobId(job.id);
      const parsed = succeeded
        ? section(job.result, "verification", verificationResult)
        : null;
      if (row !== null && parsed !== null)
        await ctx.repos.verifications.update(row.id, {
          ...(parsed.results === undefined ? {} : { results: parsed.results }),
          ...(parsed.network_required === undefined
            ? {}
            : { network_required: parsed.network_required }),
          ...(parsed.overall === undefined ? {} : { overall: parsed.overall }),
        });
      return;
    }
    case "recovery.export": {
      const row = await ctx.repos.exports.findByJobId(job.id);
      if (row === null) return;
      const parsed = succeeded
        ? section(job.result, "export", exportResult)
        : null;
      await ctx.repos.exports.update(row.id, {
        status: terminalStatus(job) === "completed" ? "completed" : "failed",
        ...(parsed?.signature === undefined
          ? {}
          : { signature: parsed.signature }),
        ...(parsed?.encryption === undefined
          ? {}
          : { encryption: parsed.encryption }),
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
