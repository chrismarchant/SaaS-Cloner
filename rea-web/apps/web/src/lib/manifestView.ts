/**
 * Reading the recovery manifest. The manifest is parsed once with the
 * contract schema (`recoveryManifestSchema`); everything else here works on
 * the parsed facts. Strings in it come from the captured system and are only
 * ever rendered as text.
 */
import {
  recoveryManifestSchema,
  type ManifestComponent,
  type ManifestFile,
  type RecoveryManifest,
} from "@rea-web/contracts/browser";

export type ManifestParse =
  | { readonly ok: true; readonly manifest: RecoveryManifest }
  | { readonly ok: false; readonly issues: readonly string[] };

export const parseManifest = (value: unknown): ManifestParse => {
  const parsed = recoveryManifestSchema.safeParse(value);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (issue) =>
        `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
    ),
  };
};

/** A container image as the manifest records it; a missing digest is said, not hidden. */
export const imageLabel = (image: {
  ref: string;
  digest: string | null;
}): string =>
  image.digest === null
    ? `${image.ref} (not pinned)`
    : `${image.ref} @ ${image.digest}`;

export const windowLabel = (
  window: { start: string; end: string } | null,
): string =>
  window === null ? "no window recorded" : `${window.start} to ${window.end}`;

export interface ManifestTotals {
  readonly files: number;
  readonly fileBytes: number;
  readonly componentsByStatus: Readonly<Record<string, number>>;
}

export const manifestTotals = (manifest: RecoveryManifest): ManifestTotals => {
  const componentsByStatus: Record<string, number> = {};
  for (const component of manifest.components)
    componentsByStatus[component.status] =
      (componentsByStatus[component.status] ?? 0) + 1;
  return {
    files: manifest.files.length,
    fileBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
    componentsByStatus,
  };
};

/** Files whose path contains `query` (case-insensitive), optionally of one component. */
export const filterFiles = (
  files: readonly ManifestFile[],
  query: string,
  componentId: string,
): readonly ManifestFile[] => {
  const needle = query.trim().toLowerCase();
  if (needle === "" && componentId === "") return files;
  return files.filter(
    (file) =>
      (componentId === "" || file.component_id === componentId) &&
      (needle === "" || file.path.toLowerCase().includes(needle)),
  );
};

/** Network classes the restore steps of a component declare. */
export const stepNetworks = (component: ManifestComponent): string[] => [
  ...new Set(component.restore.steps.map((step) => step.network)),
];
