import { afterAll, beforeAll, expect, it } from "vitest";
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
  cancelQueuedJobs,
  claimOne,
  complete,
  heartbeat,
  postEvents,
  sha256,
  startInvestigation,
  toolCallBody,
  transition,
  uploadArtifact,
} from "./helpers/flow.js";

describeDb("job lifecycle", () => {
  let h: Harness;
  let owner: Account;
  let viewer: Account;
  let p: string;
  let runner: RunnerHandle;
  const jobsPath = (jobId: string) => `/api/v1/projects/${p}/jobs/${jobId}`;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.register("lifecycle@example.com");
    viewer = await h.register("lifecycle-viewer@example.com");
    p = owner.defaultProjectId as string;
    await h.api("POST", `/api/v1/projects/${p}/members`, {
      auth: owner.auth,
      body: { email: viewer.email, role: "viewer" },
    });
    runner = await createRunner(h, owner, p, "lifecycle-runner");
    await registerRunner(h, runner, reportFor("lifecycle-runner"));
  });
  afterAll(async () => {
    await h.close();
  });

  const running = async (name: string) => {
    const setup = await startInvestigation(h, owner, p, {
      name,
      runnerId: runner.id,
    });
    const claimed = await claimOne(h, runner);
    expect(claimed.jobId).toBe(setup.jobId);
    expect(
      (await transition(h, runner, setup.jobId, claimed.token, "running"))
        .status,
    ).toBe(200);
    return { ...setup, token: claimed.token };
  };

  it("cancels a queued job immediately", async () => {
    const setup = await startInvestigation(h, owner, p, {
      name: "queued-cancel.asar",
      runnerId: runner.id,
    });
    const response = await h.api("POST", `${jobsPath(setup.jobId)}/cancel`, {
      auth: owner.auth,
    });
    expect(response.status).toBe(200);
    expect(response.json.state).toBe("cancelled");
    const view = await h.api(
      "GET",
      `/api/v1/projects/${p}/investigations/${setup.investigationId}`,
      {
        auth: owner.auth,
      },
    );
    expect(view.json.status).toBe("cancelled");
    const again = await h.api("POST", `${jobsPath(setup.jobId)}/cancel`, {
      auth: owner.auth,
    });
    expect(again.json.state).toBe("cancelled");
  });

  it("delivers cancel_requested through the heartbeat and lets the runner finish as cancelled", async () => {
    const job = await running("cancel-running.asar");
    const cancel = await h.api("POST", `${jobsPath(job.jobId)}/cancel`, {
      auth: owner.auth,
    });
    expect(cancel.json.state).toBe("running");
    expect(cancel.json.cancel_requested_at).not.toBeNull();
    const beat = await heartbeat(h, runner, [
      { job_id: job.jobId, fencing_token: job.token },
    ]);
    expect(beat.json.leases[0]).toMatchObject({
      accepted: true,
      cancel_requested: true,
    });
    const done = await complete(h, runner, job.jobId, job.token, "cancelled");
    expect(done.json.state).toBe("cancelled");
    const view = await h.api(
      "GET",
      `/api/v1/projects/${p}/investigations/${job.investigationId}`,
      {
        auth: owner.auth,
      },
    );
    expect(view.json.status).toBe("cancelled");
  });

  it("records approval decisions and delivers each exactly once in heartbeats", async () => {
    const job = await running("approve.asar");
    const approval = {
      approval_id: "appr-1",
      tool: "launch_application",
      arguments: { path: "/tmp/x" },
      effects: ["executesForeignCode"],
      reason: "runs foreign code",
    };
    const waiting = await transition(
      h,
      runner,
      job.jobId,
      job.token,
      "awaiting_approval",
      approval,
    );
    expect(waiting.status).toBe(200);
    expect(waiting.json.state).toBe("awaiting_approval");
    const duplicate = await transition(
      h,
      runner,
      job.jobId,
      job.token,
      "awaiting_approval",
      approval,
    );
    expect(duplicate.status).toBe(409);
    const missingBody = await transition(
      h,
      runner,
      job.jobId,
      job.token,
      "awaiting_approval",
    );
    expect(missingBody.status).toBe(400);

    const pending = await h.api("GET", `${jobsPath(job.jobId)}/approvals`, {
      auth: viewer.auth,
    });
    expect(pending.json.items).toEqual([
      expect.objectContaining({
        approval_id: "appr-1",
        tool: "launch_application",
        job_id: job.jobId,
      }),
    ]);

    // not resumable while undecided
    const early = await transition(h, runner, job.jobId, job.token, "running");
    expect(early.status).toBe(409);

    const viewerApprove = await h.api(
      "POST",
      `${jobsPath(job.jobId)}/approve`,
      {
        auth: viewer.auth,
        body: { approval_id: "appr-1" },
      },
    );
    expect(viewerApprove.status).toBe(403);
    const unknown = await h.api("POST", `${jobsPath(job.jobId)}/approve`, {
      auth: owner.auth,
      body: { approval_id: "nope" },
    });
    expect(unknown.status).toBe(404);

    const approve = await h.api("POST", `${jobsPath(job.jobId)}/approve`, {
      auth: owner.auth,
      body: { approval_id: "appr-1" },
    });
    expect(approve.status).toBe(200);
    expect(approve.json.state).toBe("awaiting_approval");
    expect(approve.json.cancel_requested_at).toBeNull();
    const twice = await h.api("POST", `${jobsPath(job.jobId)}/reject`, {
      auth: owner.auth,
      body: { approval_id: "appr-1" },
    });
    expect(twice.status).toBe(409);

    const first = await heartbeat(h, runner, [
      { job_id: job.jobId, fencing_token: job.token },
    ]);
    expect(first.json.leases[0].approvals).toEqual([
      expect.objectContaining({
        approval_id: "appr-1",
        decision: "approved",
        decided_by: owner.userId,
      }),
    ]);
    const second = await heartbeat(h, runner, [
      { job_id: job.jobId, fencing_token: job.token },
    ]);
    expect(second.json.leases[0].approvals).toEqual([]);
    const events = (await h.repos.jobEvents.listAfter(job.jobId, 0)).map(
      (e) => e.kind,
    );
    expect(events).toContain("job.approval_requested");
    expect(events).toContain("job.approval_decided");

    expect(
      (await transition(h, runner, job.jobId, job.token, "running")).json.state,
    ).toBe("running");
    expect(
      (await complete(h, runner, job.jobId, job.token, "succeeded")).status,
    ).toBe(200);
  });

  it("turns a rejection into a cancellation the runner sees on its next heartbeat", async () => {
    const job = await running("reject.asar");
    await transition(h, runner, job.jobId, job.token, "awaiting_approval", {
      approval_id: "appr-2",
      tool: "launch_application",
      arguments: {},
      effects: ["executesForeignCode"],
      reason: "r",
    });
    const reject = await h.api("POST", `${jobsPath(job.jobId)}/reject`, {
      auth: owner.auth,
      body: { approval_id: "appr-2" },
    });
    expect(reject.status).toBe(200);
    expect(reject.json.cancel_requested_at).not.toBeNull();
    const beat = await heartbeat(h, runner, [
      { job_id: job.jobId, fencing_token: job.token },
    ]);
    expect(beat.json.leases[0]).toMatchObject({ cancel_requested: true });
    expect(beat.json.leases[0].approvals[0]).toMatchObject({
      approval_id: "appr-2",
      decision: "rejected",
    });
    const done = await complete(h, runner, job.jobId, job.token, "cancelled");
    expect(done.json.state).toBe("cancelled");
  });

  it("restricts runner events to non-lifecycle kinds", async () => {
    const job = await running("kinds.asar");
    for (const kind of [
      "job.completed",
      "job.transition",
      "job.claimed",
      "job.approval_decided",
      "job.stale_rejected",
    ]) {
      const response = await postEvents(h, runner, job.jobId, job.token, [
        { kind },
      ]);
      expect(response.status, kind).toBe(400);
    }
    const unknownKind = await postEvents(h, runner, job.jobId, job.token, [
      { kind: "job.nonsense" },
    ]);
    expect(unknownKind.status).toBe(400);
    const ok = await postEvents(h, runner, job.jobId, job.token, [
      { kind: "job.cleanup", payload: { status: "cleanup_complete" } },
    ]);
    expect(ok.status).toBe(200);
    await complete(h, runner, job.jobId, job.token, "failed", null, {
      code: "x",
      message: "x",
      retryable: false,
    });
  });

  it("keeps tool-call object keys inside the investigation's storage prefix", async () => {
    const job = await running("keys.asar");
    const raw = Buffer.from("{}");
    const upload = await uploadArtifact(
      h,
      runner,
      job.jobId,
      job.token,
      "raw_result",
      "1.json",
      raw,
    );
    expect(upload.status).toBe(201);
    const escape = await h.api("POST", `/api/v1/jobs/${job.jobId}/tool-calls`, {
      auth: runner.auth,
      body: toolCallBody(job.token, job.investigationId, 1, {
        object_key: `projects/${p}/targets/${job.targetId}/payload`,
        sha256: sha256(raw),
        size: raw.length,
      }),
    });
    expect(escape.status).toBe(403);
    const wrongInvestigation = await h.api(
      "POST",
      `/api/v1/jobs/${job.jobId}/tool-calls`,
      {
        auth: runner.auth,
        body: toolCallBody(
          job.token,
          "0190b0a0-0000-7000-8000-000000000001",
          1,
          upload.json,
        ),
      },
    );
    expect(wrongInvestigation.status).toBe(403);
    const badKind = await uploadArtifact(
      h,
      runner,
      job.jobId,
      job.token,
      "capture_manifest",
      "m.json",
      raw,
    );
    expect(badKind.status).toBe(400);
    await complete(h, runner, job.jobId, job.token, "succeeded");
  });

  it("enforces the artifact_bytes budget server-side", async () => {
    const setup = await startInvestigation(h, owner, p, {
      name: "budget.asar",
      runnerId: runner.id,
      policy: { budget: { artifact_bytes: 64 } },
    });
    const claimed = await claimOne(h, runner);
    expect(claimed.jobId).toBe(setup.jobId);
    await transition(h, runner, setup.jobId, claimed.token, "running");
    const small = await uploadArtifact(
      h,
      runner,
      setup.jobId,
      claimed.token,
      "ledger",
      "l.json",
      Buffer.alloc(40, 1),
    );
    expect(small.status).toBe(201);
    const big = await uploadArtifact(
      h,
      runner,
      setup.jobId,
      claimed.token,
      "ledger",
      "l2.json",
      Buffer.alloc(40, 1),
    );
    expect(big.status).toBe(422);
    expect(big.json.error.code).toBe("budget_exceeded");
    expect(big.json.error.details.dimension).toBe("artifact_bytes");
    const stored = await h.store.list(
      `projects/${p}/investigations/${setup.investigationId}/evidence/`,
    );
    expect(stored.keys).toHaveLength(1);
    await complete(h, runner, setup.jobId, claimed.token, "succeeded");
  });

  it("filters and pages the job list and rejects bad filters", async () => {
    const all = await h.api("GET", `/api/v1/projects/${p}/jobs`, {
      auth: owner.auth,
      query: { limit: "2" },
    });
    expect(all.json.items).toHaveLength(2);
    expect(all.json.next_cursor).not.toBeNull();
    const next = await h.api("GET", `/api/v1/projects/${p}/jobs`, {
      auth: owner.auth,
      query: { limit: "2", cursor: all.json.next_cursor },
    });
    expect(next.json.items[0].id).not.toBe(all.json.items[0].id);
    const cancelled = await h.api("GET", `/api/v1/projects/${p}/jobs`, {
      auth: owner.auth,
      query: { state: "cancelled", kind: "investigation.run" },
    });
    expect(cancelled.json.items.length).toBeGreaterThan(0);
    expect(
      cancelled.json.items.every(
        (j: { state: string }) => j.state === "cancelled",
      ),
    ).toBe(true);
    expect(
      (
        await h.api("GET", `/api/v1/projects/${p}/jobs`, {
          auth: owner.auth,
          query: { state: "bogus" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.api("GET", `/api/v1/projects/${p}/jobs`, {
          auth: owner.auth,
          query: { cursor: "garbage" },
        })
      ).status,
    ).toBe(400);
  });
});

describeDb("follow-ups, comparisons and exports", () => {
  let h: Harness;
  let owner: Account;
  let p: string;
  let runner: RunnerHandle;
  beforeAll(async () => {
    h = await createHarness();
    owner = await h.register("followups@example.com");
    p = owner.defaultProjectId as string;
    runner = await createRunner(h, owner, p, "follow-runner");
    await registerRunner(h, runner, reportFor("follow-runner"));
  });
  afterAll(async () => {
    await h.close();
  });

  it("routes a follow-up to the owning runner while its session is live", async () => {
    const setup = await startInvestigation(h, owner, p, {
      runnerId: runner.id,
    });
    const url = `/api/v1/projects/${p}/investigations/${setup.investigationId}/follow-ups`;
    const queuedRun = await h.api("POST", url, {
      auth: owner.auth,
      body: { tool: "binary_session", arguments: {} },
    });
    expect(queuedRun.status).toBe(409);
    expect(queuedRun.json.error).toMatchObject({
      code: "capability_unavailable",
      details: { reason: "session_not_started" },
    });

    const claimed = await claimOne(h, runner);
    await transition(h, runner, setup.jobId, claimed.token, "running");

    const ok = await h.api("POST", url, {
      auth: owner.auth,
      body: { tool: "binary_session", arguments: { action: "status" } },
      headers: { "idempotency-key": "follow-1" },
    });
    expect(ok.status).toBe(202);
    expect(ok.json).toMatchObject({
      kind: "investigation.follow_up",
      state: "queued",
    });
    const replay = await h.api("POST", url, {
      auth: owner.auth,
      body: { tool: "binary_session", arguments: { action: "status" } },
      headers: { "idempotency-key": "follow-1" },
    });
    expect(replay.json.id).toBe(ok.json.id);
    const job = await h.repos.jobs.findById(ok.json.id);
    expect(job).toMatchObject({ preferred_runner_id: runner.id });
    expect(job?.input).toMatchObject({
      investigation_id: setup.investigationId,
      tool: "binary_session",
      arguments: { action: "status" },
    });

    const unknown = await h.api("POST", url, {
      auth: owner.auth,
      body: { tool: "not_a_real_tool", arguments: {} },
    });
    expect(unknown.status).toBe(409);
    expect(unknown.json.error.details.reason).toBe("tool_not_advertised");
    const unavailable = await h.api("POST", url, {
      auth: owner.auth,
      body: { tool: "inspect_android_package", arguments: {} },
    });
    expect(unavailable.status).toBe(409);
    expect(unavailable.json.error.details).toMatchObject({
      reason: "tool_unavailable",
    });
    expect(unavailable.json.error.details.unmet[0].remediation).toContain(
      "REA_JADX_MCP_JAR",
    );

    // the follow-up is claimable by the owner and the run job completes afterwards
    const followClaim = await claimOne(h, runner);
    expect(followClaim.jobId).toBe(ok.json.id);
    await transition(h, runner, ok.json.id, followClaim.token, "running");
    await complete(h, runner, ok.json.id, followClaim.token, "succeeded");

    // The runner keeps the session after the run succeeds, so follow-ups are
    // still routed to it; only the runner knows whether the session is live.
    await complete(h, runner, setup.jobId, claimed.token, "succeeded");
    const afterSuccess = await h.api("POST", url, {
      auth: owner.auth,
      body: { tool: "binary_session", arguments: {} },
    });
    expect(afterSuccess.status).toBe(202);
    expect(
      (await h.repos.jobs.findById(afterSuccess.json.id))?.preferred_runner_id,
    ).toBe(runner.id);
    await cancelQueuedJobs(h, owner, p);

    // A failed run's session was closed by its runner.
    const failedRun = await startInvestigation(h, owner, p, {
      runnerId: runner.id,
    });
    const failedClaim = await claimOne(h, runner);
    expect(failedClaim.jobId).toBe(failedRun.jobId);
    await transition(h, runner, failedRun.jobId, failedClaim.token, "running");
    await complete(
      h,
      runner,
      failedRun.jobId,
      failedClaim.token,
      "failed",
      null,
    );
    const closed = await h.api(
      "POST",
      `/api/v1/projects/${p}/investigations/${failedRun.investigationId}/follow-ups`,
      { auth: owner.auth, body: { tool: "binary_session", arguments: {} } },
    );
    expect(closed.status).toBe(409);
    expect(closed.json.error.details).toMatchObject({
      reason: "session_closed",
      job_state: "failed",
    });
  });

  it("creates export and comparison jobs after checking project ownership of every reference", async () => {
    const setup = await startInvestigation(h, owner, p, {
      name: "export.asar",
    });
    const exp = await h.api(
      "POST",
      `/api/v1/projects/${p}/investigations/${setup.investigationId}/exports`,
      {
        auth: owner.auth,
      },
    );
    expect(exp.status).toBe(202);
    expect(exp.json.kind).toBe("investigation.export");
    const exportJob = await h.repos.jobs.findById(exp.json.id);
    expect(exportJob?.input).toEqual({
      investigation_id: setup.investigationId,
    });

    const compare = await h.api("POST", `/api/v1/projects/${p}/comparisons`, {
      auth: owner.auth,
      body: {
        tool: "compare_artifacts",
        left: {
          kind: "retained-evidence",
          evidence_id: "ev-a",
          investigation_id: setup.investigationId,
        },
        right: {
          kind: "retained-evidence",
          evidence_id: "ev-b",
          investigation_id: setup.investigationId,
        },
        runner_id: runner.id,
      },
    });
    expect(compare.status).toBe(202);
    expect(compare.json.kind).toBe("investigation.compare");
    const compareJob = await h.repos.jobs.findById(compare.json.id);
    expect(compareJob?.requirements.tools).toEqual(["compare_artifacts"]);
    expect(compareJob?.preferred_runner_id).toBe(runner.id);

    const stranger = await h.register("follow-stranger@example.com");
    const strangerProject = (
      await h.api("POST", "/api/v1/projects", {
        auth: stranger.auth,
        body: { slug: "stranger", name: "S" },
      })
    ).json.id as string;
    const foreign = await h.api(
      "POST",
      `/api/v1/projects/${strangerProject}/comparisons`,
      {
        auth: stranger.auth,
        body: {
          tool: "compare_artifacts",
          left: {
            kind: "retained-evidence",
            evidence_id: "x",
            investigation_id: setup.investigationId,
          },
          right: {
            kind: "artifact",
            artifact_id: "0190b0a0-0000-7000-8000-000000000002",
          },
        },
      },
    );
    expect(foreign.status).toBe(404);
    const badTool = await h.api("POST", `/api/v1/projects/${p}/comparisons`, {
      auth: owner.auth,
      body: {
        tool: "rm_rf",
        left: {
          kind: "artifact",
          artifact_id: "0190b0a0-0000-7000-8000-000000000002",
        },
        right: {
          kind: "artifact",
          artifact_id: "0190b0a0-0000-7000-8000-000000000003",
        },
      },
    });
    expect(badTool.status).toBe(400);
  });

  it("interrupts and requeues the leases of a revoked runner", async () => {
    const victim = await createRunner(h, owner, p, "victim");
    await registerRunner(h, victim, reportFor("victim"));
    // Earlier tests leave unpinned jobs queued and claims are FIFO, so clear
    // the queue to make the victim's first claim the job under test.
    await cancelQueuedJobs(h, owner, p);
    const setup = await startInvestigation(h, owner, p, {
      name: "revoke.asar",
      runnerId: victim.id,
    });
    const claimed = await claimOne(h, victim);
    expect(claimed.jobId).toBe(setup.jobId);
    await transition(h, victim, setup.jobId, claimed.token, "running");
    const revoke = await h.api(
      "DELETE",
      `/api/v1/projects/${p}/runners/${victim.id}`,
      { auth: owner.auth },
    );
    expect(revoke.status).toBe(200);
    const job = await h.repos.jobs.findById(setup.jobId);
    // attempt starts at 1 and the interrupted -> queued retry increments it,
    // exactly as the reaper does (SS00 section 6).
    expect(job).toMatchObject({ state: "queued", attempt: 2, lease: null });
    const stale = await postEvents(h, victim, setup.jobId, claimed.token, [
      { kind: "job.log" },
    ]);
    expect(stale.status).toBe(401);
    const kinds = (await h.repos.jobEvents.listAfter(setup.jobId, 0)).map(
      (e) => e.payload["reason"],
    );
    expect(kinds).toContain("runner_revoked");
  });
});
