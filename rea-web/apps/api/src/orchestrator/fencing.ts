import { ApiError, type JobEventKind } from "@rea-web/contracts";
import { appendJobEvent, type Database, type Repositories } from "@rea-web/db";

export interface PresentedLease {
  readonly job_id: string;
  readonly runner_id: string;
  readonly fencing_token: number;
}

type Rejection = "not_leased" | "stale_lease" | "lease_expired";

interface LeaseView {
  project_id: string;
  runner_id: string | null;
  fencing_token: number | null;
  expired: boolean | null;
}

const rejectionFor = (
  lease: LeaseView,
  presented: PresentedLease,
): Rejection | null => {
  if (lease.runner_id === null || lease.fencing_token === null)
    return "not_leased";
  if (
    lease.fencing_token !== presented.fencing_token ||
    lease.runner_id !== presented.runner_id
  )
    return "stale_lease";
  return lease.expired === true ? "lease_expired" : null;
};

const staleError = (reason: Rejection): ApiError =>
  new ApiError(
    "stale_lease",
    reason === "lease_expired"
      ? "lease expired"
      : reason === "not_leased"
        ? "job is not leased"
        : "fencing token is not current",
    { reason },
  );

const stalePayload = (
  operation: string,
  reason: Rejection,
  lease: LeaseView,
  presented: PresentedLease,
) => ({
  operation,
  reason,
  presented_runner_id: presented.runner_id,
  presented_fencing_token: presented.fencing_token,
  current_fencing_token: lease.fencing_token,
});

const LEASE_QUERY = `SELECT j.project_id, l.runner_id, l.fencing_token,
    l.expires_at <= clock_timestamp() AS expired
  FROM jobs j LEFT JOIN job_leases l ON l.job_id = j.id
  WHERE j.id = $1 FOR`;

class Gate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit)
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export interface Fencing {
  /**
   * Appends runner events under the job's row lock after checking the lease in
   * the same transaction: a superseded runner cannot interleave events.
   */
  appendEvents(
    presented: PresentedLease,
    events: ReadonlyArray<{
      kind: JobEventKind;
      payload: Record<string, unknown>;
    }>,
  ): Promise<number[]>;
  /**
   * Runs `fn` (short, other connections) while a shared lock on the job row
   * prevents the lease from changing; completion, reaping and heartbeats wait.
   */
  withLease<T>(
    presented: PresentedLease,
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T>;
  /** Fails with `stale_lease` unless the lease is current right now. */
  assertCurrent(presented: PresentedLease, operation: string): Promise<void>;
}

export const createFencing = (db: Database, repos: Repositories): Fencing => {
  // Each guarded operation holds one connection while `fn` uses another; the
  // gate keeps lock holders below half the pool so `fn` can always proceed.
  const poolMax = db.pool.options.max ?? 10;
  const gate = new Gate(Math.max(1, Math.floor(poolMax / 2)));

  const readLease = async (
    client: { query: Database["query"] },
    presented: PresentedLease,
    mode: "UPDATE" | "SHARE",
  ): Promise<LeaseView> => {
    const result = await client.query<LeaseView>(
      `${LEASE_QUERY} ${mode} OF j`,
      [presented.job_id],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ApiError("not_found", "job not found");
    return row;
  };

  const withLease: Fencing["withLease"] = (presented, operation, fn) =>
    gate.run(async () => {
      type Outcome<V> =
        | { ok: true; value: V }
        | { ok: false; rejection: Rejection; lease: LeaseView };
      const outcome = await db.withTransaction(
        async (client): Promise<Outcome<Awaited<ReturnType<typeof fn>>>> => {
          const lease = await readLease(client, presented, "SHARE");
          const rejection = rejectionFor(lease, presented);
          if (rejection !== null) return { ok: false, rejection, lease };
          return { ok: true, value: await fn() };
        },
      );
      if (!outcome.ok) {
        await repos.jobEvents.append(
          undefined,
          presented.job_id,
          "job.stale_rejected",
          stalePayload(operation, outcome.rejection, outcome.lease, presented),
        );
        throw staleError(outcome.rejection);
      }
      return outcome.value;
    });

  return {
    async appendEvents(presented, events) {
      const outcome = await db.withTransaction(async (client) => {
        const lease = await readLease(client, presented, "UPDATE");
        const rejection = rejectionFor(lease, presented);
        if (rejection !== null) {
          await appendJobEvent(
            client,
            presented.job_id,
            "job.stale_rejected",
            stalePayload("events", rejection, lease, presented),
          );
          return { rejected: staleError(rejection) };
        }
        const seqs: number[] = [];
        for (const event of events) {
          const row = await appendJobEvent(
            client,
            presented.job_id,
            event.kind,
            event.payload,
          );
          seqs.push(row.seq);
        }
        return { seqs };
      });
      if ("rejected" in outcome) throw outcome.rejected;
      return outcome.seqs;
    },
    withLease,
    async assertCurrent(presented, operation) {
      await withLease(presented, operation, async () => undefined);
    },
  };
};
