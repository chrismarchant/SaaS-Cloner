import { uuidv7 } from "@rea-web/contracts";
import type { Database } from "../database.js";
import { firstRow, json } from "../support.js";
import type {
  ApprovalDecision,
  ApprovalRecord,
  EffectLedgerEntry,
  IdempotencyRecord,
  JsonObject,
} from "../types.js";

export interface EffectLedgerRepository {
  /**
   * Records that a non-repeatable step is about to run. A step that already
   * `completed` is returned unchanged so a retried attempt can skip it; a
   * `started` or `failed` step is (re)started for the new attempt.
   */
  start(
    job_id: string,
    step_key: string,
    attempt: number,
    detail?: JsonObject,
  ): Promise<EffectLedgerEntry>;
  complete(
    job_id: string,
    step_key: string,
    detail?: JsonObject,
  ): Promise<EffectLedgerEntry | null>;
  fail(
    job_id: string,
    step_key: string,
    detail?: JsonObject,
  ): Promise<EffectLedgerEntry | null>;
  get(job_id: string, step_key: string): Promise<EffectLedgerEntry | null>;
  /** True when any step is `started` without having completed or failed. */
  hasStarted(job_id: string): Promise<boolean>;
}

export function effectLedgerRepository(db: Database): EffectLedgerRepository {
  const finish =
    (status: "completed" | "failed") =>
    async (job_id: string, step_key: string, detail: JsonObject = {}) => {
      const result = await db.query<EffectLedgerEntry>(
        `UPDATE effect_ledger SET status = $3, detail = detail || $4::jsonb,
           updated_at = clock_timestamp()
         WHERE job_id = $1 AND step_key = $2 RETURNING *`,
        [job_id, step_key, status, json(detail)],
      );
      return firstRow(result.rows);
    };
  const get = async (job_id: string, step_key: string) => {
    const result = await db.query<EffectLedgerEntry>(
      "SELECT * FROM effect_ledger WHERE job_id = $1 AND step_key = $2",
      [job_id, step_key],
    );
    return firstRow(result.rows);
  };
  return {
    async start(job_id, step_key, attempt, detail = {}) {
      const result = await db.query<EffectLedgerEntry>(
        `INSERT INTO effect_ledger(job_id, step_key, status, detail, attempt)
         VALUES ($1, $2, 'started', $3::jsonb, $4)
         ON CONFLICT (job_id, step_key) DO UPDATE SET status = 'started',
           detail = EXCLUDED.detail, attempt = EXCLUDED.attempt,
           updated_at = clock_timestamp()
         WHERE effect_ledger.status <> 'completed'
         RETURNING *`,
        [job_id, step_key, json(detail), attempt],
      );
      const written = firstRow(result.rows);
      if (written !== null) return written;
      return (await get(job_id, step_key)) as EffectLedgerEntry;
    },
    complete: finish("completed"),
    fail: finish("failed"),
    get,
    async hasStarted(job_id) {
      const result = await db.query(
        "SELECT 1 FROM effect_ledger WHERE job_id = $1 AND status = 'started' LIMIT 1",
        [job_id],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export interface ApprovalsRepository {
  create(input: {
    approval_id?: string;
    job_id: string;
    tool: string;
    arguments: JsonObject;
    effects?: string[];
    reason: string;
  }): Promise<ApprovalRecord>;
  find(approval_id: string): Promise<ApprovalRecord | null>;
  /**
   * Records the first decision only; returns null when the approval does not
   * exist or was already decided (callers use `find` to tell which).
   */
  decide(
    approval_id: string,
    input: { decision: ApprovalDecision; decided_by: string },
  ): Promise<ApprovalRecord | null>;
  pendingForJob(job_id: string): Promise<ApprovalRecord[]>;
  undeliveredDecisions(job_id: string): Promise<ApprovalRecord[]>;
  markDelivered(approval_ids: string[]): Promise<number>;
}

export function approvalsRepository(db: Database): ApprovalsRepository {
  return {
    async create(input) {
      const result = await db.query<ApprovalRecord>(
        `INSERT INTO job_approvals(approval_id, job_id, tool, arguments, effects, reason)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6) RETURNING *`,
        [
          input.approval_id ?? uuidv7(),
          input.job_id,
          input.tool,
          json(input.arguments),
          json(input.effects ?? []),
          input.reason,
        ],
      );
      return result.rows[0] as ApprovalRecord;
    },
    async find(approval_id) {
      const result = await db.query<ApprovalRecord>(
        "SELECT * FROM job_approvals WHERE approval_id = $1",
        [approval_id],
      );
      return firstRow(result.rows);
    },
    async decide(approval_id, input) {
      const result = await db.query<ApprovalRecord>(
        `UPDATE job_approvals SET decision = $2, decided_by = $3,
           decided_at = clock_timestamp()
         WHERE approval_id = $1 AND decision IS NULL RETURNING *`,
        [approval_id, input.decision, input.decided_by],
      );
      return firstRow(result.rows);
    },
    async pendingForJob(job_id) {
      const result = await db.query<ApprovalRecord>(
        `SELECT * FROM job_approvals WHERE job_id = $1 AND decision IS NULL
         ORDER BY requested_at, approval_id`,
        [job_id],
      );
      return result.rows;
    },
    async undeliveredDecisions(job_id) {
      const result = await db.query<ApprovalRecord>(
        `SELECT * FROM job_approvals
         WHERE job_id = $1 AND decision IS NOT NULL AND delivered_at IS NULL
         ORDER BY decided_at, approval_id`,
        [job_id],
      );
      return result.rows;
    },
    async markDelivered(approval_ids) {
      if (approval_ids.length === 0) return 0;
      const result = await db.query(
        `UPDATE job_approvals SET delivered_at = clock_timestamp()
         WHERE approval_id = ANY($1::text[]) AND delivered_at IS NULL`,
        [approval_ids],
      );
      return result.rowCount ?? 0;
    },
  };
}

export interface IdempotencyRepository {
  find(principal_id: string, key: string): Promise<IdempotencyRecord | null>;
  /**
   * Stores the first response for `(principal_id, key)`. When a concurrent
   * request already stored one, that record is returned instead.
   */
  store(input: {
    principal_id: string;
    project_id?: string | null;
    key: string;
    request_hash: string;
    status_code: number;
    response: unknown;
  }): Promise<IdempotencyRecord>;
  purgeOlderThan(ms: number): Promise<number>;
}

export function idempotencyRepository(db: Database): IdempotencyRepository {
  const find = async (principal_id: string, key: string) => {
    const result = await db.query<IdempotencyRecord>(
      "SELECT * FROM idempotency_records WHERE principal_id = $1 AND idempotency_key = $2",
      [principal_id, key],
    );
    return firstRow(result.rows);
  };
  return {
    find,
    async store(input) {
      const result = await db.query<IdempotencyRecord>(
        `INSERT INTO idempotency_records(principal_id, project_id, idempotency_key,
           request_hash, status_code, response)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (principal_id, idempotency_key) DO NOTHING RETURNING *`,
        [
          input.principal_id,
          input.project_id ?? null,
          input.key,
          input.request_hash,
          input.status_code,
          json(input.response),
        ],
      );
      return (
        firstRow(result.rows) ??
        ((await find(input.principal_id, input.key)) as IdempotencyRecord)
      );
    },
    async purgeOlderThan(ms) {
      const result = await db.query(
        `DELETE FROM idempotency_records
         WHERE created_at < clock_timestamp() - ($1::double precision * interval '1 millisecond')`,
        [ms],
      );
      return result.rowCount ?? 0;
    },
  };
}
