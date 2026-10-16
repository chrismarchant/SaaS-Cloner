import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InvalidObjectKeyError,
  ObjectIntegrityError,
  ObjectNotFoundError,
  ObjectTooLargeError,
  sha256Stream,
  type ObjectStore,
} from "../src/index.js";

export const sha256Hex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

export const readAll = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

export interface StoreFixture {
  store: ObjectStore;
  cleanup(): Promise<void>;
}

/** Behaviour every ObjectStore backend must share. */
export function describeObjectStoreContract(
  name: string,
  create: () => Promise<StoreFixture>,
): void {
  describe(`${name} ObjectStore contract`, () => {
    let fixture: StoreFixture;
    let store: ObjectStore;
    beforeEach(async () => {
      fixture = await create();
      store = fixture.store;
    });
    afterEach(async () => {
      await fixture.cleanup();
    });

    const bodies: [string, () => Buffer | string | Readable, Buffer][] = [
      ["Buffer", () => Buffer.from("buffer body"), Buffer.from("buffer body")],
      ["string", () => "string body é", Buffer.from("string body é", "utf8")],
      [
        "Readable",
        () => Readable.from([Buffer.from("stream "), Buffer.from("body")]),
        Buffer.from("stream body"),
      ],
      ["empty string", () => "", Buffer.alloc(0)],
    ];

    for (const [label, makeBody, bytes] of bodies) {
      it(`round-trips a ${label} body`, async () => {
        const key = "projects/p1/targets/t1/payload";
        const put = await store.put(key, makeBody(), {
          contentType: "application/x-test",
        });
        expect(put).toEqual({
          key,
          size: bytes.byteLength,
          sha256: sha256Hex(bytes),
        });

        const stat = await store.head(key);
        expect(stat).toMatchObject({
          key,
          size: bytes.byteLength,
          sha256: sha256Hex(bytes),
          contentType: "application/x-test",
        });
        expect(stat?.lastModified).toBeInstanceOf(Date);

        expect(await readAll(await store.get(key))).toEqual(bytes);

        await store.delete(key);
        expect(await store.head(key)).toBeNull();
        await expect(store.get(key)).rejects.toBeInstanceOf(
          ObjectNotFoundError,
        );
      });
    }

    it("overwrites an existing object with the new bytes and digest", async () => {
      await store.put("k/one", "first");
      await store.put("k/one", "second!");
      expect(await readAll(await store.get("k/one"))).toEqual(
        Buffer.from("second!"),
      );
      expect((await store.head("k/one"))?.sha256).toBe(sha256Hex("second!"));
    });

    it("matches createHash for random bytes and sha256Stream", async () => {
      const bytes = randomBytes(100_000);
      const put = await store.put("k/random", Readable.from([bytes]));
      expect(put.sha256).toBe(sha256Hex(bytes));
      const measured = await sha256Stream(await store.get("k/random"));
      expect(measured).toEqual({
        sha256: sha256Hex(bytes),
        size: bytes.length,
      });
    });

    it("pages list results with limit 2 across 5 keys", async () => {
      for (const letter of ["c", "a", "e", "b", "d"])
        await store.put(`list/${letter}`, letter);
      await store.put("other/z", "z");

      const seen: string[] = [];
      let cursor: string | undefined;
      const pageSizes: number[] = [];
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await store.list("list/", { limit: 2, cursor });
        pageSizes.push(page.keys.length);
        seen.push(...page.keys.map((k) => k.key));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(pageSizes).toEqual([2, 2, 1]);
      expect(seen).toEqual(["list/a", "list/b", "list/c", "list/d", "list/e"]);
      const first = await store.list("list/", { limit: 2 });
      expect(first.keys[0]).toMatchObject({ key: "list/a", size: 1 });
    });

    it("lists an empty prefix as empty", async () => {
      expect(await store.list("nothing/here/")).toEqual({
        keys: [],
        nextCursor: null,
      });
    });

    it("rejects with ObjectTooLargeError past maxBytes and publishes nothing", async () => {
      await expect(
        store.put("big/stream", Readable.from([Buffer.alloc(600)]), {
          maxBytes: 500,
        }),
      ).rejects.toBeInstanceOf(ObjectTooLargeError);
      await expect(
        store.put("big/buffer", Buffer.alloc(600), { maxBytes: 500 }),
      ).rejects.toBeInstanceOf(ObjectTooLargeError);
      await expect(
        store.put("big/declared", Readable.from([Buffer.alloc(10)]), {
          maxBytes: 5,
          contentLength: 10,
        }),
      ).rejects.toMatchObject({ name: "ObjectTooLargeError", limit: 5 });
      expect(await store.head("big/stream")).toBeNull();
      expect(await store.head("big/buffer")).toBeNull();
      expect((await store.list("big/")).keys).toEqual([]);
    });

    it("accepts a body exactly at maxBytes", async () => {
      const put = await store.put(
        "big/exact",
        Readable.from([Buffer.alloc(8)]),
        {
          maxBytes: 8,
        },
      );
      expect(put.size).toBe(8);
    });

    it("fails with ObjectIntegrityError on an expectedSha256 mismatch", async () => {
      const wrong = sha256Hex("something else");
      for (const body of ["actual", Readable.from([Buffer.from("actual")])]) {
        const error = await store
          .put("integrity/obj", body, { expectedSha256: wrong })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ObjectIntegrityError);
        expect(error).toMatchObject({
          key: "integrity/obj",
          expected: wrong,
          actual: sha256Hex("actual"),
        });
        expect(await store.head("integrity/obj")).toBeNull();
      }
    });

    it("accepts a matching expectedSha256 in any case", async () => {
      const put = await store.put("integrity/ok", Readable.from(["ok"]), {
        expectedSha256: sha256Hex("ok").toUpperCase(),
      });
      expect(put.sha256).toBe(sha256Hex("ok"));
      expect((await store.head("integrity/ok"))?.sha256).toBe(sha256Hex("ok"));
    });

    it("fails with ObjectIntegrityError when contentLength is wrong", async () => {
      await expect(
        store.put("integrity/len", Readable.from([Buffer.from("abc")]), {
          contentLength: 4,
        }),
      ).rejects.toBeInstanceOf(ObjectIntegrityError);
      expect(await store.head("integrity/len")).toBeNull();
    });

    it("does not replace an existing object when a later put fails", async () => {
      await store.put("keep/me", "original");
      await expect(
        store.put("keep/me", Readable.from([Buffer.alloc(100)]), {
          maxBytes: 10,
        }),
      ).rejects.toBeInstanceOf(ObjectTooLargeError);
      expect(await readAll(await store.get("keep/me"))).toEqual(
        Buffer.from("original"),
      );
    });

    it("aborts mid-stream and leaves nothing behind", async () => {
      const controller = new AbortController();
      async function* body(): AsyncGenerator<Buffer> {
        yield Buffer.alloc(1024);
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield Buffer.alloc(1024);
      }
      const error = await store
        .put("abort/obj", Readable.from(body()), { signal: controller.signal })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("AbortError");
      expect(await store.head("abort/obj")).toBeNull();
    });

    it("rejects an already-aborted signal before writing", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        store.put("abort/early", "x", { signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(await store.head("abort/early")).toBeNull();
    });

    it("rejects hostile keys on every method", async () => {
      const hostile = [
        "../x",
        "a/../../x",
        "/abs",
        "a//b",
        "a/",
        "a/./b",
        "a\\b",
        "a\u0000b",
        "",
        "x".repeat(600),
      ];
      for (const key of hostile) {
        await expect(store.put(key, "x")).rejects.toBeInstanceOf(
          InvalidObjectKeyError,
        );
        await expect(store.get(key)).rejects.toBeInstanceOf(
          InvalidObjectKeyError,
        );
        await expect(store.head(key)).rejects.toBeInstanceOf(
          InvalidObjectKeyError,
        );
        await expect(store.delete(key)).rejects.toBeInstanceOf(
          InvalidObjectKeyError,
        );
      }
      await expect(store.list("../x")).rejects.toBeInstanceOf(
        InvalidObjectKeyError,
      );
      await expect(store.list("a//b/")).rejects.toBeInstanceOf(
        InvalidObjectKeyError,
      );
    });

    it("reports the offending key and reason on InvalidObjectKeyError", async () => {
      const error = await store.put("../x", "x").catch((e: unknown) => e);
      expect(error).toMatchObject({
        name: "InvalidObjectKeyError",
        key: "../x",
        reason: "traversal",
      });
      expect((error as Error).message).not.toContain("../x");
    });

    it("rejects invalid list limits", async () => {
      await expect(store.list("a/", { limit: 0 })).rejects.toBeInstanceOf(
        RangeError,
      );
    });

    it("handles concurrent puts to different keys", async () => {
      const payloads = Array.from({ length: 12 }, (_, i) => ({
        key: `concurrent/${String(i).padStart(2, "0")}`,
        bytes: randomBytes(2048 + i),
      }));
      const results = await Promise.all(
        payloads.map(({ key, bytes }) =>
          store.put(key, Readable.from([bytes])),
        ),
      );
      expect(results.map((r) => r.sha256)).toEqual(
        payloads.map((p) => sha256Hex(p.bytes)),
      );
      const page = await store.list("concurrent/");
      expect(page.keys.map((k) => k.key)).toEqual(payloads.map((p) => p.key));
      for (const { key, bytes } of payloads)
        expect(await readAll(await store.get(key))).toEqual(bytes);
    });

    it("delete is idempotent", async () => {
      await expect(store.delete("never/existed")).resolves.toBeUndefined();
      await store.put("once/only", "x");
      await store.delete("once/only");
      await expect(store.delete("once/only")).resolves.toBeUndefined();
    });

    it("head returns null and get throws ObjectNotFoundError for a missing key", async () => {
      expect(await store.head("missing/key")).toBeNull();
      const error = await store.get("missing/key").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ObjectNotFoundError);
      expect((error as ObjectNotFoundError).key).toBe("missing/key");
    });

    it("does not read through a get signal that is already aborted", async () => {
      await store.put("sig/obj", "x");
      const controller = new AbortController();
      controller.abort();
      await expect(
        store.get("sig/obj", { signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
    });
  });
}
