import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  classifyTarget,
  type LocalTargetRegistration,
} from "@rea-web/contracts";
import { resolveLocalPaths } from "./localPaths.js";

/** Files above this size are registered without a digest (null, not guessed). */
const DIGEST_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Describe this runner's allowlisted paths for registration as runner-local
 * targets. Only the name, path_hash, class and (for files) size and digest
 * leave the runner; the path itself never does.
 */
export const describeLocalTargets = async (
  allowlist: readonly string[],
  projectId: string,
): Promise<LocalTargetRegistration> => {
  const targets: LocalTargetRegistration["targets"] = [];
  for (const [pathHash, realPath] of await resolveLocalPaths(allowlist)) {
    const info = await stat(realPath);
    const name = basename(realPath).slice(0, 255) || "root";
    if (info.isDirectory()) {
      targets.push({
        name,
        path_hash: pathHash,
        kind: classifyTarget({
          name,
          head: new Uint8Array(),
          isDirectory: true,
        }),
        sha256: null,
        size: null,
        project_id: projectId,
      });
      continue;
    }
    if (!info.isFile()) continue;
    const handle = await open(realPath, "r");
    const head = new Uint8Array(512);
    try {
      await handle.read(head, 0, head.length, 0);
    } finally {
      await handle.close();
    }
    let sha256: string | null = null;
    if (info.size <= DIGEST_LIMIT_BYTES) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(realPath))
        hash.update(chunk as Buffer);
      sha256 = hash.digest("hex");
    }
    targets.push({
      name,
      path_hash: pathHash,
      kind: classifyTarget({ name, head }),
      sha256,
      size: info.size,
      project_id: projectId,
    });
  }
  return { targets };
};
