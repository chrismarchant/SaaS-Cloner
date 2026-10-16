import {
  ApiError,
  type JobBudget,
  type JobBudgetUsage,
  type JobFailure,
  type JobKind,
  type JobRequirements,
  type JobState,
  TERMINAL_JOB_STATES,
  type TransitionActor,
  ZERO_USAGE,
  canTransition,
  jobBudgetSchema,
  jobRequirementsSchema,
  uuidv7,
} from "@rea-web/contracts";
import type pg from "pg";
import type { Database, Queryable } from "../database.js";
import {
  type Page,
  type PageOptions,
  firstRow,
  json,
  keysetPage,
} from "../support.js";
import type { JobRecord, JsonObject } from "../types.js";
import { appendJobEvent } from "./jobEvents.js";

export type JobTerminalOutcome = "succeeded" | "failed" | "cancelled";
export type HeartbeatRejection = "stale_lease" | "lease_expired" | "not_leased";

export interface CreateJobInput {
  id?: string;
  project_id: string;
  kind: JobKind;
  requirements?: Partial<JobRequirements>;
  budget: JobBudget;
  input?: JsonObject;
  preferred_runner_id?: string | null;
  idempotency_key?: string | null;
  created_by?: string | null;
  max_attempts?: number;
}

export interface ClaimInput {
  runner_id: string;
  lease_ttl_ms: number;
  /** Decides whether the claiming runner can satisfy a job's requirements. */
  matches: (requirements: JobRequirements) => boolean;
  /** Queued jobs examined per claim (default 50). */
  candidate_limit?: number;
}

export interface ClaimResult {
  job: JobRecord;
  fencing_token: number;
  lease_expires_at: string;
}

export interface HeartbeatInput {
  job_id: string;
  runner_id: string;
  fencing_token: number;
  lease_ttl_ms: number;
  usage?: Partial<JobBudgetUsage>;
}

export interface HeartbeatResult {
  accepted: boolean;
  reason?: HeartbeatRejection;
  cancel_requested: boolean;
  lease_expires_at?: string;
}

export interface TransitionInput {
  job_id: string;
  /** Required when `actor` is `runner`. */
  fencing_token?: number | undefined;
  to: JobState;
  actor: TransitionActor;
  event_payload?: JsonObject;
  /** Stored when `to` is `failed`. */
  failure?: JobFailure | null;
}

export interface CompleteInput {
  job_id: string;
  runner_id: string;
  fencing_token: number;
  outcome: JobTerminalOutcome;
  result?: JsonObject | null;
  failure?: JobFailure | null;
  usage?: Partial<JobBudgetUsage>;
}

export interface ReapOutcome {
  job_id: string;
  outcome: "requeued" | "failed";
  /** Attempt number the job holds after reaping. */
  attempt: number;
  reason:
    | "lease_expired"
    | "retries_exhausted"
    | "non_repeatable_effect_ambiguous";
}

export interface JobsRepository {
  /** Inserts the job (`queued`), its fencing row and event seq 1 `job.created`. */
  create(input: CreateJobInput, client?: pg.PoolClient): Promise<JobRecord>;
  findById(id: string): Promise<JobRecord | null>;
  /** The jobs that exist among `ids`, in no particular order. */
  listByIds(ids: readonly string[]): Promise<JobRecord[]>;
  list(
    project_id: string,
    options?: PageOptions & { state?: JobState; kind?: JobKind },
  ): Promise<Page<JobRecord>>;
  claim(input: ClaimInput): Promise<ClaimResult | null>;
  heartbeat(input: HeartbeatInput): Promise<HeartbeatResult>;
  transition(input: TransitionInput): Promise<JobRecord>;
  complete(input: CompleteInput): Promise<JobRecord>;
  /**
   * Records a cancel request. A `queued` job has no runner to notify and is
   * cancelled immediately; an active job keeps running until its runner sees
   * `cancel_requested` in a heartbeat. Terminal jobs are returned unchanged.
   */
  requestCancel(job_id: string): Promise<JobRecord>;
  reapExpiredLeases(now?: Date): Promise<ReapOutcome[]>;
}

interface JobRow {
  id: string;
  project_id: string;
  kind: JobKind;
  state: JobState;
  attempt: number;
  max_attempts: number;
  requirements: unknown;
  budget: JobBudget;
  usage: Partial<JobBudgetUsage>;
  input: JsonObject;
  result: JsonObject | null;
  failure: JobFailure | null;
  preferred_runner_id: string | null;
  last_runner_id: string | null;
  idempotency_key: string | null;
  cancel_requested_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  lease_runner_id: string | null;
  lease_fencing_token: number | null;
  lease_expires_at: string | null;
}

