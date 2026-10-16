import type { FastifyRequest } from "fastify";
import {
  ApiError,
  uuidv7,
  validateRelativePath,
  type JobKind,
} from "@rea-web/contracts";
import type { EvidenceArtifactKind, JobRecord } from "@rea-web/db";
import type { AppContext } from "../context.js";
import { evidenceBytes } from "../db/extra.js";
import type { PresentedLease } from "../orchestrator/fencing.js";
import { streamIntoStore, type UploadSource } from "./uploads.js";

export const EVIDENCE_KINDS: readonly EvidenceArtifactKind[] = [
  "bundle",
  "raw_result",
  "export",
  "ledger",
  "findings",
];

export const BUILD_ARTIFACT_KINDS = [
  "capture_manifest",
  "capture_file",
  "export_archive",
  "export_signature",
  "verification_evidence",
] as const;
type BuildArtifactKind = (typeof BUILD_ARTIFACT_KINDS)[number];

type ArtifactKind = EvidenceArtifactKind | BuildArtifactKind;

export interface ArtifactHeaders {
  readonly kind: ArtifactKind;
  readonly name: string;
}

const headerString = (
  value: string | string[] | undefined,
): string | undefined => (Array.isArray(value) ? value[0] : value);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;

export const parseArtifactHeaders = (req: FastifyRequest): ArtifactHeaders => {
  const kind = headerString(req.headers["x-artifact-kind"]);
  const allowed: readonly string[] = [
    ...EVIDENCE_KINDS,
    ...BUILD_ARTIFACT_KINDS,
  ];
  if (kind === undefined || !allowed.includes(kind))
    throw new ApiError(
      "validation_failed",
      "X-Artifact-Kind is missing or unknown",
      {
        allowed,
      },
    );
  const name = headerString(req.headers["x-artifact-name"]) ?? "";
  if (name.length === 0 || name.length > 255 || CONTROL.test(name))
    throw new ApiError(
      "validation_failed",
      "X-Artifact-Name must be 1-255 characters without control characters",
    );
  return { kind: kind as ArtifactKind, name };
};

export const parseFencingHeader = (req: FastifyRequest): number => {
  const raw = headerString(req.headers["x-fencing-token"]);
  if (raw === undefined || !/^[1-9]\d{0,15}$/u.test(raw))
    throw new ApiError(
      "validation_failed",
      "X-Fencing-Token header is required",
    );
  return Number(raw);
};

const stringInput = (job: JobRecord, field: string): string | null => {
  const value = job.input[field];
  return typeof value === "string" ? value : null;
};

export const requireInput = (job: JobRecord, field: string): string => {
  const value = stringInput(job, field);
  if (value === null)
    throw new ApiError("validation_failed", `Job input has no ${field}`, {
      job_kind: job.kind,
    });
  return value;
};

/** What to record once the object is stored (runs under the lease lock). */
export interface ArtifactPlan {
  readonly key: string;
  readonly kind: ArtifactKind;
  readonly artifactId: string | null;
  readonly remainingBytes: Promise<number>;
  record(result: { sha256: string; size: number }): Promise<void>;
}

const sanitizeRelative = (name: string): string => {
  const checked = validateRelativePath(name, { maxLength: 400 });
  if (!checked.ok)
    throw new ApiError(
      "unsafe_path",
      "X-Artifact-Name is not a safe relative path",
      {
        rejection: checked.rejection,
      },
    );
  return checked.path;
};

const INVESTIGATION_JOBS: ReadonlySet<JobKind> = new Set<JobKind>([
  "investigation.run",
  "investigation.follow_up",
  "investigation.compare",
  "investigation.export",
]);

const wrongKind = (job: JobRecord, kind: string): ApiError =>
  new ApiError(
    "validation_failed",
    `Artifact kind ${kind} is not accepted for ${job.kind} jobs`,
  );

/** Storage prefix of one capture's package files; `manifest.json` sits at its root. */
export const capturePrefix = (
  projectId: string,
  buildId: string,
  captureId: string,
): string => `projects/${projectId}/builds/${buildId}/captures/${captureId}`;

/** Storage prefix of one verification's evidence; the restore report sits at its root. */
export const verificationPrefix = (
  projectId: string,
  buildId: string,
  captureId: string,
  verificationId: string,
): string =>
  `${capturePrefix(projectId, buildId, captureId)}/verification/${verificationId}`;

/** Storage key of one export's archive; its detached signature is `<key>.sig`. */
export const exportArchiveKey = (
  projectId: string,
  buildId: string,
  exportId: string,
): string => `projects/${projectId}/builds/${buildId}/exports/${exportId}.tar`;

