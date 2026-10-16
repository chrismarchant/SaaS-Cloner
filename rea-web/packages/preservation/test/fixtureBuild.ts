import { createHash, randomBytes } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  DEFAULT_SECRET_ENV_NAMES,
  redactorFromEnvironment,
} from "@rea-web/contracts";
import { describe } from "vitest";
import { parsePgUrl } from "../src/collectors/data.js";
import {
  type BuildDefinition,
  type CollectorContext,
  type CommandResult,
  runCommand,
} from "../src/index.js";

const APP_DIR = fileURLToPath(
  new URL("../../../fixtures/preservation/app/", import.meta.url),
);
const DOT_RENAMES: Record<string, string> = {
  gitignore: ".gitignore",
  npmrc: ".npmrc",
  nvmrc: ".nvmrc",
  "env.example": ".env.example",
};

export const SECRET_MARKER = "sk_live_fixture_should_never_appear";
export const DB_ENV_NAME = "FIXTURE_DATABASE_URL";
export const NOW = "2026-03-01T12:00:00.000Z";

export interface FixtureBuild {
  repoPath: string;
  assetsPath: string;
  databaseUrl: string;
  cleanup: () => Promise<void>;
  /** Extras for tests and for the later verifier package. */
  root: string;
  adminDatabaseUrl: string;
  databaseName: string;
  databasePassword: string;
  secretMarker: string;
  submoduleSha: string;
  headSha: string;
  lfsWorks: boolean;
  lfsOid: string | null;
  /** A fresh empty database for restore tests; dropped by cleanup. */
  createScratchDatabase: () => Promise<{ url: string; name: string }>;
  expected: {
    noteCount: number;
    modifiedFile: string;
    untrackedFile: string;
    untrackedBytes: Buffer;
  };
}

