/**
 * Derived summaries sit beside the complete raw upstream result; they never
 * replace it. Only shallow facts are extracted so the summary stays small and
 * cannot be mistaken for the Evidence record itself.
 */
export interface DerivedToolResult {
  readonly is_error: boolean;
  readonly evidence_id: string | null;
  readonly operation: string | null;
  readonly kind: string | null;
  /** Upstream Evidence confidence: observed | derived | inferred. */
  readonly confidence: string | null;
  /** Upstream Evidence authority, e.g. shipped-artifact, analyst-inference. */
  readonly authority: string | null;
  readonly predicate_type: string | null;
  readonly normalized_result_keys: readonly string[];
  readonly raw_result_present: boolean;
  readonly analysis_profile_present: boolean;
  readonly limitations: readonly string[];
  readonly coverage: unknown;
  readonly residual_unknowns_count: number | null;
  readonly error: {
    code: string;
    message: string;
    details_keys: string[];
  } | null;
  readonly text_chars: number;
  readonly structured_present: boolean;
  readonly top_level_keys: readonly string[];
}

interface CallToolResultLike {
  readonly isError?: boolean;
  readonly content?: readonly { type: string; text?: string }[];
  readonly structuredContent?: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const collectLimitations = (
  value: unknown,
  depth = 0,
  out: string[] = [],
): string[] => {
  if (depth > 3 || value === null || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;
  const limitations = record["limitations"];
  if (Array.isArray(limitations))
    for (const l of limitations) {
      if (typeof l === "string") out.push(l);
      else if (l && typeof l === "object") {
        const text =
          str((l as Record<string, unknown>)["message"]) ??
          str((l as Record<string, unknown>)["reason"]) ??
          str((l as Record<string, unknown>)["kind"]);
        if (text) out.push(text);
      }
      if (out.length >= 32) return out;
    }
  for (const key of ["normalized_result", "result", "graph", "summary"]) {
    if (key in record) collectLimitations(record[key], depth + 1, out);
  }
  return out;
};

export const deriveToolResult = (
  result: CallToolResultLike,
): DerivedToolResult => {
  const structured = result.structuredContent ?? null;
  const text = (result.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
  let error: DerivedToolResult["error"] = null;
  if (result.isError) {
    try {
      const parsed = JSON.parse(text) as { error?: Record<string, unknown> };
      const e = parsed.error;
      if (e)
        error = {
          code: str(e["code"]) ?? "unknown",
          message: str(e["message"]) ?? "",
          details_keys:
            e["details"] && typeof e["details"] === "object"
              ? Object.keys(e["details"] as Record<string, unknown>)
              : [],
        };
    } catch {
      error = {
        code: "unparsed",
        message: text.slice(0, 500),
        details_keys: [],
      };
    }
  }
  const normalized =
    (structured?.["normalized_result"] as
      | Record<string, unknown>
      | undefined) ??
    (structured?.["result"] as Record<string, unknown> | undefined) ??
    null;
  const residual = normalized?.["residual_unknowns"];
  return {
    is_error: result.isError === true,
    evidence_id: str(structured?.["evidence_id"]),
    operation: str(structured?.["operation"]),
    kind: str(structured?.["kind"]),
    confidence: str(structured?.["confidence"]),
    authority: str(structured?.["authority"]),
    predicate_type: str(structured?.["predicate_type"]),
    normalized_result_keys: normalized
      ? Object.keys(normalized).slice(0, 64)
      : [],
    raw_result_present:
      structured !== null &&
      structured["raw_result"] !== null &&
      structured["raw_result"] !== undefined,
    analysis_profile_present:
      structured !== null && "analysis_profile" in structured,
    limitations: collectLimitations(structured),
    coverage: normalized?.["coverage"] ?? null,
    residual_unknowns_count: Array.isArray(residual) ? residual.length : null,
    error,
    text_chars: text.length,
    structured_present: structured !== null,
    top_level_keys: structured ? Object.keys(structured).slice(0, 64) : [],
  };
};
