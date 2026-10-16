import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { jobResultSchemas, type JobResult } from "@rea-web/contracts";
import { createHash } from "node:crypto";
import {
  encryptExport,
  packExport,
  signArchiveDigest,
  signingKeyId,
  type RecoveryKey,
} from "@rea-web/recovery";
import type { JobContext } from "../jobContext.js";
import { downloadPackage } from "./package.js";

/**
 * recovery.export: the verified package as a deterministic tar, optionally
 * encrypted to one recovery key held by this runner. Keys live in the
 * runner's key directory (`<key id>.key`, base64) and never enter the
 * package, the archive, the job result or the logs.
 */
export interface ExportDeps {
  /** Directory of recovery keys (`<key id>.key`), outside every workspace. */
  readonly recoveryKeysDir: string | null;
  /** Directory of Ed25519 signing keys (`<public key id>.pem`, PKCS#8). */
  readonly signingKeysDir: string | null;
}

export class ExportRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportRefusedError";
  }
}

const KEY_ID = /^[A-Za-z0-9_-]{8,128}$/u;

const loadRecoveryKey = async (
  deps: ExportDeps,
  keyId: string,
): Promise<RecoveryKey> => {
  if (!KEY_ID.test(keyId))
    throw new ExportRefusedError(
      `recovery key id ${JSON.stringify(keyId)} is not valid`,
    );
  if (deps.recoveryKeysDir === null)
    throw new ExportRefusedError(
      "encryption requested but this runner has no REA_WEB_RECOVERY_KEYS_DIR",
    );
  const keyPath = join(deps.recoveryKeysDir, `${keyId}.key`);
  const keyBase64 = (
    await readFile(keyPath, "utf8").catch(() => {
      throw new ExportRefusedError(
        `recovery key ${keyId} is not on this runner`,
      );
    })
  ).trim();
  return { keyBase64, keyId, keyPath };
};

const SIGNING_KEY_ID = /^[0-9a-f]{64}$/u;

/** Private signing key for `keyId`; the file name and the key must agree. */
const loadSigningKey = async (
  deps: ExportDeps,
  keyId: string,
): Promise<string> => {
  if (!SIGNING_KEY_ID.test(keyId))
    throw new ExportRefusedError(
      "sign_with_key_id must be the signing key's public key id (64 hex characters)",
    );
  if (deps.signingKeysDir === null)
    throw new ExportRefusedError(
      "signing requested but this runner has no REA_WEB_EXPORT_SIGNING_KEYS_DIR",
    );
  const pem = await readFile(
    join(deps.signingKeysDir, `${keyId}.pem`),
    "utf8",
  ).catch(() => {
    throw new ExportRefusedError(`signing key ${keyId} is not on this runner`);
  });
  if (signingKeyId(pem) !== keyId)
    throw new ExportRefusedError(
      `signing key file ${keyId}.pem holds a different key`,
    );
  return pem;
};

export const runRecoveryExport = async (
  ctx: JobContext,
  deps: ExportDeps,
): Promise<JobResult<"recovery.export">> => {
  const recipients = Array.isArray(ctx.job.input["encrypt_to_recipients"])
    ? (ctx.job.input["encrypt_to_recipients"] as unknown[]).map(String)
    : [];
  if (recipients.length > 1)
    throw new ExportRefusedError(
      "aes-256-gcm-envelope encrypts to exactly one recovery key; request one recipient",
    );
  if (ctx.job.input["include_secret_escrow"] === true)
    throw new ExportRefusedError(
      "secret escrow is not implemented; exports contain secret names only",
    );
  const packageDir = join(ctx.workspace, "package");
  const tarPath = join(ctx.workspace, "export.tar");
  const encryptedPath = join(ctx.workspace, "export.tar.enc");
  try {
    const { root } = await downloadPackage(ctx, packageDir);
    await ctx.progress("package verified", {});
    const packed = await packExport(root, tarPath);
    let uploadPath = packed.path;
    let encryption: JobResult<"recovery.export">["export"]["encryption"] = null;
    const [recipient] = recipients;
    if (recipient !== undefined) {
      const key = await loadRecoveryKey(deps, recipient);
      const encrypted = await encryptExport(packed.path, encryptedPath, key, {
        packageRoot: root,
        keyPaths: [key.keyPath as string],
      });
      uploadPath = encrypted.path;
      encryption = {
        scheme: encrypted.header.scheme,
        recipients: [encrypted.header.key_id],
        key_location: "external",
        chunk_size: encrypted.header.chunk_size,
        plaintext_sha256: packed.sha256,
      };
    }
    const signKeyId =
      typeof ctx.job.input["sign_with_key_id"] === "string"
        ? ctx.job.input["sign_with_key_id"]
        : null;
    // Load the key before uploading anything, so a missing key fails early.
    const signingKey =
      signKeyId === null ? null : await loadSigningKey(deps, signKeyId);
    const uploaded = await ctx.client.uploadArtifact(
      ctx.job.id,
      ctx.fencingToken,
      {
        kind: "export_archive",
        name: recipient === undefined ? "export.tar" : "export.tar.enc",
      },
      { path: uploadPath },
    );
    ctx.usage.addArtifactBytes(uploaded.size);
    let signature: JobResult<"recovery.export">["export"]["signature"] = null;
    if (signingKey !== null) {
      // Sign what is distributed: the uploaded (possibly encrypted) archive.
      const digest = createHash("sha256")
        .update(await readFile(uploadPath))
        .digest("hex");
      if (digest !== uploaded.sha256)
        throw new Error("uploaded archive digest differs from the local file");
      const document = signArchiveDigest(digest, signingKey);
      const body = `${JSON.stringify(document, null, 2)}\n`;
      const sig = await ctx.client.uploadArtifact(
        ctx.job.id,
        ctx.fencingToken,
        { kind: "export_signature", name: "export.sig.json" },
        { body },
      );
      // The signature is public; the result carries the whole document.
      signature = {
        ...document,
        object_key: sig.object_key,
        sha256: sig.sha256,
        size: sig.size,
      };
    }
    return jobResultSchemas["recovery.export"].parse({
      export: { signature, encryption },
    });
  } finally {
    for (const path of [packageDir, tarPath, encryptedPath])
      await rm(path, { recursive: true, force: true });
  }
};
