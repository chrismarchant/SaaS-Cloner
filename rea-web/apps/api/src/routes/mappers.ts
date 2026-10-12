import type { z } from "zod";
import {
  type CapabilityDigest,
  type CapabilityReport,
  type JobState,
  capabilityReportSchema,
  digestCapabilities,
  executionPolicySchema,
  jobSchema,
  routingSchema,
  targetClassSchema,
  type apiTokenSchema,
  type approvalRequestViewSchema,
  type buildSchema,
  type captureSchema,
  type evidenceArtifactSchema,
  type exportSchema,
  type findingSchema,
  type investigationSchema,
  type jobSummarySchema,
  type membershipSchema,
  type preservationPlanSchema,
  type projectSchema,
  type runnerSummarySchema,
  type targetSchema,
  type toolCallSummarySchema,
  type userSchema,
  type verificationSchema,
} from "@rea-web/contracts";
import type {
  ApiTokenRecord,
  ApprovalRecord,
  BuildRecord,
  CaptureRecord,
  EvidenceArtifactRecord,
  ExportRecord,
  FindingRecord,
  InvestigationRecord,
  JobRecord,
  PlanRecord,
  ProjectRecord,
  ProjectWithRole,
  RunnerRecord,
  TargetRecord,
  ToolCallRecord,
  UserRecord,
  VerificationRecord,
} from "@rea-web/db";

type Out<S extends z.ZodType> = z.input<S>;

export const userView = (u: UserRecord): Out<typeof userSchema> => ({
  id: u.id,
  email: u.email,
  display_name: u.display_name,
  created_at: u.created_at,
});

export const projectView = (
  p: ProjectRecord | ProjectWithRole,
): Out<typeof projectSchema> => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  created_by: p.created_by,
  created_at: p.created_at,
  ...("role" in p ? { role: p.role } : {}),
});

export const membershipView = (
  p: ProjectWithRole,
): Out<typeof membershipSchema> => ({
  project_id: p.id,
  project_slug: p.slug,
  project_name: p.name,
  role: p.role,
});

export const apiTokenView = (
  t: ApiTokenRecord,
): Out<typeof apiTokenSchema> => ({
  id: t.id,
  name: t.name,
  expires_at: t.expires_at,
  created_at: t.created_at,
  last_used_at: t.last_used_at,
});

export const targetView = (t: TargetRecord): Out<typeof targetSchema> => ({
  id: t.id,
  project_id: t.project_id,
  kind: t.kind,
  name: t.name,
  class: targetClassSchema.catch("unknown").parse(t.class),
  sha256: t.sha256,
  size: t.size,
  url: t.url,
  runner_id: t.runner_id,
  metadata: t.metadata,
  created_by: t.created_by,
  created_at: t.created_at,
});

/** Strips persistence-only columns by parsing through the wire contract. */
export const jobView = (job: JobRecord): z.input<typeof jobSchema> =>
  jobSchema.parse(job);

export const jobSummaryView = (
  job: JobRecord,
): Out<typeof jobSummarySchema> => ({
  id: job.id,
  project_id: job.project_id,
  kind: job.kind,
  state: job.state,
  attempt: job.attempt,
  created_at: job.created_at,
  updated_at: job.updated_at,
});

export type InvestigationStatus = z.output<
  typeof investigationSchema
>["status"];

