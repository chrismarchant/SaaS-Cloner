import { z } from "zod";
import {
  DEFAULT_APPROVAL_EFFECTS,
  jobBudgetSchema,
  jobKindSchema,
  jobStateSchema,
  toolEffectSchema,
} from "../jobs.js";

export const ROLES = ["viewer", "member", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);
export const ROLE_RANK: Readonly<Record<Role, number>> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};
export const roleSatisfies = (actual: Role, required: Role): boolean =>
  ROLE_RANK[actual] >= ROLE_RANK[required];

export const idSchema = z.string().uuid();
export const timestampSchema = z.string();
export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/u);

export const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), next_cursor: z.string().nullable() });

// --- Auth ----------------------------------------------------------------

export const registerRequestSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(1024),
  display_name: z.string().min(1).max(120).optional(),
});
export const loginRequestSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
});
export const userSchema = z.object({
  id: idSchema,
  email: z.string(),
  display_name: z.string().nullable(),
  created_at: timestampSchema,
});
export const membershipSchema = z.object({
  project_id: idSchema,
  project_slug: slugSchema,
  project_name: z.string(),
  role: roleSchema,
});
export const meResponseSchema = z.object({
  user: userSchema,
  memberships: z.array(membershipSchema),
  principal: z.enum(["session", "api_token"]),
});
export const createApiTokenRequestSchema = z.object({
  name: z.string().min(1).max(120),
  expires_in_days: z.number().int().min(1).max(365).optional(),
});
export const apiTokenCreatedSchema = z.object({
  id: idSchema,
  name: z.string(),
  token: z.string(),
  expires_at: timestampSchema.nullable(),
});
export const apiTokenSchema = apiTokenCreatedSchema
  .omit({ token: true })
  .extend({
    created_at: timestampSchema,
    last_used_at: timestampSchema.nullable(),
  });

// --- Projects, members, runners ------------------------------------------

export const createProjectRequestSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(120),
});
export const projectSchema = z.object({
  id: idSchema,
  slug: slugSchema,
  name: z.string(),
  created_by: idSchema,
  created_at: timestampSchema,
  role: roleSchema.optional(),
});
export const upsertMemberRequestSchema = z.object({
  email: z.string().email(),
  role: roleSchema,
});
export const createRunnerRequestSchema = z.object({
  name: z.string().min(1).max(120),
  labels: z.array(z.string().min(1).max(64)).max(32).default([]),
});
export const runnerCreatedSchema = z.object({
  id: idSchema,
  name: z.string(),
  token: z.string(),
});
export const runnerSummarySchema = z.object({
  id: idSchema,
  project_id: idSchema,
  name: z.string(),
  status: z.enum(["never_connected", "online", "stale", "offline", "revoked"]),
  labels: z.array(z.string()),
  last_seen_at: timestampSchema.nullable(),
  host: z.record(z.string(), z.unknown()).nullable(),
  rea: z.record(z.string(), z.unknown()).nullable(),
  tools_available_count: z.number().int().nonnegative(),
  tools_target_required_count: z.number().int().nonnegative(),
  tools_unavailable_count: z.number().int().nonnegative(),
  providers_available: z.array(z.string()),
  collectors: z.array(z.string()),
  active_leases: z.number().int().nonnegative(),
});

// --- Targets ---------------------------------------------------------------

export const TARGET_KINDS = [
  "upload",
  "url",
  "runtime_capture",
  "runner_local",
] as const;
export const targetKindSchema = z.enum(TARGET_KINDS);

/** Classification produced by sniffing; closed vocabulary used by routing. */
export const TARGET_CLASSES = [
  "asar",
  "javascript_directory",
  "zip_archive",
  "apk",
  "ipa",
  "dmg",
  "pkg",
  "msix",
  "pe",
  "pe_managed",
  "elf",
  "elf_core",
  "macho",
  "wasm",
  "evm_bytecode",
  "firmware_image",
  "har",
  "mitmproxy_flow",
  "process_capture",
  "website_url",
  "plist",
  "unknown",
] as const;
export const targetClassSchema = z.enum(TARGET_CLASSES);
export type TargetClass = (typeof TARGET_CLASSES)[number];

