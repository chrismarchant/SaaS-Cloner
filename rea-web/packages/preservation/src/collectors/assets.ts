import { createHash } from "node:crypto";
import { constants as fsConstants, createWriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { validateRelativePath } from "@rea-web/contracts";
import {
  type CaptureRuntime,
  type CollectorOutcome,
  type Runtime,
  blockedOutcome,
  emptyOutcome,
} from "../runtime.js";
import { captureObjectSource } from "./assets/s3Collector.js";
import { planObjectSource } from "./assets/s3Plan.js";
import {
  type ComponentDeclaration,
  type ComponentPlan,
  type Omission,
  componentId,
} from "../types.js";
import {
  guessContentType,
  jsonText,
  listTree,
  stepOf,
  writeStaged,
} from "../util.js";

type AssetsDecl = Extract<ComponentDeclaration, { kind: "assets" }>;

export interface ObjectRecord {
  path: string;
  size: number;
  sha256: string;
  mtime: string;
  content_type: string;
}

const MAX_SKIP_OMISSIONS = 25;

/** Copy one regular file into `dest` while hashing, refusing symlinks at open time. */
async function copyHashed(
  abs: string,
  dest: string,
): Promise<
  { size: number; sha256: string; mtime: string } | { skipped: string }
> {
  let handle;
  try {
    handle = await open(
      abs,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    return {
      skipped: `cannot open without following links: ${(error as NodeJS.ErrnoException).code ?? "error"}`,
    };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { skipped: "not a regular file" };
    await mkdir(dirname(dest), { recursive: true });
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          size += chunk.length;
          yield chunk;
        }
      },
      createWriteStream(dest, { flags: "wx", mode: 0o644 }),
    );
    return { size, sha256: hash.digest("hex"), mtime: st.mtime.toISOString() };
  } finally {
    await handle.close();
  }
}

export async function plan(
  decl: AssetsDecl,
  rt: Runtime,
): Promise<ComponentPlan> {
  const out: ComponentPlan = {
    id: componentId(decl),
    kind: "assets",
    collector: decl.source.kind,
    permissions: [],
    estimated_bytes: null,
    dependencies: rt.build.components
      .filter((c) => c.kind === "data")
      .map(componentId),
    method: "copy regular files with sha256 manifest",
    omissions: [],
    feasible: false,
  };
  const src = decl.source;
  if (src.kind !== "runner_local") {
    out.method = "s3 list+get";
    return planObjectSource(src, rt, out);
  }
  const dir = rt.ctx.localPaths.get(src.path_hash);
  if (dir === undefined) {
    out.permissions.push({
      check: "runner resolved assets path",
      ok: false,
      detail: `path_hash ${src.path_hash.slice(0, 12)}... not resolved by the runner`,
    });
    return out;
  }
  try {
    const st = await stat(dir);
    out.permissions.push({
      check: "directory readable",
      ok: st.isDirectory(),
      detail: st.isDirectory() ? "readable" : "not a directory",
    });
    if (st.isDirectory()) {
      const listing = await listTree(dir, { skipDirs: null });
      out.estimated_bytes = listing.files.reduce((n, f) => n + f.size, 0);
      if (listing.skipped.length > 0)
        out.omissions.push({
          what: `${listing.skipped.length} symbolic links or special files`,
          reason: "never followed or copied",
          remediation:
            "Replace links with real files if their content must be preserved.",
        });
      if (listing.truncated)
        out.omissions.push({
          what: "Files beyond the listing limit",
          reason: "directory has more than 200000 files",
          remediation: "Split the asset directory.",
        });
    }
  } catch (error) {
    out.permissions.push({
      check: "directory readable",
      ok: false,
      detail: rt.ctx.redactor.redactText((error as Error).message),
    });
  }
  out.feasible = out.permissions.every((p) => p.ok);
  return out;
}

