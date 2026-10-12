import type { Job, JobEventKind, Role } from "@rea-web/contracts";

/** Row shapes mirror migrations/0001_initial.sql: snake_case, ISO timestamps, parsed JSONB. */

export type JsonObject = Record<string, unknown>;

export interface UserRecord {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string;
  created_at: string;
}

export interface SessionRecord {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

export interface ApiTokenRecord {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ProjectRecord {
  id: string;
  slug: string;
  name: string;
  created_by: string;
  created_at: string;
}

export interface ProjectWithRole extends ProjectRecord {
  role: Role;
}

export interface MembershipRecord {
  project_id: string;
  user_id: string;
  role: Role;
  created_at: string;
}

export interface MemberListing extends MembershipRecord {
  email: string;
  display_name: string | null;
}

export type RunnerStatus =
  | "never_connected"
  | "online"
  | "stale"
  | "offline"
  | "revoked";

export interface RunnerRecord {
  id: string;
  project_id: string;
  name: string;
  token_hash: string;
  labels: string[];
  status: RunnerStatus;
  capability_report: JsonObject | null;
  capability_digest: JsonObject | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
}

export type TargetKind = "upload" | "url" | "runtime_capture" | "runner_local";

export interface TargetRecord {
  id: string;
  project_id: string;
  kind: TargetKind;
  name: string;
  class: string;
  sha256: string | null;
  size: number | null;
  url: string | null;
  object_key: string | null;
  runner_id: string | null;
  runner_path_hash: string | null;
  metadata: JsonObject;
  created_by: string | null;
  created_at: string;
}

/** The contract `Job` plus the persistence-only columns callers need. */
export interface JobRecord extends Job {
  max_attempts: number;
  preferred_runner_id: string | null;
  idempotency_key: string | null;
  created_by: string | null;
}

export interface JobEventRecord {
  job_id: string;
  seq: number;
  kind: JobEventKind;
  payload: JsonObject;
  created_at: string;
}

export type EffectStatus = "started" | "completed" | "failed";

export interface EffectLedgerEntry {
  job_id: string;
  step_key: string;
  status: EffectStatus;
  detail: JsonObject;
  attempt: number;
  created_at: string;
  updated_at: string;
}

export type ApprovalDecision = "approved" | "rejected";

export interface ApprovalRecord {
  approval_id: string;
  job_id: string;
  tool: string;
  arguments: JsonObject;
  effects: string[];
  reason: string;
  requested_at: string;
  decision: ApprovalDecision | null;
  decided_by: string | null;
  decided_at: string | null;
  delivered_at: string | null;
}

export interface IdempotencyRecord {
  principal_id: string;
  project_id: string | null;
  idempotency_key: string;
  request_hash: string;
  status_code: number;
  response: unknown;
  created_at: string;
}

export type InvestigationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface InvestigationRecord {
  id: string;
  project_id: string;
  target_id: string;
  question: string;
  policy: JsonObject;
  status: InvestigationStatus;
  job_id: string | null;
  routing: JsonObject | null;
  upstream_identity: JsonObject | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ToolCallRecord {
  id: string;
  investigation_id: string;
  job_id: string;
  seq: number;
  tool_name: string;
  upstream_session_id: string;
  arguments_object_key: string | null;
  raw_result_object_key: string;
  raw_result_sha256: string;
  raw_result_bytes: number;
  derived: JsonObject;
  evidence_id: string | null;
  effects: string[];
  is_error: boolean;
  duration_ms: number;
  started_at: string;
}

export type EvidenceArtifactKind =
  | "bundle"
  | "raw_result"
  | "export"
  | "ledger"
  | "findings";

export interface EvidenceArtifactRecord {
  id: string;
  investigation_id: string;
  kind: EvidenceArtifactKind;
  name: string;
  object_key: string;
  sha256: string;
  size: number;
  created_at: string;
}

export type FindingClass = "fact" | "inference" | "proposal" | "unknown";
export type FindingSource = "upstream" | "routing" | "model" | "policy";

export interface FindingRecord {
  id: string;
  investigation_id: string;
  class: FindingClass;
  title: string;
  body: string;
  evidence_ids: string[];
  tool_call_seqs: number[];
  limitations: string[];
  source: FindingSource;
  created_at: string;
}

export interface BuildRecord {
  id: string;
  project_id: string;
  name: string;
  description: string;
  source: JsonObject;
  components: unknown;
  preferred_runner_id: string | null;
  created_by: string;
  created_at: string;
}

export interface PlanRecord {
  id: string;
  build_id: string;
  job_id: string;
  runner_id: string | null;
  plan: JsonObject | null;
  created_at: string;
}

export type CaptureStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface CaptureRecord {
  id: string;
  build_id: string;
  plan_id: string;
  job_id: string;
  status: CaptureStatus;
  manifest_object_key: string | null;
  manifest_sha256: string | null;
  consistency: "single_point" | "inconsistent" | "unknown" | null;
  component_statuses: JsonObject;
  started_at: string | null;
  finished_at: string | null;
}

export interface VerificationRecord {
  id: string;
  capture_id: string;
  job_id: string;
  scope: JsonObject;
  results: unknown[];
  network_required: JsonObject | null;
  overall: string | null;
  created_at: string;
}

export type ExportStatus = "pending" | "running" | "completed" | "failed";

export interface ExportRecord {
  id: string;
  capture_id: string;
  job_id: string;
  status: ExportStatus;
  object_key: string | null;
  sha256: string | null;
  size: number | null;
  signature: JsonObject | null;
  encryption: JsonObject | null;
  created_at: string;
}
