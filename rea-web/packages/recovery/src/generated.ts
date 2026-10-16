import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RecoveryManifest } from "@rea-web/contracts";
import {
  MANIFEST_SCHEMA_FILE,
  RECOVERY_GUIDE_FILE,
  writeFileAtomic,
} from "./fsutil.js";
import { manifestSchemaFileContent } from "./layout.js";
import { renderRecoveryMarkdown } from "./markdown.js";
import { readPackage } from "./read.js";

/**
 * The package files derived from the manifest alone (not listed in
 * `files[]`). Sole producer: `finalize` writes them, `verifyIntegrity` checks
 * them, and a package rebuilt from stored `files[]` regenerates them.
 */
export const generatedFileContents = (
  manifest: RecoveryManifest,
): ReadonlyMap<string, string> =>
  new Map([
    [RECOVERY_GUIDE_FILE, renderRecoveryMarkdown(manifest)],
    [MANIFEST_SCHEMA_FILE, manifestSchemaFileContent()],
  ]);

export const writeGeneratedFiles = async (
  root: string,
  manifest: RecoveryManifest,
): Promise<void> => {
  for (const [path, content] of generatedFileContents(manifest)) {
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFileAtomic(target, content);
  }
};

/**
 * Regenerate the derived files of a package whose `manifest.json` and listed
 * files were restored from storage, so it verifies and exports intact.
 */
export const materializeGeneratedFiles = async (
  root: string,
): Promise<void> => {
  const { manifest, root: real } = await readPackage(root);
  await writeGeneratedFiles(real, manifest);
};
