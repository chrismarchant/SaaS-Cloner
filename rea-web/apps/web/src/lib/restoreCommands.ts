/**
 * The "restore this package" command lines, built from the export record and
 * the manifest. They name arguments and environment variables only: no URL,
 * key, path or secret from the page is ever placed in them.
 */
import {
  VERIFICATION_SCOPES,
  type RecoveryManifest,
} from "@rea-web/contracts/browser";

export interface RestoreCommands {
  readonly unpack: string;
  readonly restore: string;
  readonly scopes: readonly string[];
  /** Name of the variable the operator sets to a disposable database URL. */
  readonly databaseUrlEnv: string | null;
  readonly notes: readonly string[];
}

export const RESTORE_DATABASE_ENV = "RESTORE_DATABASE_URL";

export const restoreCommands = (
  manifest: RecoveryManifest,
  encryption: { recipients: readonly string[] } | null,
): RestoreCommands => {
  const steps = manifest.components.flatMap((c) => c.restore.steps);
  const scopes = VERIFICATION_SCOPES.filter(
    (scope) => scope !== "integrity" && steps.some((s) => s.scope === scope),
  );
  const needsDatabase =
    scopes.includes("data_restore") ||
    steps.some((step) => step.network === "database");
  const registry = steps.some((step) => step.network === "registry");
  const unknownNetwork = steps.some((step) => step.network === "unknown");
  const hasAssets = manifest.components.some(
    (component) => component.kind === "assets",
  );
  const unpack = [
    "rea-recover unpack <export-file>",
    "--out <empty-dir>",
    ...(encryption === null ? [] : ["--key-file <key-file>"]),
  ].join(" ");
  const restore = [
    "rea-recover restore <unpacked-package-dir>",
    `--scope ${(scopes.length === 0 ? ["clean_build"] : scopes).join(",")}`,
    "--target <empty-dir>",
    ...(needsDatabase ? [`--database-url-env ${RESTORE_DATABASE_ENV}`] : []),
    ...(hasAssets ? ["--assets-root <empty-dir>"] : []),
    ...(registry || unknownNetwork
      ? [
          `--allow-network ${[
            registry ? "registry" : "",
            unknownNetwork ? "unknown" : "",
          ]
            .filter((name) => name !== "")
            .join(",")}`,
        ]
      : []),
  ].join(" ");
  const notes: string[] = [];
  if (encryption !== null)
    notes.push(
      `The archive is encrypted. Use the key file for one of the recipients (${encryption.recipients.join(", ") || "none listed"}); the key is not in the archive and is not on this page.`,
    );
  if (needsDatabase)
    notes.push(
      `Set ${RESTORE_DATABASE_ENV} in your environment to the URL of an empty, disposable database. Never use the capture credential, and never a production database.`,
    );
  if (registry)
    notes.push(
      "Some steps need a package registry; without --allow-network registry they report blocked.",
    );
  notes.push(
    "Verification never touches production. The restore replays the declared steps into the empty --target directory only.",
  );
  return {
    unpack,
    restore,
    scopes,
    databaseUrlEnv: needsDatabase ? RESTORE_DATABASE_ENV : null,
    notes,
  };
};
