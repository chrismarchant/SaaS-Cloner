import { createHash } from "node:crypto";
import { ZERO_USAGE } from "@rea-web/contracts";
import {
  type Account,
  type ApiResponse,
  type Harness,
  type RunnerHandle,
  uploadBytes,
} from "./harness.js";

export const sha256 = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");

export interface Claimed {
  jobId: string;
  token: number;
  response: ApiResponse;
}

export const claim = (h: Harness, runner: RunnerHandle, waitMs = 0) =>
  h.api("POST", `/api/v1/runners/${runner.id}/claim`, {
    auth: runner.auth,
    body: { wait_ms: waitMs },
  });

export async function claimOne(
  h: Harness,
  runner: RunnerHandle,
  waitMs = 0,
): Promise<Claimed> {
  const response = await claim(h, runner, waitMs);
  if (response.status !== 200)
    throw new Error(`claim failed: ${response.status} ${response.raw}`);
  return {
    jobId: response.json.job.id,
    token: response.json.fencing_token,
    response,
  };
}

export const heartbeat = (
  h: Harness,
  runner: RunnerHandle,
  leases: Array<{ job_id: string; fencing_token: number }>,
) =>
  h.api("POST", `/api/v1/runners/${runner.id}/heartbeat`, {
    auth: runner.auth,
    body: { leases: leases.map((l) => ({ ...l, usage: ZERO_USAGE })) },
  });

export const postEvents = (
  h: Harness,
  runner: RunnerHandle,
  jobId: string,
  token: number,
  events: Array<{ kind: string; payload?: Record<string, unknown> }>,
) =>
  h.api("POST", `/api/v1/jobs/${jobId}/events`, {
    auth: runner.auth,
    body: {
      fencing_token: token,
      events: events.map((e) => ({ kind: e.kind, payload: e.payload ?? {} })),
    },
  });

export const transition = (
  h: Harness,
  runner: RunnerHandle,
  jobId: string,
  token: number,
  to: "running" | "awaiting_approval",
  approval?: {
    approval_id: string;
    tool: string;
    arguments: Record<string, unknown>;
    effects: string[];
    reason: string;
  },
) =>
  h.api("POST", `/api/v1/jobs/${jobId}/transition`, {
    auth: runner.auth,
    body: { fencing_token: token, to, ...(approval ? { approval } : {}) },
  });

export const complete = (
  h: Harness,
  runner: RunnerHandle,
  jobId: string,
  token: number,
  outcome: "succeeded" | "failed" | "cancelled",
  result: Record<string, unknown> | null = {},
  failure: Record<string, unknown> | null = null,
) =>
  h.api("POST", `/api/v1/jobs/${jobId}/complete`, {
    auth: runner.auth,
    body: {
      fencing_token: token,
      outcome,
      result,
      failure,
      usage: ZERO_USAGE,
      cleanup: { status: "cleanup_complete", remaining_resource_kinds: [] },
    },
  });

export const uploadArtifact = (
  h: Harness,
  runner: RunnerHandle,
  jobId: string,
  token: number,
  kind: string,
  name: string,
  payload: Buffer,
  extra: Record<string, string> = {},
) =>
  h.api("POST", `/api/v1/jobs/${jobId}/artifacts/upload`, {
    auth: runner.auth,
    payload,
    headers: {
      "content-type": "application/octet-stream",
      "x-fencing-token": String(token),
      "x-artifact-kind": kind,
      "x-artifact-name": name,
      ...extra,
    },
  });

export const toolCallBody = (
  token: number,
  investigationId: string,
  upstreamSeq: number,
  raw: { object_key: string; sha256: string; size: number },
  overrides: Record<string, unknown> = {},
) => ({
  fencing_token: token,
  investigation_id: investigationId,
  upstream_seq: upstreamSeq,
  tool_name: "analyze_javascript_application",
  upstream_session_id: `session-${investigationId}`,
  arguments_object_key: null,
  raw_result_object_key: raw.object_key,
  raw_result_sha256: raw.sha256,
  raw_result_bytes: raw.size,
  derived: { normalized_result_keys: ["files"] },
  evidence_id: "ev-1",
  effects: ["idempotent"],
  is_error: false,
  duration_ms: 12,
  started_at: new Date().toISOString(),
  ...overrides,
});

export interface InvestigationSetup {
  targetId: string;
  investigationId: string;
  jobId: string;
  response: ApiResponse;
}

/** Uploads an `.asar` (route needs only tools the fixture runner has) and starts an investigation. */
export async function startInvestigation(
  h: Harness,
  account: Account,
  projectId: string,
  options: {
    name?: string;
    runnerId?: string;
    policy?: Record<string, unknown>;
  } = {},
): Promise<InvestigationSetup> {
  const upload = await uploadBytes(
    h,
    account,
    projectId,
    options.name ?? "app.asar",
    Buffer.from("asar-bytes-for-test"),
  );
  if (upload.status !== 201) throw new Error(`upload failed ${upload.raw}`);
  const response = await h.api(
    "POST",
    `/api/v1/projects/${projectId}/investigations`,
    {
      auth: account.auth,
      body: {
        target_id: upload.json.id,
        question: "what does it do?",
        ...(options.runnerId ? { runner_id: options.runnerId } : {}),
        ...(options.policy ? { policy: options.policy } : {}),
      },
    },
  );
  if (response.status !== 201)
    throw new Error(
      `createInvestigation failed ${response.status} ${response.raw}`,
    );
  return {
    targetId: upload.json.id,
    investigationId: response.json.id,
    jobId: response.json.job_id,
    response,
  };
}

/**
 * Cancels every queued job of the project. Tests share one database per file,
 * and claims are FIFO, so a job left queued by an earlier test would otherwise
 * be handed to the next claim (or fill the runner's concurrency).
 */
export async function cancelQueuedJobs(
  h: Harness,
  account: Account,
  projectId: string,
): Promise<void> {
  const queued = await h.api("GET", `/api/v1/projects/${projectId}/jobs`, {
    auth: account.auth,
    query: { state: "queued", limit: "100" },
  });
  if (queued.status !== 200) throw new Error(`list jobs failed: ${queued.raw}`);
  for (const job of queued.json.items as Array<{ id: string }>) {
    await h.api("POST", `/api/v1/projects/${projectId}/jobs/${job.id}/cancel`, {
      auth: account.auth,
    });
  }
}
