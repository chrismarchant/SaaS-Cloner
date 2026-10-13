import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RecoveryManifest, RestoreStep } from "@rea-web/contracts";
import { succeeded } from "../exec.js";
import {
  LFS_SKIP_SMUDGE,
  credentialEnv,
  gitArgv,
  gitEnv,
  withoutUserinfo,
} from "../git.js";
import {
  type CaptureRuntime,
  type CollectorOutcome,
  type Runtime,
  blockedOutcome,
  emptyOutcome,
} from "../runtime.js";
import {
  type BuildDefinition,
  type ComponentDeclaration,
  type ComponentPlan,
  type Omission,
  componentId,
  errorMessage,
} from "../types.js";
import {
  isRemoteGitUrl,
  jsonText,
  redactUrl,
  safeSegment,
  stepOf,
  writeStaged,
} from "../util.js";

type SourceDecl = Extract<ComponentDeclaration, { kind: "source" }>;
type Source = BuildDefinition["source"];
type SourceRevision = RecoveryManifest["source_revisions"][number];

const REMOTE_TIMEOUT_MS = 30 * 60_000;
const GIT_TIMEOUT_MS = 10 * 60_000;
const BIG_OUTPUT = 256 * 1024 * 1024;

export type Location =
  | { kind: "local"; dir: string; label: string }
  | { kind: "remote"; url: string; label: string }
  | { kind: "unresolved"; reason: string; remediation: string };

/** Where the declared source lives: a runner-resolved path, a local path, or a remote URL. */
export const resolveLocation = (
  source: Source,
  localPaths: ReadonlyMap<string, string>,
): Location => {
  if (source.kind === "runner_local") {
    const dir = localPaths.get(source.path_hash);
    return dir === undefined
      ? {
          kind: "unresolved",
          reason: `runner did not resolve source path_hash ${source.path_hash.slice(0, 12)}...`,
          remediation:
            "Run the job on the runner that registered this path, and re-register the local path if it moved.",
        }
      : {
          kind: "local",
          dir: resolve(dir),
          label: `runner_local:${source.path_hash.slice(0, 12)}`,
        };
  }
  if (isRemoteGitUrl(source.url))
    return { kind: "remote", url: source.url, label: redactUrl(source.url) };
  return {
    kind: "local",
    dir: resolve(source.url),
    label: redactUrl(source.url),
  };
};

const refOf = (source: Source): string =>
  source.kind === "git" ? source.ref : "HEAD";

const validRef = (ref: string): boolean =>
  ref.length > 0 && !ref.startsWith("-") && !/[\0\n]/u.test(ref);

interface GitRepo {
  /** Directory git commands run in (worktree top-level, bare dir or mirror). */
  dir: string;
  bare: boolean;
  gitDir: string;
}

const git = (
  rt: Runtime,
  dir: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = GIT_TIMEOUT_MS,
) =>
  rt.run(gitArgv(dir, args), {
    env: gitEnv(extraEnv),
    timeoutMs,
    maxOutputBytes: BIG_OUTPUT,
  });

async function openRepo(rt: Runtime, dir: string): Promise<GitRepo | string> {
  const top = await git(rt, dir, [
    "rev-parse",
    "--is-bare-repository",
    "--absolute-git-dir",
  ]);
  if (!succeeded(top)) return `not a git repository: ${rt.failure(top)}`;
  const [bare, gitDir] = top.stdout.trim().split("\n");
  if (bare === "true") return { dir, bare: true, gitDir: gitDir ?? dir };
  const root = await git(rt, dir, ["rev-parse", "--show-toplevel"]);
  return {
    dir: succeeded(root) ? root.stdout.trim() : dir,
    bare: false,
    gitDir: gitDir ?? join(dir, ".git"),
  };
}

