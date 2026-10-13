import { mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RecoveryManifest,
  type RestoreStep,
  createRedactor,
} from "@rea-web/contracts";
import { canonicalize, isInsideOrEqual } from "../fsutil.js";
import {
  type DatabaseTarget,
  blockedDatabaseHost,
  parseDatabaseUrl,
} from "./database.js";
import { execProcess } from "./exec.js";
import { ToolChecker } from "./tools.js";
import type { NetworkFacts } from "./status.js";

export type RestoreScope = "clean_build" | "data_restore" | "behavior";
export type NetworkClass = RestoreStep["network"];

export interface VerifyOptions {
  /** Reported as `verifier.version`; the CLI embeds its package version. */
  readonly verifierVersion: string;
  /** PEM public key; when given the detached signature must verify. */
  readonly publicKeyPem?: string;
  /** Accepted but refused: verification only restores into disposable targets. */
  readonly allowProduction?: boolean;
  /** Where the caller will write the report; it must not be inside the package. */
  readonly reportPath?: string;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export interface RestoreOptions extends VerifyOptions {
  readonly scopes: readonly RestoreScope[];
  /** An existing, empty directory. */
  readonly target?: string;
  /** Disposable database URL, password included; the password only reaches children as PGPASSWORD. */
  readonly databaseUrl?: string;
  /** Empty or missing directory for `{{assets_root}}`; default `<target>/.rea-assets`. */
  readonly assetsRoot?: string;
  readonly allowNetwork?: readonly ("registry" | "unknown")[];
  /** Operator-supplied values, passed only to steps that declare the name in `env_names`. */
  readonly stepEnv?: Readonly<Record<string, string>>;
  /** Default per-step timeout (20 minutes). */
  readonly stepTimeoutMs?: number;
  /** PATH for tool lookup and children; default `process.env.PATH`. */
  readonly hostPath?: string;
  /** `disabled` skips the network namespace probe (steps then run unisolated). */
  readonly isolation?: "auto" | "disabled";
}

export interface IsolationInfo {
  readonly available: boolean;
  readonly detail: string;
  readonly unsharePath: string | null;
}

export const DEFAULT_STEP_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

export interface Scrubber {
  readonly text: (value: string) => string;
}

/** Redacts the database password and operator-supplied values, whatever their length. */
export const createScrubber = (secrets: readonly string[]): Scrubber => {
  const values = [...new Set(secrets.filter((s) => s.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  const redactor = createRedactor({
    secretNames: ["PGPASSWORD"],
    secretValues: values,
  });
  return {
    text: (input) => {
      let out = redactor.redactText(input);
      for (const v of values) out = out.split(v).join("[REDACTED]");
      return out;
    },
  };
};

/** Resolved paths and guards shared by every scope of one run. */
export interface Ctx {
  readonly opts: RestoreOptions;
  readonly manifest: RecoveryManifest;
  readonly packageRoot: string;
  readonly scrub: Scrubber;
  readonly tools: ToolChecker;
  readonly pathVar: string;
  readonly allow: ReadonlySet<string>;
  readonly dirs: { home: string; tmp: string } | null;
  readonly db: DatabaseTarget | null;
  /** Why the supplied database URL is unusable, if it is. */
  readonly dbProblem: string | null;
  readonly target: string | null;
  /** Reason every restore scope is blocked, if any. */
  readonly globalBlock: string | null;
  readonly isolation: () => Promise<IsolationInfo>;
  /** The probe result if one has been made, without triggering it. */
  readonly probed: () => Promise<IsolationInfo> | null;
  assetsRoot: string | null;
  databaseGate: Promise<string | null> | null;
  readonly facts: {
    needed: string[];
    executed: NetworkFacts["executed"][number][];
  };
  readonly timeoutMs: number;
}

export const childEnvBase = (
  pathVar: string,
  dirs: { home: string; tmp: string },
): Record<string, string> => ({
  PATH: pathVar,
  LANG: "C.UTF-8",
  HOME: dirs.home,
  TMPDIR: dirs.tmp,
});

const probeIsolation = async (
  tools: ToolChecker,
  env: Record<string, string>,
  mode: "auto" | "disabled",
): Promise<IsolationInfo> => {
  const off = (detail: string): IsolationInfo => ({
    available: false,
    detail,
    unsharePath: null,
  });
  if (mode === "disabled") return off("network isolation disabled by option");
  if (process.platform !== "linux")
    return off(`no network namespace support on ${process.platform}`);
  const unshare = await tools.locate("unshare");
  if (unshare === null) return off("unshare was not found on PATH");
  const r = await execProcess([unshare, "-rn", "--", "true"], {
    env,
    timeoutMs: 10_000,
    tailBytes: 2048,
  });
  if (r.exitCode === 0 && r.spawnError === null)
    return {
      available: true,
      detail:
        "steps that need no network run under `unshare -rn` (new user and network namespace)",
      unsharePath: unshare,
    };
  const why = (r.stderr || r.spawnError || `exit code ${r.exitCode}`).trim();
  return off(
    `unshare -rn is unavailable here (${why.split("\n")[0] ?? "unknown"}); steps run without network isolation`,
  );
};

/** Why a directory cannot be used as an empty restore target, or its real path. */
export const emptyDirectory = async (
  path: string,
  what: string,
  options: { create: boolean },
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> => {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return { ok: false, reason: `${what} ${path} cannot be inspected` };
    if (!options.create)
      return { ok: false, reason: `${what} ${path} does not exist` };
    return { ok: true, path: await canonicalize(path) };
  }
  if (!info.isDirectory())
    return { ok: false, reason: `${what} ${path} is not a directory` };
  const real = await realpath(path);
  if ((await readdir(real)).length > 0)
    return { ok: false, reason: `${what} ${path} exists and is not empty` };
  return { ok: true, path: real };
};

const overlaps = (a: string, b: string): boolean =>
  isInsideOrEqual(a, b) || isInsideOrEqual(b, a);

/** Resolve the target and assets root and find the first reason to refuse. */
const resolvePaths = async (
  opts: RestoreOptions,
  packageRoot: string,
): Promise<{
  target: string | null;
  assetsRoot: string | null;
  block: string | null;
}> => {
  if (opts.allowProduction === true)
    return {
      target: null,
      assetsRoot: null,
      block:
        "--allow-production is refused in verification mode: this tool restores only into disposable targets",
    };
  if (
    opts.reportPath !== undefined &&
    isInsideOrEqual(packageRoot, await canonicalize(opts.reportPath))
  )
    return {
      target: null,
      assetsRoot: null,
      block: `the report path ${opts.reportPath} is inside the package; packages are immutable, write the report elsewhere`,
    };
  if (opts.scopes.length === 0)
    return { target: null, assetsRoot: null, block: null };
  if (opts.target === undefined)
    return {
      target: null,
      assetsRoot: null,
      block: "no --target directory was supplied",
    };
  const target = await emptyDirectory(opts.target, "the target", {
    create: false,
  });
  if (!target.ok)
    return { target: null, assetsRoot: null, block: target.reason };
  if (isInsideOrEqual(packageRoot, target.path))
    return {
      target: null,
      assetsRoot: null,
      block: `the target ${opts.target} lies inside the package directory`,
    };
  if (opts.assetsRoot === undefined)
    return { target: target.path, assetsRoot: null, block: null };
  const assets = await emptyDirectory(opts.assetsRoot, "the assets root", {
    create: true,
  });
  if (!assets.ok)
    return { target: target.path, assetsRoot: null, block: assets.reason };
  if (isInsideOrEqual(packageRoot, assets.path))
    return {
      target: target.path,
      assetsRoot: null,
      block: `the assets root ${opts.assetsRoot} lies inside the package directory`,
    };
  if (overlaps(target.path, assets.path))
    return {
      target: target.path,
      assetsRoot: null,
      block: "the assets root and the target must not contain one another",
    };
  return { target: target.path, assetsRoot: assets.path, block: null };
};

/** Create the assets root on first use (default: inside the target). */
export const ensureAssetsRoot = async (ctx: Ctx): Promise<string | null> => {
  if (ctx.assetsRoot === null && ctx.target !== null)
    ctx.assetsRoot = join(ctx.target, ".rea-assets");
  if (ctx.assetsRoot !== null) await mkdir(ctx.assetsRoot, { recursive: true });
  return ctx.assetsRoot;
};

export async function createContext(
  manifest: RecoveryManifest,
  packageRoot: string,
  opts: RestoreOptions,
): Promise<{ ctx: Ctx; cleanup: () => Promise<void> }> {
  const paths = await resolvePaths(opts, packageRoot);
  const parsed =
    opts.databaseUrl === undefined ? null : parseDatabaseUrl(opts.databaseUrl);
  const db = parsed?.ok === true ? parsed.db : null;
  const secrets = [
    ...(db === null ? [] : [db.password]),
    ...Object.values(opts.stepEnv ?? {}),
  ];
  const pathVar = opts.hostPath ?? process.env["PATH"] ?? DEFAULT_PATH;
  const needsDirs = opts.scopes.length > 0 && paths.block === null;
  const root = needsDirs ? await mkdtemp(join(tmpdir(), "rea-recover-")) : null;
  const dirs =
    root === null ? null : { home: join(root, "home"), tmp: join(root, "tmp") };
  if (dirs !== null) {
    await mkdir(dirs.home);
    await mkdir(dirs.tmp);
  }
  const base = childEnvBase(pathVar, dirs ?? { home: tmpdir(), tmp: tmpdir() });
  const tools = new ToolChecker(pathVar, base);
  let probe: Promise<IsolationInfo> | null = null;
  const ctx: Ctx = {
    opts,
    manifest,
    packageRoot,
    scrub: createScrubber(secrets),
    tools,
    pathVar,
    allow: new Set(opts.allowNetwork ?? []),
    dirs,
    db,
    dbProblem: parsed?.ok === false ? parsed.reason : null,
    target: paths.target,
    globalBlock: paths.block,
    isolation: () => {
      probe ??= probeIsolation(tools, base, opts.isolation ?? "auto");
      return probe;
    },
    probed: () => probe,
    assetsRoot: paths.assetsRoot,
    databaseGate: null,
    facts: { needed: [], executed: [] },
    timeoutMs: opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
  };
  return {
    ctx,
    cleanup: async () => {
      if (root !== null) await rm(root, { recursive: true, force: true });
    },
  };
}

/** The first blocked host the database connection would reach, if any. */
export const databaseBlockedHost = (ctx: Ctx): string | null =>
  ctx.db === null
    ? null
    : blockedDatabaseHost(ctx.db, ctx.manifest.restore_guards.blocked_hosts);