export const targetSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  kind: targetKindSchema,
  name: z.string(),
  class: targetClassSchema,
  sha256: z.string().length(64).nullable(),
  size: z.number().int().nonnegative().nullable(),
  url: z.string().nullable(),
  runner_id: idSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_by: idSchema.nullable(),
  created_at: timestampSchema,
});
export const createUrlTargetRequestSchema = z.object({
  url: z.string().url().max(2048),
  name: z.string().min(1).max(255).optional(),
});

export const routingSchema = z.object({
  target_id: idSchema,
  class: targetClassSchema,
  first_tool: z.string().nullable(),
  rationale: z.string(),
  requires_open_binary: z.boolean(),
  required_tools: z.array(z.string()),
  required_providers_any_of: z.array(z.string()),
  required_os: z.array(z.string()),
  candidate_runners: z.array(
    z.object({
      runner_id: idSchema,
      runner_name: z.string(),
      satisfied: z.boolean(),
      unmet: z.array(
        z.object({
          kind: z.string(),
          value: z.string(),
          reason: z.string(),
          remediation: z.string(),
        }),
      ),
    }),
  ),
});

// --- Investigations --------------------------------------------------------

export const executionPolicySchema = z.object({
  mode: z.enum(["static_only", "static_plus_runtime"]).default("static_only"),
  allowed_effects: z
    .array(toolEffectSchema)
    .default([
      "launchesProcess",
      "writesFilesystem",
      "mutatesSession",
      "idempotent",
    ]),
  approval_required_effects: z
    .array(toolEffectSchema)
    .default([...DEFAULT_APPROVAL_EFFECTS]),
  provider_id: z.string().default("auto"),
  model_follow_up: z.boolean().default(true),
  max_follow_up_rounds: z.number().int().min(0).max(50).default(12),
  budget: jobBudgetSchema.partial().default({}),
});
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;

export const createInvestigationRequestSchema = z.object({
  target_id: idSchema,
  question: z.string().min(1).max(4000),
  policy: executionPolicySchema.prefault({}),
  runner_id: idSchema.optional(),
});
export const investigationSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  target_id: idSchema,
  question: z.string(),
  policy: executionPolicySchema,
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  job_id: idSchema.nullable(),
  job_state: jobStateSchema.nullable(),
  routing: routingSchema.nullable(),
  tool_call_count: z.number().int().nonnegative(),
  finding_counts: z.record(z.string(), z.number().int().nonnegative()),
  upstream_identity: z.record(z.string(), z.unknown()).nullable(),
  created_by: idSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

export const FINDING_CLASSES = [
  "fact",
  "inference",
  "proposal",
  "unknown",
] as const;
export const findingSchema = z.object({
  id: idSchema,
  investigation_id: idSchema,
  class: z.enum(FINDING_CLASSES),
  title: z.string(),
  body: z.string(),
  evidence_ids: z.array(z.string()),
  tool_call_seqs: z.array(z.number().int().positive()),
  limitations: z.array(z.string()),
  source: z.enum(["upstream", "routing", "model", "policy"]),
  created_at: timestampSchema,
});
export type Finding = z.infer<typeof findingSchema>;

export const toolCallSummarySchema = z.object({
  id: idSchema,
  investigation_id: idSchema,
  seq: z.number().int().positive(),
  tool_name: z.string(),
  upstream_session_id: z.string(),
  evidence_id: z.string().nullable(),
  effects: z.array(z.string()),
  is_error: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
  derived: z.record(z.string(), z.unknown()),
  raw_result_bytes: z.number().int().nonnegative(),
  raw_result_sha256: z.string(),
  started_at: timestampSchema,
});

export const evidenceArtifactSchema = z.object({
  id: idSchema,
  investigation_id: idSchema,
  kind: z.enum(["bundle", "raw_result", "export", "ledger", "findings"]),
  name: z.string(),
  sha256: z.string().length(64),
  size: z.number().int().nonnegative(),
  created_at: timestampSchema,
});

