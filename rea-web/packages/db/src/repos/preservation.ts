import { uuidv7 } from "@rea-web/contracts";
import type pg from "pg";
import type { Database } from "../database.js";
import {
  type Page,
  type PageOptions,
  executor,
  firstRow,
  idKeysetPage,
  json,
  keysetPage,
  patchRow,
  toIso,
} from "../support.js";
import type {
  BuildRecord,
  CaptureRecord,
  CaptureStatus,
  ExportRecord,
  ExportStatus,
  JsonObject,
  PlanRecord,
  VerificationRecord,
} from "../types.js";

export interface BuildsRepository {
  create(
    input: {
      id?: string;
      project_id: string;
      name: string;
      description?: string;
      source: JsonObject;
      components: unknown;
      preferred_runner_id?: string | null;
      created_by: string;
    },
    client?: pg.PoolClient,
  ): Promise<BuildRecord>;
  findById(project_id: string, id: string): Promise<BuildRecord | null>;
  list(project_id: string, page?: PageOptions): Promise<Page<BuildRecord>>;
}

export function buildsRepository(db: Database): BuildsRepository {
  return {
    async create(input, client) {
      const result = await executor(db, client).query<BuildRecord>(
        `INSERT INTO builds(id, project_id, name, description, source, components,
           preferred_runner_id, created_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) RETURNING *`,
        [
          input.id ?? uuidv7(),
          input.project_id,
          input.name,
          input.description ?? "",
          json(input.source),
          json(input.components),
          input.preferred_runner_id ?? null,
          input.created_by,
        ],
      );
      return result.rows[0] as BuildRecord;
    },
    async findById(project_id, id) {
      const result = await db.query<BuildRecord>(
        "SELECT * FROM builds WHERE id = $1 AND project_id = $2",
        [id, project_id],
      );
      return firstRow(result.rows);
    },
    list: (project_id, page = {}) =>
      keysetPage<BuildRecord>(db, {
        from: "builds t",
        where: ["t.project_id = $1"],
        params: [project_id],
        ...page,
      }),
  };
}

export interface PlansRepository {
  create(
    input: {
      id?: string;
      build_id: string;
      job_id: string;
      runner_id?: string | null;
    },
    client?: pg.PoolClient,
  ): Promise<PlanRecord>;
  /** Scoped to the owning project through the build. */
  findById(project_id: string, id: string): Promise<PlanRecord | null>;
  findByJobId(job_id: string): Promise<PlanRecord | null>;
  listByBuild(build_id: string, page?: PageOptions): Promise<Page<PlanRecord>>;
  /** Stores the runner's plan document and the runner that produced it. */
  setPlan(
    id: string,
    input: { plan: JsonObject; runner_id?: string | null },
  ): Promise<PlanRecord | null>;
}

