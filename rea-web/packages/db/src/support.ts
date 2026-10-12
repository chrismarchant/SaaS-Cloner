import { ApiError } from "@rea-web/contracts";
import type pg from "pg";
import type { Database, Queryable } from "./database.js";

/** Serialises a value for a `$n::jsonb` parameter (arrays must not reach the driver raw). */
export const json = (value: unknown): string => JSON.stringify(value ?? null);

export const toIso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : value;

/** The caller's transaction client when supplied, otherwise the pool. */
export const executor = (db: Database, client?: pg.PoolClient): Queryable =>
  client ?? db;

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";

export const pgErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

/** Rewrites a unique-constraint violation as a typed `conflict`; rethrows anything else. */
export async function conflictOnUnique<T>(
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      throw new ApiError("conflict", message);
    }
    throw error;
  }
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, or null when the listing is exhausted. */
  next_cursor: string | null;
}

export interface PageOptions {
  cursor?: string | undefined;
  limit?: number | undefined;
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

export const clampLimit = (limit: number | undefined, max = MAX_PAGE_LIMIT) =>
  Math.max(1, Math.min(Math.trunc(limit ?? DEFAULT_PAGE_LIMIT), max));

/** Cursors are base64url of `part|part`; parts never contain `|`. */
export const encodeCursor = (parts: Array<string | number>): string =>
  Buffer.from(parts.join("|"), "utf8").toString("base64url");

export function decodeCursor(cursor: string, expected: number): string[] {
  const parts = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (parts.length !== expected || parts.some((p) => p.length === 0)) {
    throw new ApiError("validation_failed", "invalid cursor");
  }
  return parts;
}

export interface KeysetQuery {
  /** `FROM` clause with the primary table aliased as `t` (exposing `t.created_at`, `t.id`). */
  from: string;
  /** Conditions over the aliased tables; placeholders `$1..$n` index into `params`. */
  where?: string[];
  params?: unknown[];
  columns?: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}

/**
 * Newest-first keyset pagination on `(created_at, id)`. Timestamps are compared
 * at millisecond precision because that is what cursors (ISO strings) carry.
 */
export async function keysetPage<R extends { created_at: string; id: string }>(
  run: Queryable,
  q: KeysetQuery,
): Promise<Page<R>> {
  const limit = clampLimit(q.limit);
  const params = [...(q.params ?? [])];
  const where = [...(q.where ?? [])];
  if (q.cursor !== undefined) {
    const [createdAt, id] = decodeCursor(q.cursor, 2) as [string, string];
    if (Number.isNaN(Date.parse(createdAt))) {
      throw new ApiError("validation_failed", "invalid cursor");
    }
    params.push(createdAt, id);
    where.push(
      `(date_trunc('milliseconds', t.created_at), t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }
  params.push(limit + 1);
  const sql = `SELECT ${q.columns ?? "t.*"} FROM ${q.from}
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY date_trunc('milliseconds', t.created_at) DESC, t.id DESC
    LIMIT $${params.length}`;
  const result = await run.query<R>(sql, params).catch((error: unknown) => {
    if (q.cursor !== undefined && pgErrorCode(error) === "22P02") {
      throw new ApiError("validation_failed", "invalid cursor");
    }
    throw error;
  });
  const items = result.rows.slice(0, limit);
  const last = items[items.length - 1];
  const hasMore = result.rows.length > limit && last !== undefined;
  return {
    items,
    next_cursor: hasMore ? encodeCursor([last.created_at, last.id]) : null,
  };
}

export type ColumnKind = "plain" | "json";

/**
 * Builds and runs `UPDATE table SET ... WHERE id = $1 RETURNING *` for the
 * columns present (not `undefined`) in `patch`. Only whitelisted columns are
 * ever interpolated into SQL.
 */
export async function patchRow<R extends pg.QueryResultRow>(
  run: Queryable,
  table: string,
  id: string,
  patch: Record<string, unknown>,
  columns: Record<string, ColumnKind>,
): Promise<R | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [name, kind] of Object.entries(columns)) {
    const value = patch[name];
    if (value === undefined) continue;
    // SQL NULL, not JSON null, for an explicit null.
    params.push(kind === "json" && value !== null ? json(value) : value);
    sets.push(`${name} = $${params.length}${kind === "json" ? "::jsonb" : ""}`);
  }
  if (sets.length === 0) {
    const current = await run.query<R>(`SELECT * FROM ${table} WHERE id = $1`, [
      id,
    ]);
    return current.rows[0] ?? null;
  }
  const result = await run.query<R>(
    `UPDATE ${table} SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
    params,
  );
  return result.rows[0] ?? null;
}

export const firstRow = <R>(rows: R[]): R | null => rows[0] ?? null;
