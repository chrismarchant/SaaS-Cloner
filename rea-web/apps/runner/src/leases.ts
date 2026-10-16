import type { JobBudgetUsage } from "@rea-web/contracts";
import type { ControlPlaneClient } from "./controlPlane.js";

export interface ActiveLease {
  readonly jobId: string;
  readonly fencingToken: number;
  readonly abort: AbortController;
  readonly usage: () => JobBudgetUsage;
  /** Resolvers waiting on an approval decision, keyed by approval id. */
  readonly approvals: Map<string, (decision: "approved" | "rejected") => void>;
  lost: boolean;
  cancelRequested: boolean;
}

export type AbortReason =
  | { kind: "cancelled" }
  | { kind: "lease_lost"; reason: string }
  | { kind: "budget_exceeded"; dimension: string }
  | { kind: "shutdown" };

export const abortReasonOf = (signal: AbortSignal): AbortReason | null =>
  signal.aborted
    ? ((signal.reason as AbortReason | undefined) ?? { kind: "cancelled" })
    : null;

/**
 * Heartbeats every active lease on a fixed interval. A rejected lease aborts
 * its job (the runner must stop: any fenced write would be refused). A
 * cancellation request aborts with `cancelled`. Approval decisions are
 * delivered to the waiting executor.
 */
export class LeaseKeeper {
  private readonly leases = new Map<string, ActiveLease>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly client: ControlPlaneClient,
    private readonly intervalMs: number,
    private readonly log: (
      message: string,
      fields?: Record<string, unknown>,
    ) => void,
  ) {}

  add(lease: ActiveLease): void {
    this.leases.set(lease.jobId, lease);
  }

  remove(jobId: string): void {
    this.leases.delete(jobId);
  }

  get size(): number {
    return this.leases.size;
  }

  start(): void {
    this.timer = setInterval(() => void this.beat(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async beat(): Promise<void> {
    if (this.inFlight || this.leases.size === 0) return;
    this.inFlight = true;
    try {
      const leases = [...this.leases.values()];
      const response = await this.client.heartbeat({
        leases: leases.map((l) => ({
          job_id: l.jobId,
          fencing_token: l.fencingToken,
          usage: l.usage(),
        })),
      });
      for (const entry of response.leases) {
        const lease = this.leases.get(entry.job_id);
        if (!lease) continue;
        if (!entry.accepted) {
          lease.lost = true;
          this.log("lease rejected", {
            job_id: entry.job_id,
            reason: entry.reason,
          });
          lease.abort.abort({
            kind: "lease_lost",
            reason: entry.reason ?? "rejected",
          });
          continue;
        }
        for (const decision of entry.approvals) {
          const resolve = lease.approvals.get(decision.approval_id);
          if (resolve) {
            lease.approvals.delete(decision.approval_id);
            resolve(decision.decision);
          }
        }
        if (entry.cancel_requested && !lease.cancelRequested) {
          lease.cancelRequested = true;
          lease.abort.abort({ kind: "cancelled" });
        }
      }
    } catch (error) {
      this.log("heartbeat failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlight = false;
    }
  }
}