export function plansRepository(db: Database): PlansRepository {
  return {
    async create(input, client) {
      const result = await executor(db, client).query<PlanRecord>(
        `INSERT INTO preservation_plans(id, build_id, job_id, runner_id)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [
          input.id ?? uuidv7(),
          input.build_id,
          input.job_id,
          input.runner_id ?? null,
        ],
      );
      return result.rows[0] as PlanRecord;
    },
    async findById(project_id, id) {
      const result = await db.query<PlanRecord>(
        `SELECT p.* FROM preservation_plans p JOIN builds b ON b.id = p.build_id
         WHERE p.id = $1 AND b.project_id = $2`,
        [id, project_id],
      );
      return firstRow(result.rows);
    },
    async findByJobId(job_id) {
      const result = await db.query<PlanRecord>(
        "SELECT * FROM preservation_plans WHERE job_id = $1",
        [job_id],
      );
      return firstRow(result.rows);
    },
    listByBuild: (build_id, page = {}) =>
      keysetPage<PlanRecord>(db, {
        from: "preservation_plans t",
        where: ["t.build_id = $1"],
        params: [build_id],
        ...page,
      }),
    setPlan: (id, input) =>
      patchRow<PlanRecord>(db, "preservation_plans", id, input, {
        plan: "json",
        runner_id: "plain",
      }),
  };
}

export interface CaptureUpdate {
  status?: CaptureStatus;
  manifest_object_key?: string | null;
  manifest_sha256?: string | null;
  consistency?: "single_point" | "inconsistent" | "unknown" | null;
  component_statuses?: JsonObject;
  started_at?: string | Date | null;
  finished_at?: string | Date | null;
}

export interface CapturesRepository {
  create(
    input: { id?: string; build_id: string; plan_id: string; job_id: string },
    client?: pg.PoolClient,
  ): Promise<CaptureRecord>;
  /** Scoped to the owning project through the build. */
  findById(project_id: string, id: string): Promise<CaptureRecord | null>;
  findByJobId(job_id: string): Promise<CaptureRecord | null>;
  /** Captures have no `created_at`; newest first by id (UUIDv7). */
  listByBuild(build_id: string, limit?: number): Promise<CaptureRecord[]>;
  /** Paginated, newest first by id (UUIDv7); the cursor carries the last id. */
  pageByBuild(
    build_id: string,
    page?: PageOptions,
  ): Promise<Page<CaptureRecord>>;
  update(id: string, patch: CaptureUpdate): Promise<CaptureRecord | null>;
}

const isoOrNull = (value: string | Date | null | undefined) =>
  value === undefined || value === null ? value : toIso(value);

export function capturesRepository(db: Database): CapturesRepository {
  return {
    async create(input, client) {
      const result = await executor(db, client).query<CaptureRecord>(
        `INSERT INTO captures(id, build_id, plan_id, job_id) VALUES ($1,$2,$3,$4)
         RETURNING *`,
        [input.id ?? uuidv7(), input.build_id, input.plan_id, input.job_id],
      );
      return result.rows[0] as CaptureRecord;
    },
    async findById(project_id, id) {
      const result = await db.query<CaptureRecord>(
        `SELECT c.* FROM captures c JOIN builds b ON b.id = c.build_id
         WHERE c.id = $1 AND b.project_id = $2`,
        [id, project_id],
      );
      return firstRow(result.rows);
    },
    async findByJobId(job_id) {
      const result = await db.query<CaptureRecord>(
        "SELECT * FROM captures WHERE job_id = $1",
        [job_id],
      );
      return firstRow(result.rows);
    },
    async listByBuild(build_id, limit = 100) {
      const result = await db.query<CaptureRecord>(
        "SELECT * FROM captures WHERE build_id = $1 ORDER BY id DESC LIMIT $2",
        [build_id, Math.max(1, Math.min(Math.trunc(limit), 500))],
      );
      return result.rows;
    },
    pageByBuild: (build_id, page = {}) =>
      idKeysetPage<CaptureRecord>(db, {
        from: "captures t",
        where: ["t.build_id = $1"],
        params: [build_id],
        ...page,
      }),
    update: (id, patch) =>
      patchRow<CaptureRecord>(
        db,
        "captures",
        id,
        {
          ...patch,
          started_at: isoOrNull(patch.started_at),
          finished_at: isoOrNull(patch.finished_at),
        },
        {
          status: "plain",
          manifest_object_key: "plain",
          manifest_sha256: "plain",
          consistency: "plain",
          component_statuses: "json",
          started_at: "plain",
          finished_at: "plain",
        },
      ),
  };
}

export interface VerificationUpdate {
  results?: unknown[];
  network_required?: JsonObject | null;
  overall?: string | null;
}

export interface VerificationsRepository {
  create(
    input: {
      id?: string;
      capture_id: string;
      job_id: string;
      scope: JsonObject;
    },
    client?: pg.PoolClient,
  ): Promise<VerificationRecord>;
  /** Scoped to the owning project through capture and build. */
  findById(project_id: string, id: string): Promise<VerificationRecord | null>;
  findByJobId(job_id: string): Promise<VerificationRecord | null>;
  listByCapture(
    capture_id: string,
    page?: PageOptions,
  ): Promise<Page<VerificationRecord>>;
  update(
    id: string,
    patch: VerificationUpdate,
  ): Promise<VerificationRecord | null>;
}

export function verificationsRepository(db: Database): VerificationsRepository {
  return {
    async create(input, client) {
      const result = await executor(db, client).query<VerificationRecord>(
        `INSERT INTO verifications(id, capture_id, job_id, scope)
         VALUES ($1,$2,$3,$4::jsonb) RETURNING *`,
        [
          input.id ?? uuidv7(),
          input.capture_id,
          input.job_id,
          json(input.scope),
        ],
      );
      return result.rows[0] as VerificationRecord;
    },
    async findById(project_id, id) {
      const result = await db.query<VerificationRecord>(
        `SELECT v.* FROM verifications v
         JOIN captures c ON c.id = v.capture_id
         JOIN builds b ON b.id = c.build_id
         WHERE v.id = $1 AND b.project_id = $2`,
        [id, project_id],
      );
      return firstRow(result.rows);
    },
    async findByJobId(job_id) {
      const result = await db.query<VerificationRecord>(
        "SELECT * FROM verifications WHERE job_id = $1",
        [job_id],
      );
      return firstRow(result.rows);
    },
    listByCapture: (capture_id, page = {}) =>
      keysetPage<VerificationRecord>(db, {
        from: "verifications t",
        where: ["t.capture_id = $1"],
        params: [capture_id],
        ...page,
      }),
    update: (id, patch) =>
      patchRow<VerificationRecord>(
        db,
        "verifications",
        id,
        { ...patch },
        {
          results: "json",
          network_required: "json",
          overall: "plain",
        },
      ),
  };
}

export interface ExportUpdate {
  status?: ExportStatus;
  object_key?: string | null;
  sha256?: string | null;
  size?: number | null;
  signature?: JsonObject | null;
  encryption?: JsonObject | null;
}

export interface ExportsRepository {
  create(
    input: { id?: string; capture_id: string; job_id: string },
    client?: pg.PoolClient,
  ): Promise<ExportRecord>;
  /** Scoped to the owning project through capture and build. */
  findById(project_id: string, id: string): Promise<ExportRecord | null>;
  findByJobId(job_id: string): Promise<ExportRecord | null>;
  listByCapture(
    capture_id: string,
    page?: PageOptions,
  ): Promise<Page<ExportRecord>>;
  /** Every export of the build's captures, newest first; optionally one capture's. */
  listByBuild(
    build_id: string,
    page?: PageOptions & { capture_id?: string | undefined },
  ): Promise<Page<ExportRecord>>;
  update(id: string, patch: ExportUpdate): Promise<ExportRecord | null>;
}

export function exportsRepository(db: Database): ExportsRepository {
  return {
    async create(input, client) {
      const result = await executor(db, client).query<ExportRecord>(
        `INSERT INTO exports(id, capture_id, job_id) VALUES ($1,$2,$3) RETURNING *`,
        [input.id ?? uuidv7(), input.capture_id, input.job_id],
      );
      return result.rows[0] as ExportRecord;
    },
    async findById(project_id, id) {
      const result = await db.query<ExportRecord>(
        `SELECT e.* FROM exports e
         JOIN captures c ON c.id = e.capture_id
         JOIN builds b ON b.id = c.build_id
         WHERE e.id = $1 AND b.project_id = $2`,
        [id, project_id],
      );
      return firstRow(result.rows);
    },
    async findByJobId(job_id) {
      const result = await db.query<ExportRecord>(
        "SELECT * FROM exports WHERE job_id = $1",
        [job_id],
      );
      return firstRow(result.rows);
    },
    listByCapture: (capture_id, page = {}) =>
      keysetPage<ExportRecord>(db, {
        from: "exports t",
        where: ["t.capture_id = $1"],
        params: [capture_id],
        ...page,
      }),
    listByBuild: (build_id, { capture_id, ...page } = {}) =>
      keysetPage<ExportRecord>(db, {
        from: "exports t JOIN captures c ON c.id = t.capture_id",
        where:
          capture_id === undefined
            ? ["c.build_id = $1"]
            : ["c.build_id = $1", "t.capture_id = $2"],
        params: capture_id === undefined ? [build_id] : [build_id, capture_id],
        ...page,
      }),
    update: (id, patch) =>
      patchRow<ExportRecord>(
        db,
        "exports",
        id,
        { ...patch },
        {
          status: "plain",
          object_key: "plain",
          sha256: "plain",
          size: "plain",
          signature: "json",
          encryption: "json",
        },
      ),
  };
}