const sh = async (
  argv: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<CommandResult> => {
  const r = await runCommand(argv, {
    cwd,
    timeoutMs: 60_000,
    env: {
      HOME: process.env["HOME"] ?? "/root",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      GIT_TERMINAL_PROMPT: "0",
      ...env,
    },
  });
  if (r.exitCode !== 0)
    throw new Error(`${argv.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r;
};

const git = (cwd: string, ...args: string[]): Promise<CommandResult> =>
  sh(
    [
      "git",
      "-c",
      "protocol.file.allow=always",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    cwd,
  );

export const sha256Hex = (text: string | Buffer): string =>
  createHash("sha256").update(text).digest("hex");

const psql = (url: string, sql: string): Promise<CommandResult> => {
  const conn = parsePgUrl(url);
  if ("error" in conn) throw new Error(conn.error);
  return sh(
    ["psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
    process.cwd(),
    { ...conn.env, PGOPTIONS: "" },
  );
};

const withDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

export const HAS_DATABASE =
  (process.env["REA_WEB_TEST_DATABASE_URL"] ?? "") !== "";
if (!HAS_DATABASE)
  console.warn(
    "REA_WEB_TEST_DATABASE_URL is not set: PostgreSQL-backed preservation tests are skipped.",
  );

/** `describe` that is skipped (with the warning above) when no test server is configured. */
export const describeDb: (name: string, fn: () => void) => void = HAS_DATABASE
  ? describe
  : describe.skip;

export const adminUrl = (): string => {
  const url = process.env["REA_WEB_TEST_DATABASE_URL"];
  if (url === undefined || url === "")
    throw new Error(
      "REA_WEB_TEST_DATABASE_URL must be set for the preservation tests",
    );
  return url;
};

const write = async (
  root: string,
  rel: string,
  content: string | Buffer,
): Promise<void> => {
  const abs = join(root, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
};

async function createRepo(root: string): Promise<{
  repoPath: string;
  submoduleSha: string;
  headSha: string;
  lfsWorks: boolean;
  lfsOid: string | null;
  untrackedBytes: Buffer;
}> {
  const sub = join(root, "sub-lib");
  await mkdir(sub, { recursive: true });
  await git(sub, "init", "-q");
  await write(sub, "lib.js", "module.exports = () => 'fixture-lib';\n");
  await git(sub, "add", "-A");
  await git(sub, "commit", "-q", "-m", "lib: initial");
  const submoduleSha = (await git(sub, "rev-parse", "HEAD")).stdout.trim();

  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q");
  await cp(APP_DIR, repo, { recursive: true });
  for (const [from, to] of Object.entries(DOT_RENAMES))
    await rename(join(repo, from), join(repo, to));
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "feat: initial app");

  await write(
    repo,
    "README.md",
    "# Fixture app\n\nCaptured by the preservation tests.\n",
  );
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "docs: readme");
  await git(repo, "tag", "-a", "v1.0.0", "-m", "release 1.0.0");

  // Git LFS: only if it works fully offline with a file-based setup.
  let lfsWorks = false;
  let lfsOid: string | null = null;
  const install = await runCommand(["git", "lfs", "install", "--local"], {
    cwd: repo,
    env: { HOME: process.env["HOME"] ?? "/root" },
  });
  if (install.exitCode === 0) {
    await git(repo, "lfs", "track", "*.model");
    const payload = randomBytes(4096);
    lfsOid = sha256Hex(payload);
    await write(repo, "assets/net.model", payload);
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "feat: add LFS model");
    const listed = await runCommand(["git", "lfs", "ls-files", "--long"], {
      cwd: repo,
      env: { HOME: process.env["HOME"] ?? "/root" },
    });
    lfsWorks = listed.exitCode === 0 && listed.stdout.includes(lfsOid);
  }

  await git(repo, "checkout", "-q", "-b", "feature/search");
  await write(repo, "src/search.js", "exports.search = (q) => q;\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "feat: search");
  await git(repo, "checkout", "-q", "main");

  await git(repo, "submodule", "add", "-q", sub, "vendor/lib");
  await git(repo, "commit", "-q", "-m", "chore: add vendor/lib submodule");
  const headSha = (await git(repo, "rev-parse", "HEAD")).stdout.trim();

  // Uncommitted state: a modification, an untracked text file, an untracked
  // binary, and an ignored .env holding a fake secret.
  const routes = await readFile(join(repo, "src/routes.js"), "utf8");
  await write(
    repo,
    "src/routes.js",
    `${routes}router.delete('/api/notes/:id', (req, res) => res.status(204).end());\n`,
  );
  await write(repo, "notes/todo.txt", "remember to rotate keys\n");
  const untrackedBytes = randomBytes(2048);
  await write(repo, "scratch.dat", untrackedBytes);
  await write(
    repo,
    ".env",
    `STRIPE_SECRET_KEY=${SECRET_MARKER}\nDATABASE_URL=postgres://nobody:${SECRET_MARKER}@db.internal/app\n`,
  );
  return {
    repoPath: repo,
    submoduleSha,
    headSha,
    lfsWorks,
    lfsOid,
    untrackedBytes,
  };
}

async function createDatabase(
  adminDatabaseUrl: string,
): Promise<{ name: string; role: string; password: string; url: string }> {
  const suffix = randomBytes(5).toString("hex");
  const name = `fx_pres_${suffix}`;
  const role = `fx_role_${suffix}`;
  const password = `fxpw_${randomBytes(12).toString("hex")}`;
  await psql(
    adminDatabaseUrl,
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}'`,
  );
  await psql(adminDatabaseUrl, `CREATE DATABASE ${name} OWNER ${role}`);
  const u = new URL(withDatabase(adminDatabaseUrl, name));
  u.username = role;
  u.password = password;
  const url = u.toString();
  await psql(
    url,
    [
      "CREATE TABLE accounts (id serial PRIMARY KEY, email text UNIQUE NOT NULL)",
      "CREATE TABLE notes (id serial PRIMARY KEY, account_id integer NOT NULL REFERENCES accounts(id), body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())",
      "CREATE VIEW note_counts AS SELECT account_id, count(*) AS notes FROM notes GROUP BY account_id",
      "INSERT INTO accounts (email) VALUES ('ada@example.com'), ('grace@example.com')",
      "INSERT INTO notes (account_id, body) VALUES (1, 'first'), (1, 'second'), (2, 'third')",
    ].join("; "),
  );
  return { name, role, password, url };
}

