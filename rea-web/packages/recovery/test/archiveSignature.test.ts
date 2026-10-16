import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateSigningKeyPair,
  signArchiveDigest,
  signingKeyId,
  verifyArchiveSignature,
} from "../src/index.js";

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

describe("detached export archive signatures", () => {
  const keys = generateSigningKeyPair();
  const archive = digest("archive bytes");

  it("signs an archive digest and verifies it with the public key", () => {
    const signed = signArchiveDigest(archive, keys.privateKeyPem);
    expect(signed).toMatchObject({
      format: "rea-web-export-signature",
      algorithm: "ed25519",
      public_key_id: keys.keyId,
      archive_sha256: archive,
    });
    expect(JSON.stringify(signed)).not.toContain("PRIVATE KEY");
    expect(verifyArchiveSignature(signed, archive, keys.publicKeyPem)).toEqual({
      ok: true,
      keyId: keys.keyId,
    });
    expect(signingKeyId(keys.privateKeyPem)).toBe(keys.keyId);
  });

  it("rejects a different archive, a different key, a forged digest and junk", () => {
    const signed = signArchiveDigest(archive, keys.privateKeyPem);
    expect(
      verifyArchiveSignature(signed, digest("tampered"), keys.publicKeyPem).ok,
    ).toBe(false);
    const other = generateSigningKeyPair();
    expect(
      verifyArchiveSignature(signed, archive, other.publicKeyPem).reason,
    ).toContain("key id mismatch");
    const forged = { ...signed, archive_sha256: digest("tampered") };
    expect(
      verifyArchiveSignature(forged, digest("tampered"), keys.publicKeyPem)
        .reason,
    ).toContain("does not match");
    for (const junk of [
      null,
      {},
      { ...signed, version: 2 },
      { ...signed, signature: "!!" },
    ])
      expect(verifyArchiveSignature(junk, archive, keys.publicKeyPem).ok).toBe(
        false,
      );
    expect(() => signArchiveDigest("not-hex", keys.privateKeyPem)).toThrow();
  });
});
