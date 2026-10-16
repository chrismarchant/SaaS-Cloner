import {
  executionPolicySchema,
  type ExecutionPolicy,
} from "@rea-web/contracts";
import type { SessionManager } from "@rea-web/rea-adapter";
import type { JobContext } from "../jobContext.js";
import { AvailabilityView } from "./availability.js";
import {
  budgetFinding,
  findingFromOutcome,
  policyFinding,
  rejectedArgumentsFinding,
  type NewFinding,
} from "./findings.js";
import { guardedCall } from "./toolRunner.js";

export class SessionClosedError extends Error {
  constructor(readonly investigationId: string) {
    super(
      `investigation ${investigationId} has no live REA session on this runner; its exported evidence bundle remains available`,
    );
    this.name = "SessionClosedError";
  }
}

/**
 * Run one operator-requested tool call in the investigation's own session.
 * Retained evidence references are checked by the adapter against this
 * session's ledger; a reference owned by another session is refused.
 */
export const runFollowUp = async (
  ctx: JobContext,
  sessions: SessionManager,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const investigationId = String(input["investigation_id"] ?? "");
  const tool = String(input["tool"] ?? "");
  const args = (input["arguments"] ?? {}) as Record<string, unknown>;
  const policy: ExecutionPolicy = executionPolicySchema.parse(
    input["policy"] ?? {},
  );
  const session = sessions.forInvestigation(investigationId);
  if (!session) throw new SessionClosedError(investigationId);
  // Retained references must belong to this investigation's own session.
  const foreign = session
    .referencedEvidenceIds(args)
    .filter((id) => !session.ownsEvidence(id))
    .map((id) => {
      const owner = sessions.ownerOf(id);
      return owner
        ? `evidence ${id} belongs to session ${owner.id}, not this investigation's session ${session.id}`
        : `evidence ${id} is not retained by any live session; import an exported bundle first`;
    });
  if (foreign.length > 0) {
    await ctx.client.recordFindings(
      ctx.job.id,
      ctx.fencingToken,
      investigationId,
      [rejectedArgumentsFinding(tool, foreign.join("; "))],
    );
    return {
      investigation_id: investigationId,
      session_id: session.id,
      tool,
      outcome: "invalid_arguments",
      reasons: foreign,
    };
  }
  const availability = AvailabilityView.fromSession(session);
  const refreshed = await guardedCall({
    ctx,
    session,
    availability,
    policy,
    investigationId,
    tool: "binary_session",
    args: {},
    origin: "deterministic",
  });
  if (refreshed.kind === "ran") availability.refreshFrom(refreshed.outcome);
  const result = await guardedCall({
    ctx,
    session,
    availability,
    policy,
    investigationId,
    tool,
    args,
    origin: "operator",
  });
  const findings: NewFinding[] = [];
  if (result.kind === "ran")
    findings.push(findingFromOutcome(result, `operator follow-up ${tool}`));
  else if (result.kind === "unavailable")
    findings.push(
      policyFinding(
        tool,
        `unavailable: ${result.reason}. ${result.remediation}`,
      ),
    );
  else if (result.kind === "policy_rejected")
    findings.push(policyFinding(tool, result.reason));
  else if (result.kind === "invalid_arguments")
    findings.push(rejectedArgumentsFinding(tool, result.message));
  else if (result.kind === "budget_exhausted")
    findings.push(budgetFinding(tool));
  await ctx.client.recordFindings(
    ctx.job.id,
    ctx.fencingToken,
    investigationId,
    findings.map((f) => ctx.redactor.redactValue(f) as NewFinding),
  );
  // Re-export so evidence produced by follow-ups survives session teardown.
  const exported = await session.exportEvidence(
    `evidence/bundle-${ctx.job.id}.json`,
    { signal: ctx.signal },
  );
  let bundleKey: string | null = null;
  if (exported && !exported.outcome.derived.is_error) {
    await ctx.recordOutcome(investigationId, exported.outcome);
    const uploaded = await ctx.client.uploadArtifact(
      ctx.job.id,
      ctx.fencingToken,
      {
        kind: "bundle",
        name: `evidence-bundle-${ctx.job.id}.json`,
        investigationId,
      },
      { path: exported.path },
    );
    bundleKey = uploaded.object_key;
  }
  return {
    investigation_id: investigationId,
    session_id: session.id,
    tool,
    outcome: result.kind,
    ...(result.kind === "ran"
      ? {
          seq: result.seq,
          evidence_id: result.outcome.derived.evidence_id,
          is_error: result.outcome.derived.is_error,
        }
      : {}),
    evidence_bundle_object_key: bundleKey,
  };
};