const resolveCommit = async (
  rt: Runtime,
  repo: GitRepo,
  ref: string,
): Promise<string | null> => {
  const r = await git(rt, repo.dir, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  const sha = r.stdout.trim();
  return succeeded(r) && /^[0-9a-f]{40,64}$/u.test(sha) ? sha : null;
};

// ---------------------------------------------------------------- planning

export async function plan(
  decl: SourceDecl,
  rt: Runtime,
): Promise<ComponentPlan> {
  const source = rt.build.source;
  const loc = resolveLocation(source, rt.ctx.localPaths);
  const out: ComponentPlan = {
    id: componentId(decl),
    kind: "source",
    collector: "git",
    permissions: [],
    estimated_bytes: null,
    dependencies: [],
    method: "git bundle create --all (history, all refs)",
    omissions: [
      {
        what: "Ignored files (for example .env, build output)",
        reason:
          "Git-ignored files are never captured, so credentials kept in them are not exported.",
        remediation:
          "Declare required environment variable names in the infrastructure descriptor.",
      },
    ],
    feasible: false,
  };
  if (loc.kind === "unresolved") {
    out.permissions.push({
      check: "source location",
      ok: false,
      detail: loc.reason,
    });
    return out;
  }
  const ref = refOf(source);
  if (!validRef(ref)) {
    out.permissions.push({
      check: "ref",
      ok: false,
      detail: "ref must be non-empty and must not start with '-'",
    });
    return out;
  }
  if (loc.kind === "remote") {
    // A raw commit id is never advertised; only reachability of the remote is checked then.
    const probe = /^[0-9a-f]{40,64}$/u.test(ref) ? "HEAD" : ref;
    const r = await git(
      rt,
      rt.ctx.workspace,
      ["ls-remote", "--exit-code", withoutUserinfo(loc.url), probe],
      credentialEnv(loc.url),
      60_000,
    );
    out.permissions.push({
      check: "remote read access (git ls-remote)",
      ok: succeeded(r),
      detail: succeeded(r) ? `${probe} is advertised` : rt.failure(r),
    });
    out.method = "git clone --mirror, then git bundle create --all";
    if (source.include_working_tree)
      out.omissions.push({
        what: "Working-tree changes",
        reason:
          "A remote source is captured from a mirror clone, which has no working tree.",
        remediation:
          "Capture from a runner-local checkout to include uncommitted work.",
      });
    out.feasible = out.permissions.every((p) => p.ok);
    return out;
  }
  const repo = await openRepo(rt, loc.dir);
  if (typeof repo === "string") {
    out.permissions.push({
      check: "repository readable",
      ok: false,
      detail: rt.ctx.redactor.redactText(repo),
    });
    return out;
  }
  out.permissions.push({
    check: "repository readable",
    ok: true,
    detail: `${repo.bare ? "bare" : "worktree"} repository`,
  });
  const sha = await resolveCommit(rt, repo, ref);
  out.permissions.push({
    check: `ref ${ref} resolves to a commit`,
    ok: sha !== null,
    detail: sha ?? "ref not found",
  });
  const size = await git(rt, repo.dir, ["count-objects", "-v"]);
  if (succeeded(size)) {
    const kib = (key: string): number =>
      Number(new RegExp(`^${key}: (\\d+)$`, "mu").exec(size.stdout)?.[1] ?? 0);
    out.estimated_bytes = (kib("size") + kib("size-pack")) * 1024;
  }
  if (source.include_working_tree && sha !== null) {
    const head = await resolveCommit(rt, repo, "HEAD");
    if (repo.bare || head !== sha)
      out.omissions.push({
        what: "Working-tree changes",
        reason: repo.bare
          ? "The repository is bare."
          : `Working-tree changes are relative to HEAD (${head?.slice(0, 12) ?? "none"}) but ${ref} resolves to ${sha.slice(0, 12)}.`,
        remediation: "Capture with ref HEAD to include uncommitted work.",
      });
  }
  if (sha !== null)
    out.omissions.push(...(await planLocalGaps(rt, repo, sha, source)));
  out.feasible = out.permissions.every((p) => p.ok);
  return out;
}

/** Cheap look-ahead for things capture will not be able to carry. */
async function planLocalGaps(
  rt: Runtime,
  repo: GitRepo,
  sha: string,
  source: Source,
): Promise<Omission[]> {
  const gaps: Omission[] = [];
  if (source.include_submodules && !repo.bare) {
    for (const link of await gitlinks(rt, repo.dir, sha)) {
      const initialised = await stat(join(repo.dir, link.path, ".git")).then(
        () => true,
        () => false,
      );
      if (!initialised)
        gaps.push({
          what: `Submodule repository ${link.path} @ ${link.sha.slice(0, 12)}`,
          reason: "submodule is not initialised in the working copy",
          remediation:
            "Run 'git submodule update --init --recursive' in the source checkout before capturing.",
        });
    }
  }
  if (source.include_lfs) {
    const uses = await git(rt, repo.dir, [
      "grep",
      "-q",
      "-e",
      "filter=lfs",
      sha,
      "--",
      ":(glob)**/.gitattributes",
      ".gitattributes",
    ]);
    const lfs =
      uses.exitCode === 0
        ? await rt.run(["git", "lfs", "version"], { env: gitEnv() })
        : null;
    if (lfs !== null && !succeeded(lfs))
      gaps.push({
        what: "Git LFS object payloads",
        reason:
          "The repository uses Git LFS but git-lfs is not available on the runner.",
        remediation:
          "Install git-lfs on the runner (it is not installed automatically).",
      });
  }
  return gaps;
}

// --------------------------------------------------------------- capture

interface Staged {
  stage: string;
  prefix: string;
}

interface LfsSummary {
  uses: boolean;
  count: number;
  bytes: number;
  included: boolean;
}

interface SubmoduleRecord {
  path: string;
  sha: string;
  url: string | null;
  bundle: string | null;
  /** Set when the working copy's submodule HEAD differs from the recorded commit. */
  checked_out_sha: string | null;
}

const parseRefs = (text: string): { name: string; sha: string }[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => {
      const [name = "", sha = ""] = l.split(" ");
      return { name, sha };
    })
    .filter((r) => r.name !== "" && /^[0-9a-f]{40,64}$/u.test(r.sha));

async function mirrorClone(
  rt: CaptureRuntime,
  url: string,
): Promise<{ dir: string } | { error: string }> {
  const dir = join(
    rt.ctx.workspace,
    `mirror-${safeSegment(String(Date.now()))}.git`,
  );
  const r = await rt.run(
    [
      "git",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      // A declared URL must not name a command (`ext::sh -c ...`).
      "-c",
      "protocol.ext.allow=never",
      "clone",
      "--mirror",
      "--quiet",
      "--",
      withoutUserinfo(url),
      dir,
    ],
    {
      env: gitEnv(credentialEnv(url)),
      timeoutMs: REMOTE_TIMEOUT_MS,
      maxOutputBytes: BIG_OUTPUT,
    },
  );
  return succeeded(r) ? { dir } : { error: rt.failure(r) };
}

async function gitmodulesUrls(
  rt: Runtime,
  dir: string,
  sha: string,
): Promise<Map<string, string>> {
  const r = await git(rt, dir, [
    "config",
    `--blob=${sha}:.gitmodules`,
    "--null",
    "--list",
  ]);
  const urls = new Map<string, string>();
  if (!succeeded(r)) return urls;
  const names = new Map<string, { path?: string; url?: string }>();
  for (const entry of r.stdout.split("\0")) {
    const nl = entry.indexOf("\n");
    if (nl < 0) continue;
    const m = /^submodule\.(.+)\.(path|url)$/u.exec(entry.slice(0, nl));
    if (m === null) continue;
    const rec = names.get(m[1] as string) ?? {};
    rec[m[2] as "path" | "url"] = entry.slice(nl + 1);
    names.set(m[1] as string, rec);
  }
  for (const rec of names.values())
    if (rec.path !== undefined && rec.url !== undefined)
      urls.set(rec.path, rec.url);
  return urls;
}

interface SubmoduleResult {
  records: SubmoduleRecord[];
  omissions: Omission[];
  steps: RestoreStep[];
}

async function gitlinks(
  rt: Runtime,
  dir: string,
  commit: string,
): Promise<{ path: string; sha: string }[]> {
  const r = await git(rt, dir, ["ls-tree", "-r", "-z", commit]);
  if (!succeeded(r)) return [];
  return r.stdout
    .split("\0")
    .map((e) => /^160000 commit ([0-9a-f]{40,64})\t(.+)$/su.exec(e))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ sha: m[1] as string, path: m[2] as string }));
}