/** Investigation status is derived from its run job, never stored. */
export const statusFromJobState = (
  state: JobState | null,
): InvestigationStatus => {
  switch (state) {
    case null:
    case "queued":
      return "pending";
    case "preparing":
    case "running":
    case "awaiting_approval":
    case "interrupted":
      return "running";
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
};

export const investigationView = (
  record: InvestigationRecord,
  job: JobRecord | null,
  counts: { toolCalls: number; findings: Record<string, number> },
): Out<typeof investigationSchema> => {
  const routing = routingSchema.safeParse(record.routing);
  return {
    id: record.id,
    project_id: record.project_id,
    target_id: record.target_id,
    question: record.question,
    policy: executionPolicySchema.parse(record.policy),
    status: statusFromJobState(job?.state ?? null),
    job_id: record.job_id,
    job_state: job?.state ?? null,
    routing: routing.success ? routing.data : null,
    tool_call_count: counts.toolCalls,
    finding_counts: counts.findings,
    upstream_identity: record.upstream_identity,
    created_by: record.created_by,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
};

export const toolCallView = (
  t: ToolCallRecord,
): Out<typeof toolCallSummarySchema> => ({
  id: t.id,
  investigation_id: t.investigation_id,
  seq: t.seq,
  upstream_seq: t.upstream_seq,
  tool_name: t.tool_name,
  upstream_session_id: t.upstream_session_id,
  evidence_id: t.evidence_id,
  effects: t.effects,
  is_error: t.is_error,
  duration_ms: t.duration_ms,
  derived: t.derived,
  raw_result_bytes: t.raw_result_bytes,
  raw_result_sha256: t.raw_result_sha256,
  started_at: t.started_at,
});

export const evidenceView = (
  a: EvidenceArtifactRecord,
): Out<typeof evidenceArtifactSchema> => ({
  id: a.id,
  investigation_id: a.investigation_id,
  kind: a.kind,
  name: a.name,
  sha256: a.sha256,
  size: a.size,
  created_at: a.created_at,
});

export const findingView = (f: FindingRecord): Out<typeof findingSchema> => ({
  id: f.id,
  investigation_id: f.investigation_id,
  class: f.class,
  title: f.title,
  body: f.body,
  evidence_ids: f.evidence_ids,
  tool_call_seqs: f.tool_call_seqs,
  limitations: f.limitations,
  source: f.source,
  created_at: f.created_at,
});

export const approvalView = (
  a: ApprovalRecord,
): Out<typeof approvalRequestViewSchema> => ({
  approval_id: a.approval_id,
  job_id: a.job_id,
  tool: a.tool,
  arguments: a.arguments,
  effects: a.effects,
  reason: a.reason,
  requested_at: a.requested_at,
});

// --- Runners -----------------------------------------------------------------

export interface RunnerFacts {
  readonly report: CapabilityReport | null;
  readonly digest: CapabilityDigest | null;
}

/** Re-parses the stored report; a record that no longer parses has no facts. */
export const runnerFacts = (runner: RunnerRecord): RunnerFacts => {
  if (runner.capability_report === null) return { report: null, digest: null };
  const parsed = capabilityReportSchema.safeParse(runner.capability_report);
  return parsed.success
    ? { report: parsed.data, digest: digestCapabilities(parsed.data) }
    : { report: null, digest: null };
};

export const digestSummary = (
  digest: CapabilityDigest,
): Record<string, unknown> => ({
  tools_available: [...digest.tools_available],
  tools_target_required: [...digest.tools_target_required],
  providers_available: [...digest.providers_available],
  os: digest.os,
  labels: [...digest.labels],
  collectors: [...digest.collectors],
});

export const runnerSummaryView = (
  runner: RunnerRecord,
  activeLeases: number,
): Out<typeof runnerSummarySchema> => {
  const { report, digest } = runnerFacts(runner);
  return {
    id: runner.id,
    project_id: runner.project_id,
    name: runner.name,
    status: runner.status,
    labels: runner.labels,
    last_seen_at: runner.last_seen_at,
    host: report === null ? null : { ...report.host },
    rea: report?.rea == null ? null : { ...report.rea },
    tools_available_count: digest?.tools_available.length ?? 0,
    tools_target_required_count: digest?.tools_target_required.length ?? 0,
    tools_unavailable_count: digest?.tools_unavailable.size ?? 0,
    providers_available: digest === null ? [] : [...digest.providers_available],
    collectors: digest === null ? [] : [...digest.collectors],
    active_leases: activeLeases,
  };
};

// --- Builds / preservation -----------------------------------------------------

export const buildView = (b: BuildRecord): Out<typeof buildSchema> =>
  ({
    id: b.id,
    project_id: b.project_id,
    name: b.name,
    description: b.description,
    source: b.source,
    components: b.components,
    ...(b.preferred_runner_id === null
      ? {}
      : { runner_id: b.preferred_runner_id }),
    created_by: b.created_by,
    created_at: b.created_at,
  }) as Out<typeof buildSchema>;

export const planView = (p: PlanRecord): Out<typeof preservationPlanSchema> => {
  const doc = p.plan ?? {};
  return {
    components: [],
    consistency_strategy: "",
    known_omissions: [],
    ...doc,
    id: p.id,
    build_id: p.build_id,
    job_id: p.job_id,
    runner_id: p.runner_id,
    created_at: p.created_at,
  } as Out<typeof preservationPlanSchema>;
};

type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export const runStatusFromJob = (job: JobRecord | null): RunStatus => {
  const status = statusFromJobState(job?.state ?? null);
  return status;
};

export const captureView = (
  c: CaptureRecord,
  job: JobRecord | null,
): Out<typeof captureSchema> => ({
  id: c.id,
  build_id: c.build_id,
  plan_id: c.plan_id,
  job_id: c.job_id,
  status: runStatusFromJob(job),
  manifest_object_key: c.manifest_object_key,
  manifest_sha256: c.manifest_sha256,
  consistency: c.consistency,
  component_statuses: c.component_statuses as Out<
    typeof captureSchema
  >["component_statuses"],
  started_at: c.started_at,
  finished_at: c.finished_at,
});

export const verificationScopes = (v: VerificationRecord): string[] => {
  const scope = v.scope as unknown;
  if (Array.isArray(scope)) return scope.map(String);
  const nested = (scope as { scopes?: unknown } | null)?.scopes;
  return Array.isArray(nested) ? nested.map(String) : [];
};

export const verificationView = (
  v: VerificationRecord,
): Out<typeof verificationSchema> =>
  ({
    id: v.id,
    capture_id: v.capture_id,
    job_id: v.job_id,
    scope: verificationScopes(v),
    results: v.results,
    network_required: v.network_required,
    overall: v.overall,
    created_at: v.created_at,
  }) as Out<typeof verificationSchema>;

export const exportView = (
  e: ExportRecord,
  job: JobRecord | null,
): Out<typeof exportSchema> => {
  const status = runStatusFromJob(job);
  return {
    id: e.id,
    capture_id: e.capture_id,
    job_id: e.job_id,
    status: status === "cancelled" ? "failed" : status,
    sha256: e.sha256,
    size: e.size,
    signature: e.signature,
    encryption: e.encryption,
    created_at: e.created_at,
  };
};
