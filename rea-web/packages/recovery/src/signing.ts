import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolveWithin } from "@rea-web/contracts";
import { PackageFormatError, SignatureError } from "./errors.js";
import { SIGNATURE_FILE, sha256Hex, writeFileAtomic } from "./fsutil.js";
import { parseManifestBytes, readManifestBytes } from "./read.js";

export interface SigningKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
  /** sha256 of the DER-encoded SPKI public key, hex. */
  keyId: string;
}

const publicKeyId = (key: KeyObject): string =>
  sha256Hex(key.export({ type: "spki", format: "der" }));

const loadPublicKey = (pem: string): KeyObject => {
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519")
      throw new SignatureError("public key is not an Ed25519 key");
    return key;
  } catch (error) {
    if (error instanceof SignatureError) throw error;
    throw new SignatureError("public key is not valid PEM", error);
  }
};

export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    keyId: publicKeyId(createPublicKey(publicKey)),
  };
}

const signaturePath = (root: string, detached: string): string => {
  const resolved = resolveWithin(root, detached);
  if (!resolved.ok)
    throw new SignatureError(
      `signature path ${JSON.stringify(detached)} is unsafe (${resolved.rejection.kind})`,
    );
  return resolved.path;
};

/**
 * Sign the exact bytes of manifest.json. The manifest must already declare the
 * signature (`builder.setSignature`) with this key's id, so signing never
 * changes the signed bytes.
 */
export async function signManifest(
  root: string,
  privateKeyPem: string,
  publicKeyPem: string,
): Promise<{ signaturePath: string; keyId: string }> {
  const publicKey = loadPublicKey(publicKeyPem);
  const keyId = publicKeyId(publicKey);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch (error) {
    throw new SignatureError("private key is not valid PEM", error);
  }
  if (publicKeyId(createPublicKey(privateKey)) !== keyId)
    throw new SignatureError("private key does not match the public key");

  const bytes = await readManifestBytes(root);
  const manifest = parseManifestBytes(bytes);
  const declared = manifest.signature;
  if (declared === undefined)
    throw new SignatureError(
      "manifest does not declare a signature; call builder.setSignature before finalize",
    );
  if (declared.public_key_id !== keyId)
    throw new SignatureError(
      `manifest declares key id ${declared.public_key_id}, signing key id is ${keyId}`,
    );
  const target = signaturePath(root, declared.detached_path);
  const signature = sign(null, bytes, privateKey);
  await writeFileAtomic(target, `${signature.toString("base64")}\n`);
  return { signaturePath: target, keyId };
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

const declaredSignature = (
  bytes: Buffer,
): { key_id?: string; path?: string } => {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as {
      signature?: { public_key_id?: unknown; detached_path?: unknown };
    };
    const s = parsed.signature;
    return {
      ...(typeof s?.public_key_id === "string"
        ? { key_id: s.public_key_id }
        : {}),
      ...(typeof s?.detached_path === "string"
        ? { path: s.detached_path }
        : {}),
    };
  } catch {
    return {};
  }
};

export async function verifySignature(
  root: string,
  publicKeyPem: string,
): Promise<{ ok: boolean; keyId: string; reason?: string }> {
  const publicKey = loadPublicKey(publicKeyPem);
  const keyId = publicKeyId(publicKey);
  const fail = (reason: string) => ({ ok: false, keyId, reason });

  let bytes: Buffer;
  try {
    bytes = await readManifestBytes(root);
  } catch (error) {
    if (error instanceof PackageFormatError) return fail(error.reason);
    throw error;
  }
  const declared = declaredSignature(bytes);
  if (declared.key_id !== undefined && declared.key_id !== keyId)
    return fail(
      `key id mismatch: manifest declares ${declared.key_id}, supplied key is ${keyId}`,
    );
  const sigRel = declared.path ?? SIGNATURE_FILE;
  let sigFile: string;
  try {
    sigFile = signaturePath(root, sigRel);
    if (!(await lstat(sigFile)).isFile())
      return fail("signature file is not a regular file");
  } catch (error) {
    if (error instanceof SignatureError) return fail(error.message);
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return fail(`signature file ${sigRel} is missing`);
    throw error;
  }
  const encoded = (await readFile(sigFile, "utf8")).trim();
  if (!BASE64.test(encoded)) return fail("signature file is not base64");
  const signature = Buffer.from(encoded, "base64");
  if (signature.length !== 64) return fail("signature has the wrong length");
  if (!verify(null, bytes, publicKey, signature))
    return fail("signature does not match manifest.json");
  if (declared.key_id === undefined)
    return fail("manifest does not declare the signature it was signed under");
  return { ok: true, keyId };
}

