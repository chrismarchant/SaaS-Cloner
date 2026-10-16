import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./database.js";

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export interface MigrationOptions {
  directory?: string;
}

/** Arbitrary constant namespacing the migration advisory lock. */
const MIGRATION_LOCK_KEY = 7_283_614_021;

export const defaultMigrationsDirectory = (): string =>
  fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Applies `*.sql` files in name order, each in its own transaction, recording
 * the version in `schema_migrations`. A session-level advisory lock held on a
 * dedicated connection serialises concurrent runners, so each migration is
 * applied exactly once.
 */
export async function runMigrations(
  db: Database,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const directory = options.directory ?? defaultMigrationsDirectory();
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  const client = await db.pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      const known = await client.query<{ present: boolean }>(
        "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
      );
      const appliedVersions = new Set<string>();
      if (known.rows[0]?.present === true) {
        const rows = await client.query<{ version: string }>(
          "SELECT version FROM schema_migrations",
        );
        for (const row of rows.rows) appliedVersions.add(row.version);
      }

      for (const file of files) {
        const version = path.basename(file, ".sql");
        if (appliedVersions.has(version)) {
          result.alreadyApplied.push(version);
          continue;
        }
        const sql = await readFile(path.join(directory, file), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING",
            [version],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
        result.applied.push(version);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } catch (error) {
    // After a failed unlock/rollback the session state is unknown; drop it.
    broken = error instanceof Error ? error : new Error("migration failed");
    throw error;
  } finally {
    client.release(broken);
  }
  return result;
}
