import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

/**
 * Runner-local sources and assets are named by `path_hash`, never by path, so
 * the control plane and browser cannot name arbitrary host paths. Only paths
 * on this runner's operator-configured allowlist resolve; the hash is over
 * the real path with a domain tag, so it is stable across symlinked spellings.
 */
export const localPathHash = (realPath: string): string =>
  createHash("sha256")
    .update(`rea-web:local-path:v1\0${realPath}`)
    .digest("hex");

export const resolveLocalPaths = async (
  allowlist: readonly string[],
): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  for (const entry of allowlist) {
    const real = await realpath(entry).catch(() => null);
    if (real !== null) map.set(localPathHash(real), real);
  }
  return map;
};

/** A runner-local path the job names is not on this runner's allowlist. */
export class LocalPathUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalPathUnavailableError";
  }
}
