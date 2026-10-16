import pg from "pg";

/** Anything that can run a parameterised query: the pool or a checked-out client. */
export interface Queryable {
  query<T extends pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

export interface Database extends Queryable {
  pool: pg.Pool;
  withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface CreateDatabaseOptions {
  connectionString: string;
  max?: number;
}

const OID_TIMESTAMPTZ = 1184;
const OID_INT8 = 20;

/**
 * Type parsing owned here so repositories never reinterpret raw driver values:
 * timestamptz -> ISO-8601 string, int8 -> number (all bigint columns in the
 * schema are counters, sizes or sequences far below 2^53). JSONB is already
 * parsed by the driver.
 */
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === OID_TIMESTAMPTZ) {
      const base = pg.types.getTypeParser(oid, "text") as (
        value: string,
      ) => Date | null;
      return (value: string): string | null => {
        const date = base(value);
        return date === null ? null : date.toISOString();
      };
    }
    if (oid === OID_INT8) return (value: string): number => Number(value);
    return pg.types.getTypeParser(oid, format as "text");
  },
};

export function createDatabase(options: CreateDatabaseOptions): Database {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    types,
  });
  // An idle client that loses its connection emits 'error' on the pool; without
  // a listener that would crash the process. The failure surfaces on next use.
  pool.on("error", () => undefined);

  let closed = false;

  const query = <T extends pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>> => pool.query<T>(text, params);

  const withTransaction = async <T>(
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    let destroy: Error | undefined;
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // The connection is in an unknown state; do not return it to the pool.
        destroy =
          rollbackError instanceof Error
            ? rollbackError
            : new Error("rollback failed");
      }
      throw error;
    } finally {
      client.release(destroy);
    }
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await pool.end();
  };

  return { pool, query, withTransaction, close };
}
