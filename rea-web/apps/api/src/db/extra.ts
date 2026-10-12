import type { Database } from "@rea-web/db";

/** Transaction client handed out by `Database.withTransaction`. */
export type TxClient = Parameters<
  Parameters<Database["withTransaction"]>[0]
>[0];

/**
 * Queries the repositories do not offer. Each is read-only (or a single
 * lookup) and parameterised; they are listed in the work-package report as
 * candidates for promotion into `@rea-web/db`.
 */

export async function activeLeaseCounts(
  db: Database,
  projectId: string,
): Promise<Map<string, number>> {
  const result = await db.query<{ runner_id: string; n: number }>(
    `SELECT l.runner_id, count(*) AS n
     FROM job_leases l JOIN jobs j ON j.id = l.job_id
     WHERE j.project_id = $1 AND j.state IN ('preparing','running','awaiting_approval')
     GROUP BY l.runner_id`,
    [projectId],
  );
  return new Map(result.rows.map((row) => [row.runner_id, row.n]));
}

export async function activeLeaseCount(
  db: Database,
  runnerId: string,
): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*) AS n FROM job_leases l JOIN jobs j ON j.id = l.job_id
     WHERE l.runner_id = $1 AND j.state IN ('preparing','running','awaiting_approval')`,
    [runnerId],
  );
  return result.rows[0]?.n ?? 0;
}

export async function leasedJobIds(
  db: Database,
  runnerId: string,
): Promise<string[]> {
  const result = await db.query<{ job_id: string }>(
    "SELECT job_id FROM job_leases WHERE runner_id = $1",
    [runnerId],
  );
  return result.rows.map((row) => row.job_id);
}

export async function findRunnerLocalTargetId(
  db: Database,
  projectId: string,
  runnerId: string,
  pathHash: string,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM targets
     WHERE project_id = $1 AND runner_id = $2 AND runner_path_hash = $3 AND kind = 'runner_local'`,
    [projectId, runnerId, pathHash],
  );
  return result.rows[0]?.id ?? null;
}

export interface InvestigationCounts {
  readonly toolCalls: Map<string, number>;
  readonly findings: Map<string, Record<string, number>>;
}

export async function investigationCounts(
  db: Database,
  ids: readonly string[],
): Promise<InvestigationCounts> {
  const toolCalls = new Map<string, number>();
  const findings = new Map<string, Record<string, number>>();
  if (ids.length === 0) return { toolCalls, findings };
  const calls = await db.query<{ investigation_id: string; n: number }>(
    `SELECT investigation_id, count(*) AS n FROM tool_calls
     WHERE investigation_id = ANY($1::uuid[]) GROUP BY investigation_id`,
    [ids],
  );
  for (const row of calls.rows) toolCalls.set(row.investigation_id, row.n);
  const found = await db.query<{
    investigation_id: string;
    class: string;
    n: number;
  }>(
    `SELECT investigation_id, class, count(*) AS n FROM findings
     WHERE investigation_id = ANY($1::uuid[]) GROUP BY investigation_id, class`,
    [ids],
  );
  for (const row of found.rows) {
    const bucket = findings.get(row.investigation_id) ?? {};
    bucket[row.class] = row.n;
    findings.set(row.investigation_id, bucket);
  }
  return { toolCalls, findings };
}

export async function evidenceArtifactOwner(
  db: Database,
  artifactId: string,
): Promise<{ investigation_id: string; project_id: string } | null> {
  const result = await db.query<{
    investigation_id: string;
    project_id: string;
  }>(
    `SELECT a.investigation_id, i.project_id FROM evidence_artifacts a
     JOIN investigations i ON i.id = a.investigation_id WHERE a.id = $1`,
    [artifactId],
  );
  return result.rows[0] ?? null;
}

/** Sum of recorded evidence artifact sizes for an investigation. */
export async function evidenceBytes(
  db: Database,
  investigationId: string,
): Promise<number> {
  const result = await db.query<{ n: number | null }>(
    "SELECT coalesce(sum(size), 0) AS n FROM evidence_artifacts WHERE investigation_id = $1",
    [investigationId],
  );
  return Number(result.rows[0]?.n ?? 0);
}
