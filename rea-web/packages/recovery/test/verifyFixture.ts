import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RestoreReport, RestoreStep } from "@rea-web/contracts";
import { type RestoreOptions, createPackageBuilder } from "../src/index.js";
import {
  BUILD,
  CREATED_AT,
  PACKAGE_ID,
  PRODUCER,
  makeTempDir,
} from "./helpers.js";

const execFileAsync = promisify(execFile);

export type StepInput = Partial<Omit<RestoreStep, "scope" | "run">> & {
  id: string;
  run: string[];
  scope: RestoreStep["scope"];
};

export interface PackageSpec {
  steps: StepInput[];
  blockedHosts?: string[];
  /** Invariants written to data/main/invariants.json. */
  invariants?: {
    id: string;
    sql: string;
    expected_at_capture: string | null;
  }[];
  /** Behavior checks written to infrastructure/main/behavior-checks.json. */
  behaviorChecks?: {
    id: string;
    run: string[];
    expect_exit?: number;
    timeout_ms?: number;
  }[];
}

const COMPONENT_FOR_SCOPE = {
  clean_build: "source:main",
  data_restore: "data:main",
  behavior: "infrastructure:main",
  integrity: "source:main",
} as const;

const asStep = (input: StepInput): RestoreStep => ({
  title: input.id,
  env_names: [],
  requires: [],
  network: "none",
  ...input,
});

/** Build a finalized package whose restore steps are exactly `spec.steps`. */
export async function makePackage(
  spec: PackageSpec,
): Promise<{ root: string; workDir: string }> {
  const workDir = await makeTempDir("vpkg");
  const builder = await createPackageBuilder({
    stagingDir: join(workDir, "package"),
  });
  const window = { start: CREATED_AT, end: CREATED_AT };
  const stepsFor = (id: string): RestoreStep[] =>
    spec.steps.filter((s) => COMPONENT_FOR_SCOPE[s.scope] === id).map(asStep);
  for (const [id, kind, root] of [
    ["source:main", "source", "source/main/"],
    ["data:main", "data", "data/main/"],
    ["infrastructure:main", "infrastructure", "infrastructure/main/"],
  ] as const)
    builder.addComponent({
      id,
      kind,
      title: id,
      status: "captured",
      captured_at: window,
      method: "fixture",
      root,
      restore: { steps: stepsFor(id) },
      limitations: [],
      omissions: [],
      details: {},
    });
  await builder.addFile("source:main", "source/main/hello.txt", "hello\n");
  await builder.addFile("data:main", "data/main/dump.bin", "dump\n");
  if (spec.invariants !== undefined)
    await builder.addFile(
      "data:main",
      "data/main/invariants.json",
      JSON.stringify(spec.invariants),
    );
  await builder.addFile(
    "infrastructure:main",
    "infrastructure/main/behavior-checks.json",
    JSON.stringify({ checks: spec.behaviorChecks ?? [] }),
  );
  builder.setRestoreGuards({
    blocked_hosts: spec.blockedHosts ?? [],
    disabled_schedules: ["nightly"],
    disabled_webhooks: ["https://hooks.example.com/x"],
    default_network: "deny",
  });
  await builder.finalize({
    packageId: PACKAGE_ID,
    build: BUILD,
    producer: PRODUCER,
    createdAt: CREATED_AT,
  });
  return { root: builder.root, workDir };
}

/** A fresh empty directory. */
export async function emptyDir(label: string): Promise<string> {
  const dir = await makeTempDir(label);
  await mkdir(dir, { recursive: true });
  return dir;
}

export const baseOptions = (
  overrides: Partial<RestoreOptions> & Pick<RestoreOptions, "scopes">,
): RestoreOptions => ({ verifierVersion: "0.0.0-test", ...overrides });

/** A node program as a restore step command (argument array, no shell). */
export const nodeRun = (script: string, ...args: string[]): string[] => [
  "node",
  "-e",
  script,
  ...args,
];

export const scopeOf = (
  report: RestoreReport,
  scope: RestoreReport["scopes"][number]["scope"],
): RestoreReport["scopes"][number] => {
  const found = report.scopes.find((s) => s.scope === scope);
  if (found === undefined) throw new Error(`no ${scope} scope in report`);
  return found;
};

export const readText = (path: string): Promise<string> =>
  readFile(path, "utf8");
export const putText = (path: string, text: string): Promise<void> =>
  writeFile(path, text);

// ---- PostgreSQL (tests run only when REA_WEB_TEST_DATABASE_URL is set) ----

export const ADMIN_URL = process.env["REA_WEB_TEST_DATABASE_URL"] ?? "";
export const HAS_DATABASE = ADMIN_URL !== "";

export const psqlAdmin = async (sql: string): Promise<void> => {
  const url = new URL(ADMIN_URL);
  const password = decodeURIComponent(url.password);
  url.password = "";
  await execFileAsync(
    "psql",
    [
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "--dbname",
      url.toString(),
      "-c",
      sql,
    ],
    { env: { PATH: process.env["PATH"] ?? "", PGPASSWORD: password } },
  );
};

export interface ScratchDatabase {
  url: string;
  password: string;
  drop: () => Promise<void>;
}

/** An empty database owned by a fresh role with a random password. */
export async function createScratchDatabase(): Promise<ScratchDatabase> {
  const suffix = randomBytes(5).toString("hex");
  const name = `fx_vfy_${suffix}`;
  const role = `fx_vfy_role_${suffix}`;
  const password = `pw_${randomBytes(12).toString("hex")}`;
  await psqlAdmin(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await psqlAdmin(`CREATE DATABASE ${name} OWNER ${role}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  url.username = role;
  url.password = password;
  return {
    url: url.toString(),
    password,
    drop: async () => {
      await psqlAdmin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await psqlAdmin(`DROP ROLE IF EXISTS ${role}`);
    },
  };
}
