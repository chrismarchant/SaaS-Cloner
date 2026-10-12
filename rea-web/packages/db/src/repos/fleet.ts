import { ApiError, uuidv7 } from "@rea-web/contracts";
import type { Database } from "../database.js";
import {
  PG_FOREIGN_KEY_VIOLATION,
  type Page,
  type PageOptions,
  firstRow,
  json,
  keysetPage,
  pgErrorCode,
} from "../support.js";
import type {
  JsonObject,
  RunnerRecord,
  TargetKind,
  TargetRecord,
} from "../types.js";

export interface RunnersRepository {
  create(input: {
    id?: string;
    project_id: string;
    name: string;
    token_hash: string;
    labels?: string[];
    created_by?: string | null;
  }): Promise<RunnerRecord>;
  /** Ignores revoked runners. */
  findActiveByTokenHash(hash: string): Promise<RunnerRecord | null>;
  findById(
    project_id: string | undefined,
    id: string,
  ): Promise<RunnerRecord | null>;
  list(project_id: string): Promise<RunnerRecord[]>;
  /** Stores the report, marks the runner online and records `last_seen_at`. */
  updateCapabilities(
    id: string,
    input: { capability_report: JsonObject; capability_digest: JsonObject },
  ): Promise<RunnerRecord | null>;
  touch(id: string): Promise<void>;
  /** Marks `online` runners unseen for `olderThanMs` as `stale`; returns their ids. */
  markStale(olderThanMs: number): Promise<string[]>;
  revoke(id: string): Promise<RunnerRecord | null>;
}

export function runnersRepository(db: Database): RunnersRepository {
  return {
    async create(input) {
      const result = await db.query<RunnerRecord>(
        `INSERT INTO runners(id, project_id, name, token_hash, labels, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING *`,
        [
          input.id ?? uuidv7(),
          input.project_id,
          input.name,
          input.token_hash,
          json(input.labels ?? []),
          input.created_by ?? null,
        ],
      );
      return result.rows[0] as RunnerRecord;
    },
    async findActiveByTokenHash(hash) {
      const result = await db.query<RunnerRecord>(
        "SELECT * FROM runners WHERE token_hash = $1 AND revoked_at IS NULL AND status <> 'revoked'",
        [hash],
      );
      return firstRow(result.rows);
    },
    async findById(project_id, id) {
      const result =
        project_id === undefined
          ? await db.query<RunnerRecord>("SELECT * FROM runners WHERE id = $1", [
              id,
            ])
          : await db.query<RunnerRecord>(
              "SELECT * FROM runners WHERE id = $1 AND project_id = $2",
              [id, project_id],
            );
      return firstRow(result.rows);
    },
    async list(project_id) {
      const result = await db.query<RunnerRecord>(
        "SELECT * FROM runners WHERE project_id = $1 ORDER BY created_at, id",
        [project_id],
      );
      return result.rows;
    },
    async updateCapabilities(id, input) {
      const result = await db.query<RunnerRecord>(
        `UPDATE runners SET capability_report = $2::jsonb,
           capability_digest = $3::jsonb, status = 'online',
           last_seen_at = clock_timestamp()
         WHERE id = $1 AND revoked_at IS NULL RETURNING *`,
        [id, json(input.capability_report), json(input.capability_digest)],
      );
      return firstRow(result.rows);
    },
    async touch(id) {
      await db.query(
        `UPDATE runners SET last_seen_at = clock_timestamp(),
           status = CASE WHEN status IN ('stale','offline') THEN 'online' ELSE status END
         WHERE id = $1 AND revoked_at IS NULL`,
        [id],
      );
    },
    async markStale(olderThanMs) {
      const result = await db.query<{ id: string }>(
        `UPDATE runners SET status = 'stale'
         WHERE status = 'online'
           AND last_seen_at < clock_timestamp() - ($1::double precision * interval '1 millisecond')
         RETURNING id`,
        [olderThanMs],
      );
      return result.rows.map((row) => row.id);
    },
    async revoke(id) {
      const result = await db.query<RunnerRecord>(
        `UPDATE runners SET status = 'revoked',
           revoked_at = coalesce(revoked_at, clock_timestamp())
         WHERE id = $1 RETURNING *`,
        [id],
      );
      return firstRow(result.rows);
    },
  };
}

export interface CreateTargetInput {
  id?: string;
  project_id: string;
  kind: TargetKind;
  name: string;
  class: string;
  sha256?: string | null;
  size?: number | null;
  url?: string | null;
  object_key?: string | null;
  runner_id?: string | null;
  runner_path_hash?: string | null;
  metadata?: JsonObject;
  created_by?: string | null;
}

export interface TargetsRepository {
  create(input: CreateTargetInput): Promise<TargetRecord>;
  findById(project_id: string, id: string): Promise<TargetRecord | null>;
  list(project_id: string, page?: PageOptions): Promise<Page<TargetRecord>>;
  /** `conflict` when investigations still reference the target. */
  delete(project_id: string, id: string): Promise<boolean>;
}

export function targetsRepository(db: Database): TargetsRepository {
  return {
    async create(input) {
      const result = await db.query<TargetRecord>(
        `INSERT INTO targets(id, project_id, kind, name, class, sha256, size, url,
           object_key, runner_id, runner_path_hash, metadata, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) RETURNING *`,
        [
          input.id ?? uuidv7(),
          input.project_id,
          input.kind,
          input.name,
          input.class,
          input.sha256 ?? null,
          input.size ?? null,
          input.url ?? null,
          input.object_key ?? null,
          input.runner_id ?? null,
          input.runner_path_hash ?? null,
          json(input.metadata ?? {}),
          input.created_by ?? null,
        ],
      );
      return result.rows[0] as TargetRecord;
    },
    async findById(project_id, id) {
      const result = await db.query<TargetRecord>(
        "SELECT * FROM targets WHERE id = $1 AND project_id = $2",
        [id, project_id],
      );
      return firstRow(result.rows);
    },
    list: (project_id, page = {}) =>
      keysetPage<TargetRecord>(db, {
        from: "targets t",
        where: ["t.project_id = $1"],
        params: [project_id],
        ...page,
      }),
    async delete(project_id, id) {
      try {
        const result = await db.query(
          "DELETE FROM targets WHERE id = $1 AND project_id = $2",
          [id, project_id],
        );
        return (result.rowCount ?? 0) > 0;
      } catch (error) {
        if (pgErrorCode(error) === PG_FOREIGN_KEY_VIOLATION) {
          throw new ApiError("conflict", "target is referenced by investigations");
        }
        throw error;
      }
    },
  };
}