/**
 * Detached signature over an export archive. A finalized package's manifest
 * is immutable, so export-time signing signs the archive digest instead:
 * Ed25519 over `rea-web-export-signature:v1\n<sha256 hex>`. The document
 * carries no key material, only the public key id.
 */
export const EXPORT_SIGNATURE_FORMAT = "rea-web-export-signature" as const;

export interface ExportSignature {
  readonly format: typeof EXPORT_SIGNATURE_FORMAT;
  readonly version: 1;
  readonly algorithm: "ed25519";
  readonly public_key_id: string;
  readonly archive_sha256: string;
  readonly signed_at: string;
  readonly signature: string;
}

const archiveMessage = (sha256: string): Buffer =>
  Buffer.from(`${EXPORT_SIGNATURE_FORMAT}:v1\n${sha256}`, "utf8");

const SHA256_HEX = /^[0-9a-f]{64}$/u;

export function signArchiveDigest(
  archiveSha256: string,
  privateKeyPem: string,
  now: Date = new Date(),
): ExportSignature {
  if (!SHA256_HEX.test(archiveSha256))
    throw new SignatureError("archive digest must be lowercase sha256 hex");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch (error) {
    throw new SignatureError("private key is not valid PEM", error);
  }
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new SignatureError("private key is not an Ed25519 key");
  return {
    format: EXPORT_SIGNATURE_FORMAT,
    version: 1,
    algorithm: "ed25519",
    public_key_id: publicKeyId(createPublicKey(privateKey)),
    archive_sha256: archiveSha256,
    signed_at: now.toISOString(),
    signature: sign(null, archiveMessage(archiveSha256), privateKey).toString(
      "base64",
    ),
  };
}

/** Verify a detached export signature against the archive's actual digest. */
export function verifyArchiveSignature(
  document: unknown,
  actualSha256: string,
  publicKeyPem: string,
): { ok: boolean; keyId: string; reason?: string } {
  const publicKey = loadPublicKey(publicKeyPem);
  const keyId = publicKeyId(publicKey);
  const fail = (reason: string) => ({ ok: false, keyId, reason });
  const d = document as Partial<ExportSignature> | null;
  if (
    d === null ||
    typeof d !== "object" ||
    d.format !== EXPORT_SIGNATURE_FORMAT ||
    d.version !== 1 ||
    d.algorithm !== "ed25519" ||
    typeof d.archive_sha256 !== "string" ||
    typeof d.signature !== "string"
  )
    return fail("not a rea-web export signature document");
  if (d.public_key_id !== keyId)
    return fail(
      `key id mismatch: signed by ${String(d.public_key_id)}, supplied key is ${keyId}`,
    );
  if (d.archive_sha256 !== actualSha256)
    return fail("archive digest does not match the signed digest");
  if (!BASE64.test(d.signature)) return fail("signature is not base64");
  const signature = Buffer.from(d.signature, "base64");
  if (signature.length !== 64) return fail("signature has the wrong length");
  if (!verify(null, archiveMessage(actualSha256), publicKey, signature))
    return fail("signature does not match the archive digest");
  return { ok: true, keyId };
}

/** Public key id (sha256 of DER SPKI) of a PEM public or private key. */
export function signingKeyId(pem: string): string {
  try {
    return publicKeyId(createPublicKey(pem));
  } catch (error) {
    throw new SignatureError("key is not valid PEM", error);
  }
}
