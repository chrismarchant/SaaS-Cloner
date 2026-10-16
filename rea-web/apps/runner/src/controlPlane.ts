import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  claimResponseSchema,
  heartbeatResponseSchema,
  jobSchema,
  registerResponseSchema,
  type LocalTargetRegistration,
  type CapabilityReport,
  type ClaimResponse,
  type CleanupReport,
  type CompleteRequest,
  type Finding,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type Job,
  type JobEventKind,
  type RegisterResponse,
  type ToolCallRecord,
} from "@rea-web/contracts";

type RequestBody = NonNullable<RequestInit["body"]>;

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(`${status} ${code}: ${message}`);
    this.name = "ControlPlaneError";
  }
  get isStale(): boolean {
    return this.code === "stale_lease" || this.code === "lease_expired";
  }
}

/**
 * Outbound-only client for the runner protocol. Every job-scoped write
 * carries the lease's fencing token; the API rejects stale tokens.
 */
export class ControlPlaneClient {
  private runnerId: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get id(): string {
    if (!this.runnerId) throw new Error("runner not registered");
    return this.runnerId;
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/v1${path}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    parse: (value: unknown) => T,
    init: { signal?: AbortSignal; headers?: Record<string, string> } = {},
  ): Promise<T | null> {
    const response = await this.fetchImpl(this.url(path), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    if (response.status === 204) return null;
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const error = (
        json as {
          error?: { code?: string; message?: string; details?: unknown };
        }
      )?.error;
      throw new ControlPlaneError(
        response.status,
        error?.code ?? "http_error",
        error?.message ?? text.slice(0, 300),
        error?.details,
      );
    }
    return parse(json);
  }

  async register(report: CapabilityReport): Promise<RegisterResponse> {
    const result = await this.request(
      "POST",
      "/runners/register",
      report,
      (v) => registerResponseSchema.parse(v),
    );
    if (!result) throw new Error("register returned no body");
    this.runnerId = result.runner_id;
    return result;
  }

  /** Register this runner's allowlisted paths as runner-local targets. */
  async registerLocalTargets(body: LocalTargetRegistration): Promise<number> {
    if (!this.runnerId) throw new Error("register before registering targets");
    const result = await this.request(
      "POST",
      `/runners/${this.runnerId}/local-targets`,
      body,
      (v) => (v as { items?: unknown[] } | null)?.items?.length ?? 0,
    );
    return result ?? 0;
  }

  claim(waitMs: number, signal?: AbortSignal): Promise<ClaimResponse | null> {
    return this.request(
      "POST",
      `/runners/${this.id}/claim`,
      { wait_ms: waitMs },
      (v) => claimResponseSchema.parse(v),
      signal ? { signal } : {},
    );
  }

  async heartbeat(body: HeartbeatRequest): Promise<HeartbeatResponse> {
    const result = await this.request(
      "POST",
      `/runners/${this.id}/heartbeat`,
      body,
      (v) => heartbeatResponseSchema.parse(v),
    );
    return result ?? { leases: [] };
  }

  async postEvents(
    jobId: string,
    fencingToken: number,
    events: { kind: JobEventKind; payload: Record<string, unknown> }[],
  ): Promise<void> {
    await this.request(
      "POST",
      `/jobs/${jobId}/events`,
      { fencing_token: fencingToken, events },
      (v) => v,
    );
  }

  async transition(
    jobId: string,
    fencingToken: number,
    to: "running" | "awaiting_approval",
    approval?: {
      approval_id: string;
      tool: string;
      arguments: Record<string, unknown>;
      effects: string[];
      reason: string;
    },
  ): Promise<Job> {
    const result = await this.request(
      "POST",
      `/jobs/${jobId}/transition`,
      { fencing_token: fencingToken, to, ...(approval ? { approval } : {}) },
      (v) => jobSchema.parse(v),
    );
    if (!result) throw new Error("transition returned no body");
    return result;
  }

  async complete(
    jobId: string,
    body: Omit<CompleteRequest, "cleanup"> & { cleanup: CleanupReport },
  ): Promise<Job> {
    const result = await this.request(
      "POST",
      `/jobs/${jobId}/complete`,
      body,
      (v) => jobSchema.parse(v),
    );
    if (!result) throw new Error("complete returned no body");
    return result;
  }

