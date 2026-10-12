import { randomBytes } from "node:crypto";
import {
  access,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DecryptionError,
  EncryptionKeyLocationError,
  assertKeyOutsidePackage,
  decryptExport,
  encryptExport,
  generateRecoveryKey,
  packExport,
  readEncryptionHeader,
  readPackage,
  unpackExport,
  verifyIntegrity,
} from "../src/index.js";
import {
  buildFixture,
  cleanupTempDirs,
  flipByte,
  makeTempDir,
  pseudoRandomBytes,
  sha256,
  stageFixture,
  finalizeFixture,
} from "./helpers.js";

afterEach(cleanupTempDirs);

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

async function encryptedFixture(chunkSize?: number) {
  const key = generateRecoveryKey();
  const { root } = await buildFixture();
  const out = await makeTempDir("out");
  const packed = await packExport(root, join(out, "p.tar"));
  const enc = await encryptExport(
    packed.path,
    join(out, "p.tar.enc"),
    key,
    chunkSize === undefined ? {} : { chunkSize },
  );
  return { key, root, out, packed, enc };
}

describe("generateRecoveryKey", () => {
  it("makes 32 random bytes with a short stable id", () => {
    const a = generateRecoveryKey();
    const b = generateRecoveryKey();
    expect(Buffer.from(a.keyBase64, "base64")).toHaveLength(32);
    expect(a.keyId).toMatch(/^[0-9a-f]{16}$/u);
    expect(a.keyId).toBe(
      sha256(Buffer.from(a.keyBase64, "base64")).slice(0, 16),
    );
    expect(a.keyBase64).not.toBe(b.keyBase64);
  });
});

