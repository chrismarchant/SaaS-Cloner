import type { ToolAvailabilityGroup } from "@rea-web/contracts";
import type { ReaSession, ToolCallOutcome } from "@rea-web/rea-adapter";

export interface ToolStatus {
  readonly available: boolean;
  readonly reason: string;
  readonly remediation: string;
  readonly effects: readonly string[];
}

/**
 * Current per-tool availability for one session, refreshed from
 * `binary_session` after every target transition. The runner never infers
 * availability; it reads upstream's own facts.
 */
export class AvailabilityView {
  private byTool = new Map<string, ToolStatus>();

  constructor(groups: readonly ToolAvailabilityGroup[]) {
    this.load(groups);
  }

  load(groups: readonly ToolAvailabilityGroup[]): void {
    const next = new Map<string, ToolStatus>();
    for (const group of groups)
      for (const name of group.names)
        next.set(name, {
          available: group.available,
          reason: group.reason ?? (group.available ? "" : "unavailable"),
          remediation: group.remediation ?? "",
          effects: group.effects ?? [],
        });
    this.byTool = next;
  }

  status(tool: string): ToolStatus {
    return (
      this.byTool.get(tool) ?? {
        available: false,
        reason: "not_advertised",
        remediation: "The runner's live REA catalog does not list this tool.",
        effects: [],
      }
    );
  }

  availableTools(): string[] {
    return [...this.byTool.entries()]
      .filter(([, s]) => s.available)
      .map(([n]) => n);
  }

  /** Refresh from a binary_session outcome (returns false if it errored). */
  refreshFrom(outcome: ToolCallOutcome): boolean {
    if (outcome.derived.is_error) return false;
    const sc = outcome.raw["structuredContent"] as
      | Record<string, unknown>
      | undefined;
    const result = (sc?.["result"] ?? sc?.["normalized_result"]) as
      | { tool_availability?: { groups?: ToolAvailabilityGroup[] } }
      | undefined;
    const groups = result?.tool_availability?.groups;
    if (!Array.isArray(groups)) return false;
    this.load(groups);
    return true;
  }

  static fromSession(session: ReaSession): AvailabilityView {
    return new AvailabilityView(session.discovered.tool_availability.groups);
  }
}