interface SubmoduleOptions {
  sourceId: string;
  staged: Staged;
  /** False for repositories without a usable working copy: record only. */
  bundles: boolean;
  skipReason: string;
  /** Working-tree changes were requested: capture each submodule as checked out. */
  workingTree: boolean;
}

type Inspected =
  | { ok: true; wanted: string; dirty: boolean }
  | { ok: false; reason: string; remediation: string };

/** Which commit of an initialised submodule a restore must reproduce, and whether it can be bundled. */
async function inspectSubmodule(
  rt: Runtime,
  abs: string,
  recorded: string,
  workingTree: boolean,
): Promise<Inspected> {
  const initialised = await stat(join(abs, ".git")).then(
    () => true,
    () => false,
  );
  if (!initialised)
    return {
      ok: false,
      reason: "submodule is not initialised in the working copy",
      remediation:
        "Run 'git submodule update --init --recursive' in the source checkout, then capture again.",
    };
  const headRes = await git(rt, abs, ["rev-parse", "HEAD"]);
  const head = headRes.stdout.trim();
  const wanted = workingTree && head !== "" ? head : recorded;
  const has = await git(rt, abs, ["cat-file", "-e", `${wanted}^{commit}`]);
  if (!succeeded(has))
    return {
      ok: false,
      reason: `commit ${wanted.slice(0, 12)} is not present in the initialised submodule`,
      remediation:
        "Run 'git submodule update --init --recursive' to fetch the recorded commit, then capture again.",
    };
  const contains = await git(rt, abs, [
    "for-each-ref",
    "--contains",
    wanted,
    "--count=1",
    "--format=%(refname)",
  ]);
  if (head !== wanted && contains.stdout.trim() === "")
    return {
      ok: false,
      reason:
        "the commit is not reachable from any ref or HEAD, so a bundle cannot carry it",
      remediation: "Create a branch or tag at the commit inside the submodule.",
    };
  const status = workingTree
    ? await git(rt, abs, ["status", "--porcelain=v1", "--untracked-files=all"])
    : null;
  return {
    ok: true,
    wanted,
    dirty: status !== null && succeeded(status) && status.stdout.trim() !== "",
  };
}

