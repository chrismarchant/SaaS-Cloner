import { stat } from "node:fs/promises";
import { join } from "node:path";
import { succeeded } from "../exec.js";
import {
  type CaptureRuntime,
  type CollectorOutcome,
  type Runtime,
  blockedOutcome,
  emptyOutcome,
} from "../runtime.js";
import {
  type CommandResult,
  type ComponentDeclaration,
  type ComponentPlan,
  type Omission,
  componentId,
} from "../types.js";
import { isLoopbackHost, jsonText, stepOf, writeStaged } from "../util.js";

type DataDecl = Extract<ComponentDeclaration, { kind: "data" }>;
type Invariant = DataDecl["invariants"][number];

export interface PgConnection {
  /** Environment for libpq clients; contains the password. Never log it. */
  env: Record<string, string>;
  host: string;
  database: string;
  password: string;
  user: string;
}

const SSL_PARAMS: Record<string, string> = {
  sslmode: "PGSSLMODE",
  sslrootcert: "PGSSLROOTCERT",
  sslcert: "PGSSLCERT",
  sslkey: "PGSSLKEY",
};

/** Parse a postgres URL into libpq environment variables (credentials never reach argv). */
export const parsePgUrl = (raw: string): PgConnection | { error: string } => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "value is not a URL" };
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    return { error: `unsupported scheme ${url.protocol.replace(":", "")}` };
  const socketDir = url.searchParams.get("host");
  const host = socketDir ?? url.hostname.replace(/^\[|\]$/gu, "");
  const database =
    decodeURIComponent(url.pathname.replace(/^\//u, "")) || "postgres";
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const env: Record<string, string> = {
    PGDATABASE: database,
    PGCONNECT_TIMEOUT: "20",
    PGAPPNAME: "rea-web-preservation",
    PGOPTIONS: "-c default_transaction_read_only=on",
    LC_ALL: "C",
  };
  if (host !== "") env["PGHOST"] = host;
  if (url.port !== "") env["PGPORT"] = url.port;
  if (user !== "") env["PGUSER"] = user;
  if (password !== "") env["PGPASSWORD"] = password;
  for (const [param, name] of Object.entries(SSL_PARAMS)) {
    const v = url.searchParams.get(param);
    if (v !== null) env[name] = v;
  }
  for (const name of ["PATH", "HOME"]) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  return { env, host, database, password, user };
};

const conninfoQuote = (value: string): string =>
  `'${value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'`;

const META_SQL = `SELECT json_build_object(
  'server_version', current_setting('server_version'),
  'database', current_database(),
  'size_bytes', pg_database_size(current_database()),
  'extensions', (SELECT coalesce(json_agg(json_build_object('name', extname, 'version', extversion) ORDER BY extname), '[]'::json) FROM pg_extension),
  'tables', (SELECT coalesce(json_agg(json_build_object('schema', schemaname, 'table', relname, 'estimated_rows', n_live_tup) ORDER BY schemaname, relname), '[]'::json) FROM pg_stat_user_tables)
)`;

const READ_ONLY_START = /^\s*(select|with|values|show|table)\b/iu;

const supabaseGaps = (
  decl: DataDecl,
  rt: Runtime,
  sourceHasFunctions: boolean,
): {
  manual: NonNullable<CollectorOutcome["manual"]>;
  omissions: Omission[];
} => {
  const cid = componentId(decl);
  const storage = rt.build.components.find(
    (c) => c.kind === "assets" && c.source.kind === "supabase_storage",
  );
  const items = [
    {
      key: "auth",
      title: "Supabase Auth configuration",
      reason:
        "Auth settings (providers, redirect URLs, email templates, JWT settings, SMTP) are platform configuration, not database content. The database dump contains only the auth schema rows the capture role could read.",
      instructions:
        "Export the Auth configuration from the Supabase dashboard (Authentication > Providers, URL configuration, Email templates) or with the Supabase CLI, and record the JWT secret rotation plan. Recreate it in the restore project.",
    },
    {
      key: "storage",
      title: "Supabase Storage objects",
      reason:
        storage === undefined
          ? "Storage object payloads live outside the database; the dump holds only the storage.objects metadata rows."
          : `Storage payloads are captured by the assets component ${componentId(storage)} through the Storage S3 endpoint; check its status, because bucket settings and policies are not captured.`,
      instructions:
        "Download every bucket's objects (for example with the Supabase CLI or an S3-compatible client against the project's Storage S3 endpoint) and re-upload them after restore. Compare against the storage.objects rows in the dump.",
    },
    {
      key: "edge-functions",
      title: "Supabase Edge Functions",
      reason: sourceHasFunctions
        ? "Edge Function source appears in the captured git source (supabase/functions); the deployed versions and their secrets are not captured."
        : "Edge Function source is not part of the captured git source, and deployed functions cannot be exported by the database collector.",
      instructions:
        "Keep supabase/functions in the repository and redeploy with 'supabase functions deploy'. Record function secret NAMES; recreate the values with 'supabase secrets set'.",
    },
    {
      key: "platform-settings",
      title: "Supabase platform settings",
      reason:
        "Project settings (region, compute size, network restrictions, extensions enabled in the dashboard, realtime and API settings) are not in the database dump.",
      instructions:
        "Record the settings from the dashboard or the Management API and recreate them on the restore project.",
    },
    {
      key: "oauth",
      title: "External OAuth provider configuration",
      reason:
        "OAuth client IDs, secrets and redirect URIs are registered with each external provider (Google, GitHub, ...) and are not stored in this package.",
      instructions:
        "In each provider's console, create a new OAuth app for the restore environment and register the restore project's callback URL. Never reuse production client secrets in a disposable restore.",
    },
  ];
  return {
    manual: items.map((i) => ({
      id: `${cid}:supabase-${i.key}`,
      title: i.title,
      reason: i.reason,
      instructions: i.instructions,
      component_id: cid,
    })),
    omissions: items.map((i) => ({
      what: i.title,
      reason: i.reason,
      remediation: i.instructions,
    })),
  };
};

export async function plan(
  decl: DataDecl,
  rt: Runtime,
): Promise<ComponentPlan> {
  const out: ComponentPlan = {
    id: componentId(decl),
    kind: "data",
    collector: decl.engine,
    permissions: [],
    estimated_bytes: null,
    dependencies: [],
    method: "pg_dump -Fc (single snapshot)",
    omissions: [],
    feasible: false,
  };
  if (decl.engine === "supabase")
    out.omissions.push(...supabaseGaps(decl, rt, false).omissions);
  const raw = rt.ctx.env[decl.connection_env_name];
  out.permissions.push({
    check: `connection string in ${decl.connection_env_name}`,
    ok: raw !== undefined && raw !== "",
    detail:
      raw === undefined || raw === ""
        ? `environment variable ${decl.connection_env_name} is not set for the runner`
        : "present (value not logged)",
  });
  const tool = await rt.run(["pg_dump", "--version"], { timeoutMs: 15_000 });
  out.permissions.push({
    check: "pg_dump available",
    ok: succeeded(tool),
    detail: succeeded(tool)
      ? tool.stdout.trim()
      : "pg_dump not found on the runner PATH",
  });
  if (raw === undefined || raw === "") return out;
  const conn = parsePgUrl(raw);
  if ("error" in conn) {
    out.permissions.push({
      check: "connection string parses",
      ok: false,
      detail: conn.error,
    });
    return out;
  }
  const q = await rt.run(
    [
      "psql",
      "-X",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "select pg_database_size(current_database())",
    ],
    { env: conn.env, timeoutMs: 30_000 },
  );
  const ok = succeeded(q);
  out.permissions.push({
    check: "database reachable (select 1)",
    ok,
    detail: ok ? "connected" : rt.failure(q),
  });
  if (ok) out.estimated_bytes = Number(q.stdout.trim()) || null;
  const privileges = ok
    ? await rt.run(
        [
          "psql",
          "-X",
          "-A",
          "-t",
          "-c",
          "select has_database_privilege(current_database(), 'CONNECT')",
        ],
        { env: conn.env, timeoutMs: 30_000 },
      )
    : null;
  if (privileges !== null)
    out.permissions.push({
      check: "CONNECT privilege",
      ok: privileges.stdout.trim() === "t",
      detail:
        privileges.stdout.trim() === "t"
          ? "granted"
          : "the capture role lacks CONNECT",
    });
  out.omissions.push({
    what: "Cluster roles and passwords",
    reason:
      "Role definitions are attempted without passwords (pg_dumpall --roles-only --no-role-passwords); managed databases usually refuse this.",
    remediation:
      "Recreate application roles from the restore documentation if roles.sql is absent.",
  });
  out.feasible = out.permissions.every((p) => p.ok);
  return out;
}

interface InvariantRecord {
  id: string;
  sql: string;
  expected_at_capture: string | null;
  declared_expect: Invariant["expect"] | null;
  matches_declared: boolean | null;
  stable_during_capture: boolean | null;
  error?: string;
}

const matchesDeclared = (
  expect: Invariant["expect"],
  observed: string | null,
): boolean | null => {
  if (expect === undefined || observed === null) return null;
  if (expect === null) return observed === "";
  if (typeof expect === "boolean")
    return observed === (expect ? "t" : "f") || observed === String(expect);
  return observed === String(expect);
};

async function runInvariant(
  rt: Runtime,
  conn: PgConnection,
  inv: Invariant,
): Promise<{ value: string | null; error?: string }> {
  const sql = inv.sql.trim().replace(/;+\s*$/u, "");
  if (!READ_ONLY_START.test(sql) || sql.includes(";"))
    return {
      value: null,
      error:
        "invariant must be a single SELECT/WITH/VALUES/SHOW/TABLE statement",
    };
  const r = await rt.run(
    ["psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
    {
      env: {
        ...conn.env,
        PGOPTIONS:
          "-c default_transaction_read_only=on -c statement_timeout=60000",
      },
      timeoutMs: 90_000,
    },
  );
  return succeeded(r)
    ? { value: r.stdout.trim() }
    : { value: null, error: rt.failure(r) };
}

interface DumpRun {
  dump: CommandResult;
  start: Date;
  end: Date;
  invariants: InvariantRecord[];
}

/**
 * Evaluate invariants before and after pg_dump: a value that moved while the
 * dump ran cannot be trusted as the dump's value and is flagged unstable.
 */
async function dumpWithInvariants(
  rt: Runtime,
  conn: PgConnection,
  invariants: readonly Invariant[],
  dumpPath: string,
): Promise<DumpRun> {
  const before = new Map<string, { value: string | null; error?: string }>();
  for (const inv of invariants)
    before.set(inv.id, await runInvariant(rt, conn, inv));
  const start = rt.now();
  const dump = await rt.run(
    [
      "pg_dump",
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--file=${dumpPath}`,
    ],
    { env: conn.env, timeoutMs: 6 * 3600_000 },
  );
  const end = rt.now();
  const records: InvariantRecord[] = [];
  if (succeeded(dump))
    for (const inv of invariants) {
      const b = before.get(inv.id) ?? { value: null };
      const a = await runInvariant(rt, conn, inv);
      const error = a.error ?? b.error;
      records.push({
        id: inv.id,
        sql: inv.sql,
        expected_at_capture: a.value,
        declared_expect: inv.expect ?? null,
        matches_declared: matchesDeclared(inv.expect, a.value),
        stable_during_capture:
          a.value === null || b.value === null ? null : a.value === b.value,
        ...(error === undefined ? {} : { error }),
      });
    }
  return { dump, start, end, invariants: records };
}

interface Derived {
  tocEntries: number | null;
  tocError: string | null;
  omissions: Omission[];
  limitations: string[];
  rolesIncluded: boolean;
}

/** Schema from the same snapshot (via pg_restore) and, where permitted, roles. */
async function deriveSchemaAndRoles(
  rt: Runtime,
  conn: PgConnection,
  stage: string,
  root: string,
  dumpPath: string,
): Promise<Derived> {
  const out: Derived = {
    tocEntries: null,
    tocError: null,
    omissions: [],
    limitations: [],
    rolesIncluded: true,
  };
  const toc = await rt.run(["pg_restore", "--list", dumpPath], {
    timeoutMs: 120_000,
  });
  if (!succeeded(toc)) {
    out.tocError = rt.failure(toc);
    return out;
  }
  out.tocEntries = toc.stdout
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.startsWith(";")).length;
  const schema = await rt.run(
    [
      "pg_restore",
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      `--file=${join(stage, ...`${root}schema.sql`.split("/"))}`,
      dumpPath,
    ],
    { timeoutMs: 120_000 },
  );
  if (!succeeded(schema))
    out.omissions.push({
      what: "schema.sql",
      reason: rt.failure(schema),
      remediation:
        "The schema is still inside dump.pgc; extract it with pg_restore --schema-only.",
    });
  const roles = await rt.run(
    [
      "pg_dumpall",
      "--roles-only",
      "--no-role-passwords",
      `--file=${join(stage, ...`${root}roles.sql`.split("/"))}`,
      "-d",
      `dbname=${conninfoQuote(conn.database)}`,
    ],
    { env: conn.env, timeoutMs: 120_000 },
  );
  if (!succeeded(roles)) {
    out.rolesIncluded = false;
    out.omissions.push({
      what: "Cluster roles (roles.sql)",
      reason: rt.failure(roles),
      remediation:
        "Roles could not be read with this credential. Recreate application roles and grants manually; table-level grants are not in the dump (--no-privileges).",
    });
    out.limitations.push(
      "Row-level security policies are part of the schema dump; role memberships and GRANTs are not (dump uses --no-owner --no-privileges).",
    );
  }
  return out;
}

const invariantLimitations = (
  records: readonly InvariantRecord[],
): string[] => {
  const notes = [
    "Invariants are evaluated before and after the dump in separate read-only statements; a value that changed between them is flagged unstable and must not be treated as the dump's value.",
  ];
  const unstable = records.filter((r) => r.stable_during_capture === false);
  if (unstable.length > 0)
    notes.push(
      `Invariants whose value changed while the dump ran: ${unstable.map((r) => r.id).join(", ")}.`,
    );
  for (const r of records) {
    if (r.error !== undefined)
      notes.push(`Invariant ${r.id} could not be evaluated: ${r.error}`);
    else if (r.matches_declared === false)
      notes.push(
        `Invariant ${r.id} returned ${JSON.stringify(r.expected_at_capture)} at capture but ${JSON.stringify(r.declared_expect)} was declared.`,
      );
  }
  return notes;
};

const invariantsFile = (records: readonly InvariantRecord[]): unknown[] =>
  records.map((r) => ({
    id: r.id,
    sql: r.sql,
    expected_at_capture: r.expected_at_capture,
    declared_expect: r.declared_expect,
    matches_declared: r.matches_declared,
    stable_during_capture: r.stable_during_capture,
    ...(r.error === undefined ? {} : { error: r.error }),
  }));

interface ServerMeta {
  server_version: string;
  database: string;
  size_bytes: number;
  extensions: unknown[];
  tables: unknown[];
}

export async function capture(
  decl: DataDecl,
  rt: CaptureRuntime,
): Promise<CollectorOutcome> {
  const cid = componentId(decl);
  const root = `data/${decl.id}/`;
  const supa = decl.engine === "supabase";
  const base = {
    title: `${supa ? "Supabase" : "PostgreSQL"} database (${decl.id})`,
    method: "pg_dump -Fc (single snapshot)",
    root,
  };
  const firstSource = [...rt.sources.values()][0];
  let sourceHasFunctions = false;
  if (supa && firstSource !== undefined) {
    const co = await rt.checkout(firstSource.declId);
    if (co.ok)
      sourceHasFunctions = await stat(
        join(co.dir, "supabase", "functions"),
      ).then(
        (s) => s.isDirectory(),
        () => false,
      );
  }
  const gaps = supa
    ? supabaseGaps(decl, rt, sourceHasFunctions)
    : { manual: [], omissions: [] };
  const common: Partial<CollectorOutcome> = {
    manual: gaps.manual,
    secretNames: [decl.connection_env_name],
    relationships:
      firstSource === undefined
        ? []
        : [{ from: cid, to: firstSource.componentId, kind: "backs" }],
    omissions: gaps.omissions,
  };
  const block = (
    what: string,
    reason: string,
    remediation: string,
    extra: Partial<CollectorOutcome> = {},
  ): CollectorOutcome =>
    blockedOutcome(
      base,
      { what, reason, remediation },
      { ...common, ...extra },
    );

  const raw = rt.ctx.env[decl.connection_env_name];
  if (raw === undefined || raw === "")
    return block(
      "Database dump",
      `environment variable ${decl.connection_env_name} is not set for the runner`,
      `Set ${decl.connection_env_name} on the capture runner to a read-only PostgreSQL connection URL (use a capture-specific credential, separate from restore credentials), then capture again.`,
    );
  const conn = parsePgUrl(raw);
  if ("error" in conn)
    return block(
      "Database dump",
      `${decl.connection_env_name} is not a usable PostgreSQL URL: ${conn.error}`,
      `Set ${decl.connection_env_name} to a postgres:// or postgresql:// URL.`,
    );
  const guards = {
    blocked_hosts: isLoopbackHost(conn.host) ? [] : [conn.host],
  };

  const metaRes = await rt.run(
    ["psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", META_SQL],
    { env: conn.env, timeoutMs: 60_000 },
  );
  if (!succeeded(metaRes))
    return block(
      "Database connection",
      rt.failure(metaRes),
      `Check ${decl.connection_env_name}, network access from the runner to the database host, and that the role has CONNECT.`,
      { guards },
    );
  const meta = JSON.parse(metaRes.stdout.trim()) as ServerMeta;
  const dumpVersion = (
    await rt.run(["pg_dump", "--version"], { timeoutMs: 15_000 })
  ).stdout.trim();

  const stage = await rt.stageDir(cid);
  const dumpPath = await writeStaged(stage, `${root}dump.pgc`, "");
  const run = await dumpWithInvariants(rt, conn, decl.invariants, dumpPath);
  if (!succeeded(run.dump))
    return block(
      "Database dump",
      rt.failure(run.dump),
      "Grant the capture role SELECT on all tables (and USAGE on schemas/sequences), and use a pg_dump whose major version is at least the server's.",
      { guards, tools: ["pg_dump", "psql"] },
    );
  const derived = await deriveSchemaAndRoles(rt, conn, stage, root, dumpPath);
  if (derived.tocError !== null)
    return block(
      "Database dump",
      `dump archive failed verification: ${derived.tocError}`,
      "Capture again; check disk space on the runner.",
      { guards, tools: ["pg_dump", "pg_restore", "psql"] },
    );

  const limitations = [
    `Snapshot: pg_dump runs in a single REPEATABLE READ snapshot, so all tables in dump.pgc are mutually consistent. Server ${meta.server_version}; dump written by ${dumpVersion.split("\n")[0] ?? "pg_dump (version unknown)"}.`,
    "Restoring needs a pg_restore at least as new as the pg_dump that wrote the archive, and every extension listed in capture.json available on the target server.",
    ...invariantLimitations(run.invariants),
    ...derived.limitations,
    ...(supa
      ? [
          "Supabase-managed schemas (auth, storage, extensions) are included only as far as the capture role could read them; restoring them into plain PostgreSQL may need the Supabase roles (anon, authenticated, service_role).",
        ]
      : []),
  ];
  const omissions = [...gaps.omissions, ...derived.omissions];
  const window = {
    start: run.start.toISOString(),
    end: run.end.toISOString(),
  };
  await writeStaged(
    stage,
    `${root}invariants.json`,
    jsonText(invariantsFile(run.invariants), rt.ctx.redactor),
  );
  await writeStaged(
    stage,
    `${root}capture.json`,
    jsonText(
      {
        method:
          "pg_dump --format=custom --no-owner --no-privileges (single REPEATABLE READ snapshot)",
        snapshot_window: window,
        server_version: meta.server_version,
        pg_dump_version: dumpVersion,
        database: meta.database,
        database_size_bytes: meta.size_bytes,
        extensions: meta.extensions,
        tables: meta.tables,
        toc_entries: derived.tocEntries,
        roles_included: derived.rolesIncluded,
      },
      rt.ctx.redactor,
    ),
  );

  return {
    ...emptyOutcome(base),
    ...common,
    status: omissions.length > 0 ? "partial" : "captured",
    limitations,
    omissions,
    restoreSteps: [
      stepOf({
        id: `data-${decl.id.replace(/[^A-Za-z0-9_-]/gu, "_")}-restore`,
        title: `Restore database dump ${decl.id}`,
        run: [
          "pg_restore",
          "--no-owner",
          "--no-privileges",
          "--exit-on-error",
          "--dbname={{database_url}}",
          `{{package_root}}/${root}dump.pgc`,
        ],
        requires: ["pg_restore"],
        network: "database",
        scope: "data_restore",
      }),
    ],
    capturedAt: window,
    stageDir: stage,
    guards,
    tools: [
      "pg_dump",
      "pg_restore",
      "psql",
      ...(derived.rolesIncluded ? ["pg_dumpall"] : []),
    ],
    details: {
      engine: decl.engine,
      server_version: meta.server_version,
      pg_dump_version: dumpVersion,
      database: meta.database,
      database_size_bytes: meta.size_bytes,
      tables: meta.tables.length,
      extensions: meta.extensions,
      toc_entries: derived.tocEntries,
      roles_included: derived.rolesIncluded,
      invariants: run.invariants.map((r) => ({
        id: r.id,
        expected_at_capture: r.expected_at_capture,
        matches_declared: r.matches_declared,
        stable_during_capture: r.stable_during_capture,
      })),
      snapshot: "single REPEATABLE READ snapshot taken by pg_dump",
      connection_env_name: decl.connection_env_name,
    },
  };
}