const JOB_COLUMNS = `t.id, t.project_id, t.kind, t.state, t.attempt, t.max_attempts,
  t.requirements, t.budget, t.usage, t.input, t.result, t.failure,
  t.preferred_runner_id, t.last_runner_id, t.idempotency_key,
  t.cancel_requested_at, t.created_by, t.created_at, t.updated_at,
  l.runner_id AS lease_runner_id, l.fencing_token AS lease_fencing_token,
  l.expires_at AS lease_expires_at`;
const JOB_FROM = "jobs t LEFT JOIN job_leases l ON l.job_id = t.id";

function toJob(row: JobRow): JobRecord {
  const lease =
    row.lease_runner_id !== null &&
    row.lease_fencing_token !== null &&
    row.lease_expires_at !== null
      ? {
          runner_id: row.lease_runner_id,
          fencing_token: row.lease_fencing_token,
          expires_at: row.lease_expires_at,
        }
      : null;
  return {
    id: row.id,
    project_id: row.project_id,
    kind: row.kind,
    state: row.state,
    attempt: row.attempt,
    max_attempts: row.max_attempts,
    requirements: jobRequirementsSchema.parse(row.requirements),
    budget: row.budget,
    usage: { ...ZERO_USAGE, ...row.usage },
    input: row.input,
    result: row.result,
    failure: row.failure,
    preferred_runner_id: row.preferred_runner_id,
    last_runner_id: row.last_runner_id,
    idempotency_key: row.idempotency_key,
    cancel_requested_at: row.cancel_requested_at,
    created_by: row.created_by,
    lease,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function loadJob(run: Queryable, id: string): Promise<JobRecord | null> {
  const result = await run.query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM ${JOB_FROM} WHERE t.id = $1`,
    [id],
  );
  const row = firstRow(result.rows);
  return row === null ? null : toJob(row);
}

async function requireJob(run: Queryable, id: string): Promise<JobRecord> {
  const job = await loadJob(run, id);
  if (job === null) throw new ApiError("not_found", "job not found");
  return job;
}

interface LockedJob {
  state: JobState;
  attempt: number;
  max_attempts: number;
  cancel_requested_at: string | null;
}

/** Takes the job row lock; every mutation locks the job before anything else. */
async function lockJobOrNull(
  client: pg.PoolClient,
  id: string,
): Promise<LockedJob | null> {
  const result = await client.query<LockedJob>(
    `SELECT state, attempt, max_attempts, cancel_requested_at
     FROM jobs WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return firstRow(result.rows);
}

async function lockJob(client: pg.PoolClient, id: string): Promise<LockedJob> {
  const job = await lockJobOrNull(client, id);
  if (job === null) throw new ApiError("not_found", "job not found");
  return job;
}

interface LeaseRow {
  runner_id: string;
  fencing_token: number;
  expires_at: string;
  expired: boolean;
}

async function readLease(
  client: pg.PoolClient,
  job_id: string,
): Promise<LeaseRow | null> {
  const result = await client.query<LeaseRow>(
    `SELECT runner_id, fencing_token, expires_at,
            expires_at <= clock_timestamp() AS expired
     FROM job_leases WHERE job_id = $1`,
    [job_id],
  );
  return firstRow(result.rows);
}

function checkLease(
  lease: LeaseRow | null,
  presented: Presented,
): HeartbeatRejection | null {
  if (lease === null) return "not_leased";
  if (
    presented.fencing_token === undefined ||
    lease.fencing_token !== presented.fencing_token ||
    (presented.runner_id !== undefined &&
      lease.runner_id !== presented.runner_id)
  ) {
    return "stale_lease";
  }
  return lease.expired ? "lease_expired" : null;
}

const staleError = (reason: HeartbeatRejection): ApiError =>
  new ApiError(
    "stale_lease",
    reason === "lease_expired"
      ? "lease expired"
      : reason === "not_leased"
        ? "job is not leased"
        : "fencing token is not current",
    { reason },
  );

async function recordStale(
  client: pg.PoolClient,
  job_id: string,
  operation: string,
  reason: HeartbeatRejection,
  lease: LeaseRow | null,
  presented: Presented,
): Promise<void> {
  await appendJobEvent(client, job_id, "job.stale_rejected", {
    operation,
    reason,
    presented_runner_id: presented.runner_id ?? null,
    presented_fencing_token: presented.fencing_token ?? null,
    current_fencing_token: lease?.fencing_token ?? null,
  });
}

interface Presented {
  runner_id?: string | undefined;
  fencing_token?: number | undefined;
}

/**
 * Fencing for runner-originated writes, evaluated before state validation so a
 * superseded runner always learns it is stale. A job that has never been
 * claimed (no fencing history) falls through to state validation instead,
 * which reports the more useful `invalid_transition`.
 */
async function fence(
  client: pg.PoolClient,
  job_id: string,
  operation: string,
  presented: Presented,
): Promise<{ lease: LeaseRow | null; rejected: ApiError | null }> {
  const lease = await readLease(client, job_id);
  let rejection: HeartbeatRejection | null = null;
  if (lease !== null) {
    rejection = checkLease(lease, presented);
  } else {
    const history = await client.query<{ last_token: number }>(
      "SELECT last_token FROM job_fencing WHERE job_id = $1",
      [job_id],
    );
    if ((history.rows[0]?.last_token ?? 0) > 0) rejection = "not_leased";
  }
  if (rejection === null) return { lease, rejected: null };
  await recordStale(client, job_id, operation, rejection, lease, presented);
  return { lease, rejected: staleError(rejection) };
}

const leaseTtl = (ms: number): number => {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new ApiError("validation_failed", "lease_ttl_ms must be positive");
  }
  return ms;
};

const RELEASES_LEASE: ReadonlySet<JobState> = new Set([
  ...TERMINAL_JOB_STATES,
  "interrupted",
  "queued",
]);

type Rejected = { rejected: ApiError };

export function jobsRepository(db: Database): JobsRepository {
  async function create(
    input: CreateJobInput,
    client?: pg.PoolClient,
  ): Promise<JobRecord> {
    const requirements = jobRequirementsSchema.safeParse(
      input.requirements ?? {},
    );
    const budget = jobBudgetSchema.safeParse(input.budget);
    if (!requirements.success || !budget.success) {
      throw new ApiError(
        "validation_failed",
        "invalid job requirements or budget",
      );
    }
    const maxAttempts = input.max_attempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new ApiError("validation_failed", "max_attempts must be >= 1");
    }
    const id = input.id ?? uuidv7();
    const run = async (c: pg.PoolClient): Promise<JobRecord> => {
      await c.query(
        `INSERT INTO jobs(id, project_id, kind, state, max_attempts, requirements,
           budget, input, preferred_runner_id, idempotency_key, created_by)
         VALUES ($1,$2,$3,'queued',$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10)`,
        [
          id,
          input.project_id,
          input.kind,
          maxAttempts,
          json(requirements.data),
          json(budget.data),
          json(input.input ?? {}),
          input.preferred_runner_id ?? null,
          input.idempotency_key ?? null,
          input.created_by ?? null,
        ],
      );
      await c.query("INSERT INTO job_fencing(job_id) VALUES ($1)", [id]);
      await appendJobEvent(c, id, "job.created", {
        kind: input.kind,
        preferred_runner_id: input.preferred_runner_id ?? null,
      });
      return requireJob(c, id);
    };
    return client === undefined ? db.withTransaction(run) : run(client);
  }

  async function claim(input: ClaimInput): Promise<ClaimResult | null> {
    const ttl = leaseTtl(input.lease_ttl_ms);
    const candidateLimit = Math.max(1, Math.trunc(input.candidate_limit ?? 50));
    return db.withTransaction(async (client) => {
      const runner = await client.query<{ project_id: string }>(
        "SELECT project_id FROM runners WHERE id = $1 AND revoked_at IS NULL",
        [input.runner_id],
      );
      const projectId = runner.rows[0]?.project_id;
      if (projectId === undefined) return null;

      const candidates = await client.query<{
        id: string;
        requirements: unknown;
      }>(
        `SELECT id, requirements FROM jobs
         WHERE state = 'queued' AND project_id = $2
           AND (preferred_runner_id IS NULL OR preferred_runner_id = $1)
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED LIMIT $3`,
        [input.runner_id, projectId, candidateLimit],
      );
      let chosen: string | undefined;
      for (const candidate of candidates.rows) {
        const parsed = jobRequirementsSchema.safeParse(candidate.requirements);
        if (parsed.success && input.matches(parsed.data)) {
          chosen = candidate.id;
          break;
        }
      }
      if (chosen === undefined) return null;

      const token = await client.query<{ last_token: number }>(
        `INSERT INTO job_fencing(job_id, last_token) VALUES ($1, 1)
         ON CONFLICT (job_id) DO UPDATE SET last_token = job_fencing.last_token + 1
         RETURNING last_token`,
        [chosen],
      );
      const fencingToken = (token.rows[0] as { last_token: number }).last_token;
      const lease = await client.query<{ expires_at: string }>(
        `INSERT INTO job_leases(job_id, runner_id, fencing_token, acquired_at, expires_at)
         VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp() + ($4::double precision * interval '1 millisecond'))
         ON CONFLICT (job_id) DO UPDATE SET runner_id = EXCLUDED.runner_id,
           fencing_token = EXCLUDED.fencing_token,
           acquired_at = EXCLUDED.acquired_at, expires_at = EXCLUDED.expires_at
         RETURNING expires_at`,
        [chosen, input.runner_id, fencingToken, ttl],
      );
      await client.query(
        `UPDATE jobs SET state = 'preparing', last_runner_id = $2,
           updated_at = clock_timestamp() WHERE id = $1`,
        [chosen, input.runner_id],
      );
      const job = await requireJob(client, chosen);
      await appendJobEvent(client, chosen, "job.claimed", {
        runner_id: input.runner_id,
        fencing_token: fencingToken,
        attempt: job.attempt,
      });
      return {
        job,
        fencing_token: fencingToken,
        lease_expires_at: (lease.rows[0] as { expires_at: string }).expires_at,
      };
    });
  }

  async function heartbeat(input: HeartbeatInput): Promise<HeartbeatResult> {
    const ttl = leaseTtl(input.lease_ttl_ms);
    const presented = {
      runner_id: input.runner_id,
      fencing_token: input.fencing_token,
    };
    return db.withTransaction(async (client) => {
      const job = await lockJobOrNull(client, input.job_id);
      if (job === null)
        return {
          accepted: false,
          reason: "not_leased",
          cancel_requested: false,
        };
      const cancelRequested = job.cancel_requested_at !== null;
      const lease = await readLease(client, input.job_id);
      const rejection = checkLease(lease, presented);
      if (rejection !== null) {
        if (rejection === "stale_lease") {
          await recordStale(
            client,
            input.job_id,
            "heartbeat",
            rejection,
            lease,
            presented,
          );
        }
        return {
          accepted: false,
          reason: rejection,
          cancel_requested: cancelRequested,
        };
      }
      const extended = await client.query<{ expires_at: string }>(
        `UPDATE job_leases SET expires_at = clock_timestamp() + ($2::double precision * interval '1 millisecond')
         WHERE job_id = $1 RETURNING expires_at`,
        [input.job_id, ttl],
      );
      if (input.usage !== undefined) {
        await client.query(
          "UPDATE jobs SET usage = usage || $2::jsonb, updated_at = clock_timestamp() WHERE id = $1",
          [input.job_id, json(input.usage)],
        );
      }
      return {
        accepted: true,
        cancel_requested: cancelRequested,
        lease_expires_at: (extended.rows[0] as { expires_at: string })
          .expires_at,
      };
    });
  }

  async function transition(input: TransitionInput): Promise<JobRecord> {
    const outcome = await db.withTransaction(
      async (client): Promise<JobRecord | Rejected> => {
        const job = await lockJob(client, input.job_id);
        const presented = { fencing_token: input.fencing_token };
        let leased = false;
        if (input.actor === "runner") {
          const fenced = await fence(
            client,
            input.job_id,
            "transition",
            presented,
          );
          if (fenced.rejected !== null) return { rejected: fenced.rejected };
          leased = fenced.lease !== null;
        }
        // `queued -> preparing` creates a lease and fencing token; only claim() may do it.
        if (
          input.to === "preparing" ||
          !canTransition(job.state, input.to, input.actor)
        ) {
          throw new ApiError(
            "invalid_transition",
            `cannot transition ${job.state} -> ${input.to} as ${input.actor}`,
            { from: job.state, to: input.to, actor: input.actor },
          );
        }
        if (input.actor === "runner" && !leased) {
          await recordStale(
            client,
            input.job_id,
            "transition",
            "not_leased",
            null,
            presented,
          );
          return { rejected: staleError("not_leased") };
        }
        const sets = ["state = $2", "updated_at = clock_timestamp()"];
        const params: unknown[] = [input.job_id, input.to];
        if (job.state === "interrupted" && input.to === "queued") {
          sets.push("attempt = attempt + 1");
        }
        if (input.to === "failed" && input.failure !== undefined) {
          params.push(json(input.failure));
          sets.push(`failure = $${params.length}::jsonb`);
        }
        await client.query(
          `UPDATE jobs SET ${sets.join(", ")} WHERE id = $1`,
          params,
        );
        if (RELEASES_LEASE.has(input.to)) {
          await client.query("DELETE FROM job_leases WHERE job_id = $1", [
            input.job_id,
          ]);
        }
        await appendJobEvent(client, input.job_id, "job.transition", {
          ...input.event_payload,
          from: job.state,
          to: input.to,
          actor: input.actor,
        });
        return requireJob(client, input.job_id);
      },
    );
    if ("rejected" in outcome) throw outcome.rejected;
    return outcome;
  }

  async function complete(input: CompleteInput): Promise<JobRecord> {
    const presented = {
      runner_id: input.runner_id,
      fencing_token: input.fencing_token,
    };
    const outcome = await db.withTransaction(
      async (client): Promise<JobRecord | Rejected> => {
        const job = await lockJob(client, input.job_id);
        const fenced = await fence(client, input.job_id, "complete", presented);
        if (fenced.rejected !== null) return { rejected: fenced.rejected };
        if (!canTransition(job.state, input.outcome, "runner")) {
          throw new ApiError(
            "invalid_transition",
            `cannot complete a ${job.state} job as ${input.outcome}`,
            { from: job.state, to: input.outcome, actor: "runner" },
          );
        }
        if (fenced.lease === null) {
          await recordStale(
            client,
            input.job_id,
            "complete",
            "not_leased",
            null,
            presented,
          );
          return { rejected: staleError("not_leased") };
        }
        await client.query(
          `UPDATE jobs SET state = $2, result = $3::jsonb, failure = $4::jsonb,
             usage = usage || $5::jsonb, updated_at = clock_timestamp()
           WHERE id = $1`,
          [
            input.job_id,
            input.outcome,
            input.result === undefined || input.result === null
              ? null
              : json(input.result),
            input.failure === undefined || input.failure === null
              ? null
              : json(input.failure),
            json(input.usage ?? {}),
          ],
        );
        await client.query("DELETE FROM job_leases WHERE job_id = $1", [
          input.job_id,
        ]);
        await appendJobEvent(client, input.job_id, "job.completed", {
          outcome: input.outcome,
          from: job.state,
          runner_id: input.runner_id,
          attempt: job.attempt,
        });
        return requireJob(client, input.job_id);
      },
    );
    if ("rejected" in outcome) throw outcome.rejected;
    return outcome;
  }

  async function requestCancel(job_id: string): Promise<JobRecord> {
    return db.withTransaction(async (client) => {
      const job = await lockJob(client, job_id);
      if (TERMINAL_JOB_STATES.has(job.state)) return requireJob(client, job_id);
      if (job.cancel_requested_at === null) {
        await client.query(
          `UPDATE jobs SET cancel_requested_at = clock_timestamp(),
             updated_at = clock_timestamp() WHERE id = $1`,
          [job_id],
        );
        await appendJobEvent(client, job_id, "job.cancel_requested", {
          state: job.state,
        });
      }
      if (job.state === "queued") {
        await client.query(
          "UPDATE jobs SET state = 'cancelled', updated_at = clock_timestamp() WHERE id = $1",
          [job_id],
        );
        await appendJobEvent(client, job_id, "job.transition", {
          from: "queued",
          to: "cancelled",
          actor: "user",
        });
      }
      return requireJob(client, job_id);
    });
  }

  async function reapOne(
    client: pg.PoolClient,
    job_id: string,
    now: string | null,
  ): Promise<ReapOutcome | null> {
    const locked = await client.query<{
      state: JobState;
      attempt: number;
      max_attempts: number;
      runner_id: string;
      fencing_token: number;
    }>(
      `SELECT j.state, j.attempt, j.max_attempts, l.runner_id, l.fencing_token
       FROM jobs j JOIN job_leases l ON l.job_id = j.id
       WHERE j.id = $1 AND l.expires_at < coalesce($2::timestamptz, clock_timestamp())
       FOR UPDATE OF j SKIP LOCKED`,
      [job_id, now],
    );
    const row = firstRow(locked.rows);
    if (row === null) return null;
    await client.query("DELETE FROM job_leases WHERE job_id = $1", [job_id]);
    if (
      row.state !== "preparing" &&
      row.state !== "running" &&
      row.state !== "awaiting_approval"
    ) {
      // A lease on a job that is not active is stale bookkeeping; drop it only.
      return null;
    }
    await client.query(
      "UPDATE jobs SET state = 'interrupted', updated_at = clock_timestamp() WHERE id = $1",
      [job_id],
    );
    await appendJobEvent(client, job_id, "job.transition", {
      from: row.state,
      to: "interrupted",
      actor: "system",
      reason: "lease_expired",
      runner_id: row.runner_id,
      fencing_token: row.fencing_token,
    });
    const inFlight = await client.query(
      "SELECT 1 FROM effect_ledger WHERE job_id = $1 AND status = 'started' LIMIT 1",
      [job_id],
    );
    const ambiguous = (inFlight.rowCount ?? 0) > 0;
    if (!ambiguous && row.attempt < row.max_attempts) {
      await client.query(
        `UPDATE jobs SET state = 'queued', attempt = attempt + 1,
           updated_at = clock_timestamp() WHERE id = $1`,
        [job_id],
      );
      await appendJobEvent(client, job_id, "job.transition", {
        from: "interrupted",
        to: "queued",
        actor: "system",
        attempt: row.attempt + 1,
      });
      return {
        job_id,
        outcome: "requeued",
        attempt: row.attempt + 1,
        reason: "lease_expired",
      };
    }
    const reason = ambiguous
      ? "non_repeatable_effect_ambiguous"
      : "retries_exhausted";
    const failure: JobFailure = {
      code: "interrupted",
      message: ambiguous
        ? "lease expired while a non-repeatable effect was in flight"
        : "lease expired and retries are exhausted",
      details: { reason, attempt: row.attempt, max_attempts: row.max_attempts },
      retryable: false,
    };
    await client.query(
      `UPDATE jobs SET state = 'failed', failure = $2::jsonb,
         updated_at = clock_timestamp() WHERE id = $1`,
      [job_id, json(failure)],
    );
    await appendJobEvent(client, job_id, "job.transition", {
      from: "interrupted",
      to: "failed",
      actor: "system",
      reason,
    });
    return { job_id, outcome: "failed", attempt: row.attempt, reason };
  }

  async function reapExpiredLeases(now?: Date): Promise<ReapOutcome[]> {
    const nowIso = now === undefined ? null : now.toISOString();
    const outcomes: ReapOutcome[] = [];
    for (;;) {
      const expired = await db.query<{ job_id: string }>(
        `SELECT job_id FROM job_leases
         WHERE expires_at < coalesce($1::timestamptz, clock_timestamp())
         ORDER BY expires_at LIMIT 100`,
        [nowIso],
      );
      if (expired.rows.length === 0) break;
      let progressed = 0;
      for (const { job_id } of expired.rows) {
        const outcome = await db.withTransaction((c) =>
          reapOne(c, job_id, nowIso),
        );
        if (outcome !== null) {
          outcomes.push(outcome);
          progressed += 1;
        }
      }
      // Rows skipped because another transaction holds them are left for the next sweep.
      if (progressed === 0) break;
    }
    return outcomes;
  }

  return {
    create,
    findById: (id) => loadJob(db, id),
    async listByIds(ids) {
      if (ids.length === 0) return [];
      const result = await db.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM ${JOB_FROM} WHERE t.id = ANY($1::uuid[])`,
        [ids],
      );
      return result.rows.map(toJob);
    },
    async list(project_id, options = {}) {
      const params: unknown[] = [project_id];
      const where = ["t.project_id = $1"];
      if (options.state !== undefined) {
        params.push(options.state);
        where.push(`t.state = $${params.length}`);
      }
      if (options.kind !== undefined) {
        params.push(options.kind);
        where.push(`t.kind = $${params.length}`);
      }
      const page = await keysetPage<JobRow>(db, {
        from: JOB_FROM,
        columns: JOB_COLUMNS,
        where,
        params,
        cursor: options.cursor,
        limit: options.limit,
      });
      return { items: page.items.map(toJob), next_cursor: page.next_cursor };
    },
    claim,
    heartbeat,
    transition,
    complete,
    requestCancel,
    reapExpiredLeases,
  };
}
