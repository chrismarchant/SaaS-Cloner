import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  uuidv7,
  type Job,
  type JobEventKind,
  type Redactor,
} from "@rea-web/contracts";
import type { ToolCallOutcome } from "@rea-web/rea-adapter";
import type { ControlPlaneClient } from "./controlPlane.js";
import { ControlPlaneError } from "./controlPlane.js";
import type { ActiveLease } from "./leases.js";
import type { UsageTracker } from "./budget.js";

export type Logger = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  fields?: Record<string, unknown>,
) => void;

export class ApprovalRejectedError extends Error {
  constructor(readonly approvalId: string) {
    super(`approval ${approvalId} was rejected`);
    this.name = "ApprovalRejectedError";
  }
}

/** Everything an executor needs for one leased job. */
export class JobContext {
  readonly workspace: string;

  constructor(
    readonly job: Job,
    readonly fencingToken: number,
    readonly client: ControlPlaneClient,
    readonly lease: ActiveLease,
    readonly usage: UsageTracker,
    workspaceRoot: string,
    readonly log: Logger,
    readonly redactor: Redactor,
  ) {
    this.workspace = join(
      workspaceRoot,
      "jobs",
      job.id,
      `attempt-${job.attempt}`,
    );
  }

  get signal(): AbortSignal {
    return this.lease.abort.signal;
  }

  async prepareWorkspace(): Promise<void> {
    await mkdir(this.workspace, { recursive: true, mode: 0o700 });
  }

  /** Append job events; payloads are redacted before they leave the runner. */
  async emit(
    kind: JobEventKind,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.client.postEvents(this.job.id, this.fencingToken, [
        {
          kind,
          payload: this.redactor.redactValue(payload) as Record<
            string,
            unknown
          >,
        },
      ]);
    } catch (error) {
      if (error instanceof ControlPlaneError && error.isStale) {
        this.lease.lost = true;
        this.lease.abort.abort({ kind: "lease_lost", reason: error.code });
      }
      this.log("warn", "event post failed", {
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async progress(
    message: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.emit("job.progress", { message, ...extra });
  }

  /**
   * Upload the complete raw upstream result (unmodified JSON) and record the
   * tool call with its derived summary. Returns the stored object key.
   */
  async recordOutcome(
    investigationId: string,
    outcome: ToolCallOutcome,
  ): Promise<string> {
    const raw = JSON.stringify(outcome.raw);
    const sha256 = createHash("sha256").update(raw).digest("hex");
    const uploaded = await this.client.uploadArtifact(
      this.job.id,
      this.fencingToken,
      {
        kind: "raw_result",
        name: `${outcome.seq}-${outcome.tool}.json`,
        toolCallSeq: outcome.seq,
        investigationId,
      },
      { body: raw },
    );
    this.usage.addArtifactBytes(uploaded.size);
    await this.client.recordToolCall(this.job.id, {
      fencing_token: this.fencingToken,
      investigation_id: investigationId,
      seq: outcome.seq,
      tool_name: outcome.tool,
      upstream_session_id: outcome.session_id,
      arguments_object_key: null,
      raw_result_object_key: uploaded.object_key,
      raw_result_sha256: sha256,
      raw_result_bytes: Buffer.byteLength(raw),
      derived: this.redactor.redactValue(outcome.derived) as Record<
        string,
        unknown
      >,
      evidence_id: outcome.derived.evidence_id,
      effects: [...outcome.effects],
      is_error: outcome.derived.is_error,
      duration_ms: outcome.duration_ms,
      started_at: outcome.started_at,
    });
    await this.emit("job.tool_call", {
      seq: outcome.seq,
      tool: outcome.tool,
      is_error: outcome.derived.is_error,
      evidence_id: outcome.derived.evidence_id,
      duration_ms: outcome.duration_ms,
    });
    return uploaded.object_key;
  }

  /**
   * Pause for an operator decision: transition to awaiting_approval, wait for
   * the decision delivered by heartbeat, then transition back to running.
   * Rejection throws; cancellation aborts through the lease signal.
   */
  async awaitApproval(request: {
    tool: string;
    arguments: Record<string, unknown>;
    effects: readonly string[];
    reason: string;
  }): Promise<void> {
    const approvalId = `ap_${uuidv7()}`;
    const decision = new Promise<"approved" | "rejected">((resolve, reject) => {
      this.lease.approvals.set(approvalId, resolve);
      this.signal.addEventListener("abort", () => reject(this.signal.reason), {
        once: true,
      });
    });
    await this.client.transition(
      this.job.id,
      this.fencingToken,
      "awaiting_approval",
      {
        approval_id: approvalId,
        tool: request.tool,
        arguments: this.redactor.redactValue(request.arguments) as Record<
          string,
          unknown
        >,
        effects: [...request.effects],
        reason: request.reason,
      },
    );
    const outcome = await decision;
    if (outcome === "rejected") throw new ApprovalRejectedError(approvalId);
    await this.client.transition(this.job.id, this.fencingToken, "running");
    await this.emit("job.approval_decided", {
      approval_id: approvalId,
      decision: outcome,
    });
  }
}
