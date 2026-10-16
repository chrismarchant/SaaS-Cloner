import { createHash } from "node:crypto";
import { type WriteStream, createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";
import { type Redactor, validateRelativePath } from "@rea-web/contracts";
import { guessContentType } from "../../util.js";
import { type S3Failure, classifyS3Error } from "./s3Errors.js";
import type { S3Target } from "./s3Source.js";

export interface ListedObject {
  /** Key exactly as stored in the bucket (decoded). */
  key: string;
  size: number;
  etag: string | undefined;
  lastModified: Date | undefined;
}

/** Keys of one ListObjectsV2 page, with the token for the next. */
export interface ListedPage {
  objects: ListedObject[];
  next: string | undefined;
}

const decodeUrlKey = (encoded: string): string =>
  decodeURIComponent(encoded.replaceAll("+", " "));

/**
 * One page of keys under `prefix`. Keys are requested URL-encoded so that
 * characters XML cannot carry (control characters) survive; they are decoded
 * only when the service says it encoded them.
 */
export async function listPage(
  client: S3Client,
  bucket: string,
  prefix: string,
  pageSize: number,
  token: string | undefined,
  signal: AbortSignal,
): Promise<ListedPage> {
  const res = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      ...(prefix === "" ? {} : { Prefix: prefix }),
      MaxKeys: pageSize,
      EncodingType: "url",
      ...(token === undefined ? {} : { ContinuationToken: token }),
    }),
    { abortSignal: signal },
  );
  const encoded = res.EncodingType === "url";
  const objects: ListedObject[] = [];
  for (const item of res.Contents ?? []) {
    if (item.Key === undefined) continue;
    objects.push({
      key: encoded ? decodeUrlKey(item.Key) : item.Key,
      size: item.Size ?? 0,
      etag: item.ETag,
      lastModified: item.LastModified,
    });
  }
  return {
    objects,
    next: res.IsTruncated === true ? res.NextContinuationToken : undefined,
  };
}

/** Every key under a prefix, page by page. Errors propagate unclassified. */
export async function* listPages(
  client: S3Client,
  target: S3Target,
  pageSize: number,
  signal: AbortSignal,
): AsyncGenerator<ListedObject[], void, void> {
  let token: string | undefined;
  do {
    signal.throwIfAborted();
    const page = await listPage(
      client,
      target.bucket,
      target.listPrefix,
      pageSize,
      token,
      signal,
    );
    yield page.objects;
    token = page.next;
  } while (token !== undefined);
}

export interface SkippedObject {
  bucket: string;
  key: string;
  reason: string;
  /** True when nothing of value was lost (a zero-byte directory placeholder). */
  benign: boolean;
}

export interface ObjectRecord {
  bucket: string;
  key: string;
  /** Path below `objects/`. */
  path: string;
  size: number;
  sha256: string;
  etag: string | null;
  last_modified: string | null;
  content_type: string;
}

const MAX_RECORDED_SKIPS = 10_000;

/**
 * Writes `objects.json` incrementally (one object per line) so a listing of
 * a million objects never has to exist as one string.
 */
export class ListingWriter {
  private readonly out: WriteStream;
  private failure: Error | null = null;
  private written = 0;
  private skippedKept: SkippedObject[] = [];
  skippedTotal = 0;
  benignTotal = 0;
  private constructor(
    private readonly redactor: Redactor,
    out: WriteStream,
  ) {
    this.out = out;
    out.on("error", (error) => {
      this.failure ??= error;
    });
  }

  static async open(
    file: string,
    redactor: Redactor,
    head: Record<string, unknown>,
  ): Promise<ListingWriter> {
    await mkdir(dirname(file), { recursive: true });
    const writer = new ListingWriter(
      redactor,
      createWriteStream(file, { flags: "wx", mode: 0o644 }),
    );
    const text = JSON.stringify(redactor.redactValue(head));
    await writer.write(`${text.slice(0, -1)},\n"objects": [`);
    return writer;
  }

