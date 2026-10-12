import { uuidv7 } from "@rea-web/contracts";
import type pg from "pg";
import type { Database, Queryable } from "../database.js";
import {
  type Page,
  type PageOptions,
  clampLimit,
  executor,
  firstRow,
  json,
  keysetPage,
} from "../support.js";
import type {
  EvidenceArtifactKind,
  EvidenceArtifactRecord,
  FindingClass,
  FindingRecord,
  FindingSource,
  InvestigationRecord,
  InvestigationStatus,
  JsonObject,
  ToolCallRecord,
} from "../types.js";

export interface InvestigationsRepository {
  create(
    input: {
      id?: string;
      project_id: string;
      target_id: string;
      question: string;
      policy: JsonObject;
      created_by: string;
    },
    client?: pg.PoolClient,
  ): Promise<InvestigationRecord>;
  findById(project_id: string, id: string): Promise<InvestigationRecord | null>;
  /** Runner-side lookup: the investigation a job belongs to. */
  findByJobId(job_id: string): Promise<InvestigationRecord | null>;
  list(
    project_id: string,
    options?: PageOptions & { status?: InvestigationStatus },
  ): Promise<Page<InvestigationRecord>>;
  setJob(
    id: string,
    job_id: string | null,
    client?: pg.PoolClient,
  ): Promise<InvestigationRecord | null>;
  setStatus(
    id: string,
    status: InvestigationStatus,
  ): Promise<InvestigationRecord | null>;
  setRouting(
    id: string,
    routing: JsonObject,
  ): Promise<InvestigationRecord | null>;
  setUpstreamIdentity(
    id: string,
    identity: JsonObject,
  ): Promise<InvestigationRecord | null>;
}

export function investigationsRepository(
  db: Database,
): InvestigationsRepository {
  const update = async (
    run: Queryable,
    id: string,
    column: string,
    value: unknown,
    jsonb: boolean,
  ) => {
    const result = await run.query<InvestigationRecord>(
      `UPDATE investigations SET ${column} = $2${jsonb ? "::jsonb" : ""},
         updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
      [id, jsonb ? json(value) : value],
    );
    return firstRow(result.rows);
  };
  return {
    async create(input, client) {
      const result = await executor(db, client).query<InvestigationRecord>(
        `INSERT INTO investigations(id, project_id, target_id, question, policy, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING *`,
        [
          input.id ?? uuidv7(),
          input.project_id,
          input.target_id,
          input.question,
          json(input.policy),
          input.created_by,
        ],
      );
      return result.rows[0] as InvestigationRecord;
    },
    async findById(project_id, id) {
      const result = await db.query<InvestigationRecord>(
        "SELECT * FROM investigations WHERE id = $1 AND project_id = $2",
        [id, project_id],
      );
      return firstRow(result.rows);
    },
    async findByJobId(job_id) {
      const result = await db.query<InvestigationRecord>(
        "SELECT * FROM investigations WHERE job_id = $1",
        [job_id],
      );
      return firstRow(result.rows);
    },
    list(project_id, options = {}) {
      const params: unknown[] = [project_id];
      const where = ["t.project_id = $1"];
      if (options.status !== undefined) {
        params.push(options.status);
        where.push(`t.status = $${params.length}`);
      }
      return keysetPage<InvestigationRecord>(db, {
        from: "investigations t",
        where,
        params,
        cursor: options.cursor,
        limit: options.limit,
      });
    },
    setJob: (id, job_id, client) =>
      update(executor(db, client), id, "job_id", job_id, false),
    setStatus: (id, status) => update(db, id, "status", status, false),
    setRouting: (id, routing) => update(db, id, "routing", routing, true),
    setUpstreamIdentity: (id, identity) =>
      update(db, id, "upstream_identity", identity, true),
  };
}

export interface CreateToolCallInput {
  id?: string;
  investigation_id: string;
  job_id: string;
  seq: number;
  tool_name: string;
  upstream_session_id: string;
  arguments_object_key?: string | null;
  raw_result_object_key: string;
  raw_result_sha256: string;
  raw_result_bytes: number;
  derived?: JsonObject;
  evidence_id?: string | null;
  effects?: string[];
  is_error?: boolean;
  duration_ms: number;
  started_at: string | Date;
}

export interface ToolCallsRepository {
  /**
   * Idempotent per `(investigation_id, seq)`: a retried upload returns the row
   * stored first rather than failing or duplicating.
   */
  create(input: CreateToolCallInput): Promise<ToolCallRecord>;
  findById(id: string): Promise<ToolCallRecord | null>;
  findBySeq(
    investigation_id: string,
    seq: number,
  ): Promise<ToolCallRecord | null>;
  findByEvidenceId(
    investigation_id: string,
    evidence_id: string,
  ): Promise<ToolCallRecord | null>;
  /** Ascending by `seq`, optionally after `afterSeq`. */
  listByInvestigation(
    investigation_id: string,
    options?: { afterSeq?: number; limit?: number },
  ): Promise<ToolCallRecord[]>;
}

export function toolCallsRepository(db: Database): ToolCallsRepository {
  const one = async (sql: string, params: unknown[]) => {
    const result = await db.query<ToolCallRecord>(sql, params);
    return firstRow(result.rows);
  };
  return {
    async create(input) {
      const startedAt =
        input.started_at instanceof Date
          ? input.started_at.toISOString()
          : input.started_at;
      const inserted = await db.query<ToolCallRecord>(
        `INSERT INTO tool_calls(id, investigation_id, job_id, seq, tool_name,
           upstream_session_id, arguments_object_key, raw_result_object_key,
           raw_result_sha256, raw_result_bytes, derived, evidence_id, effects,
           is_error, duration_ms, started_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15,$16)
         ON CONFLICT (investigation_id, seq) DO NOTHING RETURNING *`,
        [
          input.id ?? uuidv7(),
          input.investigation_id,
          input.job_id,
          input.seq,
          input.tool_name,
          input.upstream_session_id,
          input.arguments_object_key ?? null,
          input.raw_result_object_key,
          input.raw_result_sha256,
          input.raw_result_bytes,
          json(input.derived ?? {}),
          input.evidence_id ?? null,
          json(input.effects ?? []),
          input.is_error ?? false,
          input.duration_ms,
          startedAt,
        ],
      );
      return (
        firstRow(inserted.rows) ??
        ((await one(
          "SELECT * FROM tool_calls WHERE investigation_id = $1 AND seq = $2",
          [input.investigation_id, input.seq],
        )) as ToolCallRecord)
      );
    },
    findById: (id) => one("SELECT * FROM tool_calls WHERE id = $1", [id]),
    findBySeq: (investigation_id, seq) =>
      one("SELECT * FROM tool_calls WHERE investigation_id = $1 AND seq = $2", [
        investigation_id,
        seq,
      ]),
    findByEvidenceId: (investigation_id, evidence_id) =>
      one(
        `SELECT * FROM tool_calls WHERE investigation_id = $1 AND evidence_id = $2
         ORDER BY seq LIMIT 1`,
        [investigation_id, evidence_id],
      ),
    async listByInvestigation(investigation_id, options = {}) {
      const result = await db.query<ToolCallRecord>(
        `SELECT * FROM tool_calls WHERE investigation_id = $1 AND seq > $2
         ORDER BY seq LIMIT $3`,
        [
          investigation_id,
          options.afterSeq ?? 0,
          clampLimit(options.limit, 1000),
        ],
      );
      return result.rows;
    },
  };
}

export interface EvidenceArtifactsRepository {
  create(input: {
    id?: string;
    investigation_id: string;
    kind: EvidenceArtifactKind;
    name: string;
    object_key: string;
    sha256: string;
    size: number;
  }): Promise<EvidenceArtifactRecord>;
  findById(
    investigation_id: string,
    id: string,
  ): Promise<EvidenceArtifactRecord | null>;
  listByInvestigation(
    investigation_id: string,
    options?: { kind?: EvidenceArtifactKind },
  ): Promise<EvidenceArtifactRecord[]>;
}

export function evidenceArtifactsRepository(
  db: Database,
): EvidenceArtifactsRepository {
  return {
    async create(input) {
      const result = await db.query<EvidenceArtifactRecord>(
        `INSERT INTO evidence_artifacts(id, investigation_id, kind, name, object_key, sha256, size)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          input.id ?? uuidv7(),
          input.investigation_id,
          input.kind,
          input.name,
          input.object_key,
          input.sha256,
          input.size,
        ],
      );
      return result.rows[0] as EvidenceArtifactRecord;
    },
    async findById(investigation_id, id) {
      const result = await db.query<EvidenceArtifactRecord>(
        "SELECT * FROM evidence_artifacts WHERE id = $1 AND investigation_id = $2",
        [id, investigation_id],
      );
      return firstRow(result.rows);
    },
    async listByInvestigation(investigation_id, options = {}) {
      const result = await db.query<EvidenceArtifactRecord>(
        `SELECT * FROM evidence_artifacts
         WHERE investigation_id = $1 AND ($2::text IS NULL OR kind = $2)
         ORDER BY created_at, id`,
        [investigation_id, options.kind ?? null],
      );
      return result.rows;
    },
  };
}

