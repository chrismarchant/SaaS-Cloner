import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import {
  type ArchiveLimits,
  type ArchiveRejection,
  ArchiveAdmission,
  DEFAULT_ARCHIVE_LIMITS,
  resolveWithin,
} from "@rea-web/contracts";
import { IntegrityError, PackageFormatError } from "./errors.js";
import {
  canonicalize,
  hashFile,
  isInsideOrEqual,
  requireRelativePath,
  tempSibling,
  walkTree,
} from "./fsutil.js";
import { readPackage } from "./read.js";

export interface ExportResult {
  path: string;
  size: number;
  sha256: string;
}

/**
 * Deterministic tar of a package directory: POSIX/ustar with PAX only where
 * needed, entries sorted, uid/gid 0, every mtime the manifest's `created_at`,
 * normalised modes, no links. Identical inputs give identical bytes.
 */
export async function packExport(
  root: string,
  outPath: string,
  opts: { gzip?: boolean } = {},
): Promise<ExportResult> {
  const { manifest, root: real } = await readPackage(root);
  const mtime = new Date(manifest.created_at);
  if (Number.isNaN(mtime.getTime()))
    throw new PackageFormatError(
      `manifest created_at ${JSON.stringify(manifest.created_at)} is not a valid date`,
    );
  const out = resolve(outPath);
  if (isInsideOrEqual(real, await canonicalize(out)))
    throw new PackageFormatError(
      "export output path must be outside the package root",
    );
  const prefix = requireRelativePath(basename(real), "package directory name");
  const tree = await walkTree(real);
  const unsafe = tree.filter((e) => e.kind === "unsafe").map((e) => e.path);
  if (unsafe.length > 0)
    throw new IntegrityError(
      `refusing to export symlinks or special files: ${unsafe.slice(0, 5).join(", ")}`,
      unsafe,
    );
  const members = [prefix, ...tree.map((e) => `${prefix}/${e.path}`)];

  const tmp = tempSibling(out);
  try {
    await mkdir(dirname(out), { recursive: true });
    await tar.create(
      {
        file: tmp,
        cwd: dirname(real),
        portable: true,
        noDirRecurse: true,
        follow: false,
        mtime,
        gzip: opts.gzip === true ? { level: 9 } : false,
        // `portable` drops directory mtimes; pin them too for determinism.
        onWriteEntry: (entry) => {
          const e = entry as unknown as { noMtime: boolean; mtime: Date };
          e.noMtime = false;
          e.mtime = mtime;
        },
      },
      members,
    );
    const { sha256, size } = await hashFile(tmp);
    await rename(tmp, out);
    return { path: out, size, sha256 };
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

const describeRejection = (r: ArchiveRejection): string => {
  switch (r.kind) {
    case "too_many_entries":
      return `archive has too many entries (${r.count})`;
    case "entry_too_large":
      return `entry ${r.path} declares ${r.bytes} bytes, above the per-entry limit`;
    case "total_too_large":
      return `archive expands past the total size limit (${r.bytes} bytes)`;
    case "ratio_exceeded":
      return `archive expansion ratio ${r.ratio.toFixed(0)} exceeds the limit`;
    case "link_entry":
      return `archive contains a link entry ${JSON.stringify(r.path)}`;
    case "unsafe_member_path":
      return `unsafe archive member path ${JSON.stringify(r.path)} (${r.rejection.kind})`;
  }
};

const rejectionError = (r: ArchiveRejection): PackageFormatError =>
  new PackageFormatError(describeRejection(r), { rejection: r });

type Admission =
  | { kind: "file"; path: string; mode: number }
  | { kind: "directory"; path: string };

const entryKind = (
  type: string,
): "file" | "directory" | "symlink" | "hardlink" | "other" => {
  switch (type) {
    case "File":
    case "OldFile":
    case "ContiguousFile":
      return "file";
    case "Directory":
      return "directory";
    case "SymbolicLink":
      return "symlink";
    case "Link":
      return "hardlink";
    default:
      return "other";
  }
};

/** Filesystem conflicts caused by archive content are format errors. */
const CONFLICT_CODES = new Set(["EEXIST", "ENOTDIR", "EISDIR", "ENAMETOOLONG"]);

const asFailure = (error: unknown): Error => {
  if (!(error instanceof Error)) return new PackageFormatError(String(error));
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && CONFLICT_CODES.has(code)
    ? new PackageFormatError(
        `archive entries conflict on disk (${code}): ${error.message}`,
        { cause: error },
      )
    : error;
};

class Extractor {
  private readonly admission: ArchiveAdmission;
  private prefix: string | undefined;
  private count = 0;
  private failure: Error | undefined;
  private readonly tasks: Promise<void>[] = [];
  private readonly madeDirs = new Set<string>();
  private notify: () => void = () => undefined;
  readonly failed: Promise<void>;

  constructor(
    private readonly staging: string,
    private readonly archiveBytes: number,
    limits: ArchiveLimits,
  ) {
    this.admission = new ArchiveAdmission(limits);
    this.failed = new Promise<void>((resolveFailed) => {
      this.notify = resolveFailed;
    });
  }

  get error(): Error | undefined {
    return this.failure;
  }
  get entries(): number {
    return this.count;
  }
  get topLevel(): string | undefined {
    return this.prefix;
  }

  fail(error: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = asFailure(error);
    this.notify();
  }

  async settle(): Promise<void> {
    await Promise.allSettled(this.tasks);
  }

  handle(entry: tar.ReadEntry): void {
    if (this.failure !== undefined) {
      entry.resume();
      return;
    }
    const admitted = this.admit(entry);
    if (admitted instanceof Error) {
      this.fail(admitted);
      entry.resume();
      return;
    }
    this.count += 1;
    this.tasks.push(this.write(entry, admitted).catch((e) => this.fail(e)));
  }

  private admit(entry: tar.ReadEntry): Admission | Error {
    const type = entryKind(entry.type);
    const verdict = this.admission.admitEntry({
      path: entry.path,
      declaredBytes: entry.size,
      compressedBytes: this.count === 0 ? this.archiveBytes : null,
      type,
    });
    if (!verdict.ok) return rejectionError(verdict.rejection);
    if (type !== "file" && type !== "directory")
      return new PackageFormatError(
        `unsupported archive entry type ${entry.type} for ${JSON.stringify(entry.path)}`,
      );
    const segments = verdict.path.split("/");
    this.prefix ??= segments[0];
    if (segments[0] !== this.prefix)
      return new PackageFormatError(
        "archive must contain a single top-level package directory",
      );
    if (segments.length === 1 && type === "file")
      return new PackageFormatError(
        `file ${JSON.stringify(verdict.path)} is outside the package directory`,
      );
    return type === "directory"
      ? { kind: "directory", path: verdict.path }
      : {
          kind: "file",
          path: verdict.path,
          mode: ((entry.mode ?? 0) & 0o111) === 0 ? 0o644 : 0o755,
        };
  }

  private async write(
    entry: tar.ReadEntry,
    admitted: Admission,
  ): Promise<void> {
    const target = resolveWithin(this.staging, admitted.path);
    if (!target.ok) {
      entry.resume();
      throw new PackageFormatError(
        `archive member ${JSON.stringify(admitted.path)} escapes the destination`,
      );
    }
    if (admitted.kind === "directory") {
      entry.resume();
      await this.ensureDir(target.path);
      return;
    }
    await this.ensureDir(dirname(target.path));
    if (entry.size === 0) {
      entry.resume();
      await writeFile(target.path, "", { flag: "wx", mode: admitted.mode });
      return;
    }
    // "wx": never overwrite and never follow a pre-existing link.
    await pipeline(
      this.guarded(entry),
      createWriteStream(target.path, { flags: "wx", mode: admitted.mode }),
    );
  }

  private async ensureDir(dir: string): Promise<void> {
    if (this.madeDirs.has(dir)) return;
    await mkdir(dir, { recursive: true, mode: 0o755 });
    this.madeDirs.add(dir);
  }

  /** Entry bytes, counted against the archive limits as they stream. */
  private async *guarded(entry: tar.ReadEntry): AsyncGenerator<Buffer> {
    for await (const chunk of entry as AsyncIterable<Buffer>) {
      if (this.failure !== undefined) throw this.failure;
      const verdict = this.admission.admitBytes(chunk.length);
      if (!verdict.ok) throw rejectionError(verdict.rejection);
      yield chunk;
    }
  }
}

/**
 * Safely extract a package export (plain or gzip tar) under `destDir`.
 * Extraction happens in a private staging directory and is moved into place
 * only if every entry passed admission, so a rejected archive leaves nothing.
 */
export async function unpackExport(
  tarPath: string,
  destDir: string,
  opts: { limits?: ArchiveLimits } = {},
): Promise<{ root: string; entries: number }> {
  const dest = resolve(destDir);
  const archiveBytes = (await stat(tarPath)).size;
  await mkdir(dest, { recursive: true });
  const staging = await mkdtemp(join(dest, ".rea-unpack-"));
  try {
    const extractor = new Extractor(
      staging,
      archiveBytes,
      opts.limits ?? DEFAULT_ARCHIVE_LIMITS,
    );
    await feed(tarPath, extractor);
    const top = extractor.topLevel;
    if (top === undefined)
      throw new PackageFormatError("archive contains no entries");
    const final = join(dest, top);
    await mkdir(final); // fails if it exists: never merge into an existing tree
    try {
      await rename(join(staging, top), final);
    } catch (error) {
      await rm(final, { recursive: true, force: true });
      throw error;
    }
    return { root: final, entries: extractor.entries };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function feed(tarPath: string, extractor: Extractor): Promise<void> {
  const parser = new tar.Parser({
    onReadEntry: (entry) => extractor.handle(entry),
  });
  parser.on("warn", (code: string, message: unknown) =>
    extractor.fail(
      new PackageFormatError(`malformed archive: ${code}: ${String(message)}`),
    ),
  );
  parser.on("error", (error: Error) => extractor.fail(error));
  parser.on("ignoredEntry", (entry: tar.ReadEntry) =>
    extractor.fail(
      new PackageFormatError(
        `unsupported archive entry ${JSON.stringify(entry.path)} (${entry.type})`,
      ),
    ),
  );
  const ended = new Promise<void>((done) => parser.once("end", () => done()));
  const input = createReadStream(tarPath, { highWaterMark: 64 * 1024 });
  const stop = new AbortController();
  try {
    for await (const chunk of input) {
      if (extractor.error !== undefined) break;
      if (!parser.write(chunk as Buffer))
        await Promise.race([
          once(parser, "drain", { signal: stop.signal }).catch(() => undefined),
          extractor.failed,
        ]);
    }
    if (extractor.error === undefined) {
      parser.end();
      await Promise.race([ended, extractor.failed]);
    }
  } finally {
    stop.abort();
    input.destroy();
    await extractor.settle();
  }
  if (extractor.error !== undefined) throw extractor.error;
}
