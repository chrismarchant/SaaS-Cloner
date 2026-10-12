import { ApiError, type JobEventKind } from "@rea-web/contracts";
import type pg from "pg";
import type { Database } from "../database.js";
import { json } from "../support.js";
import type { JobEventRecord, JsonObject } from "../types.js";

export const JOB_EVENTS_CHANNEL = "job_events";

/**
 * Appends one event inside the caller's transaction. The job row lock taken
 * here serialises writers, so `max(seq)+1` can never collide; `pg_notify` is
 * delivered when that transaction commits.
 */
export async function appendJobEvent(
  client: pg.PoolClient,
  job_id: string,
  kind: JobEventKind,
  payload: JsonObject = {},
): Promise<JobEventRecord> {
  const locked = await client.query(
    "SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE",
    [job_id],
  );
  if (locked.rowCount === 0) {
    throw new ApiError("not_found", "job not found");
  }
  const result = await client.query<JobEventRecord>(
    `INSERT INTO job_events(job_id, seq, kind, payload)
     SELECT $1, coalesce(max(seq), 0) + 1, $2, $3::jsonb
     FROM job_events WHERE job_id = $1
     RETURNING *`,
    [job_id, kind, json(payload)],
  );
  await client.query("SELECT pg_notify($1, $2)", [JOB_EVENTS_CHANNEL, job_id]);
  return result.rows[0] as JobEventRecord;
}

export interface JobEventsRepository {
  /** Joins `client`'s transaction when given; otherwise runs in its own. */
  append(
    client: pg.PoolClient | undefined,
    job_id: string,
    kind: JobEventKind,
    payload?: JsonObject,
  ): Promise<JobEventRecord>;
  /** Events with `seq > afterSeq`, ascending. */
  listAfter(
    job_id: string,
    afterSeq: number,
    limit?: number,
  ): Promise<JobEventRecord[]>;
}

export function jobEventsRepository(db: Database): JobEventsRepository {
  return {
    append: (client, job_id, kind, payload = {}) =>
      client === undefined
        ? db.withTransaction((c) => appendJobEvent(c, job_id, kind, payload))
        : appendJobEvent(client, job_id, kind, payload),
    async listAfter(job_id, afterSeq, limit = 100) {
      const result = await db.query<JobEventRecord>(
        `SELECT * FROM job_events WHERE job_id = $1 AND seq > $2
         ORDER BY seq LIMIT $3`,
        [job_id, afterSeq, Math.max(1, Math.min(Math.trunc(limit), 1000))],
      );
      return result.rows;
    },
  };
}
