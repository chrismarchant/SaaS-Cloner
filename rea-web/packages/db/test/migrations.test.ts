import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runMigrations } from "../src/index.js";
import {
  type TestDatabase,
  createTestDatabase,
  describeDb,
} from "./testDatabase.js";

describeDb("migrations", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase({ migrate: false });
  });
  afterAll(async () => {
    await t.drop();
  });

  it("applies once concurrently on a fresh database, then is idempotent", async () => {
    // Two independent pools race for the same migration.
    const a = t.open(2);
    const b = t.open(2);
    const [first, second] = await Promise.all([
      runMigrations(a),
      runMigrations(b),
    ]);

    const applied = [...first.applied, ...second.applied];
    expect(applied).toEqual(["0001_initial"]);
    const alreadyApplied = [...first.alreadyApplied, ...second.alreadyApplied];
    expect(alreadyApplied).toEqual(["0001_initial"]);

    const versions = await t.db.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(versions.rows.map((r) => r.version)).toEqual(["0001_initial"]);
    const tables = await t.db.query<{ n: number }>(
      "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'jobs'",
    );
    expect(tables.rows[0]?.n).toBe(1);

    const again = await runMigrations(t.db);
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toEqual(["0001_initial"]);
  });

  it("applies new files in name order, each in its own transaction", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rea-web-mig-"));
    try {
      await writeFile(
        path.join(dir, "0002_b.sql"),
        "CREATE TABLE mig_b (id int);",
      );
      await writeFile(path.join(dir, "0001_initial.sql"), "SELECT 1;");
      await writeFile(
        path.join(dir, "0003_bad.sql"),
        "CREATE TABLE mig_c (id int); SELECT nope();",
      );
      await writeFile(path.join(dir, "notes.txt"), "ignored");

      await expect(runMigrations(t.db, { directory: dir })).rejects.toThrow();
      // 0002 committed before the failing 0003, which rolled back entirely.
      const recorded = await t.db.query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(recorded.rows.map((r) => r.version)).toEqual([
        "0001_initial",
        "0002_b",
      ]);
      const created = await t.db.query<{ name: string | null }>(
        "SELECT to_regclass('mig_c') AS name",
      );
      expect(created.rows[0]?.name).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
