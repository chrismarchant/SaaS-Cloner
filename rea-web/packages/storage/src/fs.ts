import { randomUUID } from "node:crypto";
import { constants, createWriteStream, type Dirent, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveWithin } from "@rea-web/contracts";
import {
  InvalidObjectKeyError,
  ObjectNotFoundError,
  isAbortError,
  makeAbortError,
} from "./errors.js";
import { validateListPrefix, validateObjectKey } from "./keys.js";
import {
  MeterTransform,
  checkWritten,
  normalisePutOptions,
  parseSha256,
  toReadable,
} from "./stream.js";
import type {
  ListPage,
  ObjectStat,
  ObjectStore,
  PutOptions,
  PutResult,
} from "./types.js";

const TMP_DIR = ".tmp";
const META_DIR = ".meta";
const RESERVED_ROOT_NAMES: ReadonlySet<string> = new Set([TMP_DIR, META_DIR]);
const DEFAULT_LIST_LIMIT = 1000;
const MAX_LIST_LIMIT = 1000;

type Probe =
  | { kind: "missing" }
  | { kind: "symlink" }
  | { kind: "directory" }
  | { kind: "other" }
  /** A parent component exists but is not a directory. */
  | { kind: "not_directory" }
  | { kind: "file"; stats: Stats };

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

const isMissingError = (error: unknown): boolean => {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * Inspect `segments` under `base` one component at a time with `lstat`, never
 * following a symlink at any depth.
 */
const probe = async (
  base: string,
  segments: readonly string[],
): Promise<Probe> => {
  let current = base;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let stats: Stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (isMissingError(error)) return { kind: "missing" };
      throw error;
    }
    if (stats.isSymbolicLink()) return { kind: "symlink" };
    if (index < segments.length - 1) {
      if (!stats.isDirectory()) return { kind: "not_directory" };
      continue;
    }
    if (stats.isFile()) return { kind: "file", stats };
    return stats.isDirectory() ? { kind: "directory" } : { kind: "other" };
  }
  return { kind: "directory" };
};

/** Create directories one component at a time, refusing symlinks. */
const ensureDirs = async (
  base: string,
  segments: readonly string[],
  key: string,
): Promise<void> => {
  let current = base;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const stats = await lstat(current);
    if (stats.isSymbolicLink())
      throw new InvalidObjectKeyError(key, "symlink_in_path");
    if (!stats.isDirectory())
      throw new InvalidObjectKeyError(key, "parent_is_object");
  }
};

interface Sidecar {
  readonly sha256: string;
  readonly size: number;
  readonly contentType: string | null;
}

const parseSidecar = (raw: string): Sidecar | null => {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    const sha256 = parseSha256(record["sha256"]);
    const size = record["size"];
    const contentType = record["contentType"];
    if (sha256 === null || typeof size !== "number") return null;
    return {
      sha256,
      size,
      contentType: typeof contentType === "string" ? contentType : null,
    };
  } catch {
    return null;
  }
};

const rmQuiet = (path: string): Promise<void> =>
  rm(path, { force: true }).catch(() => undefined);

