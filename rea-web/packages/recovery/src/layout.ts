import {
  recoveryManifestJsonSchema,
  validateRelativePath,
  validateRestoreStepArguments,
  type RecoveryManifest,
} from "@rea-web/contracts";
import {
  MANIFEST_FILE,
  MANIFEST_SCHEMA_FILE,
  RECOVERY_GUIDE_FILE,
  SIGNATURE_FILE,
} from "./fsutil.js";

/**
 * Pseudo component for package-level files that belong to no captured
 * component (restore scripts, verifier bundle, licenses, verifier reports).
 */
export const PACKAGE_COMPONENT_ID = "package";
const PACKAGE_LEVEL_PREFIXES = ["recovery/", "licenses/", "verification/"];

/** Files written by `finalize`; not recorded in `files[]`, regenerated on verify. */
export const GENERATED_FILES = [
  RECOVERY_GUIDE_FILE,
  MANIFEST_SCHEMA_FILE,
] as const;

const RESERVED = new Set<string>(
  [MANIFEST_FILE, SIGNATURE_FILE, ...GENERATED_FILES].map((p) =>
    p.toLowerCase(),
  ),
);

export const isReservedPath = (path: string, extra?: string): boolean =>
  RESERVED.has(path.toLowerCase()) ||
  (extra !== undefined && extra.toLowerCase() === path.toLowerCase());

export const serializeJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

export const manifestSchemaFileContent = (): string =>
  serializeJson(recoveryManifestJsonSchema());

/** Directory prefix (with trailing slash) for a component root, or null if none. */
export const componentPrefix = (root: string): string | null => {
  if (root === "") return null;
  const validated = validateRelativePath(root);
  return validated.ok ? `${validated.path}/` : null;
};

/** Why `path` may not be recorded for `componentId`, or null if it may. */
export const pathPlacementProblem = (
  path: string,
  componentId: string,
  components: readonly { id: string; root: string }[],
): string | null => {
  if (componentId === PACKAGE_COMPONENT_ID)
    return PACKAGE_LEVEL_PREFIXES.some((p) => path.startsWith(p))
      ? null
      : `package-level file ${path} must be under ${PACKAGE_LEVEL_PREFIXES.join(", ")}`;
  const component = components.find((c) => c.id === componentId);
  if (component === undefined) return `unknown component ${componentId}`;
  const prefix = componentPrefix(component.root);
  if (prefix === null)
    return `component ${componentId} declares no usable root directory`;
  return path.startsWith(prefix)
    ? null
    : `${path} is outside component ${componentId} root ${prefix}`;
};

const duplicates = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) dup.add(v);
    seen.add(key);
  }
  return [...dup];
};

const safePathProblem = (path: string, what: string): string | null => {
  const v = validateRelativePath(path);
  if (!v.ok)
    return `${what} ${JSON.stringify(path)} unsafe (${v.rejection.kind})`;
  return v.path === path
    ? null
    : `${what} ${JSON.stringify(path)} is not normalised`;
};

/**
 * Structural rules the JSON Schema cannot express. Used both when building and
 * when reading, so a hostile manifest is rejected before any file is touched.
 */
export const findManifestProblems = (m: RecoveryManifest): string[] => {
  const problems: string[] = [];
  const ids = m.components.map((c) => c.id);
  for (const id of duplicates(ids))
    problems.push(`duplicate component id ${id}`);
  if (ids.includes(PACKAGE_COMPONENT_ID))
    problems.push(`component id ${PACKAGE_COMPONENT_ID} is reserved`);
  for (const c of m.components) {
    if (c.root !== "") {
      const p = safePathProblem(
        c.root.replace(/\/$/u, ""),
        `component ${c.id} root`,
      );
      if (p !== null) problems.push(p);
    }
    for (const step of c.restore.steps) {
      const r = validateRestoreStepArguments(step);
      if (!r.ok) problems.push(r.reason);
    }
  }
  for (const dup of duplicates(m.files.map((f) => f.path)))
    problems.push(`duplicate file path ${dup}`);
  for (const f of m.files) {
    const p = safePathProblem(f.path, "file path");
    if (p !== null) {
      problems.push(p);
      continue;
    }
    if (isReservedPath(f.path, m.signature?.detached_path))
      problems.push(`file path ${f.path} is reserved`);
    const placement = pathPlacementProblem(
      f.path,
      f.component_id,
      m.components,
    );
    if (placement !== null) problems.push(placement);
  }
  const extras = [
    m.signature?.detached_path,
    m.secrets.escrow_ref,
    ...m.verification.results.map((r) => r.evidence_path),
  ];
  for (const extra of extras) {
    if (extra === undefined) continue;
    const p = safePathProblem(extra, "referenced path");
    if (p !== null) problems.push(p);
  }
  return problems;
};
