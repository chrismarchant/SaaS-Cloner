import { randomBytes } from "node:crypto";
import { describe } from "vitest";
import pg from "pg";
import {
  type Database,
  type Repositories,
  createDatabase,
  createRepositories,
  runMigrations,
} from "../src/index.js";

export const TEST_DATABASE_URL = process.env["REA_WEB_TEST_DATABASE_URL"];

if (TEST_DATABASE_URL === undefined) {
  console.warn(
    "REA_WEB_TEST_DATABASE_URL is not set: PostgreSQL-backed db tests are skipped.",
  );
}

/** `describe` that is skipped (with the warning above) when no test server is configured. */
export const describeDb = TEST_DATABASE_URL === undefined ? describe.skip : describe;

export interface TestDatabase {
  name: string;
  url: string;
  db: Database;
  repos: Repositories;
  /** Opens an independent pool (separate connections) on the same database. */
  open(max?: number): Database;
  drop(): Promise<void>;
}

const withDatabaseName = (base: string, name: string): string => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
};

/** Creates a uniquely named database, optionally migrated. Call `drop()` in `afterAll`. */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  if (TEST_DATABASE_URL === undefined) {
    throw new Error("REA_WEB_TEST_DATABASE_URL is not set");
  }
  const name = `rea_web_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = withDatabaseName(TEST_DATABASE_URL, name);
  const opened: Database[] = [];
  const open = (max = 10): Database => {
    const database = createDatabase({ connectionString: url, max });
    opened.push(database);
    return database;
  };
  const db = open();
  if (options.migrate !== false) await runMigrations(db);
  return {
    name,
    url,
    db,
    repos: createRepositories(db),
    open,
    async drop() {
      await Promise.all(opened.map((database) => database.close()));
      const cleanup = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
