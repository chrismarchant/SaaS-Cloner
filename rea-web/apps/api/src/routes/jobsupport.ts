import type { FastifyRequest } from "fastify";
import {
  ApiError,
  DEFAULT_JOB_BUDGET,
  type JobBudget,
  type JobKind,
  type JobRequirements,
} from "@rea-web/contracts";
import type { JobRecord } from "@rea-web/db";
import type { AppContext } from "../context.js";
import type { TxClient } from "../db/extra.js";
import type { UserPrincipal } from "../auth/principal.js";

export const ACTIVE_STATES = new Set([
  "preparing",
  "running",
  "awaiting_approval",
]);

export const EMPTY_REQUIREMENTS: JobRequirements = {
  tools: [],
  providers: [],
  os: [],
  labels: [],
  effects: [],
};

export const mergeBudget = (
  overrides: { [K in keyof JobBudget]?: JobBudget[K] | undefined } | undefined,
): JobBudget => {
  const merged: JobBudget = { ...DEFAULT_JOB_BUDGET };
  for (const [name, value] of Object.entries(overrides ?? {}))
    if (value !== undefined)
      (merged as unknown as Record<string, number>)[name] = value;
  return merged;
};

export const idempotencyKeyOf = (req: FastifyRequest): string | null => {
  const header = req.headers["idempotency-key"];
  return typeof header === "string" ? header : null;
};

export interface NewJob {
  readonly project_id: string;
  readonly kind: JobKind;
  readonly id?: string;
  readonly requirements?: Partial<JobRequirements>;
  readonly budget?: JobBudget;
  readonly input: Record<string, unknown>;
  readonly preferred_runner_id?: string | null;
}

export const createJob = (
  ctx: AppContext,
  req: FastifyRequest,
  user: UserPrincipal,
  job: NewJob,
  client?: TxClient,
): Promise<JobRecord> =>
  ctx.repos.jobs.create(
    {
      ...(job.id === undefined ? {} : { id: job.id }),
      project_id: job.project_id,
      kind: job.kind,
      requirements: job.requirements ?? EMPTY_REQUIREMENTS,
      budget: job.budget ?? DEFAULT_JOB_BUDGET,
      input: job.input,
      preferred_runner_id: job.preferred_runner_id ?? null,
      idempotency_key: idempotencyKeyOf(req),
      created_by: user.user.id,
    },
    client,
  );

/** Resolves an optional caller-selected runner to a live runner of the project. */
export const resolvePreferredRunner = async (
  ctx: AppContext,
  projectId: string,
  runnerId: string | undefined,
): Promise<string | null> => {
  if (runnerId === undefined) return null;
  const runner = await ctx.repos.runners.findById(projectId, runnerId);
  if (runner === null || runner.revoked_at !== null)
    throw new ApiError("not_found", "Runner not found");
  return runner.id;
};
