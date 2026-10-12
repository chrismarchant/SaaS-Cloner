import type { Finding } from "@rea-web/contracts";
import type { ToolCallOutcome } from "@rea-web/rea-adapter";

export type NewFinding = Omit<
  Finding,
  "id" | "investigation_id" | "created_at"
>;

const describeValue = (value: unknown): string => {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (typeof value === "object")
    return `{${Object.keys(value as object)
      .slice(0, 8)
      .join(", ")}${Object.keys(value as object).length > 8 ? ", …" : ""}}`;
  if (typeof value === "string")
    return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  return String(value);
};

/**
 * Summarise the top level of an upstream normalized_result without
 * reinterpreting it: scalar values verbatim, arrays as counts, objects as key
 * lists. The complete record stays in the raw result and evidence bundle.
 */
export const summariseNormalized = (
  normalized: unknown,
  maxFields = 24,
): string => {
  if (!normalized || typeof normalized !== "object")
    return describeValue(normalized);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(
    normalized as Record<string, unknown>,
  ).slice(0, maxFields))
    lines.push(`- ${key}: ${describeValue(value)}`);
  return lines.join("\n");
};

const normalizedOf = (outcome: ToolCallOutcome): unknown => {
  const sc = outcome.raw["structuredContent"] as
    | Record<string, unknown>
    | undefined;
  return sc?.["normalized_result"] ?? sc?.["result"] ?? null;
};

/**
 * Upstream Evidence confidence maps to the finding class: observed and
 * derived Evidence are facts (derived facts note their derivation), inferred
 * Evidence is an inference. Errors become unknowns with the upstream code.
 */
export const findingFromOutcome = (
  outcome: ToolCallOutcome,
  purpose: string,
): NewFinding => {
  const d = outcome.derived;
  if (d.is_error)
    return {
      class: "unknown",
      title: `${outcome.tool} did not complete (${d.error?.code ?? "error"})`,
      body: `${purpose}.\n\nUpstream error: ${d.error?.message ?? "no message"}${d.error?.details_keys.length ? `\nDetails fields: ${d.error.details_keys.join(", ")}` : ""}`,
      evidence_ids: [],
      tool_call_seqs: [outcome.seq],
      limitations: [...d.limitations],
      source: "upstream",
    };
  const cls = d.confidence === "inferred" ? "inference" : "fact";
  const qualifiers = [
    d.confidence ? `confidence: ${d.confidence}` : null,
    d.authority ? `authority: ${d.authority}` : null,
    d.predicate_type ? `predicate: ${d.predicate_type}` : null,
    d.residual_unknowns_count !== null
      ? `residual unknowns: ${d.residual_unknowns_count}`
      : null,
  ].filter(Boolean);
  return {
    class: cls,
    title: `${outcome.tool}: ${purpose}`,
    body: `${qualifiers.join(" · ")}\n\n${summariseNormalized(normalizedOf(outcome))}`,
    evidence_ids: d.evidence_id ? [d.evidence_id] : [],
    tool_call_seqs: [outcome.seq],
    limitations: [...d.limitations],
    source: "upstream",
  };
};

export const unavailableFinding = (
  tool: string,
  purpose: string,
  reason: string,
  remediation: string,
): NewFinding => ({
  class: "unknown",
  title: `${tool} unavailable on this runner (${reason})`,
  body: `${purpose} was not attempted.\n\nRemediation (upstream): ${remediation || "none given"}`,
  evidence_ids: [],
  tool_call_seqs: [],
  limitations: [`capability unavailable: ${reason}`],
  source: "routing",
});

export const policyFinding = (tool: string, reason: string): NewFinding => ({
  class: "unknown",
  title: `${tool} not run: blocked by execution policy`,
  body: reason,
  evidence_ids: [],
  tool_call_seqs: [],
  limitations: ["policy-blocked"],
  source: "policy",
});

export const rejectedArgumentsFinding = (
  tool: string,
  reason: string,
): NewFinding => ({
  class: "unknown",
  title: `${tool} not run: request rejected before dispatch`,
  body: reason,
  evidence_ids: [],
  tool_call_seqs: [],
  limitations: ["rejected-before-dispatch"],
  source: "routing",
});

export const budgetFinding = (tool: string): NewFinding => ({
  class: "unknown",
  title: `${tool} not run: tool-call budget exhausted`,
  body: "The job's tool_calls budget was reached; remaining planned steps were skipped and the result is partial.",
  evidence_ids: [],
  tool_call_seqs: [],
  limitations: ["budget_exhausted"],
  source: "policy",
});

/** Obligations from build_reconstruction_obligation_ledger become proposals. */
export const findingsFromLedger = (outcome: ToolCallOutcome): NewFinding[] => {
  const normalized = normalizedOf(outcome) as Record<string, unknown> | null;
  const obligations = (normalized?.["obligations"] ?? normalized?.["items"]) as
    | Record<string, unknown>[]
    | undefined;
  if (!Array.isArray(obligations) || obligations.length === 0)
    return [
      {
        class: "proposal",
        title: `Reconstruction obligation ledger: ${String(normalized?.["status"] ?? "unknown")}`,
        body: summariseNormalized(normalized),
        evidence_ids: outcome.derived.evidence_id
          ? [outcome.derived.evidence_id]
          : [],
        tool_call_seqs: [outcome.seq],
        limitations: [...outcome.derived.limitations],
        source: "upstream",
      },
    ];
  return obligations.slice(0, 200).map((o) => ({
    class: "proposal" as const,
    title: `Obligation ${String(o["id"] ?? o["obligation_id"] ?? "?")}: ${String(o["title"] ?? o["claim"] ?? o["kind"] ?? "reconstruction obligation")}`,
    body: summariseNormalized(o),
    evidence_ids: [
      ...(outcome.derived.evidence_id ? [outcome.derived.evidence_id] : []),
      ...((Array.isArray(o["evidence_ids"])
        ? o["evidence_ids"]
        : []) as string[]),
    ],
    tool_call_seqs: [outcome.seq],
    limitations: [String(o["status"] ?? "status unknown")],
    source: "upstream" as const,
  }));
};
