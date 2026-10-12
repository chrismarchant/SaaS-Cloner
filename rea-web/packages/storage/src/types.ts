import type { Readable } from "node:stream";

export interface ObjectStat {
  key: string;
  size: number;
  /** Lowercase hex SHA-256 of the stored bytes, or null when unknown. */
  sha256: string | null;
  contentType: string | null;
  lastModified: Date | null;
}

export interface PutResult {
  key: string;
  size: number;
  sha256: string;
}

export interface ListPage {
  keys: ObjectStat[];
  nextCursor: string | null;
}

export interface PutOptions {
  contentType?: string;
  contentLength?: number;
  /** fail if sha256 of the written bytes differs */
  expectedSha256?: string;
  /** abort the write */
  signal?: AbortSignal;
  /** reject writes larger than this many bytes */
  maxBytes?: number;
}

export interface ObjectStore {
  readonly backend: "fs" | "s3";
  put(
    key: string,
    body: Readable | Uint8Array | string,
    options?: PutOptions,
  ): Promise<PutResult>;
  /** Throws ObjectNotFoundError when the object does not exist. */
  get(key: string, options?: { signal?: AbortSignal }): Promise<Readable>;
  head(key: string): Promise<ObjectStat | null>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  list(
    prefix: string,
    options?: { cursor?: string | undefined; limit?: number },
  ): Promise<ListPage>;
  /** s3 only. */
  presignGet?(key: string, ttlSeconds: number): Promise<string>;
}
