/**
 * A disposable local REA Web stack made of the built production entrypoints:
 * the API (`apps/api/dist/main.js`) and a runner (`apps/runner/dist/main.js`)
 * as separate processes, a fresh PostgreSQL database, a filesystem object
 * store and the built upstream REA server. Tests talk to it over HTTP only.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";

export const REA_WEB_ROOT = resolve(import.meta.dirname, "../..");
export const REA_ROOT = resolve(REA_WEB_ROOT, "..");
export const TEST_DATABASE_URL = process.env["REA_WEB_TEST_DATABASE_URL"];

const API_MAIN = join(REA_WEB_ROOT, "apps/api/dist/main.js");
const RUNNER_MAIN = join(REA_WEB_ROOT, "apps/runner/dist/main.js");
const UPSTREAM_MAIN = join(REA_ROOT, "dist/mcp/main.js");

/** Why the stack cannot run here, or null when it can. */
export const stackUnavailableReason = (): string | null => {
  if (TEST_DATABASE_URL === undefined)
    return "REA_WEB_TEST_DATABASE_URL is not set";
  for (const [path, build] of [
    [API_MAIN, "npx tsc -b tsconfig.json (rea-web)"],
    [RUNNER_MAIN, "npx tsc -b tsconfig.json (rea-web)"],
    [UPSTREAM_MAIN, "npm run build:cached (repository root)"],
  ] as const)
    if (!existsSync(path)) return `${path} is missing; run ${build}`;
  return null;
};

const freePort = async (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolvePort(address.port)
          : reject(new Error("no port")),
      );
    });
  });

interface OwnedProcess {
  readonly child: ChildProcess;
  readonly output: () => string;
}

const start = (
  script: string,
  env: Record<string, string>,
  cwd: string,
): OwnedProcess => {
  const chunks: string[] = [];
  const child = spawn(process.execPath, [script], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  child.stderr?.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  return { child, output: () => chunks.join("") };
};

const stop = async (owned: OwnedProcess | null): Promise<void> => {
  if (!owned || owned.child.exitCode !== null) return;
  const exited = new Promise<void>((r) => owned.child.once("exit", () => r()));
  owned.child.kill("SIGTERM");
  const timer = setTimeout(() => owned.child.kill("SIGKILL"), 15_000);
  await exited;
  clearTimeout(timer);
};

export interface Response<T = any> {
  readonly status: number;
  readonly json: T;
  readonly text: string;
  readonly headers: Headers;
}

export class Stack {
  readonly sessionSecret = `e2e-session-secret-${randomBytes(16).toString("hex")}`;
  apiUrl = "";
  cookie = "";
  runnerToken = "";
  private api: OwnedProcess | null = null;
  private runner: OwnedProcess | null = null;
  private scratch = "";
  private databaseName = "";
  private databaseUrl = "";

  /** Start the API; `staticDir` serves a built web UI from the same origin. */
  async start(options: { staticDir?: string } = {}): Promise<void> {
    this.scratch = await mkdtemp(join(tmpdir(), "rea-web-e2e-"));
    this.databaseName = `rea_web_e2e_${randomBytes(6).toString("hex")}`;
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${this.databaseName}`);
    await admin.end();
    const url = new URL(TEST_DATABASE_URL as string);
    url.pathname = `/${this.databaseName}`;
    this.databaseUrl = url.toString();
    const port = await freePort();
    this.apiUrl = `http://127.0.0.1:${port}`;
    this.api = start(
      API_MAIN,
      {
        PATH: process.env["PATH"] ?? "",
        REA_WEB_DATABASE_URL: this.databaseUrl,
        REA_WEB_SESSION_SECRET: this.sessionSecret,
        REA_WEB_PUBLIC_URL: this.apiUrl,
        REA_WEB_ALLOW_REGISTRATION: "true",
        REA_WEB_STORAGE_BACKEND: "fs",
        REA_WEB_STORAGE_FS_ROOT: join(this.scratch, "objects"),
        REA_WEB_HOST: "127.0.0.1",
        REA_WEB_PORT: String(port),
        REA_WEB_LOG_LEVEL: "info",
        ...(options.staticDir ? { REA_WEB_STATIC_DIR: options.staticDir } : {}),
      },
      this.scratch,
    );
    await this.waitFor(async () => {
      if (this.api?.child.exitCode !== null)
        throw new Error(`API exited:\n${this.api?.output()}`);
      const health = await fetch(`${this.apiUrl}/api/v1/health`).catch(
        () => null,
      );
      return health?.status === 200;
    }, 60_000);
  }

  /** Start the runner process with the token of a runner created in the API. */
  startRunner(token: string, extraEnv: Record<string, string> = {}): void {
    this.runnerToken = token;
    this.runner = start(
      RUNNER_MAIN,
      {
        PATH: process.env["PATH"] ?? "",
        HOME: join(this.scratch, "runner-home"),
        REA_WEB_API_URL: this.apiUrl,
        REA_WEB_RUNNER_TOKEN: token,
        REA_WEB_RUNNER_NAME: "e2e-linux",
        REA_WEB_RUNNER_WORKSPACE_ROOT: join(this.scratch, "runner-ws"),
        REA_WEB_REA_ROOT: REA_ROOT,
        REA_WEB_MODEL_PROVIDER: "disabled",
        ...extraEnv,
      },
      this.scratch,
    );
  }

  get logs(): string {
    return `${this.api?.output() ?? ""}\n${this.runner?.output() ?? ""}`;
  }

  async request<T = any>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      raw?: Uint8Array;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response<T>> {
    const headers: Record<string, string> = { ...options.headers };
    if (this.cookie) headers["cookie"] = this.cookie;
    let body: NonNullable<RequestInit["body"]> | undefined;
    if (options.raw) {
      headers["content-type"] ??= "application/octet-stream";
      body = options.raw;
    } else if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const response = await fetch(`${this.apiUrl}/api/v1${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const setCookie = response.headers.getSetCookie();
    const session = setCookie.find((c) => c.startsWith("rea_web_session="));
    if (session) this.cookie = session.split(";")[0] as string;
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      status: response.status,
      json: json as T,
      text,
      headers: response.headers,
    };
  }

  async waitFor(
    predicate: () => Promise<boolean>,
    timeoutMs: number,
    intervalMs = 250,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline)
        throw new Error(
          `timed out after ${timeoutMs} ms\n${this.logs.slice(-4000)}`,
        );
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  async stop(): Promise<void> {
    await stop(this.runner);
    await stop(this.api);
    if (this.databaseName) {
      const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await admin.connect();
      await admin.query(
        `DROP DATABASE IF EXISTS ${this.databaseName} WITH (FORCE)`,
      );
      await admin.end();
    }
    if (this.scratch) await rm(this.scratch, { recursive: true, force: true });
  }
}