  /** Returns the investigation timeline seq the control plane allocated. */
  async recordToolCall(
    jobId: string,
    record: ToolCallRecord,
  ): Promise<{ seq: number }> {
    const seq = await this.request(
      "POST",
      `/jobs/${jobId}/tool-calls`,
      record,
      (v) => (v as { seq?: unknown } | null)?.seq,
    );
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1)
      throw new ControlPlaneError(
        502,
        "invalid_response",
        "tool-call record response carries no allocated seq",
      );
    return { seq };
  }

  async recordFindings(
    jobId: string,
    fencingToken: number,
    investigationId: string,
    findings: Omit<Finding, "id" | "investigation_id" | "created_at">[],
  ): Promise<void> {
    if (findings.length === 0) return;
    await this.request(
      "POST",
      `/jobs/${jobId}/findings`,
      {
        fencing_token: fencingToken,
        investigation_id: investigationId,
        findings,
      },
      (v) => v,
    );
  }

  /** Stream a local file (or buffer) to the job's artifact store. */
  async uploadArtifact(
    jobId: string,
    fencingToken: number,
    meta: {
      kind: string;
      name: string;
      investigationId?: string;
    },
    source: { path: string } | { body: Uint8Array | string },
  ): Promise<{
    object_key: string;
    sha256: string;
    size: number;
    artifact_id: string | null;
  }> {
    let body: RequestBody;
    let length: number;
    if ("path" in source) {
      length = (await stat(source.path)).size;
      body = Readable.toWeb(
        createReadStream(source.path),
      ) as unknown as RequestBody;
    } else {
      const bytes =
        typeof source.body === "string"
          ? Buffer.from(source.body, "utf8")
          : source.body;
      length = bytes.byteLength;
      body = bytes as unknown as RequestBody;
    }
    const response = await this.fetchImpl(
      this.url(`/jobs/${jobId}/artifacts/upload`),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/octet-stream",
          "content-length": String(length),
          "x-fencing-token": String(fencingToken),
          "x-artifact-kind": meta.kind,
          "x-artifact-name": meta.name,
          ...(meta.investigationId
            ? { "x-investigation-id": meta.investigationId }
            : {}),
        },
        body,
        duplex: "half",
      } as RequestInit,
    );
    const text = await response.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const error = json["error"] as
        | { code?: string; message?: string }
        | undefined;
      throw new ControlPlaneError(
        response.status,
        error?.code ?? "http_error",
        error?.message ?? text.slice(0, 300),
      );
    }
    return json as {
      object_key: string;
      sha256: string;
      size: number;
      artifact_id: string | null;
    };
  }

  /** Download a job input (e.g. the target payload) to a local path. */
  async downloadInput(
    jobId: string,
    fencingToken: number,
    name: string,
    destination: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const response = await this.fetchImpl(
      this.url(`/jobs/${jobId}/inputs/${encodeURIComponent(name)}`),
      {
        headers: {
          authorization: `Bearer ${this.token}`,
          "x-fencing-token": String(fencingToken),
        },
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new ControlPlaneError(
        response.status,
        "input_unavailable",
        text.slice(0, 300),
      );
    }
    await pipeline(
      Readable.fromWeb(
        response.body as unknown as WebReadableStream<Uint8Array>,
      ),
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
    return (await stat(destination)).size;
  }

  /** Fetch a JSON job input (fenced), refusing bodies above maxBytes. */
  async fetchInputJson(
    jobId: string,
    fencingToken: number,
    name: string,
    options: { signal?: AbortSignal; maxBytes?: number } = {},
  ): Promise<unknown> {
    const response = await this.fetchImpl(
      this.url(`/jobs/${jobId}/inputs/${encodeURIComponent(name)}`),
      {
        headers: {
          authorization: `Bearer ${this.token}`,
          "x-fencing-token": String(fencingToken),
          accept: "application/json",
        },
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    const text = await response.text();
    if (!response.ok)
      throw new ControlPlaneError(
        response.status,
        "input_unavailable",
        text.slice(0, 300),
      );
    const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    if (Buffer.byteLength(text) > maxBytes)
      throw new ControlPlaneError(
        413,
        "input_too_large",
        `job input ${name} exceeds ${maxBytes} bytes`,
      );
    return JSON.parse(text) as unknown;
  }
}