  private write(chunk: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.failure !== null) {
        reject(this.failure);
        return;
      }
      this.out.write(chunk, (error) =>
        error === null || error === undefined ? resolve() : reject(error),
      );
    });
  }

  addObject(record: ObjectRecord): Promise<void> {
    const line = JSON.stringify(this.redactor.redactValue(record));
    const prefix = this.written === 0 ? "\n" : ",\n";
    this.written += 1;
    return this.write(`${prefix}${line}`);
  }

  addSkipped(entry: SkippedObject): void {
    this.skippedTotal += 1;
    if (entry.benign) this.benignTotal += 1;
    if (this.skippedKept.length < MAX_RECORDED_SKIPS)
      this.skippedKept.push(entry);
  }

  get skipped(): readonly SkippedObject[] {
    return this.skippedKept;
  }

  async finish(tail: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify(
      this.redactor.redactValue({
        skipped: this.skippedKept,
        skipped_not_listed: this.skippedTotal - this.skippedKept.length,
        ...tail,
      }),
    );
    await this.write(`\n],\n${body.slice(1)}\n`);
    await new Promise<void>((resolve, reject) => {
      this.out.end((error?: Error | null) =>
        error === null || error === undefined ? resolve() : reject(error),
      );
    });
  }

  /** Close without a valid tail (an abort is already propagating). */
  abandon(): void {
    this.out.destroy();
  }
}

export type Stop =
  | { kind: "objects_limit"; limit: number }
  | { kind: "bytes_limit"; limit: number }
  | { kind: "failure"; phase: "list" | "read" | "write"; failure: S3Failure };

export interface TargetOutcome {
  target: S3Target;
  /** False when an earlier stop ended the capture before this target began. */
  started: boolean;
  /** True once a listing of this target succeeded. */
  listed: boolean;
  objects: number;
  bytes: number;
  stop: Stop | null;
}

export interface EngineState {
  objects: number;
  bytes: number;
  examined: number;
  /** Reads refused with 403 (object-level denial). */
  deniedReads: number;
  /** Case/Unicode-folded output paths already used. */
  readonly taken: Set<string>;
}

export interface EngineConfig {
  client: S3Client;
  /** Staging directory (package-relative layout). */
  stage: string;
  /** Package-relative component root, ending in `/`. */
  root: string;
  signal: AbortSignal;
  maxObjects: number;
  maxBytes: number;
  pageSize: number;
  writer: ListingWriter;
  state: EngineState;
}

class StopCapture extends Error {
  constructor(readonly stop: Stop) {
    super("capture stopped");
  }
}

const foldPath = (path: string): string => path.normalize("NFC").toLowerCase();

/** Reason a key cannot become a file below `objects/`, or null when it can. */
export function relativeFileFor(
  listed: ListedObject,
  target: S3Target,
): { rel: string } | { skip: string; benign: boolean } {
  const { key } = listed;
  if (!key.startsWith(target.listPrefix))
    return { skip: "key is outside the listed prefix", benign: false };
  const rel = key.slice(target.listPrefix.length);
  if (key.endsWith("/"))
    return listed.size === 0
      ? { skip: "directory placeholder key (zero bytes)", benign: true }
      : {
          skip: "key ends with '/' but holds data, so it cannot be a file",
          benign: false,
        };
  const verdict = validateRelativePath(rel);
  if (!verdict.ok)
    return {
      skip: `key is not a safe relative path (${verdict.rejection.kind})`,
      benign: false,
    };
  if (verdict.path !== rel)
    return {
      skip: "key is not a canonical relative path (backslash, empty or '.' segments)",
      benign: false,
    };
  return { rel };
}

interface Written {
  size: number;
  sha256: string;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
}

/** Delete a file this capture was writing; never fails (a directory is left alone). */
const removePartial = (path: string): Promise<void> =>
  unlink(path).catch(() => undefined);

/** Stream one object to `dest`, hashing as it passes; a partial file never survives. */
async function download(
  cfg: EngineConfig,
  bucket: string,
  listed: ListedObject,
  dest: string,
): Promise<Written | { skip: string; benign: false }> {
  const res = await cfg.client.send(
    new GetObjectCommand({ Bucket: bucket, Key: listed.key }),
    { abortSignal: cfg.signal },
  );
  const body = res.Body as Readable | undefined;
  if (body === undefined)
    throw new Error("the storage service returned no body");
  const hash = createHash("sha256");
  let size = 0;
  await mkdir(dirname(dest), { recursive: true });
  try {
    await pipeline(
      body,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          size += chunk.length;
          yield chunk;
        }
      },
      createWriteStream(dest, { flags: "wx", mode: 0o644 }),
      { signal: cfg.signal },
    );
    if (res.ContentLength !== undefined && size !== res.ContentLength) {
      const error = new Error(`received ${size} of ${res.ContentLength} bytes`);
      error.name = "NetworkingError";
      throw error;
    }
    if (size !== listed.size) {
      await removePartial(dest);
      return {
        skip: `size changed since it was listed (listed ${listed.size} bytes, received ${size})`,
        benign: false,
      };
    }
  } catch (error) {
    await removePartial(dest);
    throw error;
  }
  return {
    size,
    sha256: hash.digest("hex"),
    etag: res.ETag ?? listed.etag ?? null,
    lastModified:
      (res.LastModified ?? listed.lastModified)?.toISOString() ?? null,
    contentType: res.ContentType ?? null,
  };
}