export interface CreateFindingInput {
  id?: string;
  investigation_id: string;
  class: FindingClass;
  title: string;
  body: string;
  evidence_ids?: string[];
  tool_call_seqs?: number[];
  limitations?: string[];
  source: FindingSource;
}

export interface FindingsRepository {
  create(input: CreateFindingInput): Promise<FindingRecord>;
  /** All-or-nothing batch insert, in input order. */
  createMany(inputs: CreateFindingInput[]): Promise<FindingRecord[]>;
  findById(investigation_id: string, id: string): Promise<FindingRecord | null>;
  listByInvestigation(
    investigation_id: string,
    options?: { class?: FindingClass },
  ): Promise<FindingRecord[]>;
}

export function findingsRepository(db: Database): FindingsRepository {
  const insert = async (run: Queryable, input: CreateFindingInput) => {
    const result = await run.query<FindingRecord>(
      `INSERT INTO findings(id, investigation_id, class, title, body, evidence_ids,
         tool_call_seqs, limitations, source, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9, clock_timestamp())
       RETURNING *`,
      [
        input.id ?? uuidv7(),
        input.investigation_id,
        input.class,
        input.title,
        input.body,
        json(input.evidence_ids ?? []),
        json(input.tool_call_seqs ?? []),
        json(input.limitations ?? []),
        input.source,
      ],
    );
    return result.rows[0] as FindingRecord;
  };
  return {
    create: (input) => insert(db, input),
    createMany: (inputs) =>
      db.withTransaction(async (client) => {
        const created: FindingRecord[] = [];
        for (const input of inputs) created.push(await insert(client, input));
        return created;
      }),
    async findById(investigation_id, id) {
      const result = await db.query<FindingRecord>(
        "SELECT * FROM findings WHERE id = $1 AND investigation_id = $2",
        [id, investigation_id],
      );
      return firstRow(result.rows);
    },
    async listByInvestigation(investigation_id, options = {}) {
      const result = await db.query<FindingRecord>(
        `SELECT * FROM findings
         WHERE investigation_id = $1 AND ($2::text IS NULL OR class = $2)
         ORDER BY created_at, id`,
        [investigation_id, options.class ?? null],
      );
      return result.rows;
    },
  };
}
