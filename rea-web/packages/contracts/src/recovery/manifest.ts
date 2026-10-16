import { z } from "zod";
import {
  verificationScopeSchema,
  verificationStatusSchema,
} from "./vocabulary.js";

export const RECOVERY_FORMAT = "rea-web-recovery" as const;
export const RECOVERY_FORMAT_VERSION = 1 as const;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const timestamp = z.string();

export const manifestFileSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256,
  component_id: z.string().min(1),
  media_type: z.string().optional(),
});

export const restoreStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  run: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  env_names: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/u)).default([]),
  requires: z.array(z.string()).default([]),
  /**
   * Outbound network the step needs: `none`; `database` (only the disposable
   * database the restorer supplies); `registry` (package registries);
   * `unknown`. The restorer denies everything else where it can.
   */
  network: z.enum(["none", "database", "registry", "unknown"]).default("none"),
  scope: verificationScopeSchema,
});

export const omissionSchema = z.object({
  what: z.string(),
  reason: z.string(),
  remediation: z.string(),
});

export const manifestComponentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "source",
    "dependencies",
    "data",
    "assets",
    "infrastructure",
    "integrations",
    "product",
    "artifacts",
  ]),
  title: z.string(),
  status: z.enum(["captured", "partial", "blocked", "manual"]),
  captured_at: z.object({ start: timestamp, end: timestamp }).nullable(),
  method: z.string(),
  root: z.string(),
  entries: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  restore: z.object({ steps: z.array(restoreStepSchema) }),
  limitations: z.array(z.string()).default([]),
  omissions: z.array(omissionSchema).default([]),
  details: z.record(z.string(), z.unknown()).default({}),
});

export const sourceRevisionSchema = z.object({
  repository: z.string(),
  remote_url_redacted: z.string().nullable(),
  head_sha: z.string(),
  refs: z.array(z.object({ name: z.string(), sha: z.string() })),
  submodules: z.array(
    z.object({ path: z.string(), sha: z.string(), url: z.string().nullable() }),
  ),
  lfs: z.object({
    count: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    included: z.boolean(),
  }),
  working_tree: z.object({
    included: z.boolean(),
    dirty_files: z.number().int().nonnegative(),
    untracked_files: z.number().int().nonnegative(),
  }),
});

export const recoveryManifestSchema = z.object({
  format: z.literal(RECOVERY_FORMAT),
  format_version: z.literal(RECOVERY_FORMAT_VERSION),
  package_id: z.string().uuid(),
  build: z.object({
    id: z.string(),
    name: z.string(),
    project_slug: z.string(),
    description: z.string(),
  }),
  created_at: timestamp,
  producer: z.object({
    name: z.literal("rea-web"),
    version: z.string(),
    upstream_rea: z
      .object({
        package_version: z.string(),
        source_sha: z.string().nullable(),
        catalog_digest: z.string().nullable(),
      })
      .nullable(),
    tools: z.array(z.object({ name: z.string(), version: z.string() })),
  }),
  source_revisions: z.array(sourceRevisionSchema),
  components: z.array(manifestComponentSchema).min(1),
  relationships: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      kind: z.enum(["depends_on", "serves", "backs", "generated_from"]),
    }),
  ),
  files: z.array(manifestFileSchema),
  dependencies: z.object({
    runtimes: z.array(
      z.object({ name: z.string(), version: z.string(), source: z.string() }),
    ),
    package_managers: z.array(
      z.object({
        name: z.string(),
        version: z.string().nullable(),
        lockfile: z.string().nullable(),
      }),
    ),
    container_images: z.array(
      z.object({ ref: z.string(), digest: z.string().nullable() }),
    ),
    registries: z.array(
      z.object({
        url: z.string(),
        required_for: z.array(z.string()),
        credentials_required: z.boolean(),
      }),
    ),
    system_packages: z.array(z.string()),
  }),
  manual_prerequisites: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      reason: z.string(),
      instructions: z.string(),
      component_id: z.string().optional(),
    }),
  ),
  secrets: z.object({
    mode: z.enum(["names_only", "escrow"]),
    names: z.array(z.string()),
    escrow_ref: z.string().optional(),
    escrow_encryption: z.record(z.string(), z.unknown()).optional(),
  }),
  consistency: z.object({
    strategy: z.string(),
    window: z.object({ start: timestamp, end: timestamp }).nullable(),
    classification: z.enum(["single_point", "inconsistent", "unknown"]),
    gaps: z.array(z.string()),
  }),
  verification: z.object({
    scope: z.array(verificationScopeSchema),
    results: z.array(
      z.object({
        scope: verificationScopeSchema,
        status: verificationStatusSchema,
        detail: z.string(),
        performed_at: timestamp,
        evidence_path: z.string().optional(),
      }),
    ),
    network_required: z.object({
      verdict: z.enum(["yes", "no", "unknown"]),
      reasons: z.array(z.string()),
    }),
  }),
  missing_or_blocked: z.array(
    z.object({
      component_id: z.string(),
      status: z.enum(["missing", "blocked", "manual"]),
      reason: z.string(),
      remediation: z.string(),
    }),
  ),
  restore_guards: z.object({
    blocked_hosts: z.array(z.string()),
    disabled_schedules: z.array(z.string()),
    disabled_webhooks: z.array(z.string()),
    default_network: z.enum(["deny", "allow"]),
  }),
  signature: z
    .object({
      algorithm: z.literal("ed25519"),
      public_key_id: z.string(),
      detached_path: z.string(),
    })
    .optional(),
  encryption: z
    .object({
      scheme: z.enum(["aes-256-gcm-envelope"]),
      recipients: z.array(z.string()),
      key_location: z.literal("external"),
    })
    .optional(),
});

