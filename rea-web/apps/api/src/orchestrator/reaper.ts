import type { Repositories, ReapOutcome } from "@rea-web/db";

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface LoopHandle {
  /** Runs one iteration now (also used by tests); resolves with its result. */
  runOnce(): Promise<unknown>;
  stop(): Promise<void>;
}

const startLoop = (
  name: string,
  intervalMs: number,
  logger: Logger | undefined,
  tick: () => Promise<unknown>,
): LoopHandle => {
  let stopped = false;
  let running: Promise<unknown> | null = null;
  const run = async (): Promise<unknown> => {
    if (running !== null) return running;
    running = tick()
      .catch((error: unknown) => {
        logger?.error({ err: error, loop: name }, "maintenance loop failed");
        return undefined;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  const timer = setInterval(() => {
    if (!stopped) void run();
  }, intervalMs);
  timer.unref();
  return {
    runOnce: run,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
};

export interface ReaperOptions {
  /** Runners unseen for this long are marked `stale`. */
  readonly staleRunnerMs: number;
  readonly logger?: Logger;
}

/**
 * Expired leases become `interrupted` and are requeued (or failed) by the
 * repository. A requeued job whose cancellation had already been requested is
 * cancelled here rather than run again. Also marks silent runners stale and
 * drops expired sessions.
 */
export const reapOnce = async (
  repos: Repositories,
  options: ReaperOptions,
): Promise<ReapOutcome[]> => {
  const outcomes = await repos.jobs.reapExpiredLeases();
  for (const outcome of outcomes) {
    options.logger?.warn(
      {
        job_id: outcome.job_id,
        outcome: outcome.outcome,
        reason: outcome.reason,
      },
      "lease expired",
    );
    if (outcome.outcome !== "requeued") continue;
    const job = await repos.jobs.findById(outcome.job_id);
    if (job?.cancel_requested_at != null)
      await repos.jobs.requestCancel(job.id);
  }
  const stale = await repos.runners.markStale(options.staleRunnerMs);
  if (stale.length > 0)
    options.logger?.info({ runner_ids: stale }, "runners marked stale");
  await repos.sessions.deleteExpired();
  return outcomes;
};

export const startReaper = (
  repos: Repositories,
  intervalMs: number,
  options: ReaperOptions,
): LoopHandle =>
  startLoop("reaper", intervalMs, options.logger, () =>
    reapOnce(repos, options),
  );

export const startIdempotencyPurge = (
  repos: Repositories,
  ttlMs: number,
  intervalMs: number,
  logger?: Logger,
): LoopHandle =>
  startLoop("idempotency-purge", intervalMs, logger, () =>
    repos.idempotency.purgeOlderThan(ttlMs),
  );
