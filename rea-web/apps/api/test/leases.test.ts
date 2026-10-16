import { afterAll, beforeAll, expect, it } from "vitest";
import { startReaper } from "../src/orchestrator/reaper.js";
import {
  type Account,
  type Harness,
  type RunnerHandle,
  createHarness,
  createRunner,
  describeDb,
  registerRunner,
  reportFor,
} from "./helpers/harness.js";
import {
  claimOne,
  complete,
  heartbeat,
  postEvents,
  startInvestigation,
  transition,
} from "./helpers/flow.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb("lease expiry and reaping", () => {
  let h: Harness;
  let owner: Account;
  let p: string;
  let first: RunnerHandle;
  let second: RunnerHandle;
  beforeAll(async () => {
    h = await createHarness({ leaseTtlMs: 250 });
    owner = await h.register("leases@example.com");
    p = owner.defaultProjectId as string;
    first = await createRunner(h, owner, p, "first");
    second = await createRunner(h, owner, p, "second");
    await registerRunner(h, first, reportFor("first"));
    await registerRunner(h, second, reportFor("second"));
  });
  afterAll(async () => {
    await h.close();
  });

  it("interrupts and requeues an expired lease, and the next claim gets a higher fencing token", async () => {
    const setup = await startInvestigation(h, owner, p, { runnerId: first.id });
    const claimed = await claimOne(h, first);
    expect(claimed.token).toBe(1);
    await transition(h, first, setup.jobId, 1, "running");
    await sleep(330);

    // Expired but not yet reaped: fenced writes already fail.
    const early = await postEvents(h, first, setup.jobId, 1, [
      { kind: "job.log" },
    ]);
    expect(early.status).toBe(409);
    expect(early.json.error.details.reason).toBe("lease_expired");

    const outcomes = await h.reap();
    expect(outcomes).toEqual([
      {
        job_id: setup.jobId,
        outcome: "requeued",
        attempt: 2,
        reason: "lease_expired",
      },
    ]);
    const requeued = await h.repos.jobs.findById(setup.jobId);
    expect(requeued).toMatchObject({
      state: "queued",
      attempt: 2,
      lease: null,
    });
    const kinds = (await h.repos.jobEvents.listAfter(setup.jobId, 0)).map(
      (e) => `${e.kind}:${String(e.payload["to"] ?? "")}`,
    );
    expect(kinds).toContain("job.transition:interrupted");
    expect(kinds).toContain("job.transition:queued");

    const again = await claimOne(h, first);
    expect(again.jobId).toBe(setup.jobId);
    expect(again.token).toBe(2);

    // The superseded attempt cannot complete or heartbeat.
    const stale = await complete(h, first, setup.jobId, 1, "succeeded");
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("stale_lease");
    const beat = await heartbeat(h, first, [
      { job_id: setup.jobId, fencing_token: 1 },
    ]);
    expect(beat.json.leases[0]).toMatchObject({
      accepted: false,
      reason: "stale_lease",
    });
    expect((await h.repos.jobs.findById(setup.jobId))?.state).toBe("preparing");
    expect((await transition(h, first, setup.jobId, 2, "running")).status).toBe(
      200,
    );
    const done = await complete(h, first, setup.jobId, 2, "succeeded");
    expect(done.status).toBe(200);
  });

  it("keeps a heartbeating lease alive across the TTL", async () => {
    const setup = await startInvestigation(h, owner, p, {
      runnerId: first.id,
      name: "alive.asar",
    });
    const claimed = await claimOne(h, first);
    expect(claimed.jobId).toBe(setup.jobId);
    for (let i = 0; i < 4; i += 1) {
      await sleep(60);
      const beat = await heartbeat(h, first, [
        { job_id: setup.jobId, fencing_token: claimed.token },
      ]);
      expect(beat.json.leases[0].accepted).toBe(true);
    }
    expect(await h.reap()).toEqual([]);
    expect((await h.repos.jobs.findById(setup.jobId))?.state).toBe("preparing");
    expect(
      (await transition(h, first, setup.jobId, claimed.token, "running"))
        .status,
    ).toBe(200);
    expect(
      (await complete(h, first, setup.jobId, claimed.token, "succeeded"))
        .status,
    ).toBe(200);
  });

  it("fails the job once retries are exhausted", async () => {
    const setup = await startInvestigation(h, owner, p, {
      runnerId: second.id,
      name: "flaky.asar",
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await claimOne(h, second);
      expect(claimed.jobId).toBe(setup.jobId);
      await sleep(330);
      await h.reap();
    }
    const job = await h.repos.jobs.findById(setup.jobId);
    expect(job).toMatchObject({
      state: "failed",
      failure: {
        code: "interrupted",
        details: { reason: "retries_exhausted" },
      },
    });
    const view = await h.api(
      "GET",
      `/api/v1/projects/${p}/investigations/${setup.investigationId}`,
      {
        auth: owner.auth,
      },
    );
    expect(view.json.status).toBe("failed");
  });

  it("cancels instead of re-running when cancellation was requested before the lease expired", async () => {
    const setup = await startInvestigation(h, owner, p, {
      runnerId: first.id,
      name: "cancelme.asar",
    });
    const claimed = await claimOne(h, first);
    expect(claimed.jobId).toBe(setup.jobId);
    await transition(h, first, setup.jobId, claimed.token, "running");
    const cancel = await h.api(
      "POST",
      `/api/v1/projects/${p}/jobs/${setup.jobId}/cancel`,
      {
        auth: owner.auth,
      },
    );
    expect(cancel.status).toBe(200);
    expect(cancel.json.state).toBe("running");
    expect(cancel.json.cancel_requested_at).not.toBeNull();
    await sleep(330);
    await h.reap();
    expect((await h.repos.jobs.findById(setup.jobId))?.state).toBe("cancelled");
  });

  it("marks silent runners stale and a claim brings them back online", async () => {
    await sleep(600);
    await h.reap();
    expect((await h.repos.runners.findById(p, second.id))?.status).toBe(
      "stale",
    );
    const response = await h.api("POST", `/api/v1/runners/${second.id}/claim`, {
      auth: second.auth,
      body: { wait_ms: 0 },
    });
    expect(response.status).toBe(204);
    expect((await h.repos.runners.findById(p, second.id))?.status).toBe(
      "online",
    );
  });

  it("runs the reaper loop on an interval and stops it cleanly", async () => {
    const setup = await startInvestigation(h, owner, p, {
      runnerId: first.id,
      name: "loop.asar",
    });
    expect((await claimOne(h, first)).jobId).toBe(setup.jobId);
    const loop = startReaper(h.repos, 20, { staleRunnerMs: 60_000 });
    try {
      const deadline = Date.now() + 5000;
      let state = "";
      while (Date.now() < deadline) {
        state = (await h.repos.jobs.findById(setup.jobId))?.state ?? "";
        if (state === "queued") break;
        await sleep(25);
      }
      expect(state).toBe("queued");
    } finally {
      await loop.stop();
    }
  });
});