async function bundleSubmodules(
  rt: CaptureRuntime,
  top: GitRepo,
  topSha: string,
  opts: SubmoduleOptions,
): Promise<SubmoduleResult> {
  const { sourceId, staged } = opts;
  const result: SubmoduleResult = { records: [], omissions: [], steps: [] };
  const usedNames = new Set<string>();
  const visit = async (
    dir: string,
    commit: string,
    prefix: string,
    depth: number,
  ): Promise<void> => {
    const links = await gitlinks(rt, dir, commit);
    if (links.length === 0) return;
    const urls = await gitmodulesUrls(rt, dir, commit);
    for (const link of links) {
      const full = prefix + link.path;
      const rawUrl = urls.get(link.path);
      const record: SubmoduleRecord = {
        path: full,
        sha: link.sha,
        url: rawUrl === undefined ? null : redactUrl(rawUrl),
        bundle: null,
        checked_out_sha: null,
      };
      result.records.push(record);
      const abs = join(dir, link.path);
      const fail = (reason: string, remediation: string): void => {
        result.omissions.push({
          what: `Submodule repository ${full} @ ${link.sha.slice(0, 12)}`,
          reason,
          remediation,
        });
      };
      if (!opts.bundles) {
        fail(
          opts.skipReason,
          "Capture this submodule's repository as its own build source.",
        );
        continue;
      }
      if (depth > 8) {
        fail(
          "submodule nesting deeper than 8 levels",
          "Capture deeper submodules separately.",
        );
        continue;
      }
      const found = await inspectSubmodule(rt, abs, link.sha, opts.workingTree);
      if (!found.ok) {
        fail(found.reason, found.remediation);
        continue;
      }
      if (found.dirty)
        result.omissions.push({
          what: `Uncommitted changes inside submodule ${full}`,
          reason:
            "Only committed submodule state is captured; modified or untracked files inside the submodule are not part of worktree.patch.",
          remediation:
            "Commit the changes inside the submodule and capture again.",
        });
      if (found.wanted !== link.sha) record.checked_out_sha = found.wanted;
      let name = safeSegment(full);
      for (let i = 2; usedNames.has(name.toLowerCase()); i += 1)
        name = `${safeSegment(full)}_${i}`;
      usedNames.add(name.toLowerCase());
      const rel = `submodules/${name}.bundle`;
      const out = join(staged.stage, staged.prefix, rel);
      await mkdir(dirname(out), { recursive: true });
      const b = await git(rt, abs, ["bundle", "create", out, "--all"]);
      if (!succeeded(b)) {
        fail(
          `git bundle failed: ${rt.failure(b)}`,
          "Check the submodule repository is healthy and not empty.",
        );
        continue;
      }
      record.bundle = rel;
      const target = `{{target}}/${sourceId}/${full}`;
      result.steps.push(
        stepOf({
          id: `${safeSegment(sourceId)}-submodule-${name}-clone`,
          title: `Clone submodule ${full} from its bundle`,
          run: [
            "git",
            "clone",
            "--no-hardlinks",
            `{{package_root}}/${staged.prefix}${rel}`,
            target,
          ],
          requires: ["git"],
          scope: "clean_build",
        }),
        stepOf({
          id: `${safeSegment(sourceId)}-submodule-${name}-checkout`,
          title: `Check out submodule ${full} at ${found.wanted.slice(0, 12)}`,
          run: ["git", "-C", target, "checkout", "--detach", found.wanted],
          requires: ["git"],
          scope: "clean_build",
        }),
      );
      await visit(abs, found.wanted, `${full}/`, depth + 1);
    }
  };
  await visit(top.dir, topSha, "", 0);
  return result;
}

