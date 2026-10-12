import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  InvalidObjectKeyError,
  ObjectIntegrityError,
  createS3ObjectStore,
  type ObjectStore,
} from "../src/index.js";
import { describeObjectStoreContract, readAll, sha256Hex } from "./contract.js";
import { startMockS3, type MockS3 } from "./mockS3.js";

const BUCKET = "test-bucket";
let mock: MockS3;

beforeAll(async () => {
  mock = await startMockS3(BUCKET);
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.objects.clear();
  mock.uploads.clear();
  mock.requests.length = 0;
});

const create = (prefix?: string): ObjectStore =>
  createS3ObjectStore({
    bucket: BUCKET,
    region: "us-east-1",
    endpoint: mock.endpoint,
    forcePathStyle: true,
    accessKeyId: "AKIATESTKEY",
    secretAccessKey: "test-secret",
    ...(prefix === undefined ? {} : { prefix }),
  });

describeObjectStoreContract("s3", async () => {
  mock.objects.clear();
  return { store: create(), cleanup: async () => undefined };
});

describe("s3 backend specifics", () => {
  it("streams bodies over 5 MiB through multipart upload", async () => {
    const bytes = randomBytes(6 * 1024 * 1024);
    const store = create();
    const chunks: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += 64 * 1024)
      chunks.push(bytes.subarray(at, at + 64 * 1024));

    const put = await store.put("big/stream", Readable.from(chunks), {
      contentType: "application/octet-stream",
    });
    expect(put).toEqual({
      key: "big/stream",
      size: bytes.length,
      sha256: sha256Hex(bytes),
    });
    const parts = mock.requests.filter((r) => /partNumber=/u.test(r));
    expect(parts).toHaveLength(2);
    expect(mock.requests.some((r) => r.startsWith("POST") && r.includes("uploads"))).toBe(true);
    expect(mock.uploads.size).toBe(0);
    expect(mock.objects.get("big/stream")?.body.equals(bytes)).toBe(true);
    // The digest is attached after a streamed upload.
    expect(mock.objects.get("big/stream")?.metadata["sha256"]).toBe(sha256Hex(bytes));
    expect((await store.head("big/stream"))?.sha256).toBe(sha256Hex(bytes));
    expect(await readAll(await store.get("big/stream"))).toEqual(bytes);
  });

  it("uploads a 6 MiB Buffer via multipart with the digest set up front", async () => {
    const bytes = randomBytes(6 * 1024 * 1024);
    const store = create();
    const put = await store.put("big/buffer", bytes);
    expect(put.sha256).toBe(sha256Hex(bytes));
    expect(mock.requests.filter((r) => /partNumber=/u.test(r))).toHaveLength(2);
    expect(mock.requests.some((r) => r.startsWith("PUT") && !r.includes("partNumber") && !r.includes("big/buffer"))).toBe(false);
    expect(mock.objects.get("big/buffer")?.metadata["sha256"]).toBe(sha256Hex(bytes));
    expect(await readAll(await store.get("big/buffer"))).toEqual(bytes);
  });

  it("uses a single PutObject for small bodies and records the digest and type", async () => {
    const store = create();
    await store.put("small/buffer", "hello", { contentType: "text/plain" });
    expect(mock.requests).toEqual([`PUT /${BUCKET}/small/buffer`]);
    expect(mock.objects.get("small/buffer")).toMatchObject({
      contentType: "text/plain",
      metadata: { sha256: sha256Hex("hello") },
    });
  });

  it("records a caller-supplied digest up front for streams (no copy)", async () => {
    const store = create();
    await store.put("small/stream", Readable.from(["abc"]), {
      expectedSha256: sha256Hex("abc"),
      contentType: "text/plain",
    });
    expect(mock.requests).toEqual([`PUT /${BUCKET}/small/stream`]);
    expect(mock.objects.get("small/stream")?.metadata["sha256"]).toBe(sha256Hex("abc"));
  });

  it("preserves the content type when attaching a digest to a streamed upload", async () => {
    const store = create();
    await store.put("small/typed", Readable.from(["abc"]), { contentType: "text/x-typed" });
    expect(mock.objects.get("small/typed")?.contentType).toBe("text/x-typed");
    expect(mock.objects.get("small/typed")?.metadata["sha256"]).toBe(sha256Hex("abc"));
  });

  it("removes a streamed object whose digest does not match", async () => {
    const store = create();
    await expect(
      store.put("bad/stream", Readable.from(["abc"]), { expectedSha256: "0".repeat(64) }),
    ).rejects.toBeInstanceOf(ObjectIntegrityError);
    expect(mock.objects.has("bad/stream")).toBe(false);
  });

  it("aborts a multipart upload when maxBytes is exceeded mid-stream", async () => {
    const store = create();
    const chunks = Array.from({ length: 96 }, () => Buffer.alloc(64 * 1024));
    await expect(
      store.put("big/capped", Readable.from(chunks), { maxBytes: 6 * 1024 * 1024 }),
    ).resolves.toMatchObject({ size: 96 * 64 * 1024 });
    mock.objects.clear();
    const oversized = Array.from({ length: 200 }, () => Buffer.alloc(64 * 1024));
    await expect(
      store.put("big/capped", Readable.from(oversized), { maxBytes: 7 * 1024 * 1024 }),
    ).rejects.toMatchObject({ name: "ObjectTooLargeError" });
    expect(mock.objects.has("big/capped")).toBe(false);
    expect(mock.uploads.size).toBe(0);
  });

  it("returns lastModified, size and nulls (unknown) for listing digest and type", async () => {
    const store = create();
    await store.put("l/a", "abc", { contentType: "text/plain" });
    const page = await store.list("l/");
    expect(page.keys).toHaveLength(1);
    expect(page.keys[0]).toMatchObject({
      key: "l/a",
      size: 3,
      sha256: null,
      contentType: null,
    });
    expect(page.keys[0]?.lastModified).toBeInstanceOf(Date);
    expect(mock.requests.at(-1)).toMatch(/list-type=2/u);
    expect(mock.requests.at(-1)).toMatch(/prefix=l%2F/u);
  });

  it("passes limit as max-keys and the cursor as continuation-token", async () => {
    const store = create();
    for (const k of ["a", "b", "c"]) await store.put(`p/${k}`, k);
    mock.requests.length = 0;
    const first = await store.list("p/", { limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    const second = await store.list("p/", { limit: 2, cursor: first.nextCursor ?? "" });
    expect(second.keys.map((k) => k.key)).toEqual(["p/c"]);
    expect(second.nextCursor).toBeNull();
    expect(mock.requests[0]).toMatch(/max-keys=2/u);
    expect(mock.requests[1]).toMatch(/continuation-token=/u);
  });

  it("prepends the store prefix to every key and strips it from listings", async () => {
    const store = create("tenant-1/base");
    const other = create("tenant-2");
    await store.put("a/obj", "mine");
    await other.put("a/obj", "theirs");
    expect([...mock.objects.keys()].sort()).toEqual([
      "tenant-1/base/a/obj",
      "tenant-2/a/obj",
    ]);
    expect((await store.list("")).keys.map((k) => k.key)).toEqual(["a/obj"]);
    expect(await readAll(await store.get("a/obj"))).toEqual(Buffer.from("mine"));
    await store.delete("a/obj");
    expect(await store.head("a/obj")).toBeNull();
    expect(await other.head("a/obj")).not.toBeNull();
  });

  it("rejects an unsafe store prefix", () => {
    expect(() => create("../escape")).toThrow(InvalidObjectKeyError);
  });

  it("presignGet returns a signed URL containing the key", async () => {
    const store = create();
    expect(store.presignGet).toBeDefined();
    const url = new URL(
      (await store.presignGet?.("projects/p1/export/e1.tar", 300)) ?? "",
    );
    expect(url.origin).toBe(mock.endpoint);
    expect(url.pathname).toBe(`/${BUCKET}/projects/p1/export/e1.tar`);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/u);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(mock.requests).toEqual([]);

    await store.put("projects/p1/export/e1.tar", "tar bytes");
    const response = await fetch(url);
    expect(await response.text()).toBe("tar bytes");
  });

  it("validates presign keys and ttl", async () => {
    const store = create();
    await expect(store.presignGet?.("../x", 60)).rejects.toBeInstanceOf(InvalidObjectKeyError);
    await expect(store.presignGet?.("a", 0)).rejects.toBeInstanceOf(RangeError);
  });

  it("does not expose presignGet-less behaviour on fs", async () => {
    const { createFsObjectStore } = await import("../src/index.js");
    expect(createFsObjectStore({ root: "/nonexistent-root" }).presignGet).toBeUndefined();
  });
});