export const followUpRequestSchema = z.object({
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});

export const evidenceRefSchema = z.union([
  z.object({
    kind: z.literal("retained-evidence"),
    evidence_id: z.string(),
    investigation_id: idSchema,
  }),
  z.object({ kind: z.literal("artifact"), artifact_id: idSchema }),
]);
export const comparisonRequestSchema = z.object({
  tool: z.enum([
    "compare_artifacts",
    "compare_functions",
    "compare_bundles",
    "compare_application_versions",
    "compare_web_captures",
    "compare_process_captures",
    "compare_managed_members",
    "compare_javascript_export_shapes",
  ]),
  left: evidenceRefSchema,
  right: evidenceRefSchema,
  runner_id: idSchema.optional(),
});

export const jobSummarySchema = z.object({
  id: idSchema,
  project_id: idSchema,
  kind: jobKindSchema,
  state: jobStateSchema,
  attempt: z.number().int().positive(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

export const approvalRequestViewSchema = z.object({
  approval_id: z.string(),
  job_id: idSchema,
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  effects: z.array(z.string()),
  reason: z.string(),
  requested_at: timestampSchema,
});

export const projectToolSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  annotations: z.record(z.string(), z.unknown()).nullable(),
  input_schema: z.record(z.string(), z.unknown()),
  input_schema_sha256: z.string(),
  per_runner: z.array(
    z.object({
      runner_id: idSchema,
      runner_name: z.string(),
      available: z.boolean(),
      target_required: z.boolean(),
      reason: z.string().nullable(),
      remediation: z.string().nullable(),
    }),
  ),
});

// --- Builds / preservation ------------------------------------------------

export const COMPONENT_KINDS = [
  "source",
  "dependencies",
  "data",
  "assets",
  "infrastructure",
  "integrations",
  "product",
  "artifacts",
] as const;
export const componentKindSchema = z.enum(COMPONENT_KINDS);
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export const buildSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("git"),
    url: z.string().min(1),
    ref: z.string().min(1).default("HEAD"),
    include_working_tree: z.boolean().default(false),
    include_lfs: z.boolean().default(true),
    include_submodules: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("runner_local"),
    runner_id: idSchema,
    path_hash: z.string().length(64),
    include_working_tree: z.boolean().default(true),
    include_lfs: z.boolean().default(true),
    include_submodules: z.boolean().default(true),
  }),
]);

export const componentDeclarationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), id: z.string().min(1) }),
  z.object({
    kind: z.literal("dependencies"),
    id: z.string().min(1),
    lockfiles: z.array(z.string()).default([]),
    container_images: z.array(z.string()).default([]),
  }),
  z.object({
    kind: z.literal("data"),
    id: z.string().min(1),
    engine: z.enum(["postgresql", "supabase"]),
    connection_env_name: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    invariants: z
      .array(
        z.object({
          id: z.string(),
          sql: z.string().max(4000),
          expect: z
            .union([z.string(), z.number(), z.boolean(), z.null()])
            .optional(),
        }),
      )
      .default([]),
  }),
  z.object({
    kind: z.literal("assets"),
    id: z.string().min(1),
    source: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("s3"),
        bucket: z.string(),
        prefix: z.string().default(""),
        endpoint_env_name: z.string().optional(),
        credentials_env_prefix: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
      }),
      z.object({
        kind: z.literal("runner_local"),
        runner_id: idSchema,
        path_hash: z.string().length(64),
      }),
      z.object({
        kind: z.literal("supabase_storage"),
        project_ref: z.string(),
        buckets: z.array(z.string()),
        credentials_env_prefix: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
      }),
    ]),
  }),
  z.object({
    kind: z.literal("infrastructure"),
    id: z.string().min(1),
    descriptor: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("integrations"),
    id: z.string().min(1),
    descriptor: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("product"),
    id: z.string().min(1),
    source_component_id: z.string().min(1),
    name: z.string().min(1).max(120),
    rea_target_ids: z.array(idSchema).default([]),
  }),
  z.object({
    kind: z.literal("artifacts"),
    id: z.string().min(1),
    investigation_ids: z.array(idSchema).default([]),
  }),
]);
export type ComponentDeclaration = z.infer<typeof componentDeclarationSchema>;