async function captureObject(
  cfg: EngineConfig,
  target: S3Target,
  listed: ListedObject,
): Promise<void> {
  const { state, writer } = cfg;
  state.examined += 1;
  if (state.examined > cfg.maxObjects)
    throw new StopCapture({ kind: "objects_limit", limit: cfg.maxObjects });
  const skip = (reason: string, benign: boolean): void =>
    writer.addSkipped({
      bucket: target.bucket,
      key: listed.key,
      reason,
      benign,
    });
  const file = relativeFileFor(listed, target);
  if ("skip" in file) return skip(file.skip, file.benign);
  const path = `${target.outDir}${file.rel}`;
  const folded = foldPath(path);
  if (state.taken.has(folded))
    return skip(
      "output name collides case-insensitively (or by Unicode normalisation) with another object",
      false,
    );
  if (state.bytes + listed.size > cfg.maxBytes)
    throw new StopCapture({ kind: "bytes_limit", limit: cfg.maxBytes });
  state.taken.add(folded);
  const dest = join(cfg.stage, ...`${cfg.root}objects/${path}`.split("/"));
  let written: Awaited<ReturnType<typeof download>>;
  try {
    written = await download(cfg, target.bucket, listed, dest);
  } catch (error) {
    state.taken.delete(folded);
    if (cfg.signal.aborted) throw error;
    const failure = classifyS3Error(error);
    switch (failure.kind) {
      case "no_such_key":
        return skip("object was deleted after it was listed", false);
      case "precondition":
        return skip("object was modified after it was listed", false);
      case "access_denied":
        state.deniedReads += 1;
        return skip(`read denied (${failure.message})`, false);
      case "local_conflict":
        return skip(
          `cannot be stored as a file next to another object (${failure.message})`,
          false,
        );
      default:
        throw new StopCapture({
          kind: "failure",
          phase: failure.kind === "local_io" ? "write" : "read",
          failure,
        });
    }
  }
  if ("skip" in written) {
    state.taken.delete(folded);
    return skip(written.skip, written.benign);
  }
  state.objects += 1;
  state.bytes += written.size;
  await writer.addObject({
    bucket: target.bucket,
    key: listed.key,
    path,
    size: written.size,
    sha256: written.sha256,
    etag: written.etag,
    last_modified: written.lastModified,
    content_type: written.contentType ?? guessContentType(file.rel),
  });
}

/** Limits and transport or local failures end the capture; a refused bucket does not. */
const haltsCapture = (stop: Stop): boolean =>
  stop.kind !== "failure" ||
  stop.failure.kind === "network" ||
  stop.failure.kind === "local_io" ||
  stop.failure.kind === "other";

/**
 * Capture every target in order, listing and reading page by page. Stops at
 * the first limit or storage failure; what was written before stays.
 */
export async function captureTargets(
  cfg: EngineConfig,
  targets: readonly S3Target[],
): Promise<TargetOutcome[]> {
  const outcomes: TargetOutcome[] = [];
  let halted: Stop | null = null;
  for (const target of targets) {
    const outcome: TargetOutcome = {
      target,
      started: halted === null,
      listed: false,
      objects: 0,
      bytes: 0,
      stop: halted,
    };
    outcomes.push(outcome);
    if (halted !== null) continue;
    const before = { objects: cfg.state.objects, bytes: cfg.state.bytes };
    try {
      const pages = listPages(cfg.client, target, cfg.pageSize, cfg.signal);
      for (;;) {
        let next: IteratorResult<ListedObject[], void>;
        try {
          next = await pages.next();
        } catch (error) {
          if (cfg.signal.aborted) throw error;
          throw new StopCapture({
            kind: "failure",
            phase: "list",
            failure: classifyS3Error(error),
          });
        }
        if (next.done === true) break;
        outcome.listed = true;
        for (const listed of next.value) {
          cfg.signal.throwIfAborted();
          await captureObject(cfg, target, listed);
        }
      }
    } catch (error) {
      if (!(error instanceof StopCapture)) throw error;
      outcome.stop = error.stop;
      if (haltsCapture(error.stop)) halted = error.stop;
    }
    outcome.objects = cfg.state.objects - before.objects;
    outcome.bytes = cfg.state.bytes - before.bytes;
  }
  return outcomes;
}
