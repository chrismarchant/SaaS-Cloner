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
  claim,
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

describeDb("runner protocol end to end", () => {
  let h: Harness;
  let owner: Account;
  let p: string;
  let runner: RunnerHandle;
  beforeAll(async () => {
    h = await createHarness();
    owner = await h.register("proto@example.com");
    p = owner.defaultProjectId as string;
    runner = await createRunner(h, owner, p, "proto-runner");
  });
  afterAll(async () => {
    await h.close();
  });

  it("registers a capability report and returns protocol parameters", async () => {
    const response = await h.api("POST", "/api/v1/runners/register", {
      auth: runner.auth,
      body: reportFor("proto-runner"),
    });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      runner_id: runner.id,
      protocol_version: 1,
      lease_ttl_ms: h.config.leaseTtlMs,
    });
    expect(response.json.heartbeat_interval_ms).toBeLessThan(
      h.config.leaseTtlMs,
    );
    const stored = await h.repos.runners.findById(p, runner.id);
    expect(stored?.status).toBe("online");
    expect(stored?.capability_report).toMatchObject({
      runner_name: "proto-runner",
    });
    expect(stored?.capability_digest).toMatchObject({
      os: "linux",
      providers_available: expect.arrayContaining(["rea-dotnet-static"]),
    });
    const invalid = await h.api("POST", "/api/v1/runners/register", {
      auth: runner.auth,
      body: { protocol_version: 1 },
    });
    expect(invalid.status).toBe(400);
  });

  it("answers an empty claim with 204", async () => {
    const response = await claim(h, runner, 0);
    expect(response.status).toBe(204);
    expect(response.raw).toBe("");
  });

  it("runs a job from creation through claim, heartbeat, events, tool call, artifacts to completion", async () => {
    const setup = await startInvestigation(h, owner, p);
    expect(setup.response.json).toMatchObject({
      status: "pending",
      job_state: "queued",
      tool_call_count: 0,
    });
    expect(setup.response.json.routing.class).toBe("asar");
    const job = await h.repos.jobs.findById(setup.jobId);
    expect(job?.kind).toBe("investigation.run");
    expect(job?.requirements.tools).toEqual([
      "analyze_javascript_application",
      "binary_session",
    ]);
    expect(job?.input).toMatchObject({
      investigation_id: setup.investigationId,
      target_id: setup.targetId,
      target: { kind: "upload", class: "asar", name: "app.asar" },
      question: "what does it do?",
    });
    expect(JSON.stringify(job?.input)).not.toContain("object_key");

    // claim
    const claimed = await claim(h, runner, 0);
    expect(claimed.status).toBe(200);
    expect(claimed.json.job.id).toBe(setup.jobId);
    expect(claimed.json.job.state).toBe("preparing");
    expect(claimed.json.fencing_token).toBe(1);
    expect(new Date(claimed.json.lease_expires_at).getTime()).toBeGreaterThan(
      Date.now(),
    );
    const token = 1;

    // heartbeat
    const beat = await heartbeat(h, runner, [
      { job_id: setup.jobId, fencing_token: token },
    ]);
    expect(beat.status).toBe(200);
    expect(beat.json.leases[0]).toMatchObject({
      job_id: setup.jobId,
      accepted: true,
      cancel_requested: false,
      approvals: [],
    });

    // target input
    const input = await h.api(
      "GET",
      `/api/v1/jobs/${setup.jobId}/inputs/target`,
      {
        auth: runner.auth,
        headers: { "x-fencing-token": String(token) },
      },
    );
    expect(input.status).toBe(200);
    expect(input.raw).toBe("asar-bytes-for-test");
    expect(input.headers["x-content-sha256"]).toBe(
      sha256("asar-bytes-for-test"),
    );
    const noToken = await h.api(
      "GET",
      `/api/v1/jobs/${setup.jobId}/inputs/target`,
      {
        auth: runner.auth,
      },
    );
    expect(noToken.status).toBe(400);
    const wrongToken = await h.api(
      "GET",
      `/api/v1/jobs/${setup.jobId}/inputs/target`,
      {
        auth: runner.auth,
        headers: { "x-fencing-token": "7" },
      },
    );
    expect(wrongToken.status).toBe(409);
    const unknownInput = await h.api(
      "GET",
      `/api/v1/jobs/${setup.jobId}/inputs/secrets`,
      {
        auth: runner.auth,
        headers: { "x-fencing-token": String(token) },
      },
    );
    expect(unknownInput.status).toBe(404);

    // running
    const running = await transition(h, runner, setup.jobId, token, "running");
    expect(running.status).toBe(200);
    expect(running.json.state).toBe("running");

    // events: contiguous seqs
    const before = await h.repos.jobEvents.listAfter(setup.jobId, 0);
    const lastSeq = before[before.length - 1]?.seq as number;
    const posted = await postEvents(h, runner, setup.jobId, token, [
      { kind: "job.progress", payload: { step: "discovery" } },
      { kind: "job.log", payload: { line: "hello" } },
      { kind: "job.budget", payload: { tool_calls: 1 } },
    ]);
    expect(posted.status).toBe(200);
    expect(posted.json.seqs).toEqual([lastSeq + 1, lastSeq + 2, lastSeq + 3]);
    const all = await h.repos.jobEvents.listAfter(setup.jobId, 0);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    // The wrong-token input read above is recorded as a rejection, nothing else.
    expect(all.filter((e) => e.kind === "job.stale_rejected")).toHaveLength(1);
    expect(
      all
        .map((e) => e.kind)
        .filter((kind) => kind !== "job.stale_rejected")
        .slice(0, 4),
    ).toEqual(["job.created", "job.claimed", "job.transition", "job.progress"]);

    // raw result upload then tool call
    const raw = Buffer.from(
      JSON.stringify({ content: [{ type: "text", text: "files: 3" }] }),
    );
    const rawUpload = await uploadArtifact(
      h,
      runner,
      setup.jobId,
      token,
      "raw_result",
      "1.json",
      raw,
    );
    expect(rawUpload.status).toBe(201);
    expect(rawUpload.json).toEqual({
      object_key: expect.stringMatching(
        new RegExp(
          `^projects/${p}/investigations/${setup.investigationId}/raw/[0-9a-f-]{36}\\.json$`,
        ),
      ),
      sha256: sha256(raw),
      size: raw.length,
      artifact_id: null,
    });
    const recorded = await h.api(
      "POST",
      `/api/v1/jobs/${setup.jobId}/tool-calls`,
      {
        auth: runner.auth,
        body: toolCallBody(token, setup.investigationId, 1, rawUpload.json),
      },
    );
    expect(recorded.status).toBe(201);
    expect(recorded.json).toMatchObject({
      seq: 1,
      upstream_seq: 1,
      tool_name: "analyze_javascript_application",
      raw_result_sha256: sha256(raw),
    });
    const replayed = await h.api(
      "POST",
      `/api/v1/jobs/${setup.jobId}/tool-calls`,
      {
        auth: runner.auth,
        body: toolCallBody(token, setup.investigationId, 1, rawUpload.json),
      },
    );
    expect(replayed.status).toBe(201);
    expect(replayed.json.id).toBe(recorded.json.id);

    const calls = await h.api(
      "GET",
      `/api/v1/projects/${p}/investigations/${setup.investigationId}/tool-calls`,
      { auth: owner.auth },
    );
    expect(calls.json.items).toHaveLength(1);
    expect(calls.json.next_cursor).toBeNull();
    const rawDownload = await h.api(
      "GET",
      `/api/v1/projects/${p}/investigations/${setup.investigationId}/tool-calls/${recorded.json.id}/raw`,
      { auth: owner.auth },
    );
    expect(rawDownload.status).toBe(200);
    expect(rawDownload.raw).toBe(raw.toString());

    // evidence artifact
    const bundle = Buffer.from('{"bundle":true}');
    const bundleUpload = await uploadArtifact(
      h,
      runner,
      setup.jobId,
      token,
      "bundle",
      "bundle.json",
      bundle,
    );
    expect(bundleUpload.status).toBe(201);
    expect(bundleUpload.json.artifact_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(bundleUpload.json.object_key).toBe(
      `projects/${p}/investigations/${setup.investigationId}/evidence/${bundleUpload.json.artifact_id}.json`,
    );
    const evidence = await h.api(
      "GET",
      `/api/v1/projects/${p}/investigations/${setup.investigationId}/evidence`,
      { auth: owner.auth },
    );
    expect(evidence.json.items).toHaveLength(1);
    expect(evidence.json.items[0]).toMatchObject({
      kind: "bundle",
      sha256: sha256(bundle),
    });
    const download = await h.api(
      "GET",
      `/api/v1/projects/${p}/investigations/${setup.investigationId}/evidence/${bundleUpload.json.artifact_id}`,
      { auth: owner.auth },
    );
    expect(download.raw).toBe(bundle.toString());
    expect(String(download.headers["content-disposition"])).toContain(
      "bundle.json",
    );

    // findings
    const findings = await h.api(
      "POST",
      `/api/v1/jobs/${setup.jobId}/findings`,
      {
        auth: runner.auth,
        body: {
          fencing_token: token,
          investigation_id: setup.investigationId,
          findings: [
            {
              class: "fact",
              title: "Electron app",
              body: "Uses electron 30",
              evidence_ids: ["ev-1"],
              tool_call_seqs: [1],
              limitations: [],
              source: "upstream",
            },
            {
              class: "unknown",
              title: "Auth flow",
              body: "Not observed",
              evidence_ids: [],
              tool_call_seqs: [],
              limitations: ["static only"],
              source: "policy",
            },
          ],
        },
      },
    );
    expect(findings.status).toBe(201);
    expect(findings.json).toEqual({ count: 2 });

    // complete
    const done = await complete(h, runner, setup.jobId, token, "succeeded", {
      summary: "done",
      upstream_identity: { package_version: "6.4.0" },
    });
    expect(done.status).toBe(200);
    expect(done.json.state).toBe("succeeded");
    expect(done.json.lease).toBeNull();

    const view = await h.api(
      "GET",
      `/api/v1/projects/${p}/investigations/${setup.investigationId}`,
      {
        auth: owner.auth,
      },
    );
    expect(view.json).toMatchObject({
      status: "completed",
      job_state: "succeeded",
      tool_call_count: 1,
      finding_counts: { fact: 1, unknown: 1 },
      upstream_identity: { package_version: "6.4.0" },
    });
    const grouped = await h.api(
      "GET",
      `/api/v1/projects/${p}/investigations/${setup.investigationId}/findings`,
      { auth: owner.auth },
    );
    expect(grouped.json.items).toHaveLength(2);
    const finalEvents = await h.repos.jobEvents.listAfter(setup.jobId, 0);
    expect(finalEvents.map((e) => e.seq)).toEqual(
      finalEvents.map((_, i) => i + 1),
    );
    expect(finalEvents.map((e) => e.kind).slice(-2)).toEqual([
      "job.cleanup",
      "job.completed",
    ]);

    // everything fenced is rejected after completion
    const late = await postEvents(h, runner, setup.jobId, token, [
      { kind: "job.log" },
    ]);
    expect(late.status).toBe(409);
    expect(late.json.error.code).toBe("stale_lease");
    const lateComplete = await complete(
      h,
      runner,
      setup.jobId,
      token,
      "succeeded",
    );
    expect(lateComplete.status).toBe(409);
  });

  it("rejects a stale token on complete and leaves the job unchanged", async () => {
    const setup = await startInvestigation(h, owner, p, { name: "stale.asar" });
    const claimed = await claimOne(h, runner);
    expect(claimed.jobId).toBe(setup.jobId);
    await transition(h, runner, setup.jobId, claimed.token, "running");

    const stale = await complete(
      h,
      runner,
      setup.jobId,
      claimed.token + 5,
      "succeeded",
    );
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("stale_lease");
    const job = await h.repos.jobs.findById(setup.jobId);
    expect(job?.state).toBe("running");
    expect(job?.result).toBeNull();
    expect(job?.lease?.fencing_token).toBe(claimed.token);
    const events = await h.repos.jobEvents.listAfter(setup.jobId, 0);
    expect(events.some((e) => e.kind === "job.stale_rejected")).toBe(true);

    const staleArtifact = await uploadArtifact(
      h,
      runner,
      setup.jobId,
      claimed.token + 1,
      "bundle",
      "b.json",
      Buffer.from("{}"),
    );
    expect(staleArtifact.status).toBe(409);
    const staleTransition = await transition(
      h,
      runner,
      setup.jobId,
      claimed.token + 1,
      "running",
    );
    expect(staleTransition.status).toBe(409);
    expect(
      (
        await h.store.list(
          `projects/${p}/investigations/${setup.investigationId}/`,
        )
      ).keys,
    ).toHaveLength(0);

    const ok = await complete(
      h,
      runner,
      setup.jobId,
      claimed.token,
      "failed",
      null,
      {
        code: "boom",
        message: "it failed",
        retryable: false,
      },
    );
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      state: "failed",
      failure: { code: "boom" },
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

  it("refuses to let a second runner act on a job leased to the first", async () => {
    const second = await createRunner(h, owner, p, "second-runner");
    await registerRunner(h, second, reportFor("second-runner"));
    const setup = await startInvestigation(h, owner, p, {
      name: "contested.asar",
    });
    const claimed = await claimOne(h, runner);
    expect(claimed.jobId).toBe(setup.jobId);

    const stolen = await complete(
      h,
      second,
      setup.jobId,
      claimed.token,
      "succeeded",
    );
    expect(stolen.status).toBe(403);
    const events = await postEvents(h, second, setup.jobId, claimed.token, [
      { kind: "job.log" },
    ]);
    expect(events.status).toBe(403);
    const upload = await uploadArtifact(
      h,
      second,
      setup.jobId,
      claimed.token,
      "bundle",
      "b.json",
      Buffer.from("{}"),
    );
    expect(upload.status).toBe(403);
    const input = await h.api(
      "GET",
      `/api/v1/jobs/${setup.jobId}/inputs/target`,
      {
        auth: second.auth,
        headers: { "x-fencing-token": String(claimed.token) },
      },
    );
    expect(input.status).toBe(403);
    const hijackBeat = await heartbeat(h, second, [
      { job_id: setup.jobId, fencing_token: claimed.token },
    ]);
    expect(hijackBeat.status).toBe(200);
    expect(hijackBeat.json.leases[0]).toMatchObject({
      accepted: false,
      reason: "stale_lease",
    });
    const job = await h.repos.jobs.findById(setup.jobId);
    expect(job?.state).toBe("preparing");
    expect(job?.lease?.runner_id).toBe(runner.id);

    // the rightful runner still can
    const rightful = await complete(
      h,
      runner,
      setup.jobId,
      claimed.token,
      "failed",
      null,
      {
        code: "x",
        message: "x",
        retryable: false,
      },
    );
    expect(rightful.status).toBe(200);
    expect(rightful.json.state).toBe("failed");
  });
});
