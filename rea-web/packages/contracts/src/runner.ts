import { z } from "zod";
import {
  cleanupReportSchema,
  jobBudgetUsageSchema,
  jobFailureSchema,
  jobSchema,
  JOB_EVENT_KINDS,
} from "./jobs.js";

export const RUNNER_PROTOCOL_VERSION = 1 as const;

/** Verbatim upstream shapes are carried as opaque JSON; only the fields the
 * orchestrator needs for matching are typed. */
export const advertisedToolSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  input_schema: z.record(z.string(), z.unknown()),
  input_schema_sha256: z.string().length(64),
  has_output_schema: z.boolean(),
});
export type AdvertisedTool = z.infer<typeof advertisedToolSchema>;

export const toolAvailabilityGroupSchema = z.object({
  names: z.array(z.string()),
  surface: z.string().optional(),
  effects: z.array(z.string()).optional(),
  annotations: z.array(z.string()).optional(),
  available: z.boolean(),
  // Upstream emits `reason`/`remediation: null` on available groups.
  reason: z.string().nullable().optional(),
  remediation: z.string().nullable().optional(),
  client_requirements: z.unknown().optional(),
  modes: z.unknown().optional(),
});
export type ToolAvailabilityGroup = z.infer<typeof toolAvailabilityGroupSchema>;

export const hostFactsSchema = z.object({
  os: z.enum(["linux", "darwin", "win32"]),
  arch: z.string(),
  release: z.string(),
  hostname_hash: z.string().length(64),
  node_version: z.string(),
  docker_available: z.boolean(),
  gui: z.boolean(),
  adb_devices: z.number().int().nonnegative(),
  cpus: z.number().int().positive(),
  memory_bytes: z.number().int().positive(),
});
export type HostFacts = z.infer<typeof hostFactsSchema>;

export const reaIdentitySchema = z.object({
  package_version: z.string(),
  root_path_hash: z.string().length(64),
  build_commit: z.string().nullable(),
  source_sha: z.string().nullable(),
  sdk: z.record(z.string(), z.unknown()),
  negotiated_protocol_version: z.string().nullable(),
  catalog: z.object({
    counts: z.record(z.string(), z.number()),
    digests: z.record(z.string(), z.string()),
  }),
  skill: z.record(z.string(), z.unknown()).nullable(),
  protocol_features: z.record(z.string(), z.unknown()).nullable(),
});
export type ReaIdentity = z.infer<typeof reaIdentitySchema>;

export const capabilityReportSchema = z.object({
  protocol_version: z.literal(RUNNER_PROTOCOL_VERSION),
  runner_name: z.string().min(1).max(120),
  host: hostFactsSchema,
  rea: reaIdentitySchema.nullable(),
  rea_unavailable_reason: z.string().nullable(),
  tools_list: z.array(advertisedToolSchema),
  prompts_list: z.array(z.string()),
  tool_availability: z.object({
    groups: z.array(toolAvailabilityGroupSchema),
    client_requirements: z.unknown().optional(),
  }),
  analysis_provider_candidates: z.array(z.record(z.string(), z.unknown())),
  provider_capabilities: z.array(z.record(z.string(), z.unknown())),
  env_capability_names: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/u)),
  labels: z.array(z.string().min(1).max(64)).max(32),
  max_concurrent_jobs: z.number().int().min(1).max(64),
  workspace_root_free_bytes: z.number().int().nonnegative(),
  collectors: z.array(z.string()).default([]),
  reported_at: z.string(),
});
export type CapabilityReport = z.infer<typeof capabilityReportSchema>;

/** Derived summary used for matching; computed server-side from the report. */
export interface CapabilityDigest {
  readonly tools_available: readonly string[];
  readonly tools_target_required: readonly string[];
  readonly tools_unavailable: ReadonlyMap<
    string,
    { reason: string; remediation: string }
  >;
  readonly providers_available: readonly string[];
  readonly os: HostFacts["os"];
  readonly labels: readonly string[];
  readonly collectors: readonly string[];
}

export const digestCapabilities = (
  report: CapabilityReport,
): CapabilityDigest => {
  const available: string[] = [];
  const targetRequired: string[] = [];
  const unavailable = new Map<
    string,
    { reason: string; remediation: string }
  >();
  for (const group of report.tool_availability.groups) {
    for (const name of group.names) {
      if (group.available) available.push(name);
      else if (group.reason === "target_required") targetRequired.push(name);
      else
        unavailable.set(name, {
          reason: group.reason ?? "unavailable",
          remediation: group.remediation ?? "",
        });
    }
  }
  const providers: string[] = [];
  for (const candidate of report.analysis_provider_candidates) {
    const id = candidate["provider_id"] ?? candidate["id"];
    const availability = candidate["availability"];
    const status =
      typeof availability === "object" && availability !== null
        ? (availability as { status?: unknown }).status
        : undefined;
    if (typeof id === "string" && status === "available") providers.push(id);
  }
  for (const capability of report.provider_capabilities) {
    const provider = capability["provider"] as { id?: unknown } | undefined;
    const groups = capability["groups"];
    if (
      typeof provider?.id === "string" &&
      Array.isArray(groups) &&
      groups.some((g) => (g as { available?: unknown }).available === true) &&
      !providers.includes(provider.id)
    )
      providers.push(provider.id);
  }
  return {
    tools_available: available,
    tools_target_required: targetRequired,
    tools_unavailable: unavailable,
    providers_available: providers,
    os: report.host.os,
    labels: report.labels,
    collectors: report.collectors,
  };
};

export interface UnmetRequirement {
  readonly kind: "tool" | "provider" | "os" | "label" | "collector";
  readonly value: string;
  readonly reason: string;
  readonly remediation: string;
}

