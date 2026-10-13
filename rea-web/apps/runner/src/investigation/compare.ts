import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  compareJobInputSchema,
  type CompareJobInput,
} from "@rea-web/contracts";
import type {
  LiveTool,
  ReaSession,
  SessionManager,
} from "@rea-web/rea-adapter";
import type { JobContext } from "../jobContext.js";
import { AvailabilityView } from "./availability.js";
import {
  EvidenceSourceError,
  findStoredEvidence,
  loadBundle,
  loadInvestigationIndex,
  type EvidenceRecord,
  type StoredBundle,
} from "./evidenceSources.js";
import {
  budgetFinding,
  findingFromOutcome,
  policyFinding,
  rejectedArgumentsFinding,
  type NewFinding,
} from "./findings.js";
import { guardedCall } from "./toolRunner.js";

/**
 * investigation.compare: run one upstream `compare_*` tool over two stored
 * evidence references in a fresh REA session owned by this job. Evidence is
 * read from digest-checked stored bundles, so any runner of the project can
 * compare evidence produced by any investigation without touching another
 * investigation's live session. Findings and the comparison's own evidence
 * land on the anchor investigation (the left side's), as the API recorded.
 */
export interface CompareDeps {
  readonly sessions: SessionManager;
  readonly sessionOptions: (
    workspace: string,
  ) => Parameters<SessionManager["open"]>[1];
}

interface ResolvedSide {
  readonly label: "left" | "right";
  readonly investigationId: string;
  readonly bundle: StoredBundle;
  readonly record: EvidenceRecord | null;
}

const describeSide = (side: ResolvedSide) => ({
  investigation_id: side.investigationId,
  artifact_id: side.bundle.artifactId,
  bundle_sha256: side.bundle.sha256,
  evidence_id: side.record?.evidence_id ?? null,
});

const resolveSide = async (
  ctx: JobContext,
  label: "left" | "right",
  ref: CompareJobInput["left"],
  investigationId: string,
): Promise<ResolvedSide> => {
  const index = await loadInvestigationIndex(ctx, investigationId);
  if (ref.kind === "retained-evidence") {
    const found = await findStoredEvidence(ctx, index, ref.evidence_id);
    return { label, investigationId, ...found };
  }
  const artifact = index.artifacts.find((a) => a.id === ref.artifact_id);
  if (!artifact || artifact.kind !== "bundle")
    throw new EvidenceSourceError(
      `artifact ${ref.artifact_id} is not an evidence bundle of investigation ${investigationId}`,
    );
  const bundle = await loadBundle(ctx, artifact);
  // A single-record bundle identifies its record; otherwise only bundle-level
  // comparison (compare_bundles) is defined for it.
  return {
    label,
    investigationId,
    bundle,
    record: bundle.records.length === 1 ? (bundle.records[0] ?? null) : null,
  };
};

type JsonSchema = {
  type?: unknown;
  $ref?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  $defs?: Record<string, JsonSchema>;
};

/**
 * Input properties that take one complete Evidence record, in declared order,
 * read from the tool's live input schema rather than a hard-coded list.
 */
export const evidenceParameters = (tool: LiveTool): string[] => {
  const schema = tool.inputSchema as JsonSchema;
  const defs = schema.$defs ?? {};
  const resolve = (s: JsonSchema | undefined): JsonSchema | undefined =>
    s?.$ref?.startsWith("#/$defs/") ? defs[s.$ref.slice(8)] : s;
  return Object.entries(schema.properties ?? {})
    .filter(([, prop]) => {
      const target = resolve(prop);
      const required = target?.required ?? [];
      return (
        target?.type === "object" &&
        required.includes("evidence_id") &&
        required.includes("normalized_result")
      );
    })
    .map(([name]) => name);
};

type Plan =
  | { kind: "call"; args: Record<string, unknown> }
  | { kind: "rejected"; reason: string };

const planArguments = (
  tool: LiveTool,
  left: ResolvedSide,
  right: ResolvedSide,
): Plan => {
  if (tool.name === "compare_bundles") {
    const pairs =
      left.record && right.record
        ? [
            {
              left_evidence_id: left.record.evidence_id,
              right_evidence_id: right.record.evidence_id,
            },
          ]
        : [];
    return {
      kind: "call",
      args: {
        left_bundle_path: left.bundle.path,
        right_bundle_path: right.bundle.path,
        record_pairs: pairs,
      },
    };
  }
  const params = evidenceParameters(tool);
  const [leftParam, rightParam] = params;
  if (leftParam === undefined || rightParam === undefined)
    return {
      kind: "rejected",
      reason: `${tool.name} does not take two Evidence records in its live input schema; run it as an investigation follow-up with explicit arguments`,
    };
  for (const side of [left, right])
    if (!side.record)
      return {
        kind: "rejected",
        reason: `the ${side.label} reference is a bundle with ${side.bundle.records.length} records; ${tool.name} needs one Evidence record (reference it as retained evidence, or use compare_bundles)`,
      };
  const args: Record<string, unknown> = {
    [leftParam]: left.record,
    [rightParam]: right.record,
  };
  const missing = ((tool.inputSchema as JsonSchema).required ?? []).filter(
    (name) => !(name in args),
  );
  if (missing.length > 0)
    return {
      kind: "rejected",
      reason: `${tool.name} also requires ${missing.join(", ")}, which stored evidence references cannot supply; run it as an investigation follow-up with explicit arguments`,
    };
  return { kind: "call", args };
};