export const createBuildRequestSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(4000).default(""),
  source: buildSourceSchema,
  components: z.array(componentDeclarationSchema).min(1),
  runner_id: idSchema.optional(),
});
export const buildSchema = createBuildRequestSchema.extend({
  id: idSchema,
  project_id: idSchema,
  created_by: idSchema,
  created_at: timestampSchema,
});

export const COMPONENT_STATUSES = [
  "captured",
  "partial",
  "blocked",
  "manual",
  "pending",
] as const;
export const componentStatusSchema = z.enum(COMPONENT_STATUSES);

export const preservationPlanSchema = z.object({
  id: idSchema,
  build_id: idSchema,
  job_id: idSchema,
  runner_id: idSchema.nullable(),
  components: z.array(
    z.object({
      id: z.string(),
      kind: componentKindSchema,
      collector: z.string(),
      permissions: z.array(
        z.object({ check: z.string(), ok: z.boolean(), detail: z.string() }),
      ),
      estimated_bytes: z.number().int().nonnegative().nullable(),
      dependencies: z.array(z.string()),
      method: z.string(),
      omissions: z.array(
        z.object({
          what: z.string(),
          reason: z.string(),
          remediation: z.string(),
        }),
      ),
      feasible: z.boolean(),
    }),
  ),
  consistency_strategy: z.string(),
  known_omissions: z.array(
    z.object({ what: z.string(), reason: z.string(), remediation: z.string() }),
  ),
  created_at: timestampSchema,
});

export const captureSchema = z.object({
  id: idSchema,
  build_id: idSchema,
  plan_id: idSchema,
  job_id: idSchema,
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  manifest_object_key: z.string().nullable(),
  manifest_sha256: z.string().nullable(),
  consistency: z.enum(["single_point", "inconsistent", "unknown"]).nullable(),
  component_statuses: z.record(z.string(), componentStatusSchema),
  started_at: timestampSchema.nullable(),
  finished_at: timestampSchema.nullable(),
});

export const VERIFICATION_SCOPES = [
  "integrity",
  "clean_build",
  "data_restore",
  "behavior",
] as const;
export const verificationScopeSchema = z.enum(VERIFICATION_SCOPES);
export const VERIFICATION_STATUSES = [
  "captured",
  "integrity_verified",
  "clean_build_verified",
  "data_restore_verified",
  "behavior_verified",
  "partial",
  "blocked",
] as const;
export const verificationStatusSchema = z.enum(VERIFICATION_STATUSES);

export const createVerificationRequestSchema = z.object({
  scope: z.array(verificationScopeSchema).min(1),
  runner_id: idSchema.optional(),
});
export const verificationSchema = z.object({
  id: idSchema,
  capture_id: idSchema,
  job_id: idSchema,
  scope: z.array(verificationScopeSchema),
  results: z.array(
    z.object({
      scope: verificationScopeSchema,
      status: verificationStatusSchema,
      detail: z.string(),
      performed_at: timestampSchema,
      evidence_object_key: z.string().nullable(),
    }),
  ),
  network_required: z
    .object({
      verdict: z.enum(["yes", "no", "unknown"]),
      reasons: z.array(z.string()),
    })
    .nullable(),
  overall: verificationStatusSchema.nullable(),
  created_at: timestampSchema,
});

export const createExportRequestSchema = z.object({
  sign_with_key_id: z.string().optional(),
  encrypt_to_recipients: z.array(z.string()).optional(),
  include_secret_escrow: z.boolean().default(false),
});
export const exportSchema = z.object({
  id: idSchema,
  capture_id: idSchema,
  job_id: idSchema,
  status: z.enum(["pending", "running", "completed", "failed"]),
  sha256: z.string().nullable(),
  size: z.number().int().nonnegative().nullable(),
  signature: z.record(z.string(), z.unknown()).nullable(),
  encryption: z.record(z.string(), z.unknown()).nullable(),
  created_at: timestampSchema,
});