export type RecoveryManifest = z.infer<typeof recoveryManifestSchema>;
export type ManifestComponent = z.infer<typeof manifestComponentSchema>;
export type ManifestFile = z.infer<typeof manifestFileSchema>;
export type RestoreStep = z.infer<typeof restoreStepSchema>;

export const recoveryManifestJsonSchema = (): Record<string, unknown> =>
  z.toJSONSchema(recoveryManifestSchema, {
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as Record<string, unknown>;

/** Placeholders permitted in restore step arguments. */
export const RESTORE_PLACEHOLDERS = [
  "{{target}}",
  "{{database_url}}",
  "{{assets_root}}",
  "{{package_root}}",
] as const;

/** Interpreters that would turn an argument array back into a shell string. */
const SHELL_INTERPRETERS = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "ksh",
  "csh",
  "tcsh",
  "fish",
  "busybox",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);
/** Launchers whose next argument is another program to execute. */
const LAUNCHERS = new Set([
  "env",
  "nohup",
  "nice",
  "timeout",
  "xargs",
  "sudo",
  "doas",
]);

const basename = (program: string): string =>
  program.split(/[\\/]/u).pop()?.toLowerCase() ?? program;

const placeholdersIn = (value: string): string[] =>
  value.match(/\{\{[^}]*\}\}/gu) ?? [];

/**
 * Restore steps are argument arrays executed without a shell. Reject
 * unknown placeholders, shell interpreters (by basename, so `/bin/sh` and
 * `dash` count), launchers that would hide another program, and working
 * directories outside `{{target}}`, `{{package_root}}` or `{{assets_root}}`.
 */
export const validateRestoreStepArguments = (
  step: RestoreStep,
): { ok: true } | { ok: false; reason: string } => {
  for (const value of [...step.run, ...(step.cwd ? [step.cwd] : [])])
    for (const p of placeholdersIn(value))
      if (!(RESTORE_PLACEHOLDERS as readonly string[]).includes(p))
        return {
          ok: false,
          reason: `unknown placeholder ${p} in step ${step.id}`,
        };
  const program = basename(step.run[0] ?? "");
  if (SHELL_INTERPRETERS.has(program))
    return {
      ok: false,
      reason: `shell interpreter ${program} not permitted in step ${step.id}`,
    };
  if (LAUNCHERS.has(program))
    return {
      ok: false,
      reason: `launcher ${program} not permitted in step ${step.id}; name the program directly`,
    };
  if (step.cwd !== undefined) {
    const root = ["{{target}}", "{{package_root}}", "{{assets_root}}"].find(
      (r) => step.cwd === r || step.cwd?.startsWith(`${r}/`),
    );
    if (root === undefined)
      return {
        ok: false,
        reason: `cwd of step ${step.id} must start with {{target}}, {{package_root}} or {{assets_root}}`,
      };
    if (step.cwd.split("/").some((segment) => segment === ".."))
      return { ok: false, reason: `cwd of step ${step.id} contains ".."` };
  }
  return { ok: true };
};
