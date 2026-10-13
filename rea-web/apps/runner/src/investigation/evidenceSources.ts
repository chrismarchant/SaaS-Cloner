import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  investigationIndexSchema,
  type InvestigationIndex,
} from "@rea-web/contracts";
import type { JobContext } from "../jobContext.js";

/**
 * Stored investigation evidence, read through the runner protocol. Compare
 * and export jobs use what the control plane stored (digest-checked), never
 * another investigation's live session: that keeps sessions isolated and
 * makes the job reproducible on any runner of the project.
 */

/** Bundles above this size are refused instead of parsed in memory. */
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

export class EvidenceSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceSourceError";
  }
}

export interface EvidenceRecord {
  readonly evidence_id: string;
  readonly [key: string]: unknown;
}

export interface StoredBundle {
  readonly artifactId: string;
  readonly path: string;
  readonly sha256: string;
  readonly records: readonly EvidenceRecord[];
}

export const loadInvestigationIndex = async (
  ctx: JobContext,
  investigationId: string,
): Promise<InvestigationIndex> =>
  investigationIndexSchema.parse(
    await ctx.client.fetchInputJson(
      ctx.job.id,
      ctx.fencingToken,
      `investigation-${investigationId}`,
      { signal: ctx.signal },
    ),
  );

const sha256File = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/**
 * Download a stored input to the job workspace and check it against the
 * digest the control plane recorded. A mismatch is an integrity failure.
 */
export const downloadVerified = async (
  ctx: JobContext,
  input: string,
  fileName: string,
  expected: { sha256: string; size: number },
): Promise<string> => {
  if (expected.size > MAX_BUNDLE_BYTES)
    throw new EvidenceSourceError(
      `${input} is ${expected.size} bytes, above the ${MAX_BUNDLE_BYTES}-byte limit for in-memory evidence`,
    );
  const directory = join(ctx.workspace, "inputs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, fileName);
  await rm(path, { force: true });
  await ctx.client.downloadInput(
    ctx.job.id,
    ctx.fencingToken,
    input,
    path,
    ctx.signal,
  );
  const actual = await sha256File(path);
  if (actual !== expected.sha256)
    throw new EvidenceSourceError(
      `${input} digest mismatch: stored ${expected.sha256}, received ${actual}`,
    );
  return path;
};

/** Parse an upstream evidence bundle file: an object with a `records` array. */
export const parseBundle = (text: string, label: string): EvidenceRecord[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EvidenceSourceError(`${label} is not JSON`);
  }
  const records = (parsed as { records?: unknown } | null)?.records;
  if (!Array.isArray(records))
    throw new EvidenceSourceError(`${label} has no records array`);
  return records.filter(
    (r): r is EvidenceRecord =>
      typeof r === "object" &&
      r !== null &&
      typeof (r as { evidence_id?: unknown }).evidence_id === "string",
  );
};

export const loadBundle = async (
  ctx: JobContext,
  artifact: { id: string; sha256: string; size: number },
): Promise<StoredBundle> => {
  const path = await downloadVerified(
    ctx,
    `artifact-${artifact.id}`,
    `artifact-${artifact.id}.json`,
    artifact,
  );
  return {
    artifactId: artifact.id,
    path,
    sha256: artifact.sha256,
    records: parseBundle(
      await readFile(path, "utf8"),
      `artifact ${artifact.id}`,
    ),
  };
};

/**
 * Find a retained evidence record in the investigation's stored bundles,
 * newest first. Every run and follow-up exports the whole session ledger, so
 * the newest bundle holding the id carries its final form.
 */
export const findStoredEvidence = async (
  ctx: JobContext,
  index: InvestigationIndex,
  evidenceId: string,
): Promise<{ bundle: StoredBundle; record: EvidenceRecord }> => {
  const bundles = index.artifacts
    .filter((a) => a.kind === "bundle")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const artifact of bundles) {
    const bundle = await loadBundle(ctx, artifact);
    const record = bundle.records.find((r) => r.evidence_id === evidenceId);
    if (record) return { bundle, record };
  }
  throw new EvidenceSourceError(
    `evidence ${evidenceId} is not in any stored evidence bundle of investigation ${index.investigation.id}` +
      (bundles.length === 0 ? " (it has no exported bundle)" : ""),
  );
};
