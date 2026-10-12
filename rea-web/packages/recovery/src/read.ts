import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  type RecoveryManifest,
  recoveryManifestSchema,
} from "@rea-web/contracts";
import { PackageFormatError } from "./errors.js";
import {
  MANIFEST_FILE,
  MANIFEST_SCHEMA_FILE,
  RECOVERY_GUIDE_FILE,
  SIGNATURE_FILE,
  compareCodepoints,
  hashFile,
  sha256Hex,
  walkTree,
} from "./fsutil.js";
import {
  GENERATED_FILES,
  findManifestProblems,
  manifestSchemaFileContent,
} from "./layout.js";
import { renderRecoveryMarkdown } from "./markdown.js";

const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

export interface IntegrityReport {
  ok: boolean;
  /** Number of `files[]` entries examined. */
  checked: number;
  mismatched: { path: string; expected: string; actual: string }[];
  missing: string[];
  extra: string[];
  unsafe_paths: string[];
}

/** Parse and structurally validate manifest bytes. Throws PackageFormatError. */
export const parseManifestBytes = (bytes: Uint8Array): RecoveryManifest => {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new PackageFormatError("manifest.json is not valid JSON", {
      cause: error,
    });
  }
  const parsed = recoveryManifestSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new PackageFormatError(
      `manifest.json failed schema validation at ${first?.path.join(".") || "<root>"}: ${first?.message ?? "unknown"}`,
      { cause: parsed.error },
    );
  }
  const problems = findManifestProblems(parsed.data);
  if (problems.length > 0)
    throw new PackageFormatError(
      `manifest.json is structurally invalid: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ""}`,
    );
  return parsed.data;
};

export const readManifestBytes = async (root: string): Promise<Buffer> => {
  const path = join(root, MANIFEST_FILE);
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new PackageFormatError("manifest.json is missing", {
        cause: error,
      });
    throw error;
  }
  if (!stat.isFile())
    throw new PackageFormatError("manifest.json is not a regular file");
  if (stat.size > MAX_MANIFEST_BYTES)
    throw new PackageFormatError(
      `manifest.json is ${stat.size} bytes, above the ${MAX_MANIFEST_BYTES} byte limit`,
    );
  return readFile(path);
};

export async function readPackage(
  root: string,
): Promise<{ manifest: RecoveryManifest; root: string }> {
  let real: string;
  try {
    real = await realpath(root);
  } catch (error) {
    throw new PackageFormatError(`package root ${root} is not readable`, {
      cause: error,
    });
  }
  return {
    manifest: parseManifestBytes(await readManifestBytes(real)),
    root: real,
  };
}

const ancestorsAndSelf = (path: string): string[] => {
  const parts = path.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
};

/** Expected hash of each generated file, derived from the manifest alone. */
const generatedExpectations = (
  manifest: RecoveryManifest,
): Map<string, string> =>
  new Map([
    [RECOVERY_GUIDE_FILE, sha256Hex(renderRecoveryMarkdown(manifest))],
    [MANIFEST_SCHEMA_FILE, sha256Hex(manifestSchemaFileContent())],
  ]);

export interface VerifyIntegrityOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export async function verifyIntegrity(
  root: string,
  opts: VerifyIntegrityOptions = {},
): Promise<IntegrityReport> {
  const { manifest, root: real } = await readPackage(root);
  const tree = await walkTree(real);
  const unsafeSet = new Set(
    tree.filter((e) => e.kind === "unsafe").map((e) => e.path),
  );
  const present = new Set(
    tree.filter((e) => e.kind === "file").map((e) => e.path),
  );
  const listed = new Set(manifest.files.map((f) => f.path));
  const unsafe = new Set<string>(unsafeSet);
  const report: IntegrityReport = {
    ok: false,
    checked: 0,
    mismatched: [],
    missing: [],
    extra: [],
    unsafe_paths: [],
  };

  const scan: Scan = {
    root: real,
    present,
    unsafe,
    report,
    signal: opts.signal,
  };
  const total = manifest.files.length;
  for (const entry of manifest.files) {
    opts.signal?.throwIfAborted();
    report.checked += 1;
    await checkFile(scan, entry.path, entry);
    opts.onProgress?.(report.checked, total);
  }

  for (const [path, sha256] of generatedExpectations(manifest)) {
    if (listed.has(path)) continue;
    opts.signal?.throwIfAborted();
    await checkFile(scan, path, { sha256 });
  }

  const known = new Set<string>([
    MANIFEST_FILE,
    manifest.signature?.detached_path ?? SIGNATURE_FILE,
    ...GENERATED_FILES,
    ...listed,
  ]);
  report.extra = [...present].filter((p) => !known.has(p));
  report.extra.sort(compareCodepoints);
  report.missing.sort(compareCodepoints);
  report.mismatched.sort((a, b) => compareCodepoints(a.path, b.path));
  report.unsafe_paths = [...unsafe].sort(compareCodepoints);
  report.ok =
    report.mismatched.length === 0 &&
    report.missing.length === 0 &&
    report.extra.length === 0 &&
    report.unsafe_paths.length === 0;
  return report;
}

const isUnsafePath = (path: string, unsafe: ReadonlySet<string>): boolean =>
  ancestorsAndSelf(path).some((p) => unsafe.has(p));

interface Scan {
  readonly root: string;
  readonly present: ReadonlySet<string>;
  readonly unsafe: Set<string>;
  readonly report: IntegrityReport;
  readonly signal: AbortSignal | undefined;
}

/** Compare one on-disk file with its expected hash (and size when known). */
async function checkFile(
  scan: Scan,
  path: string,
  expected: { sha256: string; size?: number },
): Promise<void> {
  const { report, unsafe } = scan;
  if (isUnsafePath(path, unsafe)) {
    unsafe.add(path);
    return;
  }
  if (!scan.present.has(path)) {
    report.missing.push(path);
    return;
  }
  let actual: { sha256: string; size: number };
  try {
    actual = await hashFile(join(scan.root, ...path.split("/")), scan.signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") report.missing.push(path);
    else if (code === "ELOOP" || error instanceof PackageFormatError)
      unsafe.add(path);
    else throw error;
    return;
  }
  if (
    actual.sha256 !== expected.sha256 ||
    (expected.size !== undefined && actual.size !== expected.size)
  )
    report.mismatched.push({
      path,
      expected: expected.sha256,
      actual: actual.sha256,
    });
}