describe("encryptExport / decryptExport", () => {
  it("round-trips a package export", async () => {
    const { key, out, packed, enc } = await encryptedFixture();
    expect(enc.header).toMatchObject({
      magic: "rea-web-enc",
      scheme: "aes-256-gcm-envelope",
      key_id: key.keyId,
      chunk_size: 1024 * 1024,
      recipients: [key.keyId],
    });
    expect(await readEncryptionHeader(enc.path)).toEqual(enc.header);
    expect(enc.size).toBe((await stat(enc.path)).size);
    expect(enc.sha256).toBe(sha256(await readFile(enc.path)));

    const ciphertext = await readFile(enc.path);
    expect(ciphertext.includes(Buffer.from(key.keyBase64, "base64"))).toBe(
      false,
    );
    expect(ciphertext.includes(Buffer.from(key.keyBase64))).toBe(false);
    expect(ciphertext.includes(Buffer.from("fixture-package"))).toBe(false);

    const dec = await decryptExport(enc.path, join(out, "back.tar"), key);
    expect(dec.sha256).toBe(packed.sha256);
    expect(dec.size).toBe(packed.size);
    expect(sha256(await readFile(dec.path))).toBe(packed.sha256);

    const unpacked = await unpackExport(dec.path, await makeTempDir("dest"));
    expect((await verifyIntegrity(unpacked.root)).ok).toBe(true);
  });

  it("uses a fresh IV per encryption", async () => {
    const { key, out, packed, enc } = await encryptedFixture();
    const second = await encryptExport(
      packed.path,
      join(out, "second.enc"),
      key,
    );
    expect(second.header.iv).not.toBe(enc.header.iv);
    expect(second.sha256).not.toBe(enc.sha256);
  });

  it("handles empty, exact-chunk and multi-chunk inputs", async () => {
    const key = generateRecoveryKey();
    const dir = await makeTempDir("sizes");
    for (const size of [0, 1, 1023, 1024, 2048, 2049, 5000]) {
      const plain = join(dir, `p-${size}`);
      await writeFile(plain, pseudoRandomBytes(size, `s${size}`));
      const enc = await encryptExport(plain, join(dir, `e-${size}`), key, {
        chunkSize: 1024,
      });
      const dec = await decryptExport(enc.path, join(dir, `d-${size}`), key);
      expect(dec.size).toBe(size);
      expect(dec.sha256).toBe(sha256(pseudoRandomBytes(size, `s${size}`)));
    }
  });

  async function expectDecryptFails(
    enc: string,
    key: { keyBase64: string },
    reason?: DecryptionError["reason"],
  ): Promise<void> {
    const out = dirname(enc);
    const target = join(out, "should-not-exist.tar");
    const error = await decryptExport(enc, target, key).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DecryptionError);
    if (reason !== undefined)
      expect((error as DecryptionError).reason).toBe(reason);
    expect(await exists(target)).toBe(false);
    expect((await readdir(out)).filter((n) => n.includes("partial"))).toEqual(
      [],
    );
  }

  it("detects flipped ciphertext bytes in any chunk and in the tag", async () => {
    for (const offset of ["first", "middle", "last"] as const) {
      const { key, enc } = await encryptedFixture();
      const size = (await stat(enc.path)).size;
      const headerLength = (await readFile(enc.path)).indexOf(0x0a) + 1;
      const at =
        offset === "first"
          ? headerLength + 5
          : offset === "middle"
            ? Math.floor(size / 2)
            : size - 3;
      await flipByte(enc.path, at);
      await expectDecryptFails(enc.path, key, "authentication_failed");
    }
  });

  it("detects header tampering", async () => {
    const { key, enc } = await encryptedFixture();
    const text = await readFile(enc.path);
    // a different but well-formed header must fail authentication
    const corrupt = Buffer.concat([
      Buffer.from(
        JSON.stringify({ ...enc.header, recipients: ["ffffffffffffffff"] }) +
          "\n",
      ),
      text.subarray(text.indexOf(0x0a) + 1),
    ]);
    await writeFile(enc.path, corrupt);
    await expectDecryptFails(enc.path, key, "authentication_failed");
    await writeFile(
      enc.path,
      Buffer.concat([
        Buffer.from("{nope}\n"),
        text.subarray(text.indexOf(0x0a) + 1),
      ]),
    );
    await expectDecryptFails(enc.path, key, "bad_header");
    await writeFile(enc.path, Buffer.from("no newline here"));
    await expectDecryptFails(enc.path, key, "bad_header");
  });

  it("detects truncation anywhere, including exactly at a chunk boundary", async () => {
    const { key, enc } = await encryptedFixture();
    const original = await readFile(enc.path);
    const headerLength = original.indexOf(0x0a) + 1;
    const block = 1024 * 1024 + 16;
    expect(original.length).toBeGreaterThan(headerLength + 2 * block);
    for (const size of [
      original.length - 1,
      original.length - 16,
      original.length - 100,
      headerLength + 2 * block, // whole chunks only: the last kept chunk was not final
      headerLength + block,
      headerLength + block + 8,
      headerLength + 3,
      headerLength,
      0,
    ]) {
      await writeFile(enc.path, original.subarray(0, size));
      await expectDecryptFails(enc.path, key);
    }
    await writeFile(enc.path, original);
    expect(
      (await decryptExport(enc.path, join(dirname(enc.path), "ok.tar"), key))
        .size,
    ).toBeGreaterThan(0);
  });

  it("detects appended data and reordered chunks", async () => {
    const { key, enc } = await encryptedFixture(4096);
    const original = await readFile(enc.path);
    await writeFile(enc.path, Buffer.concat([original, randomBytes(50)]));
    await expectDecryptFails(enc.path, key, "authentication_failed");

    const headerLength = original.indexOf(0x0a) + 1;
    const block = 4096 + 16;
    const swapped = Buffer.from(original);
    original.copy(
      swapped,
      headerLength,
      headerLength + block,
      headerLength + 2 * block,
    );
    original.copy(
      swapped,
      headerLength + block,
      headerLength,
      headerLength + block,
    );
    await writeFile(enc.path, swapped);
    await expectDecryptFails(enc.path, key, "authentication_failed");
  });

  it("rejects the wrong key", async () => {
    const { enc } = await encryptedFixture();
    await expectDecryptFails(enc.path, generateRecoveryKey(), "bad_key");
    await expectDecryptFails(enc.path, { keyBase64: "AAAA" }, "bad_key");
  });

  it("rejects an invalid key on encrypt", async () => {
    const dir = await makeTempDir("badkey");
    await writeFile(join(dir, "p"), "x");
    const key = generateRecoveryKey();
    await expect(
      encryptExport(join(dir, "p"), join(dir, "e"), {
        keyBase64: "AAAA",
        keyId: key.keyId,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      encryptExport(join(dir, "p"), join(dir, "e"), {
        keyBase64: key.keyBase64,
        keyId: "0000000000000000",
      }),
    ).rejects.toThrow(RangeError);
    expect(await exists(join(dir, "e"))).toBe(false);
  });
});

describe("key location", () => {
  it("refuses an output path inside the package root", async () => {
    const key = generateRecoveryKey();
    const { root } = await buildFixture();
    const out = await makeTempDir("out");
    const packed = await packExport(root, join(out, "p.tar"));
    for (const target of [
      join(root, "export.enc"),
      join(root, "source", "main", "export.enc"),
    ]) {
      await expect(encryptExport(packed.path, target, key)).rejects.toThrow(
        EncryptionKeyLocationError,
      );
      expect(await exists(target)).toBe(false);
    }
    expect((await verifyIntegrity(root)).ok).toBe(true);
  });

  it("refuses key material inside the package root", async () => {
    const key = generateRecoveryKey();
    const { root } = await buildFixture();
    const out = await makeTempDir("out");
    const packed = await packExport(root, join(out, "p.tar"));
    await expect(
      encryptExport(packed.path, join(out, "p.enc"), {
        ...key,
        keyPath: join(root, "recovery.key"),
      }),
    ).rejects.toThrow(EncryptionKeyLocationError);
    await expect(
      encryptExport(packed.path, join(out, "p.enc"), key, {
        keyPaths: [join(root, "keys", "k")],
      }),
    ).rejects.toThrow(EncryptionKeyLocationError);
    expect(await exists(join(out, "p.enc"))).toBe(false);
  });

  it("guards a staging root that has no manifest yet", async () => {
    const key = generateRecoveryKey();
    const { root } = await stageFixture();
    const out = await makeTempDir("out");
    await writeFile(join(out, "p.tar"), "tar-bytes");
    await expect(
      encryptExport(join(out, "p.tar"), join(root, "p.enc"), key, {
        packageRoot: root,
      }),
    ).rejects.toThrow(EncryptionKeyLocationError);
  });

  it("assertKeyOutsidePackage checks containment after resolving symlinks", async () => {
    const { root } = await buildFixture();
    const elsewhere = await makeTempDir("keys");
    await expect(
      assertKeyOutsidePackage(root, join(root, "k.key")),
    ).rejects.toThrow(EncryptionKeyLocationError);
    await expect(
      assertKeyOutsidePackage(root, join(root, "a", "b", "k.key")),
    ).rejects.toThrow(EncryptionKeyLocationError);
    await expect(assertKeyOutsidePackage(root, root)).rejects.toThrow(
      EncryptionKeyLocationError,
    );
    await expect(
      assertKeyOutsidePackage(root, join(elsewhere, "k.key")),
    ).resolves.toBeUndefined();
    // a sibling directory sharing the package's name prefix is outside it
    await expect(
      assertKeyOutsidePackage(root, `${root}-keys/k.key`),
    ).resolves.toBeUndefined();
    // a symlink pointing into the package does not hide the location
    await symlink(root, join(elsewhere, "sneaky"));
    await expect(
      assertKeyOutsidePackage(root, join(elsewhere, "sneaky", "k.key")),
    ).rejects.toThrow(EncryptionKeyLocationError);
  });

  it("never records key material in the manifest", async () => {
    const key = generateRecoveryKey();
    const { builder, root } = await stageFixture();
    builder.setEncryption({
      scheme: "aes-256-gcm-envelope",
      recipients: [key.keyId],
      key_location: "external",
    });
    const manifest = await finalizeFixture(builder);
    expect(manifest.encryption).toEqual({
      scheme: "aes-256-gcm-envelope",
      recipients: [key.keyId],
      key_location: "external",
    });
    expect(
      (await readFile(join(root, "manifest.json"), "utf8")).includes(
        key.keyBase64,
      ),
    ).toBe(false);
    expect((await readPackage(root)).manifest.encryption?.key_location).toBe(
      "external",
    );
  });
});
