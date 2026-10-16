import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InvalidObjectKeyError,
  ObjectNotFoundError,
  ObjectTooLargeError,
  createFsObjectStore,
  type ObjectStore,
} from "../src/index.js";
import { describeObjectStoreContract, readAll, sha256Hex } from "./contract.js";

describeObjectStoreContract("fs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rea-storage-fs-"));
  return {
    store: createFsObjectStore({ root: join(dir, "root") }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
});

const listFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
};

describe("fs backend specifics", () => {
  let dir: string;
  let root: string;
  let outside: string;
  let store: ObjectStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rea-storage-fs-"));
    root = join(dir, "root");
    outside = join(dir, "outside");
    await mkdir(outside);
    store = createFsObjectStore({ root });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stores objects at <root>/<key> with a sidecar under .meta", async () => {
    await store.put("a/b/c.bin", "hello", { contentType: "text/plain" });
    expect(await readFile(join(root, "a/b/c.bin"), "utf8")).toBe("hello");
    const sidecar = JSON.parse(
      await readFile(join(root, ".meta/a/b/c.bin.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(sidecar).toMatchObject({
      sha256: sha256Hex("hello"),
      size: 5,
      contentType: "text/plain",
    });
    expect(await readdir(join(root, ".tmp"))).toEqual([]);
  });

  it("leaves no partial file, temp file or sidecar after a maxBytes rejection", async () => {
    await expect(
      store.put("big/obj", Readable.from([randomBytes(4096)]), {
        maxBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(await listFiles(root)).toEqual([]);
  });

  it("leaves no temp file or sidecar after an integrity failure or abort", async () => {
    await expect(
      store.put("bad/obj", "abc", { expectedSha256: "0".repeat(64) }),
    ).rejects.toMatchObject({ name: "ObjectIntegrityError" });
    expect(await listFiles(root)).toEqual([]);
  });

  it("does not stream the body into memory", async () => {
    // 64 MiB in 1 MiB chunks, produced lazily.
    const chunk = Buffer.alloc(1024 * 1024, 7);
    let produced = 0;
    const body = new Readable({
      read() {
        produced += 1;
        this.push(produced <= 64 ? chunk : null);
      },
    });
    const put = await store.put("large/obj", body);
    expect(put.size).toBe(64 * 1024 * 1024);
    expect((await lstat(join(root, "large/obj"))).size).toBe(put.size);
  });

  it("reports an unknown digest when the sidecar is missing or stale", async () => {
    await store.put("k/obj", "12345");
    await rm(join(root, ".meta/k/obj.json"));
    expect(await store.head("k/obj")).toMatchObject({
      size: 5,
      sha256: null,
      contentType: null,
    });
    await store.put("k/obj", "12345");
    await writeFile(join(root, "k/obj"), "changed on disk");
    expect((await store.head("k/obj"))?.sha256).toBeNull();
  });

  it("ignores a corrupt sidecar", async () => {
    await store.put("k/obj", "x");
    await writeFile(join(root, ".meta/k/obj.json"), "{not json");
    expect(await store.head("k/obj")).toMatchObject({ size: 1, sha256: null });
  });

  it("delete removes the object and its sidecar", async () => {
    await store.put("d/obj", "x");
    await store.delete("d/obj");
    expect((await listFiles(root)).filter((f) => f.includes("obj"))).toEqual(
      [],
    );
  });

  it("reserves the internal .tmp and .meta names", async () => {
    for (const key of [".tmp/x", ".meta/x", ".meta/a.json"]) {
      await expect(store.put(key, "x")).rejects.toBeInstanceOf(
        InvalidObjectKeyError,
      );
      await expect(store.get(key)).rejects.toBeInstanceOf(
        InvalidObjectKeyError,
      );
    }
    expect(await store.list(".meta/")).toEqual({ keys: [], nextCursor: null });
  });

  it("never lists internal directories", async () => {
    await store.put("visible", "x");
    const page = await store.list("");
    expect(page.keys.map((k) => k.key)).toEqual(["visible"]);
  });

  it("lists in byte order across directory boundaries and honours partial-segment prefixes", async () => {
    const keys = ["a/b", "a.b", "a-b", "a/c/d", "ab", "b"];
    for (const key of keys) await store.put(key, key);
    const all: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await store.list("", { limit: 2, cursor });
      all.push(...page.keys.map((k) => k.key));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(all).toEqual([...keys].sort());
    expect((await store.list("a/")).keys.map((k) => k.key)).toEqual([
      "a/b",
      "a/c/d",
    ]);
    expect((await store.list("a")).keys.map((k) => k.key)).toEqual([
      "a-b",
      "a.b",
      "a/b",
      "a/c/d",
      "ab",
    ]);
    expect((await store.list("a/c")).keys.map((k) => k.key)).toEqual(["a/c/d"]);
  });

  it("returns digest and content type in listings", async () => {
    await store.put("l/obj", "x", { contentType: "text/plain" });
    expect((await store.list("l/")).keys[0]).toMatchObject({
      key: "l/obj",
      sha256: sha256Hex("x"),
      contentType: "text/plain",
    });
  });

  it("refuses to put a key that collides with an object or prefix", async () => {
    await store.put("c/obj", "x");
    await expect(store.put("c/obj/child", "x")).rejects.toBeInstanceOf(
      InvalidObjectKeyError,
    );
    await expect(store.put("c", "x")).rejects.toBeInstanceOf(
      InvalidObjectKeyError,
    );
    expect(await readAll(await store.get("c/obj"))).toEqual(Buffer.from("x"));
  });

  describe("symlinks", () => {
    const secret = "outside secret";
    beforeEach(async () => {
      await mkdir(root, { recursive: true });
      await writeFile(join(outside, "secret.txt"), secret);
      await symlink(join(outside, "secret.txt"), join(root, "link-file"));
      await symlink(outside, join(root, "link-dir"));
      await store.put("real/obj", "real");
      await symlink(outside, join(root, "real/nested-link"));
    });

    it("does not read through a symlink", async () => {
      await expect(store.get("link-file")).rejects.toBeInstanceOf(
        ObjectNotFoundError,
      );
      await expect(store.get("link-dir/secret.txt")).rejects.toBeInstanceOf(
        ObjectNotFoundError,
      );
      await expect(
        store.get("real/nested-link/secret.txt"),
      ).rejects.toBeInstanceOf(ObjectNotFoundError);
      expect(await store.head("link-file")).toBeNull();
      expect(await store.head("link-dir/secret.txt")).toBeNull();
    });

    it("does not follow symlinks when listing", async () => {
      const page = await store.list("");
      expect(page.keys.map((k) => k.key)).toEqual(["real/obj"]);
      expect((await store.list("link-dir/")).keys).toEqual([]);
    });

    it("does not delete a symlink or its target", async () => {
      await store.delete("link-file");
      await store.delete("link-dir/secret.txt");
      expect((await lstat(join(root, "link-file"))).isSymbolicLink()).toBe(
        true,
      );
      expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe(secret);
    });

    it("does not write through a symlink", async () => {
      await expect(store.put("link-dir/new.txt", "x")).rejects.toBeInstanceOf(
        InvalidObjectKeyError,
      );
      await expect(store.put("link-file", "overwrite")).rejects.toBeInstanceOf(
        InvalidObjectKeyError,
      );
      expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe(secret);
      expect(await readdir(outside)).toEqual(["secret.txt"]);
    });

    it("rejects a symlinked sidecar directory without leaking its contents", async () => {
      await writeFile(
        join(outside, "obj.json"),
        JSON.stringify({ sha256: "f".repeat(64), size: 4 }),
      );
      await rm(join(root, ".meta/real"), { recursive: true, force: true });
      await symlink(outside, join(root, ".meta/real"));
      expect((await store.head("real/obj"))?.sha256).toBeNull();
    });
  });
});
