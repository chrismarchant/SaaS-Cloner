import { Transform, type Readable, type TransformCallback } from "node:stream";
import type { FastifyRequest } from "fastify";
import { ApiError, classifyTarget, uuidv7 } from "@rea-web/contracts";
import {
  ObjectTooLargeError,
  type ObjectStore,
  type PutResult,
} from "@rea-web/storage";

const HEAD_BYTES = 512;

/** Pass-through that remembers the first bytes for magic-number sniffing. */
export class HeadTee extends Transform {
  private readonly chunks: Buffer[] = [];
  private captured = 0;
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    if (this.captured < HEAD_BYTES) {
      const slice = chunk.subarray(0, HEAD_BYTES - this.captured);
      this.chunks.push(Buffer.from(slice));
      this.captured += slice.length;
    }
    callback(null, chunk);
  }
  get head(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** 1-255 characters, no path separators, no control characters, not `.`/`..`. */
export const parseTargetName = (
  header: string | string[] | undefined,
): string => {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value.length === 0)
    throw new ApiError("validation_failed", "X-Target-Name header is required");
  if (
    value.length > 255 ||
    /[\\/]/u.test(value) ||
    CONTROL.test(value) ||
    value === "." ||
    value === ".." ||
    value.trim() !== value
  )
    throw new ApiError(
      "validation_failed",
      "X-Target-Name must be 1-255 characters without path separators or control characters",
    );
  return value;
};

export interface UploadSource {
  readonly stream: Readable;
  readonly contentLength: number | undefined;
  /** True when the transport truncated the body at its own cap. */
  truncated(): boolean;
  readonly filename?: string;
}

/** Declared `Content-Length`, when present and well-formed. */
export const declaredLength = (req: FastifyRequest): number | undefined => {
  const raw = req.headers["content-length"];
  if (typeof raw !== "string" || !/^\d+$/u.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
};

export interface StoredUpload extends PutResult {
  readonly head: Buffer;
}

/**
 * Streams a body into the object store under a server-derived key while
 * hashing it, sniffing its head, and enforcing `maxBytes`. On any failure the
 * partially written object is removed.
 */
export const streamIntoStore = async (
  store: ObjectStore,
  key: string,
  source: UploadSource,
  options: { maxBytes: number; onTooLarge: () => ApiError },
): Promise<StoredUpload> => {
  if (
    source.contentLength !== undefined &&
    source.contentLength > options.maxBytes
  )
    throw options.onTooLarge();
  const tee = new HeadTee();
  source.stream.once("error", (error) => tee.destroy(error));
  source.stream.pipe(tee);
  try {
    const result = await store.put(key, tee, {
      maxBytes: options.maxBytes,
      ...(source.contentLength === undefined
        ? {}
        : { contentLength: source.contentLength }),
    });
    if (source.truncated())
      throw new ObjectTooLargeError(key, options.maxBytes);
    return { ...result, head: tee.head };
  } catch (error) {
    source.stream.unpipe(tee);
    source.stream.resume();
    await store.delete(key).catch(() => undefined);
    if (error instanceof ObjectTooLargeError) throw options.onTooLarge();
    throw error;
  }
};

export const targetObjectKey = (projectId: string, targetId: string): string =>
  `projects/${projectId}/targets/${targetId}/payload`;

export const newTargetId = (): string => uuidv7();

export const sniffClass = (name: string, head: Buffer) =>
  classifyTarget({ name, head });