export function createFsObjectStore(options: { root: string }): ObjectStore {
  const root = resolve(options.root);
  const tmpRoot = join(root, TMP_DIR);
  const metaRoot = join(root, META_DIR);

  const parse = (key: string): { key: string; segments: string[] } => {
    const valid = validateObjectKey(key);
    const segments = valid.split("/");
    if (RESERVED_ROOT_NAMES.has(segments[0] ?? ""))
      throw new InvalidObjectKeyError(key, "reserved_name");
    const contained = resolveWithin(root, valid);
    if (!contained.ok)
      throw new InvalidObjectKeyError(key, contained.rejection.kind);
    return { key: valid, segments };
  };

  const sidecarSegments = (segments: readonly string[]): string[] => [
    ...segments.slice(0, -1),
    `${segments[segments.length - 1] ?? ""}.json`,
  ];

  const readSidecar = async (
    segments: readonly string[],
  ): Promise<Sidecar | null> => {
    const sidecar = sidecarSegments(segments);
    const found = await probe(metaRoot, sidecar);
    if (found.kind !== "file") return null;
    try {
      return parseSidecar(await readFile(join(metaRoot, ...sidecar), "utf8"));
    } catch (error) {
      if (isMissingError(error)) return null;
      throw error;
    }
  };

  const statFor = async (
    key: string,
    segments: readonly string[],
    stats: Stats,
  ): Promise<ObjectStat> => {
    const sidecar = await readSidecar(segments);
    // A sidecar describing a different size belongs to another version of
    // the object; its digest is unknown rather than wrong.
    const trusted = sidecar !== null && sidecar.size === stats.size;
    return {
      key,
      size: stats.size,
      sha256: trusted ? sidecar.sha256 : null,
      contentType: trusted ? sidecar.contentType : null,
      lastModified: stats.mtime,
    };
  };

  const writeSidecar = async (
    key: string,
    segments: readonly string[],
    sidecar: Sidecar,
  ): Promise<void> => {
    const target = sidecarSegments(segments);
    await ensureDirs(root, [META_DIR, ...target.slice(0, -1)], key);
    const tmp = join(tmpRoot, `${randomUUID()}.meta`);
    try {
      await writeFile(tmp, JSON.stringify({ version: 1, ...sidecar }), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(tmp, join(metaRoot, ...target));
    } catch (error) {
      await rmQuiet(tmp);
      throw error;
    }
  };

  const put = async (
    rawKey: string,
    body: Readable | Uint8Array | string,
    putOptions?: PutOptions,
  ): Promise<PutResult> => {
    const { key, segments } = parse(rawKey);
    const opts = normalisePutOptions(key, putOptions);
    const { signal } = opts;
    if (signal?.aborted) throw makeAbortError(signal);

    const existing = await probe(root, segments);
    if (existing.kind === "symlink")
      throw new InvalidObjectKeyError(key, "symlink_in_path");
    if (existing.kind === "directory" || existing.kind === "other")
      throw new InvalidObjectKeyError(key, "conflicts_with_existing_entry");
    if (existing.kind === "not_directory")
      throw new InvalidObjectKeyError(key, "parent_is_object");

    await mkdir(root, { recursive: true });
    await ensureDirs(root, [TMP_DIR], key);
    const tmp = join(tmpRoot, randomUUID());
    const meter = new MeterTransform(key, opts.maxBytes);
    try {
      await pipeline(
        toReadable(body),
        meter,
        createWriteStream(tmp, { flags: "wx", mode: 0o600 }),
        signal === undefined ? {} : { signal },
      );
      if (signal?.aborted) throw makeAbortError(signal);
      const written = { sha256: meter.sha256(), size: meter.bytesSeen };
      const mismatch = checkWritten(key, opts, written);
      if (mismatch !== null) throw mismatch;

      await ensureDirs(root, segments.slice(0, -1), key);
      const target = join(root, ...segments);
      // Drop the previous digest first: between here and the sidecar write a
      // reader sees an unknown digest, never a stale one.
      await rmQuiet(join(metaRoot, ...sidecarSegments(segments)));
      await rename(tmp, target);
      try {
        await writeSidecar(key, segments, {
          ...written,
          contentType: opts.contentType ?? null,
        });
      } catch (error) {
        await rmQuiet(target);
        throw error;
      }
      return { key, ...written };
    } catch (error) {
      await rmQuiet(tmp);
      if (signal?.aborted && !isAbortError(error)) throw makeAbortError(signal);
      throw error;
    }
  };

  const get = async (
    rawKey: string,
    getOptions?: { signal?: AbortSignal },
  ): Promise<Readable> => {
    const { key, segments } = parse(rawKey);
    const signal = getOptions?.signal;
    if (signal?.aborted) throw makeAbortError(signal);
    const found = await probe(root, segments);
    if (found.kind !== "file") throw new ObjectNotFoundError(key);
    let handle;
    try {
      // O_NOFOLLOW closes the lstat/open race on the final component.
      handle = await open(
        join(root, ...segments),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (isMissingError(error) || errorCode(error) === "ELOOP")
        throw new ObjectNotFoundError(key);
      throw error;
    }
    const stream = handle.createReadStream();
    if (signal !== undefined) {
      const onAbort = (): void => {
        stream.destroy(makeAbortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      stream.once("close", () => {
        signal.removeEventListener("abort", onAbort);
      });
    }
    return stream;
  };

  const head = async (rawKey: string): Promise<ObjectStat | null> => {
    const { key, segments } = parse(rawKey);
    const found = await probe(root, segments);
    if (found.kind !== "file") return null;
    return statFor(key, segments, found.stats);
  };

  const del = async (rawKey: string): Promise<void> => {
    const { segments } = parse(rawKey);
    const found = await probe(root, segments);
    // Never delete through, or instead of, a symlink.
    if (found.kind === "symlink") return;
    if (found.kind === "file") await rmQuiet(join(root, ...segments));
    if (found.kind === "file" || found.kind === "missing") {
      const sidecar = await probe(metaRoot, sidecarSegments(segments));
      if (sidecar.kind === "file")
        await rmQuiet(join(metaRoot, ...sidecarSegments(segments)));
    }
  };

  /** Depth-first walk yielding keys in ascending lexicographic key order. */
  async function* walk(
    dirPath: string,
    dirKey: string,
    prefix: string,
    cursor: string | undefined,
  ): AsyncGenerator<string> {
    let entries: Dirent[];
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      if (isMissingError(error)) return;
      throw error;
    }
    const candidates = entries
      .filter((entry) => entry.isFile() || entry.isDirectory())
      .filter((entry) => dirKey !== "" || !RESERVED_ROOT_NAMES.has(entry.name))
      .map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
      }))
      .map((entry) => ({
        ...entry,
        order: entry.directory ? `${entry.name}/` : entry.name,
      }))
      .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    for (const entry of candidates) {
      const full = `${dirKey}${entry.name}`;
      if (entry.directory) {
        const sub = `${full}/`;
        if (!sub.startsWith(prefix) && !prefix.startsWith(sub)) continue;
        // Every key below `sub` sorts before the cursor.
        if (cursor !== undefined && sub < cursor && !cursor.startsWith(sub))
          continue;
        yield* walk(join(dirPath, entry.name), sub, prefix, cursor);
      } else {
        if (!full.startsWith(prefix)) continue;
        if (cursor !== undefined && full <= cursor) continue;
        yield full;
      }
    }
  }

  const list = async (
    prefix: string,
    listOptions?: { cursor?: string | undefined; limit?: number },
  ): Promise<ListPage> => {
    validateListPrefix(prefix);
    const limit = listOptions?.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT)
      throw new RangeError(`limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
    if (prefix !== "" && RESERVED_ROOT_NAMES.has(prefix.split("/")[0] ?? ""))
      return { keys: [], nextCursor: null };

    const keys: ObjectStat[] = [];
    let more = false;
    for await (const key of walk(root, "", prefix, listOptions?.cursor)) {
      const segments = key.split("/");
      // Re-check each entry with lstat: it may have changed since readdir.
      const found = await probe(root, segments);
      if (found.kind !== "file") continue;
      if (keys.length === limit) {
        more = true;
        break;
      }
      keys.push(await statFor(key, segments, found.stats));
    }
    const last = keys[keys.length - 1];
    return { keys, nextCursor: more && last !== undefined ? last.key : null };
  };

  return {
    backend: "fs",
    put,
    get,
    head,
    delete: del,
    list,
  };
}
