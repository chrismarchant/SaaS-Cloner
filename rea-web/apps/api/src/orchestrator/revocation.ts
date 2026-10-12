import { ApiError, type JobFailure } from "@rea-web/contracts";
import { leasedJobIds } from "../db/extra.js";
import type { AppContext } from "../context.js";

/**
 * Interrupts every job leased to a revoked runner and applies the same retry
 * rule as the reaper: requeue unless a non-repeatable effect is in flight or
 * attempts are exhausted. Returns the ids acted on.
 */
export const interruptRunnerLeases = async (
  ctx: Pick<AppContext, "repos" | "db">,
  runnerId: string,
): Promise<string[]> => {
  const handled: string[] = [];
  for (const jobId of await leasedJobIds(ctx.db, runnerId)) {
    try {
      const interrupted = await ctx.repos.jobs.transition({
        job_id: jobId,
        actor: "system",
        to: "interrupted",
        event_payload: { reason: "runner_revoked", runner_id: runnerId },
      });
      const ambiguous = await ctx.repos.effectLedger.hasStarted(jobId);
      if (!ambiguous && interrupted.attempt < interrupted.max_attempts) {
        const queued = await ctx.repos.jobs.transition({
          job_id: jobId,
          actor: "system",
          to: "queued",
          event_payload: { reason: "runner_revoked" },
        });
        if (queued.cancel_requested_at !== null)
          await ctx.repos.jobs.requestCancel(jobId);
      } else {
        const failure: JobFailure = {
          code: "interrupted",
          message: ambiguous
            ? "runner revoked while a non-repeatable effect was in flight"
            : "runner revoked and retries are exhausted",
          details: { reason: "runner_revoked" },
          retryable: false,
        };
        await ctx.repos.jobs.transition({
          job_id: jobId,
          actor: "system",
          to: "failed",
          failure,
          event_payload: { reason: "runner_revoked" },
        });
      }
      handled.push(jobId);
    } catch (error) {
      // The job left its active state between the lookup and the transition.
      if (!(error instanceof ApiError && error.code === "invalid_transition"))
        throw error;
    }
  }
  return handled;
};
