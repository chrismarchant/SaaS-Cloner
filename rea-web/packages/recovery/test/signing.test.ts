import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SignatureError,
  generateSigningKeyPair,
  packExport,
  readPackage,
  signManifest,
  unpackExport,
  verifyIntegrity,
  verifySignature,
} from "../src/index.js";
import {
  buildFixture,
  cleanupTempDirs,
  flipByte,
  makeTempDir,
} from "./helpers.js";

afterEach(cleanupTempDirs);

describe("detached Ed25519 signature", () => {
  it("signs the exact manifest bytes and verifies", async () => {
    const keys = generateSigningKeyPair();
    expect(keys.keyId).toMatch(/^[0-9a-f]{64}$/u);
    const { root, manifest } = await buildFixture({
      signature: { keyId: keys.keyId },
    });
    expect(manifest.signature).toEqual({
      algorithm: "ed25519",
      public_key_id: keys.keyId,
      detached_path: "manifest.json.sig",
    });
    const before = await readFile(join(root, "manifest.json"));
    const signed = await signManifest(
      root,
      keys.privateKeyPem,
      keys.publicKeyPem,
    );
    expect(signed).toEqual({
      signaturePath: join(root, "manifest.json.sig"),
      keyId: keys.keyId,
    });
    expect(await readFile(join(root, "manifest.json"))).toEqual(before);
    expect(await verifySignature(root, keys.publicKeyPem)).toEqual({
      ok: true,
      keyId: keys.keyId,
    });
    // the signature file is not an "extra" file
    expect((await verifyIntegrity(root)).ok).toBe(true);
    expect((await readPackage(root)).manifest.signature?.public_key_id).toBe(
      keys.keyId,
    );
  });

  it("survives pack and unpack", async () => {
    const keys = generateSigningKeyPair();
    const { root } = await buildFixture({ signature: { keyId: keys.keyId } });
    await signManifest(root, keys.privateKeyPem, keys.publicKeyPem);
    const out = await makeTempDir("out");
    const packed = await packExport(root, join(out, "p.tar"));
    const unpacked = await unpackExport(packed.path, await makeTempDir("dest"));
    expect((await verifySignature(unpacked.root, keys.publicKeyPem)).ok).toBe(
      true,
    );
    expect((await verifyIntegrity(unpacked.root)).ok).toBe(true);
  });

  it("fails when manifest.json is altered by one byte", async () => {
    const keys = generateSigningKeyPair();
    const { root } = await buildFixture({ signature: { keyId: keys.keyId } });
    await signManifest(root, keys.privateKeyPem, keys.publicKeyPem);
    await flipByte(join(root, "manifest.json"), 40);
    const result = await verifySignature(root, keys.publicKeyPem);
    expect(result.ok).toBe(false);
    expect(result.keyId).toBe(keys.keyId);
    expect(result.reason).toMatch(/does not match/u);
  });

  it("fails when a hash in the manifest is edited to match tampered content", async () => {
    const keys = generateSigningKeyPair();
    const { root } = await buildFixture({ signature: { keyId: keys.keyId } });
    await signManifest(root, keys.privateKeyPem, keys.publicKeyPem);
    const path = join(root, "manifest.json");
    const text = await readFile(path, "utf8");
    await writeFile(
      path,
      text.replace("hello", "jello").replace(/"size": 6/u, '"size": 7'),
    );
    expect((await verifySignature(root, keys.publicKeyPem)).ok).toBe(false);
  });

  it("fails with a key id mismatch for the wrong public key", async () => {
    const keys = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const { root } = await buildFixture({ signature: { keyId: keys.keyId } });
    await signManifest(root, keys.privateKeyPem, keys.publicKeyPem);
    const result = await verifySignature(root, other.publicKeyPem);
    expect(result.ok).toBe(false);
    expect(result.keyId).toBe(other.keyId);
    expect(result.reason).toMatch(/key id mismatch/u);
  });

  it("reports a missing or malformed signature file", async () => {
    const keys = generateSigningKeyPair();
    const { root } = await buildFixture({ signature: { keyId: keys.keyId } });
    expect((await verifySignature(root, keys.publicKeyPem)).reason).toMatch(
      /missing/u,
    );
    await writeFile(join(root, "manifest.json.sig"), "not base64!!");
    expect((await verifySignature(root, keys.publicKeyPem)).reason).toMatch(
      /base64/u,
    );
    await writeFile(
      join(root, "manifest.json.sig"),
      Buffer.alloc(10).toString("base64"),
    );
    expect((await verifySignature(root, keys.publicKeyPem)).reason).toMatch(
      /length/u,
    );
  });

  it("refuses to sign a manifest that does not declare the signature", async () => {
    const keys = generateSigningKeyPair();
    const { root } = await buildFixture();
    await expect(
      signManifest(root, keys.privateKeyPem, keys.publicKeyPem),
    ).rejects.toThrow(SignatureError);
  });

  it("refuses mismatched or invalid keys", async () => {
    const keys = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const { root } = await buildFixture({ signature: { keyId: keys.keyId } });
    await expect(
      signManifest(root, other.privateKeyPem, keys.publicKeyPem),
    ).rejects.toThrow(/does not match/u);
    await expect(
      signManifest(root, other.privateKeyPem, other.publicKeyPem),
    ).rejects.toThrow(/manifest declares key id/u);
    await expect(
      signManifest(root, "garbage", keys.publicKeyPem),
    ).rejects.toThrow(SignatureError);
    await expect(verifySignature(root, "garbage")).rejects.toThrow(
      SignatureError,
    );
  });
});
