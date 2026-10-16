#!/usr/bin/env node
import {
  DEFAULT_SECRET_ENV_NAMES,
  redactorFromEnvironment,
} from "@rea-web/contracts";
import { createDatabase, createRepositories, runMigrations } from "@rea-web/db";
import { createObjectStoreFromEnv } from "@rea-web/storage";
import { createApp } from "./app.js";
import { DEFAULT_STORAGE_FS_ROOT, loadConfig } from "./config.js";
import { createLogger } from "./logging.js";
import { startIdempotencyPurge, startReaper } from "./orchestrator/reaper.js";

const main = async (): Promise<void> => {
  const env = process.env;
  const redactor = redactorFromEnvironment(env, DEFAULT_SECRET_ENV_NAMES);
  const logger = createLogger({
    level: env["REA_WEB_LOG_LEVEL"] ?? "info",
    redactor,
  });
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    // The message names variables only; it never contains their values.
    logger.fatal({
      msg: error instanceof Error ? error.message : "invalid configuration",
    });
    process.exitCode = 1;
    return;
  }
  const db = createDatabase({ connectionString: config.databaseUrl });
  const migrated = await runMigrations(db);
  if (migrated.applied.length > 0)
    logger.info({ applied: migrated.applied }, "migrations applied");
  const repos = createRepositories(db);
  const store = createObjectStoreFromEnv({
    REA_WEB_STORAGE_BACKEND: "fs",
    REA_WEB_STORAGE_FS_ROOT: DEFAULT_STORAGE_FS_ROOT,
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([, value]) => value !== undefined && value !== "",
      ),
    ),
  });
  const app = await createApp({ repos, db, store, config, logger });

  const reaper = startReaper(
    repos,
    Math.max(250, Math.floor(config.leaseTtlMs / 4)),
    {
      staleRunnerMs: config.leaseTtlMs * 2,
      logger,
    },
  );
  const purge = startIdempotencyPurge(
    repos,
    config.idempotencyTtlMs,
    60 * 60 * 1000,
    logger,
  );

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    await reaper.stop();
    await purge.stop();
    await app.close();
    await db.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void stop(signal).then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ err: error }, "shutdown failed");
          process.exit(1);
        },
      );
    });

  await app.listen({ host: config.host, port: config.port });
};

main().catch((error: unknown) => {
  // Startup failures can include driver messages; keep them off stderr unredacted.
  const redactor = redactorFromEnvironment(
    process.env,
    DEFAULT_SECRET_ENV_NAMES,
  );
  process.stderr.write(
    `${redactor.redactText(error instanceof Error ? error.message : "startup failed")}\n`,
  );
  process.exitCode = 1;
});