const digestOf = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const runComparison = async (
  ctx: JobContext,
  deps: CompareDeps,
  rawInput: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const input = compareJobInputSchema.parse(rawInput);
  const anchor = input.investigation_id;
  const { policy } = input;
  const record = async (findings: NewFinding[]) =>
    ctx.client.recordFindings(
      ctx.job.id,
      ctx.fencingToken,
      anchor,
      findings.map((f) => ctx.redactor.redactValue(f) as NewFinding),
    );

  let left: ResolvedSide;
  let right: ResolvedSide;
  try {
    left = await resolveSide(
      ctx,
      "left",
      input.left,
      input.left_investigation_id,
    );
    right = await resolveSide(
      ctx,
      "right",
      input.right,
      input.right_investigation_id,
    );
  } catch (error) {
    if (!(error instanceof EvidenceSourceError)) throw error;
    await record([rejectedArgumentsFinding(input.tool, error.message)]);
    return {
      tool: input.tool,
      anchor_investigation_id: anchor,
      outcome: "invalid_arguments",
      reasons: [error.message],
    };
  }
  await ctx.progress("comparison inputs verified", {
    left: describeSide(left),
    right: describeSide(right),
  });

  const session: ReaSession = await deps.sessions.open(
    `compare:${ctx.job.id}`,
    deps.sessionOptions(join(ctx.workspace, "rea")),
  );
  try {
    const tool = session.tool(input.tool);
    const plan: Plan = tool
      ? planArguments(tool, left, right)
      : {
          kind: "rejected",
          reason: `${input.tool} is not advertised by this runner's REA server`,
        };
    const base = {
      tool: input.tool,
      anchor_investigation_id: anchor,
      session_id: session.id,
      left: describeSide(left),
      right: describeSide(right),
    };
    if (plan.kind === "rejected") {
      await record([rejectedArgumentsFinding(input.tool, plan.reason)]);
      return { ...base, outcome: "invalid_arguments", reasons: [plan.reason] };
    }
    const availability = AvailabilityView.fromSession(session);
    const result = await guardedCall({
      ctx,
      session,
      availability,
      policy,
      investigationId: anchor,
      tool: input.tool,
      args: plan.args,
      origin: "operator",
    });
    const purpose = `comparison of ${left.record?.evidence_id ?? `bundle ${left.bundle.artifactId}`} (investigation ${left.investigationId}) with ${right.record?.evidence_id ?? `bundle ${right.bundle.artifactId}`} (investigation ${right.investigationId})`;
    if (result.kind === "ran")
      await record([findingFromOutcome(result, purpose)]);
    else if (result.kind === "unavailable")
      await record([
        policyFinding(
          input.tool,
          `unavailable: ${result.reason}. ${result.remediation}`,
        ),
      ]);
    else if (result.kind === "policy_rejected")
      await record([policyFinding(input.tool, result.reason)]);
    else if (result.kind === "invalid_arguments")
      await record([rejectedArgumentsFinding(input.tool, result.message)]);
    else if (result.kind === "budget_exhausted")
      await record([budgetFinding(input.tool)]);

    // Keep the comparison's own evidence: export this session's ledger.
    let bundleKey: string | null = null;
    if (result.kind === "ran") {
      const exported = await session.exportEvidence(
        `evidence/comparison-${ctx.job.id}.json`,
        { signal: ctx.signal },
      );
      if (exported) {
        await ctx.recordOutcome(anchor, exported.outcome);
        if (!exported.outcome.derived.is_error)
          bundleKey = (
            await ctx.client.uploadArtifact(
              ctx.job.id,
              ctx.fencingToken,
              {
                kind: "bundle",
                name: `comparison-bundle-${ctx.job.id}.json`,
                investigationId: anchor,
              },
              { path: exported.path },
            )
          ).object_key;
      }
    }
    return {
      ...base,
      outcome: result.kind,
      arguments_sha256: digestOf(plan.args),
      ...(result.kind === "ran"
        ? {
            seq: result.seq,
            evidence_id: result.outcome.derived.evidence_id,
            is_error: result.outcome.derived.is_error,
          }
        : {}),
      evidence_bundle_object_key: bundleKey,
    };
  } finally {
    await deps.sessions.close(session.id);
  }
};