async function createAssets(root: string): Promise<string> {
  const dir = join(root, "assets-src");
  await write(dir, "uploads/2026/avatar.png", randomBytes(1500));
  await write(
    dir,
    "uploads/2026/report.pdf",
    Buffer.from("%PDF-1.4 fixture\n"),
  );
  await write(dir, "uploads/readme.txt", "user uploads\n");
  await write(dir, "top.csv", "a,b\n1,2\n");
  await symlink("/etc/hostname", join(dir, "uploads", "escape-link"));
  return dir;
}

export async function createFixtureBuild(
  root: string,
  options: { adminDatabaseUrl?: string } = {},
): Promise<FixtureBuild> {
  const adminDatabaseUrl = options.adminDatabaseUrl ?? adminUrl();
  await mkdir(root, { recursive: true });
  const repo = await createRepo(root);
  const assetsPath = await createAssets(root);
  const db = await createDatabase(adminDatabaseUrl);
  const scratch: string[] = [];
  return {
    repoPath: repo.repoPath,
    assetsPath,
    databaseUrl: db.url,
    root,
    adminDatabaseUrl,
    databaseName: db.name,
    databasePassword: db.password,
    secretMarker: SECRET_MARKER,
    submoduleSha: repo.submoduleSha,
    headSha: repo.headSha,
    lfsWorks: repo.lfsWorks,
    lfsOid: repo.lfsOid,
    expected: {
      noteCount: 3,
      modifiedFile: "src/routes.js",
      untrackedFile: "notes/todo.txt",
      untrackedBytes: repo.untrackedBytes,
    },
    createScratchDatabase: async () => {
      const name = `fx_pres_restore_${randomBytes(5).toString("hex")}`;
      await psql(adminDatabaseUrl, `CREATE DATABASE ${name}`);
      scratch.push(name);
      return { name, url: withDatabase(adminDatabaseUrl, name) };
    },
    cleanup: async () => {
      for (const name of [db.name, ...scratch])
        await psql(
          adminDatabaseUrl,
          `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`,
        ).catch(() => undefined);
      await psql(adminDatabaseUrl, `DROP ROLE IF EXISTS ${db.role}`).catch(
        () => undefined,
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

export interface TestContext {
  ctx: CollectorContext;
  logs: {
    level: string;
    message: string;
    fields: Record<string, unknown> | undefined;
  }[];
  controller: AbortController;
}

export const makeContext = (
  workspace: string,
  fixture: FixtureBuild,
  extra: {
    env?: Record<string, string | undefined>;
    localPaths?: Map<string, string>;
  } = {},
): TestContext => {
  const env = { [DB_ENV_NAME]: fixture.databaseUrl, ...extra.env };
  const logs: TestContext["logs"] = [];
  const controller = new AbortController();
  return {
    controller,
    logs,
    ctx: {
      workspace,
      env,
      signal: controller.signal,
      log: (level, message, fields) => logs.push({ level, message, fields }),
      redactor: redactorFromEnvironment(env, [
        ...DEFAULT_SECRET_ENV_NAMES,
        DB_ENV_NAME,
      ]),
      localPaths:
        extra.localPaths ??
        new Map([
          [sha256Hex(fixture.repoPath), fixture.repoPath],
          [sha256Hex(fixture.assetsPath), fixture.assetsPath],
        ]),
      now: () => new Date(),
    },
  };
};

export const RUNNER_ID = "0194f1e0-0000-7000-8000-000000000001";

export const fullBuild = (fixture: FixtureBuild): BuildDefinition => ({
  id: "build-fixture",
  name: "Fixture Build",
  description: "Preservation fixture",
  project_slug: "fixture",
  source: {
    kind: "runner_local",
    runner_id: RUNNER_ID,
    path_hash: sha256Hex(fixture.repoPath),
    include_working_tree: true,
    include_lfs: true,
    include_submodules: true,
  },
  components: [
    { kind: "source", id: "main" },
    {
      kind: "dependencies",
      id: "deps",
      lockfiles: [],
      container_images: ["redis:7"],
    },
    {
      kind: "data",
      id: "db",
      engine: "postgresql",
      connection_env_name: DB_ENV_NAME,
      invariants: [
        { id: "notes-count", sql: "select count(*) from notes", expect: 3 },
      ],
    },
    {
      kind: "assets",
      id: "uploads",
      source: {
        kind: "runner_local",
        runner_id: RUNNER_ID,
        path_hash: sha256Hex(fixture.assetsPath),
      },
    },
    {
      kind: "infrastructure",
      id: "infra",
      descriptor: {
        services: [
          {
            name: "web",
            kind: "web",
            build_command: ["node", "build.mjs"],
            start_command: ["node", "server.js"],
            health_check: { path: "/health" },
            region: "us-east-1",
            volumes: [],
            depends_on: [],
          },
        ],
        schedules: [
          {
            name: "nightly-cleanup",
            cron: "0 3 * * *",
            command: ["node", "jobs/cleanup.js"],
          },
        ],
        domains: ["app.example.com"],
        env_names: ["PORT"],
        secret_refs: [{ name: "STRIPE_SECRET_KEY", store: "railway" }],
        behavior_checks: [
          {
            id: "build-output",
            title: "Build output exists",
            run: [
              "node",
              "-e",
              "process.exit(require('fs').existsSync('dist/out.txt') ? 0 : 1)",
            ],
            cwd: "source",
            expect_exit: 0,
            timeout_ms: 30000,
          },
        ],
      },
    },
    {
      kind: "integrations",
      id: "integ",
      descriptor: {
        providers: [
          {
            name: "Stripe",
            api_version: "2024-06-20",
            scopes: ["read_write"],
            webhooks: [
              {
                url: "https://app.example.com/webhooks/stripe?whsec=query_secret_value",
                events: ["invoice.paid"],
              },
            ],
            callbacks: [],
            account_owner: "billing@example.com",
            manual_steps: ["Create a test-mode webhook endpoint"],
          },
        ],
      },
    },
    {
      kind: "product",
      id: "prd",
      source_component_id: "main",
      name: "Fixture App",
      rea_target_ids: [],
    },
    {
      kind: "artifacts",
      id: "evidence",
      investigation_ids: ["0194f1e0-0000-7000-8000-0000000000aa"],
    },
  ],
});

export interface RestoreVars {
  target: string;
  packageRoot: string;
  databaseUrl?: string;
  assetsRoot?: string;
}

const fill = (text: string, v: RestoreVars): string =>
  text
    .split("{{package_root}}")
    .join(v.packageRoot)
    .split("{{target}}")
    .join(v.target)
    .split("{{database_url}}")
    .join(v.databaseUrl ?? "")
    .split("{{assets_root}}")
    .join(v.assetsRoot ?? "");

/**
 * Execute a component's restore steps exactly as a verifier would: argument
 * arrays only, placeholders substituted, no shell. Throws on the first failure.
 */
export async function runRestoreSteps(
  steps: readonly {
    id: string;
    run: string[];
    cwd?: string | undefined;
    scope: string;
  }[],
  vars: RestoreVars,
  options: { only?: (step: { id: string; scope: string }) => boolean } = {},
): Promise<{ id: string; result: CommandResult }[]> {
  const done: { id: string; result: CommandResult }[] = [];
  for (const step of steps) {
    if (options.only !== undefined && !options.only(step)) continue;
    const argv = step.run.map((a) => fill(a, vars));
    const cwd = step.cwd === undefined ? vars.target : fill(step.cwd, vars);
    const result = await runCommand(argv, {
      cwd,
      timeoutMs: 120_000,
      env: {
        HOME: process.env["HOME"] ?? "/root",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
    });
    if (result.exitCode !== 0)
      throw new Error(
        `restore step ${step.id} failed: ${result.stderr || result.stdout}`,
      );
    done.push({ id: step.id, result });
  }
  return done;
}

export const queryScalar = async (url: string, sql: string): Promise<string> =>
  (await psql(url, sql)).stdout.trim();
