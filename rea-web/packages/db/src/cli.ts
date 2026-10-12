import { pathToFileURL } from "node:url";
import { createDatabase } from "./database.js";
import { runMigrations } from "./migrate.js";

const USAGE = "usage: db-cli migrate   (requires REA_WEB_DATABASE_URL)\n";

/**
 * Argument parsing only; no shell. Returns the process exit code. The
 * connection string is read from the environment and never printed.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  out: { write(text: string): unknown } = process.stdout,
  errOut: { write(text: string): unknown } = process.stderr,
): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "migrate" || rest.length > 0) {
    errOut.write(USAGE);
    return 2;
  }
  const connectionString = env["REA_WEB_DATABASE_URL"];
  if (connectionString === undefined || connectionString === "") {
    errOut.write("REA_WEB_DATABASE_URL is not set\n");
    return 2;
  }
  const db = createDatabase({ connectionString, max: 2 });
  try {
    const result = await runMigrations(db);
    out.write(
      `migrations applied: ${result.applied.length === 0 ? "none" : result.applied.join(", ")}; already applied: ${result.alreadyApplied.length}\n`,
    );
    return 0;
  } catch (error) {
    // Driver errors can echo connection details; report the message only.
    const message = error instanceof Error ? error.message : "unknown error";
    errOut.write(`migration failed: ${message}\n`);
    return 1;
  } finally {
    await db.close();
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