export const unmetRequirements = (
  digest: CapabilityDigest,
  requirements: {
    tools: readonly string[];
    providers: readonly string[];
    os: readonly string[];
    labels: readonly string[];
    collectors?: readonly string[];
  },
): UnmetRequirement[] => {
  const unmet: UnmetRequirement[] = [];
  for (const tool of requirements.tools) {
    if (
      digest.tools_available.includes(tool) ||
      digest.tools_target_required.includes(tool)
    )
      continue;
    const detail = digest.tools_unavailable.get(tool);
    unmet.push({
      kind: "tool",
      value: tool,
      reason: detail?.reason ?? "not_advertised",
      remediation:
        detail?.remediation ??
        "The runner's REA catalog does not advertise this tool.",
    });
  }
  for (const provider of requirements.providers) {
    if (!digest.providers_available.includes(provider))
      unmet.push({
        kind: "provider",
        value: provider,
        reason: "provider_unavailable",
        remediation:
          "Configure this provider on a runner; see its candidate diagnostics.",
      });
  }
  if (requirements.os.length > 0 && !requirements.os.includes(digest.os))
    unmet.push({
      kind: "os",
      value: requirements.os.join("|"),
      reason: "unsupported_host",
      remediation: `Requires one of ${requirements.os.join(", ")}; runner is ${digest.os}.`,
    });
  for (const label of requirements.labels) {
    if (!digest.labels.includes(label))
      unmet.push({
        kind: "label",
        value: label,
        reason: "label_missing",
        remediation: "Attach a runner carrying this label.",
      });
  }
  for (const collector of requirements.collectors ?? []) {
    if (!digest.collectors.includes(collector))
      unmet.push({
        kind: "collector",
        value: collector,
        reason: "collector_missing",
        remediation: "Attach a runner with this collector enabled.",
      });
  }
  return unmet;
};

// --- Protocol messages -----------------------------------------------------

export const registerResponseSchema = z.object({
  runner_id: z.string(),
  server_time: z.string(),
  protocol_version: z.literal(RUNNER_PROTOCOL_VERSION),
  lease_ttl_ms: z.number().int().positive(),
  heartbeat_interval_ms: z.number().int().positive(),
});
export type RegisterResponse = z.infer<typeof registerResponseSchema>;

export const claimRequestSchema = z.object({
  wait_ms: z.number().int().min(0).max(25_000).default(20_000),
});

export const claimResponseSchema = z.object({
  job: jobSchema,
  fencing_token: z.number().int().positive(),
  lease_expires_at: z.string(),
});
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

export const heartbeatRequestSchema = z.object({
  leases: z.array(
    z.object({
      job_id: z.string(),
      fencing_token: z.number().int().positive(),
      usage: jobBudgetUsageSchema,
    }),
  ),
  capability_report: capabilityReportSchema.optional(),
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

export const approvalDecisionSchema = z.object({
  approval_id: z.string(),
  decision: z.enum(["approved", "rejected"]),
  decided_by: z.string(),
  decided_at: z.string(),
});

export const heartbeatResponseSchema = z.object({
  leases: z.array(
    z.object({
      job_id: z.string(),
      fencing_token: z.number().int().positive(),
      accepted: z.boolean(),
      reason: z.string().optional(),
      lease_expires_at: z.string().optional(),
      cancel_requested: z.boolean(),
      approvals: z.array(approvalDecisionSchema),
    }),
  ),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

export const runnerEventSchema = z.object({
  kind: z.enum(JOB_EVENT_KINDS),
  payload: z.record(z.string(), z.unknown()),
});

export const postEventsRequestSchema = z.object({
  fencing_token: z.number().int().positive(),
  events: z.array(runnerEventSchema).min(1).max(500),
});

export const transitionRequestSchema = z.object({
  fencing_token: z.number().int().positive(),
  to: z.enum(["running", "awaiting_approval"]),
  approval: z
    .object({
      approval_id: z.string(),
      tool: z.string(),
      arguments: z.record(z.string(), z.unknown()),
      effects: z.array(z.string()),
      reason: z.string(),
    })
    .optional(),
});

export const completeRequestSchema = z.object({
  fencing_token: z.number().int().positive(),
  outcome: z.enum(["succeeded", "failed", "cancelled"]),
  result: z.record(z.string(), z.unknown()).nullable(),
  failure: jobFailureSchema.nullable(),
  usage: jobBudgetUsageSchema,
  cleanup: cleanupReportSchema,
});
export type CompleteRequest = z.infer<typeof completeRequestSchema>;

export const toolCallRecordSchema = z.object({
  fencing_token: z.number().int().positive(),
  investigation_id: z.string(),
  /**
   * Call index inside `upstream_session_id`. The investigation timeline `seq`
   * is allocated by the control plane, which owns the investigation; a second
   * session (requeued run, comparison) restarts this counter.
   */
  upstream_seq: z.number().int().positive(),
  tool_name: z.string(),
  upstream_session_id: z.string(),
  arguments_object_key: z.string().nullable(),
  raw_result_object_key: z.string(),
  raw_result_sha256: z.string().length(64),
  raw_result_bytes: z.number().int().nonnegative(),
  derived: z.record(z.string(), z.unknown()),
  evidence_id: z.string().nullable(),
  effects: z.array(z.string()),
  is_error: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
  started_at: z.string(),
});
export type ToolCallRecord = z.infer<typeof toolCallRecordSchema>;

export const localTargetRegistrationSchema = z.object({
  targets: z.array(
    z.object({
      name: z.string().min(1).max(255),
      path_hash: z.string().length(64),
      kind: z.string(),
      sha256: z.string().length(64).nullable(),
      size: z.number().int().nonnegative().nullable(),
      project_id: z.string(),
    }),
  ),
});
