import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  InvalidObjectKeyError,
  ObjectNotFoundError,
  ObjectTooLargeError,
  isAbortError,
  makeAbortError,
} from "./errors.js";
import { validateListPrefix, validateObjectKey } from "./keys.js";
import {
  MeterTransform,
  checkWritten,
  normalisePutOptions,
  parseSha256,
  type NormalisedPutOptions,
} from "./stream.js";
import type {
  ListPage,
  ObjectStat,
  ObjectStore,
  PutOptions,
  PutResult,
} from "./types.js";

/** S3 minimum multipart part size; bodies below it use a single PutObject. */
const PART_SIZE = 5 * 1024 * 1024;
const QUEUE_SIZE = 4;
/** CopyObject (used to attach a digest to streamed uploads) caps at 5 GiB. */
const MAX_STREAMED_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_LIST_LIMIT = 1000;
const MAX_LIST_LIMIT = 1000;
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

export interface S3ObjectStoreOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
}

const httpStatus = (error: unknown): number | undefined => {
  const meta = (error as { $metadata?: { httpStatusCode?: number } } | null)
    ?.$metadata;
  return meta?.httpStatusCode;
};

const isObjectMissing = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (error.name === "NoSuchKey" || error.name === "NotFound") return true;
  return httpStatus(error) === 404 && error.name !== "NoSuchBucket";
};

const normalisePrefix = (prefix: string | undefined): string => {
  if (prefix === undefined || prefix === "") return "";
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  try {
    validateObjectKey(trimmed);
  } catch {
    throw new InvalidObjectKeyError(prefix, "invalid_store_prefix");
  }
  return `${trimmed}/`;
};

