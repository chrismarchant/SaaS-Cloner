import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, createRepositories } from "../src/index.js";
import {
  type JobRequirements,
  ZERO_USAGE,
  jobSchema,
} from "@rea-web/contracts";
import {
  type TestDatabase,
  createTestDatabase,
  describeDb,
} from "./testDatabase.js";
import { jobInput, seedProject, seedRunner } from "./fixtures.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const any = () => true;
const TTL = 60_000;

describeDb("jobs", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.drop();
  });

  /** Fresh project + runner per test so queued jobs never leak between tests. */
  async function world() {
    const { user, project } = await seedProject(t.repos);
    const runner = await seedRunner(t.repos, project.id, user.id);
    return { user, project, runner };
  }
  const expireLease = (job_id: string) =>
    t.db.query(
      "UPDATE job_leases SET expires_at = now() - interval '1 second' WHERE job_id = $1",
      [job_id],
    );
  const eventKinds = async (job_id: string) =>
    (await t.repos.jobEvents.listAfter(job_id, 0, 100)).map((e) => e.kind);

  it("create inserts a queued job, a fencing row and event seq 1 job.created", async () => {
    const { project, user } = await world();
    const job = await t.repos.jobs.create(
      jobInput(project.id, {
        requirements: { tools: ["open_binary"] },
        input: { a: 1 },
        created_by: user.id,
        idempotency_key: "k1",
      }),
    );
    expect(job.state).toBe("queued");
    expect(job.attempt).toBe(1);
    expect(job.max_attempts).toBe(3);
    expect(job.lease).toBeNull();
    expect(job.requirements).toEqual({
      tools: ["open_binary"],
      providers: [],
      os: [],
      labels: [],
      effects: [],
    });
    expect(job.usage).toEqual(ZERO_USAGE);
    expect(jobSchema.safeParse(job).success).toBe(true);
    expect(await t.repos.jobs.findById(job.id)).toEqual(job);

    const events = await t.repos.jobEvents.listAfter(job.id, 0, 10);
    expect(events.map((e) => [e.seq, e.kind])).toEqual([[1, "job.created"]]);
    const fencing = await t.db.query<{ last_token: number }>(
      "SELECT last_token FROM job_fencing WHERE job_id = $1",
      [job.id],
    );
    expect(fencing.rows[0]?.last_token).toBe(0);
    expect(
      await t.repos.jobs.findById("00000000-0000-4000-8000-000000000000"),
    ).toBeNull();
  });

  it("create rejects invalid budgets with validation_failed", async () => {
    const { project } = await world();
    await expect(
      t.repos.jobs.create(
        jobInput(project.id, { budget: { wall_ms: -1 } as never }),
      ),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("claim returns the oldest matching queued job and skips non-matching ones", async () => {
    const { project, runner } = await world();
    const first = await t.repos.jobs.create(
      jobInput(project.id, { requirements: { tools: ["gpu_tool"] } }),
    );
    const second = await t.repos.jobs.create(
      jobInput(project.id, { requirements: { tools: ["open_binary"] } }),
    );
    const third = await t.repos.jobs.create(
      jobInput(project.id, { requirements: { tools: ["open_binary"] } }),
    );

    const seen: JobRequirements[] = [];
    const claim = await t.repos.jobs.claim({
      runner_id: runner.id,
      lease_ttl_ms: TTL,
      matches: (r) => {
        seen.push(r);
        return !r.tools.includes("gpu_tool");
      },
    });
    expect(claim?.job.id).toBe(second.id);
    expect(claim?.job.state).toBe("preparing");
    expect(claim?.fencing_token).toBe(1);
    expect(claim?.job.lease).toEqual({
      runner_id: runner.id,
      fencing_token: 1,
      expires_at: claim?.lease_expires_at,
    });
    expect(Date.parse(claim?.lease_expires_at ?? "")).toBeGreaterThan(
      Date.now(),
    );
    expect(await eventKinds(second.id)).toEqual(["job.created", "job.claimed"]);
    // The skipped job is untouched and still queued.
    expect((await t.repos.jobs.findById(first.id))?.state).toBe("queued");
    expect((await t.repos.jobs.findById(third.id))?.state).toBe("queued");

    const next = await t.repos.jobs.claim({
      runner_id: runner.id,
      lease_ttl_ms: TTL,
      matches: (r) => !r.tools.includes("gpu_tool"),
    });
    expect(next?.job.id).toBe(third.id);
    expect(
      await t.repos.jobs.claim({
        runner_id: runner.id,
        lease_ttl_ms: TTL,
        matches: (r) => !r.tools.includes("gpu_tool"),
      }),
    ).toBeNull();
  });

  it("claim honours preferred runner, project boundaries and revoked runners", async () => {
    const { project, runner, user } = await world();
    const other = await seedRunner(t.repos, project.id, user.id);
    const stranger = await world();
    const pinned = await t.repos.jobs.create(
      jobInput(project.id, { preferred_runner_id: other.id }),
    );

    expect(
      await t.repos.jobs.claim({
        runner_id: runner.id,
        lease_ttl_ms: TTL,
        matches: any,
      }),
    ).toBeNull();
    expect(
      await t.repos.jobs.claim({
        runner_id: stranger.runner.id,
        lease_ttl_ms: TTL,
        matches: any,
      }),
    ).toBeNull();
    await t.repos.runners.revoke(other.id);
    expect(
      await t.repos.jobs.claim({
        runner_id: other.id,
        lease_ttl_ms: TTL,
        matches: any,
      }),
    ).toBeNull();
    expect((await t.repos.jobs.findById(pinned.id))?.state).toBe("queued");
  });

  it("two concurrent claims on one queued job: exactly one wins", async () => {
    const { project, runner, user } = await world();
    const rival = await seedRunner(t.repos, project.id, user.id);
    const job = await t.repos.jobs.create(jobInput(project.id));
    const a = createJobs(t.open(2));
    const b = createJobs(t.open(2));
    const results = await Promise.all([
      a.claim({ runner_id: runner.id, lease_ttl_ms: TTL, matches: any }),
      b.claim({ runner_id: rival.id, lease_ttl_ms: TTL, matches: any }),
    ]);
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.job.id).toBe(job.id);
    expect(winners[0]?.fencing_token).toBe(1);
    expect(
      (await eventKinds(job.id)).filter((k) => k === "job.claimed"),
    ).toHaveLength(1);
  });

  describe("fencing", () => {
    async function claimed() {
      const w = await world();
      await t.repos.jobs.create(jobInput(w.project.id));
      const claim = await t.repos.jobs.claim({
        runner_id: w.runner.id,
        lease_ttl_ms: TTL,
        matches: any,
      });
      if (claim === null) throw new Error("expected a claim");
      return { ...w, job: claim.job, token: claim.fencing_token };
    }

    it("heartbeat extends the lease, merges usage and reports accepted", async () => {
      const { job, runner, token } = await claimed();
      const before = Date.parse(job.lease?.expires_at ?? "");
      await sleep(5);
      const hb = await t.repos.jobs.heartbeat({
        job_id: job.id,
        runner_id: runner.id,
        fencing_token: token,
        lease_ttl_ms: 120_000,
        usage: { tool_calls: 3, wall_ms: 500 },
      });
      expect(hb.accepted).toBe(true);
      expect(hb.reason).toBeUndefined();
      expect(hb.cancel_requested).toBe(false);
      expect(Date.parse(hb.lease_expires_at ?? "")).toBeGreaterThan(before);
      const after = await t.repos.jobs.findById(job.id);
      expect(after?.usage).toEqual({
        ...ZERO_USAGE,
        tool_calls: 3,
        wall_ms: 500,
      });
      expect(after?.lease?.expires_at).toBe(hb.lease_expires_at);
    });

    it("heartbeat distinguishes stale_lease, lease_expired and not_leased", async () => {
      const { job, runner, token, project } = await claimed();
      const base = { job_id: job.id, lease_ttl_ms: TTL };
      expect(
        await t.repos.jobs.heartbeat({
          ...base,
          runner_id: runner.id,
          fencing_token: token + 1,
        }),
      ).toMatchObject({ accepted: false, reason: "stale_lease" });
      const impostor = await seedRunner(t.repos, project.id);
      expect(
        await t.repos.jobs.heartbeat({
          ...base,
          runner_id: impostor.id,
          fencing_token: token,
        }),
      ).toMatchObject({ accepted: false, reason: "stale_lease" });
      expect(
        (await eventKinds(job.id)).filter((k) => k === "job.stale_rejected"),
      ).toHaveLength(2);

      await expireLease(job.id);
      expect(
        await t.repos.jobs.heartbeat({
          ...base,
          runner_id: runner.id,
          fencing_token: token,
        }),
      ).toMatchObject({ accepted: false, reason: "lease_expired" });

      const unleased = await t.repos.jobs.create(jobInput(project.id));
      expect(
        await t.repos.jobs.heartbeat({
          job_id: unleased.id,
          runner_id: runner.id,
          fencing_token: 1,
          lease_ttl_ms: TTL,
        }),
      ).toEqual({
        accepted: false,
        reason: "not_leased",
        cancel_requested: false,
      });
    });

    it("stale tokens are rejected by heartbeat, transition and complete and leave the job unchanged", async () => {
      const w = await claimed();
      // Lease expires, reaper requeues, a second runner claims with a newer token.
      await expireLease(w.job.id);
      await t.repos.jobs.reapExpiredLeases();
      const second = await seedRunner(t.repos, w.project.id);
      const reclaim = await t.repos.jobs.claim({
        runner_id: second.id,
        lease_ttl_ms: TTL,
        matches: any,
      });
      expect(reclaim?.job.id).toBe(w.job.id);
      expect(reclaim?.fencing_token).toBe(w.token + 1);

      const snapshot = await t.repos.jobs.findById(w.job.id);
      const stale = { job_id: w.job.id, fencing_token: w.token };

      expect(
        await t.repos.jobs.heartbeat({
          ...stale,
          runner_id: w.runner.id,
          lease_ttl_ms: TTL,
        }),
      ).toMatchObject({ accepted: false, reason: "stale_lease" });
      await expect(
        t.repos.jobs.transition({ ...stale, to: "running", actor: "runner" }),
      ).rejects.toMatchObject({ code: "stale_lease" });
      await expect(
        t.repos.jobs.complete({
          ...stale,
          runner_id: w.runner.id,
          outcome: "succeeded",
          result: { x: 1 },
        }),
      ).rejects.toMatchObject({ code: "stale_lease" });
      // A running job is also protected from a stale completion.
      await t.repos.jobs.transition({
        job_id: w.job.id,
        fencing_token: reclaim?.fencing_token,
        to: "running",
        actor: "runner",
      });
      const running = await t.repos.jobs.findById(w.job.id);
      await expect(
        t.repos.jobs.complete({
          ...stale,
          runner_id: w.runner.id,
          outcome: "succeeded",
        }),
      ).rejects.toMatchObject({ code: "stale_lease" });

      const after = await t.repos.jobs.findById(w.job.id);
      expect(after?.state).toBe("running");
      expect(after?.result).toBeNull();
      expect(after?.lease).toEqual(running?.lease);
      expect(snapshot?.state).toBe("preparing");
      expect(snapshot?.lease?.fencing_token).toBe(w.token + 1);
      expect(await eventKinds(w.job.id)).toContain("job.stale_rejected");
    });

    it("a superseded runner is told stale_lease even after the reaper requeued the job", async () => {
      const w = await claimed();
      await expireLease(w.job.id);
      await t.repos.jobs.reapExpiredLeases();
      expect((await t.repos.jobs.findById(w.job.id))?.state).toBe("queued");
      await expect(
        t.repos.jobs.complete({
          job_id: w.job.id,
          runner_id: w.runner.id,
          fencing_token: w.token,
          outcome: "succeeded",
        }),
      ).rejects.toMatchObject({ code: "stale_lease" });
      await expect(
        t.repos.jobs.transition({
          job_id: w.job.id,
          fencing_token: w.token,
          to: "running",
          actor: "runner",
        }),
      ).rejects.toMatchObject({ code: "stale_lease" });
      expect((await t.repos.jobs.findById(w.job.id))?.state).toBe("queued");
    });

    it("an expired lease cannot transition or complete even with the right token", async () => {
      const { job, runner, token } = await claimed();
      await expireLease(job.id);
      await expect(
        t.repos.jobs.transition({
          job_id: job.id,
          fencing_token: token,
          to: "running",
          actor: "runner",
        }),
      ).rejects.toMatchObject({
        code: "stale_lease",
        details: { reason: "lease_expired" },
      });
      expect((await t.repos.jobs.findById(job.id))?.state).toBe("preparing");
      expect(runner.id).toBeDefined();
    });
  });

  describe("reaper", () => {
    it("requeues an expired job with attempt 2 and the next claim issues a greater token", async () => {
      const { project, runner } = await world();
      const job = await t.repos.jobs.create(jobInput(project.id));
      const first = await t.repos.jobs.claim({
        runner_id: runner.id,
        lease_ttl_ms: TTL,
        matches: any,
      });
      await expireLease(job.id);

      const reaped = (await t.repos.jobs.reapExpiredLeases()).filter(
        (r) => r.job_id === job.id,
      );
      expect(reaped).toEqual([
        {
          job_id: job.id,
          outcome: "requeued",
          attempt: 2,
          reason: "lease_expired",
        },
      ]);
      const requeued = await t.repos.jobs.findById(job.id);
      expect(requeued).toMatchObject({
        state: "queued",
        attempt: 2,
        lease: null,
      });

      const second = await t.repos.jobs.claim({
        runner_id: runner.id,
        lease_ttl_ms: TTL,
        matches: any,
      });
      expect(second?.job.attempt).toBe(2);
      expect(second?.fencing_token).toBeGreaterThan(first?.fencing_token ?? 0);
      expect(await eventKinds(job.id)).toEqual([
        "job.created",
        "job.claimed",
        "job.transition",
        "job.transition",
        "job.claimed",
      ]);
      // Nothing left to reap for this job.
      expect(
        (await t.repos.jobs.reapExpiredLeases()).map((r) => r.job_id),
      ).not.toContain(job.id);
    });

    it("does not touch live leases and honours an explicit now", async () => {
      const { project, runner } = await world();
      const job = await t.repos.jobs.create(jobInput(project.id));
      await t.repos.jobs.claim({
        runner_id: runner.id,
        lease_ttl_ms: TTL,
        matches: any,
      });
      const live = await t.repos.jobs.reapExpiredLeases();
      expect(live.map((r) => r.job_id)).not.toContain(job.id);
      expect((await t.repos.jobs.findById(job.id))?.state).toBe("preparing");
      const reaped = await t.repos.jobs.reapExpiredLeases(
        new Date(Date.now() + 10 * TTL),
      );
      expect(reaped.map((r) => r.job_id)).toContain(job.id);
    });

    it("fails instead of requeueing when an effect-ledger step is still started", async () => {
      const { project, runner } = await world();
      const job = await t.repos.jobs.create(jobInput(project.id));
      const claim = await t.repos.jobs.claim({
        runner_id: runner.id,
        lease_ttl_ms: TTL,
        matches: any,
      });
      await t.repos.jobs.transition({
        job_id: job.id,
        fencing_token: claim?.fencing_token,
        to: "running",
        actor: "runner",
      });
      await t.repos.effectLedger.start(job.id, "install_adb_package", 1, {
        package: "x",
      });
      expect(await t.repos.effectLedger.hasStarted(job.id)).toBe(true);
      await expireLease(job.id);

      const reaped = (await t.repos.jobs.reapExpiredLeases()).filter(
        (r) => r.job_id === job.id,
      );
      expect(reaped).toEqual([
        {
          job_id: job.id,
          outcome: "failed",
          attempt: 1,
          reason: "non_repeatable_effect_ambiguous",
        },
      ]);
      const failed = await t.repos.jobs.findById(job.id);
      expect(failed?.state).toBe("failed");
      expect(failed?.failure).toMatchObject({
        code: "interrupted",
        retryable: false,
      });
      expect(failed?.lease).toBeNull();
    });

    it("fails when attempts are exhausted", async () => {
      const { project, runner } = await world();
      const job = await t.repos.jobs.create(
        jobInput(project.id, { max_attempts: 1 }),
      );
      await t.repos.jobs.claim({
        runner_id: runner.id,
        lease_ttl_ms: TTL,
        matches: any,
      });
      await expireLease(job.id);
      const reaped = (await t.repos.jobs.reapExpiredLeases()).filter(
        (r) => r.job_id === job.id,
      );
      expect(reaped[0]).toMatchObject({
        outcome: "failed",
        reason: "retries_exhausted",
      });
      expect((await t.repos.jobs.findById(job.id))?.failure).toMatchObject({
        code: "interrupted",
      });
    });

    it("a completed effect does not block a retry", async () => {
      const { project, runner } = await world();
      const job = await t.repos.jobs.create(jobInput(project.id));
      await t.repos.jobs.claim({
        runner_id: runner.id,
        lease_ttl_ms: TTL,
        matches: any,
      });
      await t.repos.effectLedger.start(job.id, "step", 1);
      await t.repos.effectLedger.complete(job.id, "step", { ok: true });
      await expireLease(job.id);
      const reaped = (await t.repos.jobs.reapExpiredLeases()).filter(
        (r) => r.job_id === job.id,
      );
      expect(reaped[0]?.outcome).toBe("requeued");
    });
  });

  describe("transition and complete", () => {
    it("rejects queued->running and allows preparing->running by the runner holding the token", async () => {
      const { project, runner } = await world();
      const job = await t.repos.jobs.create(jobInput(project.id));
      await expect(
        t.repos.jobs.transition({
          job_id: job.id,
          fencing_token: 1,
          to: "running",
          actor: "runner",
        }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
      await expect(
        t.repos.jobs.transition({
          job_id: job.id,
          to: "preparing",
          actor: "system",
        }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
      expect((await t.repos.jobs.findById(job.id))?.state).toBe("queued");

      const claim = await t.repos.jobs.claim({
        runner_id: runner.id,
        lease_ttl_ms: TTL,
        matches: any,
      });
      // A runner transition without a token is fenced out.
      await expect(
        t.repos.jobs.transition({
          job_id: job.id,
          to: "running",
          actor: "runner",
        }),
      ).rejects.toMatchObject({ code: "stale_lease" });
      // Users cannot drive runner-only transitions.
      await expect(
        t.repos.jobs.transition({
          job_id: job.id,
          to: "running",
          actor: "user",
        }),
      ).rejects.toMatchObject({ code: "invalid_transition" });

      const running = await t.repos.jobs.transition({
        job_id: job.id,
        fencing_token: claim?.fencing_token,
        to: "running",
        actor: "runner",
        event_payload: { note: "workspace ready" },
      });
      expect(running.state).toBe("running");
      expect(running.lease?.fencing_token).toBe(claim?.fencing_token);
      const events = await t.repos.jobEvents.listAfter(job.id, 0, 50);
      const last = events[events.length - 1];
      expect(last).toMatchObject({
        kind: "job.transition",
        payload: {
          from: "preparing",
          to: "running",
          actor: "runner",
          note: "workspace ready",
        },
      });
      await expect(
        t.repos.jobs.transition({
          job_id: "00000000-0000-4000-8000-000000000000",
          to: "running",
          actor: "system",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("complete finalises state, stores result and usage, drops the lease and logs job.completed", async () => {
      const { project, runner } = await world();
      const job = await t.repos.jobs.create(jobInput(project.id));
      const claim = await t.repos.jobs.claim({
        runner_id: runner.id,
        lease_ttl_ms: TTL,
        matches: any,
      });
      const token = claim?.fencing_token ?? 0;
      // preparing -> succeeded is not a legal transition.
      await expect(
        t.repos.jobs.complete({
          job_id: job.id,
          runner_id: runner.id,
          fencing_token: token,
          outcome: "succeeded",
        }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
      await t.repos.jobs.transition({
        job_id: job.id,
        fencing_token: token,
        to: "running",
        actor: "runner",
      });
      const done = await t.repos.jobs.complete({
        job_id: job.id,
        runner_id: runner.id,
        fencing_token: token,
        outcome: "succeeded",
        result: { evidence: "e1" },
        usage: { tool_calls: 7 },
      });
      expect(done).toMatchObject({
        state: "succeeded",
        lease: null,
        result: { evidence: "e1" },
        failure: null,
      });
      expect(done.usage.tool_calls).toBe(7);
      const events = await t.repos.jobEvents.listAfter(job.id, 0, 50);
      expect(events[events.length - 1]).toMatchObject({
        kind: "job.completed",
        payload: { outcome: "succeeded" },
      });
      // Terminal: a replayed completion no longer holds a lease and is refused.
      await expect(
        t.repos.jobs.complete({
          job_id: job.id,
          runner_id: runner.id,
          fencing_token: token,
          outcome: "succeeded",
        }),
      ).rejects.toMatchObject({
        code: "stale_lease",
        details: { reason: "not_leased" },
      });
    });

    it("complete can record a failure", async () => {
      const { project, runner } = await world();
      const job = await t.repos.jobs.create(jobInput(project.id));
      const claim = await t.repos.jobs.claim({
        runner_id: runner.id,
        lease_ttl_ms: TTL,
        matches: any,
      });
      const failure = {
        code: "budget_exceeded",
        message: "wall_ms",
        retryable: false,
      };
      const done = await t.repos.jobs.complete({
        job_id: job.id,
        runner_id: runner.id,
        fencing_token: claim?.fencing_token ?? 0,
        outcome: "failed",
        failure,
      });
      expect(done).toMatchObject({ state: "failed", failure });
    });
  });

  describe("cancellation", () => {
    it("requestCancel is reflected in the next heartbeat and the job keeps running until the runner reports", async () => {
      const { project, runner } = await world();
      const job = await t.repos.jobs.create(jobInput(project.id));
      const claim = await t.repos.jobs.claim({
        runner_id: runner.id,
        lease_ttl_ms: TTL,
        matches: any,
      });
      const token = claim?.fencing_token ?? 0;
      const hb = () =>
        t.repos.jobs.heartbeat({
          job_id: job.id,
          runner_id: runner.id,
          fencing_token: token,
          lease_ttl_ms: TTL,
        });
      expect((await hb()).cancel_requested).toBe(false);

      const requested = await t.repos.jobs.requestCancel(job.id);
      expect(requested.state).toBe("preparing");
      expect(requested.cancel_requested_at).not.toBeNull();
      expect(await hb()).toMatchObject({
        accepted: true,
        cancel_requested: true,
      });
      // Idempotent: no second event.
      await t.repos.jobs.requestCancel(job.id);
      expect(
        (await eventKinds(job.id)).filter((k) => k === "job.cancel_requested"),
      ).toHaveLength(1);

      const done = await t.repos.jobs.complete({
        job_id: job.id,
        runner_id: runner.id,
        fencing_token: token,
        outcome: "cancelled",
      });
      expect(done.state).toBe("cancelled");
      expect((await t.repos.jobs.requestCancel(job.id)).state).toBe(
        "cancelled",
      );
    });

    it("requestCancel cancels a queued job immediately", async () => {
      const { project, runner } = await world();
      const job = await t.repos.jobs.create(jobInput(project.id));
      const cancelled = await t.repos.jobs.requestCancel(job.id);
      expect(cancelled.state).toBe("cancelled");
      expect(
        await t.repos.jobs.claim({
          runner_id: runner.id,
          lease_ttl_ms: TTL,
          matches: any,
        }),
      ).toBeNull();
      await expect(
        t.repos.jobs.requestCancel("00000000-0000-4000-8000-000000000000"),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  });

  describe("listing", () => {
    it("filters by state and kind and pages with cursors", async () => {
      const { project, runner } = await world();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        await sleep(3);
        const kind = i === 0 ? "preservation.plan" : "investigation.run";
        ids.push(
          (await t.repos.jobs.create(jobInput(project.id, { kind }))).id,
        );
      }
      // Claim the oldest job (preservation.plan).
      await t.repos.jobs.claim({
        runner_id: runner.id,
        lease_ttl_ms: TTL,
        matches: any,
      });

      expect(
        (await t.repos.jobs.list(project.id, { state: "preparing" })).items.map(
          (j) => j.id,
        ),
      ).toEqual([ids[0]]);
      const kinds = await t.repos.jobs.list(project.id, {
        kind: "investigation.run",
        limit: 3,
      });
      expect(kinds.items.map((j) => j.id)).toEqual([ids[4], ids[3], ids[2]]);
      expect(kinds.next_cursor).not.toBeNull();
      const rest = await t.repos.jobs.list(project.id, {
        kind: "investigation.run",
        limit: 3,
        cursor: kinds.next_cursor ?? "",
      });
      expect(rest.items.map((j) => j.id)).toEqual([ids[1]]);
      expect(rest.next_cursor).toBeNull();
      const everything = await t.repos.jobs.list(project.id);
      expect(everything.items).toHaveLength(5);
      expect(
        everything.items.find((j) => j.id === ids[0])?.lease?.runner_id,
      ).toBe(runner.id);
    });
  });

  describe("job events", () => {
    it("assigns contiguous sequence numbers under 20 concurrent appends", async () => {
      const { project } = await world();
      const job = await t.repos.jobs.create(jobInput(project.id));
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          t.repos.jobEvents.append(undefined, job.id, "job.log", { i }),
        ),
      );
      const events = await t.repos.jobEvents.listAfter(job.id, 0, 100);
      expect(events.map((e) => e.seq)).toEqual(
        Array.from({ length: 21 }, (_, i) => i + 1),
      );
      expect(new Set(events.slice(1).map((e) => e.payload["i"])).size).toBe(20);
    });

    it("listAfter pages by sequence number", async () => {
      const { project } = await world();
      const job = await t.repos.jobs.create(jobInput(project.id));
      for (let i = 0; i < 6; i++)
        await t.repos.jobEvents.append(undefined, job.id, "job.progress", {
          i,
        });
      const page1 = await t.repos.jobEvents.listAfter(job.id, 0, 3);
      expect(page1.map((e) => e.seq)).toEqual([1, 2, 3]);
      const page2 = await t.repos.jobEvents.listAfter(job.id, 3, 3);
      expect(page2.map((e) => e.seq)).toEqual([4, 5, 6]);
      expect(await t.repos.jobEvents.listAfter(job.id, 7, 3)).toEqual([]);
      await expect(
        t.repos.jobEvents.append(
          undefined,
          "00000000-0000-4000-8000-000000000000",
          "job.log",
        ),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("append joins the caller's transaction and notifies listeners on commit", async () => {
      const { project } = await world();
      const job = await t.repos.jobs.create(jobInput(project.id));
      const listener = await t.db.pool.connect();
      const notified: string[] = [];
      listener.on("notification", (m) => {
        if (m.channel === "job_events" && m.payload !== undefined)
          notified.push(m.payload);
      });
      try {
        await listener.query("LISTEN job_events");
        await expect(
          t.db.withTransaction(async (client) => {
            await t.repos.jobEvents.append(client, job.id, "job.log", {
              rolled: "back",
            });
            throw new Error("abort");
          }),
        ).rejects.toThrow("abort");
        expect(await t.repos.jobEvents.listAfter(job.id, 1, 10)).toEqual([]);
        await t.repos.jobEvents.append(undefined, job.id, "job.log", {});
        for (let i = 0; i < 50 && notified.length === 0; i++) await sleep(20);
        expect(notified).toEqual([job.id]);
      } finally {
        listener.release(true); // drop the connection: it still has LISTEN active
      }
    });
  });
});

function createJobs(db: Database) {
  return createRepositories(db).jobs;
}