/** Derives the storage key and bookkeeping for one artifact; clients never supply keys. */
export const planArtifact = (
  ctx: AppContext,
  job: JobRecord,
  headers: ArtifactHeaders,
): ArtifactPlan => {
  const p = job.project_id;
  const budgetLeft = (extra: number): number =>
    Math.max(
      0,
      job.budget.artifact_bytes - Math.max(job.usage.artifact_bytes, extra),
    );
  const { kind } = headers;

  if (INVESTIGATION_JOBS.has(job.kind)) {
    if (!(EVIDENCE_KINDS as readonly string[]).includes(kind))
      throw wrongKind(job, kind);
    const investigationId = requireInput(job, "investigation_id");
    const base = `projects/${p}/investigations/${investigationId}`;
    const remaining = evidenceBytes(ctx.db, investigationId).then(budgetLeft);
    if (kind === "raw_result") {
      // Unique per upload: the tool-call record, not the key, carries the
      // server-allocated seq, so sessions never overwrite each other's results.
      return {
        key: `${base}/raw/${uuidv7()}.json`,
        kind,
        artifactId: null,
        remainingBytes: remaining,
        record: async () => undefined,
      };
    }
    const id = uuidv7();
    const key =
      kind === "export"
        ? `${base}/export/${id}.zip`
        : `${base}/evidence/${id}.json`;
    return {
      key,
      kind,
      artifactId: id,
      remainingBytes: remaining,
      record: async (result) => {
        await ctx.repos.evidenceArtifacts.create({
          id,
          investigation_id: investigationId,
          kind: kind as EvidenceArtifactKind,
          name: headers.name,
          object_key: key,
          sha256: result.sha256,
          size: result.size,
        });
      },
    };
  }

  const remaining = Promise.resolve(budgetLeft(0));
  const buildId = stringInput(job, "build_id");
  if (buildId === null) throw wrongKind(job, kind);
  const buildBase = `projects/${p}/builds/${buildId}`;

  if (job.kind === "preservation.capture") {
    const captureId = requireInput(job, "capture_id");
    const base = capturePrefix(p, buildId, captureId);
    if (kind === "capture_manifest") {
      const key = `${base}/manifest.json`;
      return {
        key,
        kind,
        artifactId: null,
        remainingBytes: remaining,
        record: async (result) => {
          await ctx.repos.captures.update(captureId, {
            manifest_object_key: key,
            manifest_sha256: result.sha256,
          });
        },
      };
    }
    if (kind === "capture_file") {
      const relative = sanitizeRelative(headers.name);
      if (relative === "manifest.json")
        throw new ApiError("unsafe_path", "manifest.json is reserved");
      return {
        key: `${base}/${relative}`,
        kind,
        artifactId: null,
        remainingBytes: remaining,
        record: async () => undefined,
      };
    }
  }

  if (job.kind === "recovery.export") {
    const exportId = requireInput(job, "export_id");
    const archive = exportArchiveKey(p, buildId, exportId);
    if (kind === "export_archive")
      return {
        key: archive,
        kind,
        artifactId: null,
        remainingBytes: remaining,
        record: async (result) => {
          await ctx.repos.exports.update(exportId, {
            object_key: archive,
            sha256: result.sha256,
            size: result.size,
          });
        },
      };
    if (kind === "export_signature") {
      const key = `${archive}.sig`;
      return {
        key,
        kind,
        artifactId: null,
        remainingBytes: remaining,
        record: async (result) => {
          await ctx.repos.exports.update(exportId, {
            signature: {
              object_key: key,
              sha256: result.sha256,
              size: result.size,
            },
          });
        },
      };
    }
  }

  if (job.kind === "recovery.verify" && kind === "verification_evidence") {
    const captureId = requireInput(job, "capture_id");
    const verificationId = requireInput(job, "verification_id");
    return {
      key: `${verificationPrefix(p, buildId, captureId, verificationId)}/${sanitizeRelative(headers.name)}`,
      kind,
      artifactId: null,
      remainingBytes: remaining,
      record: async () => undefined,
    };
  }
  throw wrongKind(job, kind);
};

/** Streams, then records under the lease; removes the object if either step fails. */
export const storeArtifact = async (
  ctx: AppContext,
  presented: PresentedLease,
  plan: ArtifactPlan,
  source: UploadSource,
): Promise<{
  object_key: string;
  sha256: string;
  size: number;
  artifact_id: string | null;
}> => {
  const remaining = await plan.remainingBytes;
  const limit = Math.min(ctx.config.maxUploadBytes, remaining);
  const stored = await streamIntoStore(ctx.store, plan.key, source, {
    maxBytes: limit,
    onTooLarge: () =>
      remaining < ctx.config.maxUploadBytes
        ? new ApiError("budget_exceeded", "artifact_bytes budget exhausted", {
            dimension: "artifact_bytes",
          })
        : new ApiError(
            "payload_too_large",
            "Artifact exceeds the upload limit",
            {
              max_bytes: ctx.config.maxUploadBytes,
            },
          ),
  });
  try {
    await ctx.fencing.withLease(presented, "artifact_upload", () =>
      plan.record({ sha256: stored.sha256, size: stored.size }),
    );
  } catch (error) {
    // The lease moved on while the bytes were in flight, or bookkeeping failed.
    await ctx.store.delete(plan.key).catch(() => undefined);
    throw error;
  }
  return {
    object_key: plan.key,
    sha256: stored.sha256,
    size: stored.size,
    artifact_id: plan.artifactId,
  };
};