export function createS3ObjectStore(
  options: S3ObjectStoreOptions,
): ObjectStore {
  const { bucket } = options;
  const storePrefix = normalisePrefix(options.prefix);
  const client = new S3Client({
    region: options.region,
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.forcePathStyle === undefined
      ? {}
      : { forcePathStyle: options.forcePathStyle }),
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    // Many S3-compatible services (Railway buckets among them) reject the
    // CRC32 trailers the SDK adds by default; only send/verify when required.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  const remoteKey = (key: string): string => `${storePrefix}${key}`;

  const statFromHead = (
    key: string,
    head: {
      ContentLength?: number | undefined;
      ContentType?: string | undefined;
      LastModified?: Date | undefined;
      Metadata?: Record<string, string> | undefined;
    },
  ): ObjectStat => ({
    key,
    size: head.ContentLength ?? 0,
    sha256: parseSha256(head.Metadata?.["sha256"]),
    contentType: head.ContentType ?? null,
    lastModified: head.LastModified ?? null,
  });

  const deleteRemote = async (key: string): Promise<void> => {
    await client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: remoteKey(key) }),
    );
  };

  /** Upload a streamed body, hashing as it passes through. */
  const uploadStream = async (
    key: string,
    source: Readable,
    opts: NormalisedPutOptions,
  ): Promise<{ sha256: string; size: number; etag: string | undefined }> => {
    const meter = new MeterTransform(key, opts.maxBytes);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const upload = new Upload({
      client,
      partSize: PART_SIZE,
      queueSize: QUEUE_SIZE,
      leavePartsOnError: false,
      params: {
        Bucket: bucket,
        Key: remoteKey(key),
        Body: meter,
        ...(opts.contentType === undefined
          ? {}
          : { ContentType: opts.contentType }),
        // A caller-supplied digest can be recorded up front; otherwise it is
        // attached after the upload, once the stream has been hashed.
        ...(opts.expectedSha256 === undefined
          ? {}
          : { Metadata: { sha256: opts.expectedSha256 } }),
      },
    });
    try {
      const piped = pipeline(source, meter, {
        signal: controller.signal,
      }).catch((error: unknown) => {
        void upload.abort().catch(() => undefined);
        throw error;
      });
      const uploaded = upload.done().catch((error: unknown) => {
        controller.abort(error);
        throw error;
      });
      const [pipeResult, uploadResult] = await Promise.allSettled([
        piped,
        uploaded,
      ]);
      if (opts.signal?.aborted) throw makeAbortError(opts.signal);
      if (pipeResult.status === "rejected") throw pipeResult.reason;
      if (uploadResult.status === "rejected") throw uploadResult.reason;
      return {
        sha256: meter.sha256(),
        size: meter.bytesSeen,
        etag: uploadResult.value.ETag,
      };
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      source.destroy();
    }
  };

  const uploadBuffer = async (
    key: string,
    body: Uint8Array,
    sha256: string,
    opts: NormalisedPutOptions,
  ): Promise<void> => {
    const upload = new Upload({
      client,
      partSize: PART_SIZE,
      queueSize: QUEUE_SIZE,
      leavePartsOnError: false,
      params: {
        Bucket: bucket,
        Key: remoteKey(key),
        Body: body,
        Metadata: { sha256 },
        ...(opts.contentType === undefined
          ? {}
          : { ContentType: opts.contentType }),
      },
    });
    const onAbort = (): void => {
      void upload.abort().catch(() => undefined);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await upload.done();
    } catch (error) {
      if (opts.signal?.aborted) throw makeAbortError(opts.signal);
      throw error;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  };

  /** Attach a digest to an already-uploaded object without rewriting bytes. */
  const attachDigest = async (
    key: string,
    sha256: string,
    contentType: string | undefined,
    etag: string | undefined,
  ): Promise<void> => {
    const source = remoteKey(key);
    try {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: source,
          CopySource: encodeURIComponent(`${bucket}/${source}`),
          MetadataDirective: "REPLACE",
          Metadata: { sha256 },
          ...(contentType === undefined ? {} : { ContentType: contentType }),
          // Refuse to stamp our digest onto an object another writer replaced.
          ...(etag === undefined ? {} : { CopySourceIfMatch: etag }),
        }),
      );
    } catch (error) {
      if (httpStatus(error) !== 412)
        await deleteRemote(key).catch(() => undefined);
      throw error;
    }
  };

  const put = async (
    rawKey: string,
    body: Readable | Uint8Array | string,
    putOptions?: PutOptions,
  ): Promise<PutResult> => {
    const key = validateObjectKey(rawKey);
    const opts = normalisePutOptions(key, putOptions);
    if (opts.signal?.aborted) throw makeAbortError(opts.signal);

    if (!(body instanceof Readable)) {
      const bytes =
        typeof body === "string"
          ? Buffer.from(body, "utf8")
          : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
      if (opts.maxBytes !== undefined && bytes.byteLength > opts.maxBytes)
        throw new ObjectTooLargeError(key, opts.maxBytes);
      const written = {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      };
      // Known up front, so nothing is published when a check fails.
      const mismatch = checkWritten(key, opts, written);
      if (mismatch !== null) throw mismatch;
      await uploadBuffer(key, bytes, written.sha256, opts);
      return { key, ...written };
    }

    let result;
    try {
      result = await uploadStream(key, body, opts);
    } catch (error) {
      if (opts.signal?.aborted && !isAbortError(error))
        throw makeAbortError(opts.signal);
      throw error;
    }
    const { etag, ...written } = result;
    const mismatch = checkWritten(key, opts, written);
    if (mismatch !== null) {
      await deleteRemote(key).catch(() => undefined);
      throw mismatch;
    }
    if (opts.expectedSha256 === undefined) {
      if (written.size > MAX_STREAMED_BYTES) {
        await deleteRemote(key).catch(() => undefined);
        throw new ObjectTooLargeError(key, MAX_STREAMED_BYTES);
      }
      await attachDigest(key, written.sha256, opts.contentType, etag);
    }
    return { key, ...written };
  };

  const get = async (
    rawKey: string,
    getOptions?: { signal?: AbortSignal },
  ): Promise<Readable> => {
    const key = validateObjectKey(rawKey);
    const signal = getOptions?.signal;
    if (signal?.aborted) throw makeAbortError(signal);
    let response;
    try {
      response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: remoteKey(key) }),
        signal === undefined ? {} : { abortSignal: signal },
      );
    } catch (error) {
      if (isObjectMissing(error)) throw new ObjectNotFoundError(key);
      if (signal?.aborted) throw makeAbortError(signal);
      throw error;
    }
    const stream = response.Body;
    if (!(stream instanceof Readable))
      throw new Error("S3 GetObject did not return a Node.js stream");
    return stream;
  };

  const head = async (rawKey: string): Promise<ObjectStat | null> => {
    const key = validateObjectKey(rawKey);
    try {
      return statFromHead(
        key,
        await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: remoteKey(key) }),
        ),
      );
    } catch (error) {
      if (isObjectMissing(error)) return null;
      throw error;
    }
  };

  const del = async (rawKey: string): Promise<void> => {
    const key = validateObjectKey(rawKey);
    try {
      await deleteRemote(key);
    } catch (error) {
      if (!isObjectMissing(error)) throw error;
    }
  };

  const list = async (
    prefix: string,
    listOptions?: { cursor?: string | undefined; limit?: number },
  ): Promise<ListPage> => {
    validateListPrefix(prefix);
    const limit = listOptions?.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT)
      throw new RangeError(
        `limit must be an integer from 1 to ${MAX_LIST_LIMIT}`,
      );
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${storePrefix}${prefix}`,
        MaxKeys: limit,
        ...(listOptions?.cursor === undefined
          ? {}
          : { ContinuationToken: listOptions.cursor }),
      }),
    );
    // Listings carry no digest or content type; head() reports those.
    const keys: ObjectStat[] = (response.Contents ?? []).flatMap((item) =>
      item.Key === undefined || !item.Key.startsWith(storePrefix)
        ? []
        : [
            {
              key: item.Key.slice(storePrefix.length),
              size: item.Size ?? 0,
              sha256: null,
              contentType: null,
              lastModified: item.LastModified ?? null,
            },
          ],
    );
    return {
      keys,
      nextCursor:
        response.IsTruncated === true
          ? (response.NextContinuationToken ?? null)
          : null,
    };
  };

  const presignGet = async (
    rawKey: string,
    ttlSeconds: number,
  ): Promise<string> => {
    const key = validateObjectKey(rawKey);
    if (
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > MAX_PRESIGN_SECONDS
    )
      throw new RangeError(
        `ttlSeconds must be an integer from 1 to ${MAX_PRESIGN_SECONDS}`,
      );
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: remoteKey(key) }),
      { expiresIn: ttlSeconds },
    );
  };

  return { backend: "s3", put, get, head, delete: del, list, presignGet };
}
