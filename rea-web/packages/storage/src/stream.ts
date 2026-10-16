import { createHash } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { ObjectIntegrityError, ObjectTooLargeError } from "./errors.js";
import type { PutOptions } from "./types.js";

const toBuffer = (chunk: unknown): Buffer | null => {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (chunk instanceof Uint8Array)
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return null;
};

/** Consume a stream, returning its SHA-256 (lowercase hex) and byte count. */
export async function sha256Stream(
  body: Readable,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of body) {
    const buffer = toBuffer(chunk);
    if (buffer === null) throw new TypeError("stream yielded a non-byte chunk");
    hash.update(buffer);
    size += buffer.byteLength;
  }
  return { sha256: hash.digest("hex"), size };
}

export const toReadable = (body: Readable | Uint8Array | string): Readable => {
  if (body instanceof Readable) return body;
  const buffer = toBuffer(body) ?? Buffer.alloc(0);
  return Readable.from(buffer.byteLength === 0 ? [] : [buffer], {
    objectMode: false,
  });
};

/** Pass-through that counts bytes, hashes them and enforces a size cap. */
export class MeterTransform extends Transform {
  private readonly hash = createHash("sha256");
  private bytes = 0;
  private digestHex: string | null = null;

  constructor(
    private readonly key: string,
    private readonly maxBytes: number | undefined,
  ) {
    super();
  }

  override _transform(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const buffer = toBuffer(chunk);
    if (buffer === null) {
      callback(new TypeError("stream yielded a non-byte chunk"));
      return;
    }
    this.bytes += buffer.byteLength;
    if (this.maxBytes !== undefined && this.bytes > this.maxBytes) {
      callback(new ObjectTooLargeError(this.key, this.maxBytes));
      return;
    }
    this.hash.update(buffer);
    callback(null, buffer);
  }

  /**
   * Named to avoid `size`/`length`: lib-storage sniffs those to guess a
   * stream's total length and would read 0 here.
   */
  get bytesSeen(): number {
    return this.bytes;
  }

  sha256(): string {
    this.digestHex ??= this.hash.digest("hex");
    return this.digestHex;
  }
}

export interface NormalisedPutOptions {
  readonly contentType: string | undefined;
  readonly contentLength: number | undefined;
  readonly expectedSha256: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly maxBytes: number | undefined;
}

const nonNegativeInteger = (name: string, value: number | undefined) => {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative integer`);
};

/** Validate caller options once; rejects a declared length over the cap. */
export const normalisePutOptions = (
  key: string,
  options: PutOptions | undefined,
): NormalisedPutOptions => {
  nonNegativeInteger("maxBytes", options?.maxBytes);
  nonNegativeInteger("contentLength", options?.contentLength);
  const expected = options?.expectedSha256;
  if (expected !== undefined && !/^[0-9a-f]{64}$/iu.test(expected))
    throw new RangeError("expectedSha256 must be 64 hexadecimal characters");
  const maxBytes = options?.maxBytes;
  const contentLength = options?.contentLength;
  if (
    maxBytes !== undefined &&
    contentLength !== undefined &&
    contentLength > maxBytes
  )
    throw new ObjectTooLargeError(key, maxBytes);
  return {
    contentType: options?.contentType,
    contentLength,
    expectedSha256: expected?.toLowerCase(),
    signal: options?.signal,
    maxBytes,
  };
};

/** Compare written bytes with the caller's expectations. */
export const checkWritten = (
  key: string,
  options: NormalisedPutOptions,
  written: { sha256: string; size: number },
): ObjectIntegrityError | null => {
  if (
    options.contentLength !== undefined &&
    options.contentLength !== written.size
  )
    return new ObjectIntegrityError(
      key,
      `size:${options.contentLength}`,
      `size:${written.size}`,
    );
  if (
    options.expectedSha256 !== undefined &&
    options.expectedSha256 !== written.sha256
  )
    return new ObjectIntegrityError(
      key,
      options.expectedSha256,
      written.sha256,
    );
  return null;
};

export const parseSha256 = (value: unknown): string | null =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : null;
