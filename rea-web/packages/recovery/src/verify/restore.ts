import { realpath } from "node:fs/promises";
import {
  type RestoreReport,
  type ScopeResult,
  RESTORE_REPORT_FORMAT,
  restoreReportSchema,
} from "@rea-web/contracts";
import { PackageFormatError } from "../errors.js";
import { sha256Hex } from "../fsutil.js";
import {
  type VerifyIntegrityOptions,
  parseManifestBytes,
  readManifestBytes,
  verifyIntegrity,
} from "../read.js";
import { verifySignature } from "../signing.js";
import {
  type Ctx,
  type RestoreOptions,
  type RestoreScope,
  type VerifyOptions,
  createContext,
} from "./context.js";
import { normalizeBlockedHost } from "./database.js";
import { runScope } from "./scopes.js";
import { SCOPE_ORDER, networkVerdict, overallStatus } from "./status.js";

const NO_MANIFEST_SHA = "0".repeat(64);

type Loaded =
  | {
      ok: true;
      root: string;
      manifest: import("@rea-web/contracts").RecoveryManifest;
      manifestSha: string;
    }
  | { ok: false; reason: string };

async function loadPackage(packageDir: string): Promise<Loaded> {
  let root: string;
  try {
    root = await realpath(packageDir);
  } catch {
    return {
      ok: false,
      reason: `package directory ${packageDir} is not readable`,
    };
  }
  try {
    const bytes = await readManifestBytes(root);
    return {
      ok: true,
      root,
      manifest: parseManifestBytes(bytes),
      manifestSha: sha256Hex(bytes),
    };
  } catch (error) {
    if (error instanceof PackageFormatError)
      return { ok: false, reason: error.message };
    throw error;
  }
}

const listPaths = (paths: readonly string[]): string =>
  `${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ` (+${paths.length - 5} more)` : ""}`;

/** Integrity scope: hashes, structure, and the detached signature when a key is given. */
async function integrityScope(
  loaded: Extract<Loaded, { ok: true }>,
  opts: VerifyOptions,
): Promise<{ ok: boolean; detail: string }> {
  const integrityOptions: VerifyIntegrityOptions = {};
  if (opts.signal !== undefined) integrityOptions.signal = opts.signal;
  const report = await verifyIntegrity(loaded.root, integrityOptions);
  const problems: string[] = [];
  if (report.mismatched.length > 0)
    problems.push(
      `${report.mismatched.length} file(s) differ from the manifest hash: ${listPaths(report.mismatched.map((m) => m.path))}`,
    );
  if (report.missing.length > 0)
    problems.push(
      `${report.missing.length} file(s) missing: ${listPaths(report.missing)}`,
    );
  if (report.extra.length > 0)
    problems.push(
      `${report.extra.length} file(s) not in the manifest: ${listPaths(report.extra)}`,
    );
  if (report.unsafe_paths.length > 0)
    problems.push(
      `${report.unsafe_paths.length} symlink or special file(s): ${listPaths(report.unsafe_paths)}`,
    );
  let signature = "";
  if (opts.publicKeyPem !== undefined) {
    try {
      const sig = await verifySignature(loaded.root, opts.publicKeyPem);
      if (sig.ok) signature = `; detached signature valid (key ${sig.keyId})`;
      else problems.push(`signature check failed: ${sig.reason ?? "invalid"}`);
    } catch (error) {
      problems.push(`signature check failed: ${(error as Error).message}`);
    }
  } else if (loaded.manifest.signature !== undefined) {
    signature =
      "; the package declares a signature that was not verified (no public key supplied)";
  }
  return problems.length > 0
    ? { ok: false, detail: problems.join("; ") }
    : {
        ok: true,
        detail: `${report.checked} file(s) match their recorded SHA-256 and the manifest is valid${signature}`,
      };
}

const scopeResult = (
  scope: ScopeResult["scope"],
  status: ScopeResult["status"],
  detail: string,
  now: () => Date,
): ScopeResult => ({
  scope,
  status,
  detail,
  performed_at: now().toISOString(),
  missing_tools: [],
  steps: [],
  invariants: [],
});

const orderedScopes = (scopes: readonly RestoreScope[]): RestoreScope[] =>
  SCOPE_ORDER.filter(
    (s): s is RestoreScope =>
      (scopes as readonly string[]).includes(s) && s !== "integrity",
  );

const PRODUCTION_REFUSAL =
  "--allow-production is refused in verification mode: this tool restores only into disposable targets";

interface Established {
  readonly ctx: Ctx | null;
  /** Why no requested scope was attempted, when none was. */
  readonly stop: string | null;
  readonly cleanup: () => Promise<void>;
}

