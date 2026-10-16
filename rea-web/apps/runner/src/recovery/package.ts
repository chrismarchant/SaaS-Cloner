import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  recoveryManifestSchema,
  validateRelativePath,
  type RecoveryManifest,
} from "@rea-web/contracts";
import { materializeGeneratedFiles, verifyIntegrity } from "@rea-web/recovery";
import type { JobContext } from "../jobContext.js";

/**
 * Materialise a captured package from object storage into the job workspace:
 * the stored manifest first, then every file it lists (addressed by index),
 * each checked against the manifest digest, then the derived files, then a
 * full integrity check.
 */
export class PackageDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageDownloadError";
  }
}

const sha256File = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
};

export const downloadPackage = async (
  ctx: JobContext,
  directory: string,
): Promise<{ root: string; manifest: RecoveryManifest }> => {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifestPath = join(directory, "manifest.json");
  await ctx.client.downloadInput(
    ctx.job.id,
    ctx.fencingToken,
    "manifest",
    manifestPath,
    ctx.signal,
  );
  const manifest = recoveryManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  for (const [index, file] of manifest.files.entries()) {
    const checked = validateRelativePath(file.path);
    if (!checked.ok || checked.path === "manifest.json")
      throw new PackageDownloadError(
        `manifest lists an unsafe path ${file.path}`,
      );
    const target = join(directory, checked.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await ctx.client.downloadInput(
      ctx.job.id,
      ctx.fencingToken,
      `capture-file-${index}`,
      target,
      ctx.signal,
    );
    const actual = await sha256File(target);
    if (actual !== file.sha256)
      throw new PackageDownloadError(
        `${file.path} digest mismatch: manifest ${file.sha256}, stored ${actual}`,
      );
  }
  // Derived files (RECOVERY.md, the manifest schema) are not in files[];
  // the recovery package regenerates them from the manifest.
  await materializeGeneratedFiles(directory);
  const integrity = await verifyIntegrity(directory);
  if (!integrity.ok)
    throw new PackageDownloadError(
      `package failed integrity verification: ${JSON.stringify(integrity).slice(0, 1000)}`,
    );
  return { root: directory, manifest };
};
