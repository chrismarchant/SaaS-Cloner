import type { Job, toolCallSummarySchema } from "@rea-web/contracts/browser";
import type { z } from "zod";
import { useJobsOfKind } from "../../api/hooks";
import type { EvidenceOption } from "../../components/EvidencePicker";

export type ToolCall = z.output<typeof toolCallSummarySchema>;

/** Evidence ids recorded by this investigation's own tool calls. */
export const evidenceOptions = (calls: readonly ToolCall[]): EvidenceOption[] =>
  calls
    .filter((call) => call.evidence_id !== null)
    .map((call) => ({
      evidenceId: call.evidence_id as string,
      label: `#${call.seq} ${call.tool_name} · ${(call.evidence_id as string).slice(0, 14)}…`,
    }));

/** Jobs of one kind that belong to an investigation, newest first. */
export const useInvestigationJobs = (
  projectId: string,
  investigationId: string,
  kind: string,
  live: boolean,
): { jobs: Job[]; error: unknown; pending: boolean } => {
  const list = useJobsOfKind(projectId, kind, live);
  const jobs = (list.data?.items ?? [])
    .filter((job) => job.input["investigation_id"] === investigationId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { jobs, error: list.error, pending: list.isPending };
};

export const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

export const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