/** Decide whether anything may run: the package must be readable and its integrity must hold. */
async function establish(
  loaded: Loaded,
  opts: RestoreOptions,
  requested: readonly RestoreScope[],
  now: () => Date,
  scopes: ScopeResult[],
): Promise<Established> {
  const refuse = (stop: string): Established => {
    scopes.push(scopeResult("integrity", "blocked", `blocked: ${stop}`, now));
    return { ctx: null, stop, cleanup: () => Promise.resolve() };
  };
  if (!loaded.ok) return refuse(loaded.reason);
  if (opts.allowProduction === true) return refuse(PRODUCTION_REFUSAL);
  const created = await createContext(loaded.manifest, loaded.root, {
    ...opts,
    scopes: requested,
  });
  const integrity = await integrityScope(loaded, opts);
  if (!integrity.ok) {
    scopes.push(
      scopeResult(
        "integrity",
        "blocked",
        `integrity check failed: ${integrity.detail}`,
        now,
      ),
    );
    return {
      ctx: null,
      stop: `integrity check failed: ${integrity.detail}`,
      cleanup: created.cleanup,
    };
  }
  scopes.push(
    scopeResult("integrity", "integrity_verified", integrity.detail, now),
  );
  if (requested.length > 0 && created.ctx.globalBlock === null)
    await created.ctx.isolation();
  return { ctx: created.ctx, stop: null, cleanup: created.cleanup };
}

async function run(
  packageDir: string,
  opts: RestoreOptions,
): Promise<RestoreReport> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const requested = orderedScopes(opts.scopes);
  const loaded = await loadPackage(packageDir);
  const scopes: ScopeResult[] = [];
  const { ctx, stop, cleanup } = await establish(
    loaded,
    opts,
    requested,
    now,
    scopes,
  );
  try {
    for (const scope of requested)
      scopes.push(
        ctx === null
          ? scopeResult(
              scope,
              "blocked",
              `blocked: ${stop ?? "nothing ran"}`,
              now,
            )
          : await runScope(ctx, scope, scopes),
      );
    return await assemble(loaded, opts, ctx, scopes, startedAt, now);
  } finally {
    await cleanup();
  }
}

async function assemble(
  loaded: Loaded,
  opts: RestoreOptions,
  ctx: Ctx | null,
  scopes: ScopeResult[],
  startedAt: string,
  now: () => Date,
): Promise<RestoreReport> {
  const guards = loaded.ok ? loaded.manifest.restore_guards : null;
  const iso = (await ctx?.probed()) ?? null;
  const verdict =
    ctx === null
      ? {
          verdict: "unknown" as const,
          reasons: [
            "no restore step was executed: package integrity was not established",
          ],
        }
      : networkVerdict({
          needed: ctx.facts.needed,
          executed: ctx.facts.executed,
        });
  const report = {
    format: RESTORE_REPORT_FORMAT,
    format_version: 1 as const,
    package_id: loaded.ok ? loaded.manifest.package_id : "unknown",
    manifest_sha256: loaded.ok ? loaded.manifestSha : NO_MANIFEST_SHA,
    started_at: startedAt,
    finished_at: now().toISOString(),
    verifier: {
      name: "rea-recover" as const,
      version: opts.verifierVersion,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    network_isolation:
      iso === null
        ? {
            mechanism: "none" as const,
            available: false,
            detail: "not probed: no restore step was attempted",
          }
        : {
            mechanism: iso.available
              ? ("linux-network-namespace" as const)
              : ("none" as const),
            available: iso.available,
            detail: iso.detail,
          },
    guards: {
      blocked_hosts: (guards?.blocked_hosts ?? []).map(normalizeBlockedHost),
      database_host:
        ctx?.db === null || ctx === null
          ? null
          : ctx.db.hosts.join(",") || null,
      disabled_schedules: guards?.disabled_schedules ?? [],
      disabled_webhooks: guards?.disabled_webhooks ?? [],
    },
    scopes,
    network_required: verdict,
    overall: overallStatus(scopes),
  };
  return restoreReportSchema.parse(report);
}

/**
 * Check a package without restoring anything: SHA-256 of every file, manifest
 * structure and, with a public key, the detached signature.
 */
export function verifyPackage(
  packageDir: string,
  options: VerifyOptions,
): Promise<RestoreReport> {
  return run(packageDir, { ...options, scopes: [] });
}

/**
 * Verify integrity, then restore into disposable targets and check each
 * requested scope. Nothing runs unless integrity holds.
 */
export function restorePackage(
  packageDir: string,
  options: RestoreOptions,
): Promise<RestoreReport> {
  return run(packageDir, options);
}