async function captureLfs(
  rt: CaptureRuntime,
  staged: Staged,
  repo: GitRepo,
  sha: string,
  remote: boolean,
  includeLfs: boolean,
  credEnv: Record<string, string>,
): Promise<{
  summary: LfsSummary;
  omissions: Omission[];
  limitations: string[];
}> {
  const summary: LfsSummary = {
    uses: false,
    count: 0,
    bytes: 0,
    included: false,
  };
  const omissions: Omission[] = [];
  const uses = await git(rt, repo.dir, [
    "grep",
    "-q",
    "-e",
    "filter=lfs",
    sha,
    "--",
    ":(glob)**/.gitattributes",
    ".gitattributes",
  ]);
  summary.uses = uses.exitCode === 0;
  if (!summary.uses)
    return {
      summary: { ...summary, included: includeLfs },
      omissions,
      limitations: [],
    };
  if (!includeLfs) {
    omissions.push({
      what: "Git LFS object payloads",
      reason:
        "The build source declares include_lfs: false; only LFS pointers are in the repository bundle.",
      remediation: "Set include_lfs to true and capture again.",
    });
    return { summary, omissions, limitations: [] };
  }
  const available = await rt.run(["git", "lfs", "version"], { env: gitEnv() });
  if (!succeeded(available)) {
    omissions.push({
      what: "Git LFS object payloads",
      reason:
        "The repository uses Git LFS but git-lfs is not available on the runner.",
      remediation:
        "Install git-lfs on the runner (it is not installed automatically) and capture again.",
    });
    return { summary, omissions, limitations: [] };
  }
  if (remote) {
    const fetch = await git(
      rt,
      repo.dir,
      ["lfs", "fetch", "--all"],
      credEnv,
      REMOTE_TIMEOUT_MS,
    );
    if (!succeeded(fetch))
      omissions.push({
        what: "Git LFS object payloads",
        reason: `git lfs fetch --all failed: ${rt.failure(fetch)}`,
        remediation:
          "Make the LFS endpoint reachable with credentials available to git, or capture from a checkout that has the objects.",
      });
  }
  const list = await git(rt, repo.dir, ["lfs", "ls-files", "--long", sha]);
  if (!succeeded(list)) {
    omissions.push({
      what: "Git LFS object payloads",
      reason: `git lfs ls-files failed: ${rt.failure(list)}`,
      remediation: "Check the repository's LFS configuration.",
    });
    return { summary, omissions, limitations: [] };
  }
  const oids = new Set<string>();
  for (const line of list.stdout.split("\n")) {
    const m = /^([0-9a-f]{64}) [*-] /u.exec(line);
    if (m !== null) oids.add(m[1] as string);
  }
  const common = await git(rt, repo.dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const base = join(
    succeeded(common) ? common.stdout.trim() : repo.gitDir,
    "lfs",
    "objects",
  );
  let missing = 0;
  for (const oid of [...oids].sort()) {
    rt.ctx.signal.throwIfAborted();
    const rel = `lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;
    const src = join(base, oid.slice(0, 2), oid.slice(2, 4), oid);
    try {
      const st = await stat(src);
      const dest = join(staged.stage, staged.prefix, rel);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest, fsConstants.COPYFILE_EXCL);
      summary.count += 1;
      summary.bytes += st.size;
    } catch {
      missing += 1;
    }
  }
  summary.included = missing === 0;
  if (missing > 0)
    omissions.push({
      what: `${missing} of ${oids.size} Git LFS objects`,
      reason:
        "The objects are referenced by LFS pointers but are not in the local LFS store (never fetched).",
      remediation:
        "Run 'git lfs fetch --all' in the source repository, then capture again.",
    });
  return { summary, omissions, limitations: [] };
}

interface WorktreeResult {
  included: boolean;
  dirty: number;
  untracked: number;
  dirtyPaths: string[];
  untrackedPaths: string[];
  patch: boolean;
  omissions: Omission[];
}

const parseStatus = (z: string): { dirty: string[]; untracked: string[] } => {
  const dirty: string[] = [];
  const untracked: string[] = [];
  const parts = z.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i] ?? "";
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy === "??") untracked.push(path);
    else dirty.push(path);
    if (xy.includes("R") || xy.includes("C")) i += 1;
  }
  return { dirty, untracked };
};

async function captureWorktree(
  rt: CaptureRuntime,
  staged: Staged,
  repo: GitRepo,
): Promise<WorktreeResult> {
  const result: WorktreeResult = {
    included: false,
    dirty: 0,
    untracked: 0,
    dirtyPaths: [],
    untrackedPaths: [],
    patch: false,
    omissions: [],
  };
  const status = await git(rt, repo.dir, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (!succeeded(status)) {
    result.omissions.push({
      what: "Working-tree changes",
      reason: `git status failed: ${rt.failure(status)}`,
      remediation: "Check the working copy is readable and not mid-operation.",
    });
    return result;
  }
  const { dirty, untracked } = parseStatus(status.stdout);
  result.dirty = dirty.length;
  result.untracked = untracked.length;
  result.dirtyPaths = dirty;
  result.untrackedPaths = untracked;
  if (dirty.length + untracked.length === 0) {
    result.included = true;
    return result;
  }
  const tmp = join(rt.ctx.workspace, `worktree-${Date.now()}`);
  const objects = join(tmp, "objects");
  await mkdir(objects, { recursive: true });
  const real = await git(rt, repo.dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "objects",
  ]);
  const env = gitEnv({
    GIT_INDEX_FILE: join(tmp, "index"),
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: real.stdout.trim(),
  });
  const patchPath = join(staged.stage, staged.prefix, "worktree.patch");
  await mkdir(dirname(patchPath), { recursive: true });
  try {
    for (const args of [
      ["read-tree", "HEAD"],
      ["add", "-A"],
    ]) {
      const r = await rt.run(gitArgv(repo.dir, args), {
        env,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (!succeeded(r))
        throw new Error(`git ${args[0]} failed: ${rt.failure(r)}`);
    }
    const diff = await rt.run(
      gitArgv(repo.dir, [
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        `--output=${patchPath}`,
        "HEAD",
      ]),
      { env, timeoutMs: GIT_TIMEOUT_MS },
    );
    if (!succeeded(diff))
      throw new Error(`git diff failed: ${rt.failure(diff)}`);
    const size = await stat(patchPath).then(
      (s) => s.size,
      () => 0,
    );
    result.patch = size > 0;
    result.included = true;
  } catch (error) {
    result.omissions.push({
      what: "Working-tree changes",
      reason: rt.ctx.redactor.redactText(errorMessage(error)),
      remediation:
        "Commit or stash the changes, or fix the reported problem, then capture again.",
    });
    await rm(patchPath, { force: true });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return result;
}

async function countIgnored(
  rt: Runtime,
  repo: GitRepo,
): Promise<number | null> {
  const r = await git(rt, repo.dir, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  return succeeded(r)
    ? r.stdout.split("\0").filter((e) => e !== "").length
    : null;
}

type Base = { title: string; method: string; root: string };

interface Prepared {
  repo: GitRepo;
  remote: boolean;
  headSha: string;
  headNow: string | null;
  refs: { name: string; sha: string }[];
  origin: string | null;
}

/** Open the repository (mirror-cloning remote URLs) and resolve the requested ref. */
async function prepare(
  rt: CaptureRuntime,
  loc: Exclude<Location, { kind: "unresolved" }>,
  ref: string,
  base: Base,
): Promise<Prepared | CollectorOutcome> {
  const failure = (what: string, reason: string, remediation: string) =>
    blockedOutcome(base, { what, reason, remediation });
  let repoDir: string;
  if (loc.kind === "remote") {
    const mirrored = await mirrorClone(rt, loc.url);
    if ("error" in mirrored)
      return failure(
        "Source repository",
        mirrored.error,
        "Check the URL and that the runner has git credentials (for example an SSH agent or credential helper) with read access.",
      );
    repoDir = mirrored.dir;
  } else repoDir = loc.dir;
  const repo = await openRepo(rt, repoDir);
  if (typeof repo === "string")
    return failure(
      "Source repository",
      rt.ctx.redactor.redactText(repo),
      "Point the build at a git repository the runner can read.",
    );
  const headSha = await resolveCommit(rt, repo, ref);
  if (headSha === null)
    return failure(
      `Revision ${ref}`,
      `ref ${ref} does not resolve to a commit`,
      "Declare a ref that exists (branch, tag or commit).",
    );
  const headNow = await resolveCommit(rt, repo, "HEAD");
  const refsRes = await git(rt, repo.dir, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
  ]);
  const refs = parseRefs(refsRes.stdout);
  if (headNow !== null) refs.unshift({ name: "HEAD", sha: headNow });
  const origin =
    loc.kind === "remote"
      ? loc.url
      : await git(rt, repo.dir, ["remote", "get-url", "origin"]).then((r) =>
          succeeded(r) ? r.stdout.trim() : null,
        );
  return {
    repo,
    remote: loc.kind === "remote",
    headSha,
    headNow,
    refs,
    origin,
  };
}

/** Write and verify repo.bundle; returns an outcome when the commit cannot be carried. */
async function writeBundle(
  rt: CaptureRuntime,
  prepared: Prepared,
  ref: string,
  bundlePath: string,
  base: Base,
): Promise<CollectorOutcome | null> {
  const { repo, headSha, headNow } = prepared;
  await mkdir(dirname(bundlePath), { recursive: true });
  const bundle = await git(rt, repo.dir, [
    "bundle",
    "create",
    bundlePath,
    "--all",
  ]);
  if (!succeeded(bundle))
    return blockedOutcome(base, {
      what: "Repository bundle",
      reason: rt.failure(bundle),
      remediation:
        "Ensure the repository has at least one commit and is readable.",
    });
  const verify = await git(rt, repo.dir, ["bundle", "verify", bundlePath]);
  if (!succeeded(verify))
    return blockedOutcome(base, {
      what: "Repository bundle",
      reason: `git bundle verify failed: ${rt.failure(verify)}`,
      remediation: "Re-run the capture; check disk space.",
    });
  const reach = await git(rt, repo.dir, [
    "for-each-ref",
    "--contains",
    headSha,
    "--count=1",
    "--format=%(refname)",
  ]);
  if (reach.stdout.trim() === "" && headNow !== headSha)
    return blockedOutcome(base, {
      what: `Revision ${ref}`,
      reason:
        "the requested commit is not reachable from any ref or HEAD, so the bundle does not contain it",
      remediation: "Create a branch or tag at the commit and capture again.",
    });
  return null;
}

const NO_WORKTREE: WorktreeResult = {
  included: false,
  dirty: 0,
  untracked: 0,
  dirtyPaths: [],
  untrackedPaths: [],
  patch: false,
  omissions: [],
};

/** Working-tree changes are only meaningful relative to HEAD of a non-bare local checkout. */
async function captureWorkingTree(
  rt: CaptureRuntime,
  staged: Staged,
  prepared: Prepared,
  ref: string,
): Promise<{
  worktree: WorktreeResult;
  ignored: number | null;
  omissions: Omission[];
}> {
  const { repo, remote, headSha, headNow } = prepared;
  if (remote || repo.bare || headNow !== headSha)
    return {
      worktree: NO_WORKTREE,
      ignored: null,
      omissions: [
        {
          what: "Working-tree changes",
          reason: remote
            ? "A remote source is captured from a mirror clone, which has no working tree."
            : repo.bare
              ? "The repository is bare."
              : `Working-tree changes are relative to HEAD (${headNow?.slice(0, 12) ?? "none"}) but ${ref} resolves to ${headSha.slice(0, 12)}.`,
          remediation: remote
            ? "Capture from a runner-local checkout."
            : "Capture with ref HEAD to include uncommitted work.",
        },
      ],
    };
  const worktree = await captureWorktree(rt, staged, repo);
  return {
    worktree,
    ignored: await countIgnored(rt, repo),
    omissions: worktree.omissions,
  };
}

/** Restore steps: the checkout subset (also used to build scan checkouts) and the LFS extras. */
function buildSteps(
  id: string,
  root: string,
  sha: string,
  parts: { lfs: LfsSummary; submodules: SubmoduleResult; patch: boolean },
): { checkoutSteps: RestoreStep[]; restoreSteps: RestoreStep[] } {
  const pkg = (rel: string): string => `{{package_root}}/${root}${rel}`;
  const sid = safeSegment(id);
  const target = `{{target}}/${id}`;
  const noSmudge = parts.lfs.uses ? LFS_SKIP_SMUDGE : [];
  const checkoutSteps: RestoreStep[] = [
    stepOf({
      id: `${sid}-clone`,
      title: "Clone the repository bundle",
      run: [
        "git",
        ...noSmudge,
        "clone",
        "--no-hardlinks",
        pkg("repo.bundle"),
        target,
      ],
      requires: ["git"],
      scope: "clean_build",
    }),
    stepOf({
      id: `${sid}-checkout`,
      title: `Check out ${sha.slice(0, 12)}`,
      run: ["git", ...noSmudge, "-C", target, "checkout", "--detach", sha],
      requires: ["git"],
      scope: "clean_build",
    }),
    ...parts.submodules.steps,
  ];
  if (parts.patch)
    checkoutSteps.push(
      stepOf({
        id: `${sid}-worktree`,
        title: "Apply captured working-tree changes",
        run: [
          "git",
          "-C",
          target,
          "apply",
          "--binary",
          "--whitespace=nowarn",
          pkg("worktree.patch"),
        ],
        requires: ["git"],
        scope: "clean_build",
      }),
    );
  const restoreSteps = [...checkoutSteps];
  if (parts.lfs.uses && parts.lfs.count > 0)
    restoreSteps.push(
      stepOf({
        id: `${sid}-lfs-objects`,
        title: "Place Git LFS objects in the local store",
        run: ["cp", "-R", pkg("lfs/."), `${target}/.git/lfs/`],
        requires: ["cp"],
        scope: "clean_build",
      }),
      stepOf({
        id: `${sid}-lfs-install`,
        title: "Enable Git LFS filters in the clone",
        run: ["git", "-C", target, "lfs", "install", "--local"],
        requires: ["git", "git-lfs"],
        scope: "clean_build",
      }),
      stepOf({
        id: `${sid}-lfs-checkout`,
        title: "Materialise LFS files from the local store",
        run: ["git", "-C", target, "lfs", "checkout"],
        requires: ["git", "git-lfs"],
        scope: "clean_build",
      }),
    );
  return { checkoutSteps, restoreSteps };
}

const MAX_LISTED_PATHS = 1000;

export async function capture(
  decl: SourceDecl,
  rt: CaptureRuntime,
): Promise<CollectorOutcome> {
  const id = decl.id;
  const cid = componentId(decl);
  const root = `source/${id}/`;
  const base: Base = {
    title: `Source (${id})`,
    method: "git bundle create --all",
    root,
  };
  const source = rt.build.source;
  const ref = refOf(source);
  const loc = resolveLocation(source, rt.ctx.localPaths);
  const start = rt.now();
  if (loc.kind === "unresolved")
    return blockedOutcome(base, {
      what: "Source repository",
      reason: loc.reason,
      remediation: loc.remediation,
    });
  if (!validRef(ref))
    return blockedOutcome(base, {
      what: "Source repository",
      reason: "ref must be non-empty and must not start with '-'",
      remediation: "Declare a branch, tag or commit as the ref.",
    });
  const prepared = await prepare(rt, loc, ref, base);
  if ("status" in prepared) return prepared;
  const { repo, remote, headSha, headNow, refs, origin } = prepared;

  const staged: Staged = { stage: await rt.stageDir(cid), prefix: root };
  const bundleFailure = await writeBundle(
    rt,
    prepared,
    ref,
    join(staged.stage, root, "repo.bundle"),
    base,
  );
  if (bundleFailure !== null) return bundleFailure;

  const omissions: Omission[] = [];
  const limitations: string[] = [
    "Git history is preserved verbatim: any secret that was ever committed is inside repo.bundle. Secret-scrubbing is not applied to repository content.",
    "Git-ignored files (for example .env) are never captured. Repository-local configuration and hooks (.git/config, .git/hooks) are not captured.",
    "Neither a PRD nor decompiled output is an exact-source backup; this component is the exact-source record.",
  ];
  if (refs.some((r) => r.name === "refs/stash"))
    limitations.push(
      "refs/stash is part of the bundle, so stashed changes are preserved as commits.",
    );

  // The working tree is captured relative to HEAD of a local, non-bare checkout.
  const wantWorktree = source.include_working_tree;
  const worktreeUsable = !remote && !repo.bare && headNow === headSha;
  const submodules = await captureSubmodules(
    rt,
    prepared,
    source,
    staged,
    id,
    wantWorktree && worktreeUsable,
  );
  omissions.push(...submodules.omissions);
  const lfs = await captureLfs(
    rt,
    staged,
    repo,
    headSha,
    remote,
    source.include_lfs,
    loc.kind === "remote" ? credentialEnv(loc.url) : {},
  );
  omissions.push(...lfs.omissions);
  let worktree = NO_WORKTREE;
  let ignored: number | null = null;
  if (wantWorktree) {
    const captured = await captureWorkingTree(rt, staged, prepared, ref);
    worktree = captured.worktree;
    ignored = captured.ignored;
    omissions.push(...captured.omissions);
    if (worktree.included && lfs.summary.uses)
      limitations.push(
        "Modified LFS-tracked files appear in worktree.patch as LFS pointers; their new payloads are not part of the lfs/ store.",
      );
    if (worktree.patch)
      limitations.push(
        "worktree.patch contains every untracked file that git does not ignore, verbatim: any secret stored in such a file (for example an un-ignored .env) is inside the package.",
      );
  }

  await writeStaged(
    staged.stage,
    `${root}revision.json`,
    jsonText(
      {
        ref,
        head_sha: headSha,
        head_at_capture: headNow,
        refs,
        submodules: submodules.records,
        lfs: {
          uses_lfs: lfs.summary.uses,
          count: lfs.summary.count,
          bytes: lfs.summary.bytes,
          included: lfs.summary.included,
        },
        working_tree: {
          requested: wantWorktree,
          included: worktree.included,
          patch: worktree.patch,
          modified_paths: worktree.dirtyPaths.slice(0, MAX_LISTED_PATHS),
          untracked_paths: worktree.untrackedPaths.slice(0, MAX_LISTED_PATHS),
          lists_truncated:
            worktree.dirtyPaths.length > MAX_LISTED_PATHS ||
            worktree.untrackedPaths.length > MAX_LISTED_PATHS,
          ignored_entries_not_captured: ignored,
        },
      },
      rt.ctx.redactor,
    ),
  );

  const { checkoutSteps, restoreSteps } = buildSteps(id, root, headSha, {
    lfs: lfs.summary,
    submodules,
    patch: worktree.patch,
  });
  const revision: SourceRevision = {
    repository: loc.label,
    remote_url_redacted: origin === null ? null : redactUrl(origin),
    head_sha: headSha,
    refs,
    submodules: submodules.records.map((s) => ({
      path: s.path,
      sha: s.sha,
      url: s.url,
    })),
    lfs: {
      count: lfs.summary.count,
      bytes: lfs.summary.bytes,
      included: lfs.summary.included,
    },
    working_tree: {
      included: worktree.included,
      dirty_files: worktree.dirty,
      untracked_files: worktree.untracked,
    },
  };
  return {
    ...emptyOutcome(base),
    status: omissions.length > 0 ? "partial" : "captured",
    limitations,
    omissions,
    restoreSteps,
    capturedAt: { start: start.toISOString(), end: rt.now().toISOString() },
    stageDir: staged.stage,
    sourceRevision: revision,
    sourceInfo: { declId: id, componentId: cid, headSha, checkoutSteps },
    tools: ["git", ...(lfs.summary.uses ? ["git-lfs"] : [])],
    details: {
      ref,
      head_sha: headSha,
      location: remote ? "remote (mirror clone)" : "local repository",
      refs_recorded: refs.length,
      submodules: submodules.records,
      lfs: lfs.summary,
      working_tree: {
        requested: wantWorktree,
        included: worktree.included,
        modified: worktree.dirty,
        untracked: worktree.untracked,
        patch: worktree.patch,
      },
      files: {
        bundle: `${root}repo.bundle`,
        revision: `${root}revision.json`,
        ...(worktree.patch ? { worktree_patch: `${root}worktree.patch` } : {}),
      },
      bundle_verified: true,
    },
  };
}

async function captureSubmodules(
  rt: CaptureRuntime,
  prepared: Prepared,
  source: Source,
  staged: Staged,
  sourceId: string,
  workingTree: boolean,
): Promise<SubmoduleResult> {
  const { repo, remote, headSha } = prepared;
  if (source.include_submodules)
    return bundleSubmodules(rt, repo, headSha, {
      sourceId,
      staged,
      bundles: !remote && !repo.bare,
      skipReason: remote
        ? "remote sources are captured from a mirror clone, which has no initialised submodules"
        : "submodule repositories were not bundled",
      workingTree,
    });
  const links = await gitlinks(rt, repo.dir, headSha);
  const urls = await gitmodulesUrls(rt, repo.dir, headSha);
  return {
    records: links.map((l) => ({
      path: l.path,
      sha: l.sha,
      url: urls.has(l.path) ? redactUrl(urls.get(l.path) as string) : null,
      bundle: null,
      checked_out_sha: null,
    })),
    omissions:
      links.length === 0
        ? []
        : [
            {
              what: "Submodule repositories",
              reason:
                "The build source declares include_submodules: false; only gitlinks (path and commit) are recorded.",
              remediation: "Set include_submodules to true and capture again.",
            },
          ],
    steps: [],
  };
}
