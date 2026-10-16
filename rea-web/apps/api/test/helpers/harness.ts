import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions } from "fastify";
import { describe } from "vitest";
import {
  DEFAULT_SECRET_ENV_NAMES,
  redactorFromEnvironment,
  type CapabilityReport,
} from "@rea-web/contracts";
import {
  type Database,
  type Repositories,
  createDatabase,
  createRepositories,
  runMigrations,
} from "@rea-web/db";
import { createFsObjectStore, type ObjectStore } from "@rea-web/storage";
import { createApp } from "../../src/app.js";
import { type AppConfig, makeConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { reapOnce } from "../../src/orchestrator/reaper.js";

const reportFixture: unknown = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/contracts/test-fixtures/linux-no-providers-report.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

export const TEST_DATABASE_URL = process.env["REA_WEB_TEST_DATABASE_URL"];

if (TEST_DATABASE_URL === undefined) {
  console.warn(
    "REA_WEB_TEST_DATABASE_URL is not set: PostgreSQL-backed API tests are skipped.",
  );
}

export const describeDb: (name: string, fn: () => void) => void =
  TEST_DATABASE_URL === undefined ? describe.skip : describe;

export const SESSION_SECRET = "test-session-secret-0123456789abcdef-XYZ";

const withDatabaseName = (base: string, name: string): string => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
};

export type Headers = Record<string, string | string[] | number | undefined>;

export interface ApiResponse<T = any> {
  status: number;
  json: T;
  headers: Headers;
  raw: string;
}

export interface Credentials {
  cookie?: string;
  bearer?: string;
}

export interface Harness {
  app: FastifyInstance;
  db: Database;
  repos: Repositories;
  store: ObjectStore;
  config: AppConfig;
  logs: string[];
  storeRoot: string;
  api(
    method: InjectOptions["method"] & string,
    path: string,
    options?: {
      auth?: Credentials;
      body?: unknown;
      headers?: Record<string, string>;
      payload?: string | Buffer;
      query?: Record<string, string>;
    },
  ): Promise<ApiResponse>;
  register(email: string, password?: string): Promise<Account>;
  reap(): ReturnType<typeof reapOnce>;
  listen(): Promise<string>;
  close(): Promise<void>;
}

export interface Account {
  email: string;
  userId: string;
  cookie: string;
  auth: Credentials;
  defaultProjectId: string | null;
}

export const cookieFrom = (headers: Headers): string | null => {
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const entry = list.find((c) => c.startsWith("rea_web_session="));
  return entry === undefined ? null : (entry.split(";")[0] ?? null);
};

export async function createHarness(
  overrides: Partial<AppConfig> = {},
): Promise<Harness> {
  if (TEST_DATABASE_URL === undefined)
    throw new Error("REA_WEB_TEST_DATABASE_URL is not set");
  const name = `rea_web_api_test_${randomBytes(6).toString("hex")}`;
  const admin = createDatabase({ connectionString: TEST_DATABASE_URL, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.close();
  const url = withDatabaseName(TEST_DATABASE_URL, name);
  const db = createDatabase({ connectionString: url, max: 8 });
  await runMigrations(db);
  const repos = createRepositories(db);
  const storeRoot = await mkdtemp(join(tmpdir(), "rea-web-api-store-"));
  const store = createFsObjectStore({ root: storeRoot });
  const config = makeConfig({
    databaseUrl: url,
    sessionSecret: SESSION_SECRET,
    validateResponses: true,
    ssePingMs: 200,
    claimPollMs: 50,
    ...overrides,
  });
  const logs: string[] = [];
  const redactor = redactorFromEnvironment(
    { REA_WEB_SESSION_SECRET: SESSION_SECRET },
    DEFAULT_SECRET_ENV_NAMES,
  );
  const logger = createLogger({
    level: "trace",
    redactor,
    destination: { write: (line) => logs.push(line) },
  });
  const app = await createApp({ repos, db, store, config, logger });
  await app.ready();

  const api: Harness["api"] = async (method, path, options = {}) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.auth?.cookie !== undefined)
      headers["cookie"] = options.auth.cookie;
    if (options.auth?.bearer !== undefined)
      headers["authorization"] = `Bearer ${options.auth.bearer}`;
    const response = await app.inject({
      method,
      url: path,
      headers,
      ...(options.body === undefined
        ? {}
        : { payload: options.body as object }),
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      ...(options.query === undefined ? {} : { query: options.query }),
    });
    let json: any = null;
    try {
      json = response.body === "" ? null : JSON.parse(response.body);
    } catch {
      json = null;
    }
    return {
      status: response.statusCode,
      json,
      headers: response.headers,
      raw: response.body,
    };
  };

  const harness: Harness = {
    app,
    db,
    repos,
    store,
    config,
    logs,
    storeRoot,
    api,
    async register(email, password = "correct horse battery staple") {
      const response = await api("POST", "/api/v1/auth/register", {
        body: { email, password },
      });
      if (response.status !== 201)
        throw new Error(`register failed: ${response.status} ${response.raw}`);
      const cookie = cookieFrom(response.headers);
      if (cookie === null) throw new Error("no session cookie");
      const projects = response.json.memberships as Array<{
        project_id: string;
      }>;
      return {
        email,
        userId: response.json.user.id,
        cookie,
        auth: { cookie },
        defaultProjectId: projects[0]?.project_id ?? null,
      };
    },
    reap: () => reapOnce(repos, { staleRunnerMs: config.leaseTtlMs * 2 }),
    async listen() {
      return app.listen({ host: "127.0.0.1", port: 0 });
    },
    async close() {
      await app.close();
      await db.close();
      await rm(storeRoot, { recursive: true, force: true });
      const cleanup = createDatabase({
        connectionString: TEST_DATABASE_URL,
        max: 1,
      });
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.close();
      }
    },
  };
  return harness;
}

/** Fixture report with a unique runner name; mutate a copy, never the import. */
export const reportFor = (
  runnerName: string,
  patch: (report: CapabilityReport) => void = () => undefined,
): CapabilityReport => {
  const copy = structuredClone(reportFixture) as unknown as CapabilityReport;
  copy.runner_name = runnerName;
  copy.reported_at = new Date().toISOString();
  patch(copy);
  return copy;
};

export interface RunnerHandle {
  id: string;
  token: string;
  auth: Credentials;
}

export async function createRunner(
  h: Harness,
  admin: Account,
  projectId: string,
  name: string,
): Promise<RunnerHandle> {
  const response = await h.api(
    "POST",
    `/api/v1/projects/${projectId}/runners`,
    {
      auth: admin.auth,
      body: { name, labels: [] },
    },
  );
  if (response.status !== 201)
    throw new Error(`createRunner failed: ${response.status} ${response.raw}`);
  return {
    id: response.json.id,
    token: response.json.token,
    auth: { bearer: response.json.token },
  };
}

export async function registerRunner(
  h: Harness,
  runner: RunnerHandle,
  report: CapabilityReport,
): Promise<void> {
  const response = await h.api("POST", "/api/v1/runners/register", {
    auth: runner.auth,
    body: report,
  });
  if (response.status !== 200)
    throw new Error(
      `runner register failed: ${response.status} ${response.raw}`,
    );
}

export const uploadBytes = (
  h: Harness,
  account: Account,
  projectId: string,
  name: string,
  bytes: Buffer,
  extraHeaders: Record<string, string> = {},
) =>
  h.api("POST", `/api/v1/projects/${projectId}/targets/uploads`, {
    auth: account.auth,
    payload: bytes,
    headers: {
      "content-type": "application/octet-stream",
      "x-target-name": name,
      ...extraHeaders,
    },
  });
