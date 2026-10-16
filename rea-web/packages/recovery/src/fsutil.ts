import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { validateRelativePath } from "@rea-web/contracts";
import { PackageFormatError } from "./errors.js";

export const MANIFEST_FILE = "manifest.json";
export const SIGNATURE_FILE = "manifest.json.sig";
export const RECOVERY_GUIDE_FILE = "RECOVERY.md";
export const MANIFEST_SCHEMA_FILE = "recovery/manifest.v1.schema.json";
export const LICENSES_FILE = "licenses/README.md";

/** O_NOFOLLOW makes `open` fail on a symlink, closing the lstat/open race. */
export const O_NOFOLLOW: number = fsConstants.O_NOFOLLOW ?? 0;

export const sha256Hex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

export const tempSibling = (path: string): string =>
  `${path}.partial-${process.pid}-${randomBytes(6).toString("hex")}`;

/** Normalise a manifest/archive relative path or throw a format error. */
export const requireRelativePath = (member: string, what: string): string => {
  const validated = validateRelativePath(member);
  if (!validated.ok)
    throw new PackageFormatError(
      `${what} ${JSON.stringify(member)} is not a safe relative path (${validated.rejection.kind})`,
    );
  return validated.path;
};

/** Write a file atomically: temp sibling then rename. */
export const writeFileAtomic = async (
  path: string,
  data: string | Uint8Array,
): Promise<void> => {
  const tmp = tempSibling(path);
  try {
    await writeFile(tmp, data, { flag: "wx" });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
};

/** Open a regular file without following a final symlink; reject non-files. */
export const openRegularFile = async (path: string): Promise<FileHandle> => {
  const handle = await open(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new PackageFormatError(`${path} is not a regular file`);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
};

/** Hash a regular file, never following symlinks. */
export const hashFile = async (
  path: string,
  signal?: AbortSignal,
): Promise<{ sha256: string; size: number }> => {
  const handle = await openRegularFile(path);
  try {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted();
      const buf = chunk as Buffer;
      hash.update(buf);
      size += buf.length;
    }
    return { sha256: hash.digest("hex"), size };
  } finally {
    await handle.close();
  }
};

/**
 * Resolve symlinks in the deepest existing ancestor of `path` and re-append the
 * not-yet-existing remainder, so containment checks hold for paths that will be
 * created later.
 */
export const canonicalize = async (path: string): Promise<string> => {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return rest.length === 0 ? real : join(real, ...rest.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.push(current.slice(parent.length).replace(/^[\\/]+/u, ""));
      current = parent;
    }
  }
};

export const isInsideOrEqual = (root: string, candidate: string): boolean =>
  candidate === root ||
  candidate.startsWith(root.endsWith(sep) ? root : root + sep);

export type TreeEntry =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "directory"; readonly path: string }
  | { readonly kind: "unsafe"; readonly path: string };

/**
 * Enumerate a package tree with lstat semantics. Symlinks and special files are
 * reported as `unsafe` and never descended into. Output is sorted by path.
 */
export const walkTree = async (root: string): Promise<TreeEntry[]> => {
  const out: TreeEntry[] = [];
  const visit = async (abs: string, rel: string): Promise<void> => {
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        out.push({ kind: "unsafe", path: relPath });
      } else if (entry.isDirectory()) {
        out.push({ kind: "directory", path: relPath });
        await visit(join(abs, entry.name), relPath);
      } else {
        out.push({ kind: "file", path: relPath });
      }
    }
  };
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory())
    throw new PackageFormatError(`${root} is not a directory`);
  await visit(root, "");
  return out.sort((a, b) => compareCodepoints(a.path, b.path));
};

/** Locale-independent (UTF-16 code unit) ordering so output is deterministic. */
export const compareCodepoints = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