export async function capture(
  decl: AssetsDecl,
  rt: CaptureRuntime,
): Promise<CollectorOutcome> {
  const cid = componentId(decl);
  const root = `assets/${decl.id}/`;
  const base = {
    title: `Assets (${decl.id})`,
    method: "copy regular files with sha256 manifest",
    root,
  };
  const src = decl.source;
  if (src.kind !== "runner_local") return captureObjectSource(decl, src, rt);
  const dir = rt.ctx.localPaths.get(src.path_hash);
  if (dir === undefined)
    return blockedOutcome(base, {
      what: "Assets directory",
      reason: `runner did not resolve path_hash ${src.path_hash.slice(0, 12)}...`,
      remediation: "Run the job on the runner that registered this path.",
    });
  const st = await stat(dir).catch(() => null);
  if (st === null || !st.isDirectory())
    return blockedOutcome(base, {
      what: "Assets directory",
      reason: "path is missing or not a directory",
      remediation: "Check the registered local path.",
    });

  const stage = await rt.stageDir(cid);
  const start = rt.now();
  const listing = await listTree(dir, { skipDirs: null });
  const skipped = [...listing.skipped];
  const objects: ObjectRecord[] = [];
  const seen = new Set<string>();
  for (const f of listing.files) {
    rt.ctx.signal.throwIfAborted();
    const v = validateRelativePath(f.rel);
    if (!v.ok || v.path !== f.rel) {
      skipped.push({
        rel: f.rel,
        reason: "file name is not a safe relative path",
      });
      continue;
    }
    if (seen.has(f.rel.toLowerCase())) {
      skipped.push({
        rel: f.rel,
        reason: "name collides case-insensitively with another file",
      });
      continue;
    }
    seen.add(f.rel.toLowerCase());
    const copied = await copyHashed(
      f.abs,
      join(stage, ...`${root}objects/${f.rel}`.split("/")),
    );
    if ("skipped" in copied) {
      seen.delete(f.rel.toLowerCase());
      skipped.push({ rel: f.rel, reason: copied.skipped });
      continue;
    }
    objects.push({
      path: f.rel,
      size: copied.size,
      sha256: copied.sha256,
      mtime: copied.mtime,
      content_type: guessContentType(f.rel),
    });
  }
  const end = rt.now();
  const omissions: Omission[] = skipped
    .slice(0, MAX_SKIP_OMISSIONS)
    .map((s) => ({
      what: `Skipped ${s.rel}`,
      reason: s.reason,
      remediation:
        "Replace it with a regular file inside the assets directory if its content must be preserved.",
    }));
  if (skipped.length > MAX_SKIP_OMISSIONS)
    omissions.push({
      what: `${skipped.length - MAX_SKIP_OMISSIONS} further skipped entries`,
      reason: "see skipped[] in objects.json",
      remediation: "Replace links and special files with regular files.",
    });
  if (listing.truncated)
    omissions.push({
      what: "Files beyond the listing limit",
      reason: "the directory has more than 200000 files",
      remediation: "Split the asset directory and declare each part.",
    });
  await writeStaged(
    stage,
    `${root}objects.json`,
    jsonText(
      {
        source: "runner_local",
        path_hash: src.path_hash,
        captured_at: { start: start.toISOString(), end: end.toISOString() },
        objects,
        skipped,
        totals: {
          objects: objects.length,
          bytes: objects.reduce((n, o) => n + o.size, 0),
          skipped: skipped.length,
        },
      },
      rt.ctx.redactor,
    ),
  );
  const hasObjects = objects.length > 0;
  const outcome = emptyOutcome(base);
  return {
    ...outcome,
    status: omissions.length > 0 ? "partial" : "captured",
    omissions,
    limitations: [
      "File ownership, permission bits and empty directories are not preserved; modification times are recorded in objects.json only.",
      "The window in captured_at covers reading every file; files changed during that window are captured as they were read.",
    ],
    restoreSteps: hasObjects
      ? [
          stepOf({
            id: `assets-${decl.id.replace(/[^A-Za-z0-9_-]/gu, "_")}-restore`,
            title: `Restore asset files ${decl.id}`,
            run: [
              "cp",
              "-R",
              `{{package_root}}/${root}objects/.`,
              `{{assets_root}}/${decl.id}/`,
            ],
            requires: ["cp"],
            scope: "data_restore",
          }),
        ]
      : [],
    capturedAt: { start: start.toISOString(), end: end.toISOString() },
    stageDir: stage,
    details: {
      objects: objects.length,
      bytes: objects.reduce((n, o) => n + o.size, 0),
      skipped: skipped.length,
    },
    relationships: [...rt.sources.values()]
      .slice(0, 1)
      .map((s) => ({ from: cid, to: s.componentId, kind: "backs" as const })),
  };
}
