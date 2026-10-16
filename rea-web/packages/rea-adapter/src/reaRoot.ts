import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Locate and describe the upstream REA installation a runner uses. The root
 * must contain `scripts/rea.mjs` and a built `dist/mcp/main.js`; the package
 * version comes from its package.json and the source SHA from `git rev-parse`
 * when the root is a checkout (null for an installed package).
 */
export interface ReaRootInfo {
  readonly root: string;
  readonly package_version: string;
  readonly package_name: string;
  readonly built: boolean;
  readonly source_sha: string | null;
}

export const describeReaRoot = async (
  candidate: string,
): Promise<ReaRootInfo> => {
  const root = resolve(candidate);
  const pkg = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as {
    name?: string;
    version?: string;
  };
  if (pkg.name !== "rea-agents")
    throw new Error(
      `${root} is not a rea-agents package (name=${pkg.name ?? "missing"})`,
    );
  await access(join(root, "scripts", "rea.mjs"));
  let built = true;
  try {
    await access(join(root, "dist", "mcp", "main.js"));
  } catch {
    built = false;
  }
  const sourceSha = await new Promise<string | null>((done) => {
    execFile(
      "git",
      ["-C", root, "rev-parse", "HEAD"],
      { timeout: 10_000 },
      (error, stdout) => done(error ? null : stdout.trim() || null),
    );
  });
  return {
    root,
    package_version: pkg.version ?? "unknown",
    package_name: pkg.name,
    built,
    source_sha: sourceSha,
  };
};
