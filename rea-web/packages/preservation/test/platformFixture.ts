import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SECRET_ENV_NAMES,
  redactorFromEnvironment,
} from "@rea-web/contracts";
import {
  type BuildDefinition,
  type CaptureResult,
  type CollectorContext,
  capturePackage,
  planPreservation,
  runCommand,
} from "../src/index.js";

export const PLATFORM_FIXTURE = fileURLToPath(
  new URL("../../../fixtures/preservation/platform/", import.meta.url),
);

/** Directories stored without their leading dot in the fixture tree. */
const DOT_RENAMES: Record<string, string> = { "dot-railway": ".railway" };

export const RUNNER_ID = "0194f1e0-0000-7000-8000-0000000000b1";

export const sha256Of = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Copy the platform fixture to `dir`, restore dotted names, then apply overrides (null deletes). */
export async function materializePlatformFixture(
  dir: string,
  overrides: Record<string, string | null> = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await cp(PLATFORM_FIXTURE, dir, { recursive: true });
  for (const [from, to] of Object.entries(DOT_RENAMES))
    await rename(join(dir, from), join(dir, to));
  for (const [rel, content] of Object.entries(overrides)) {
    const abs = join(dir, ...rel.split("/"));
    if (content === null) await rm(abs, { force: true });
    else {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
  }
}

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  const r = await runCommand(
    ["git", "-c", "init.defaultBranch=main", ...args],
    {
      cwd,
      timeoutMs: 60_000,
      env: {
        HOME: process.env["HOME"] ?? "/root",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  if (r.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
};

export async function createPlatformRepo(
  dir: string,
  overrides: Record<string, string | null> = {},
): Promise<void> {
  await materializePlatformFixture(dir, overrides);
  await git(dir, "init", "-q");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "feat: platform fixture");
}

export type InfraDescriptor = Extract<
  BuildDefinition["components"][number],
  { kind: "infrastructure" }
>["descriptor"];

export interface PlatformCapture {
  result: CaptureResult;
  pkg: string;
  repo: string;
  read: (rel: string) => Promise<string>;
  json: <T>(rel: string) => Promise<T>;
  /** Every file of the package as [relative path, bytes]. */
  allFiles: () => Promise<[string, Buffer][]>;
}

export interface CaptureOptions {
  root: string;
  name: string;
  overrides?: Record<string, string | null>;
  descriptor?: InfraDescriptor;
  integrations?: boolean;
  env?: Record<string, string>;
}

/** Capture a source + infrastructure (+ integrations) build of the platform fixture. */
export async function capturePlatformFixture(
  options: CaptureOptions,
): Promise<PlatformCapture> {
  const repo = join(options.root, `${options.name}-repo`);
  const pkg = join(options.root, `${options.name}-pkg`);
  const workspace = join(options.root, `${options.name}-ws`);
  await mkdir(workspace, { recursive: true });
  await createPlatformRepo(repo, options.overrides);
  const env = options.env ?? {};
  const ctx: CollectorContext = {
    workspace,
    env,
    signal: new AbortController().signal,
    log: () => undefined,
    redactor: redactorFromEnvironment(env, [...DEFAULT_SECRET_ENV_NAMES]),
    localPaths: new Map([[sha256Of(repo), repo]]),
    now: () => new Date(),
  };
  const build: BuildDefinition = {
    id: `build-${options.name}`,
    name: "Platform fixture",
    description: "Platform configuration collectors",
    project_slug: "platform",
    source: {
      kind: "runner_local",
      runner_id: RUNNER_ID,
      path_hash: sha256Of(repo),
      include_working_tree: false,
      include_lfs: false,
      include_submodules: false,
    },
    components: [
      { kind: "source", id: "main" },
      {
        kind: "infrastructure",
        id: "infra",
        descriptor: options.descriptor ?? {},
      },
      ...(options.integrations === true
        ? [{ kind: "integrations" as const, id: "integ", descriptor: {} }]
        : []),
    ],
  };
  const plan = await planPreservation(build, ctx);
  const result = await capturePackage(build, plan, ctx, {
    stagingDir: pkg,
    producerVersion: "0.0.0-test",
  });
  const read = (rel: string): Promise<string> =>
    readFile(join(pkg, ...rel.split("/")), "utf8");
  return {
    result,
    pkg,
    repo,
    read,
    json: async <T>(rel: string): Promise<T> =>
      JSON.parse(await read(rel)) as T,
    allFiles: async () => {
      const out: [string, Buffer][] = [];
      for (const e of await readdir(pkg, {
        recursive: true,
        withFileTypes: true,
      }))
        if (e.isFile()) {
          const abs = join(e.parentPath, e.name);
          out.push([abs.slice(pkg.length + 1), await readFile(abs)]);
        }
      return out;
    },
  };
}
