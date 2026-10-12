import { afterAll, beforeAll, expect, it } from "vitest";
import { investigationIndexSchema } from "@rea-web/contracts";
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
  sha256,
  startInvestigation,
  toolCallBody,
  transition,
  uploadArtifact,
} from "./helpers/flow.js";

describeDb("investigation inputs for compare and export jobs", () => {
  let h: Harness;
  let owner: Account;
  let stranger: Account;
  let p: string;
  let runner: RunnerHandle;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.register("inputs-owner@example.com");
    stranger = await h.register("inputs-stranger@example.com");
    p = owner.defaultProjectId as string;
    runner = await createRunner(h, owner, p, "inputs-runner");
    await registerRunner(h, runner, reportFor("inputs-runner"));
  });
  afterAll(async () => {
    await h.close();
  });

  const inputs = (
    jobId: string,
    token: number,
    name: string,
    auth = runner.auth,
  ) =>
    h.api("GET", `/api/v1/jobs/${jobId}/inputs/${name}`, {
      auth,
      headers: { "x-fencing-token": String(token) },
    });

  /** A finished investigation with one raw result, one bundle and two findings. */
  const finishedInvestigation = async (name: string) => {
    await cancelQueuedJobs(h, owner, p);
    const setup = await startInvestigation(h, owner, p, {
      name,
      runnerId: runner.id,
    });
    const claimed = await claimOne(h, runner);
    const token = claimed.token;
    await transition(h, runner, setup.jobId, token, "running");
    const raw = Buffer.from(
      JSON.stringify({ content: [{ type: "text", text: name }] }),
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
    const args = Buffer.from(JSON.stringify({ path: "/app" }));
    const argsKey = `projects/${p}/investigations/${setup.investigationId}/arguments/1.json`;
    await h.store.put(argsKey, args);
    const recorded = await h.api(
      "POST",
      `/api/v1/jobs/${setup.jobId}/tool-calls`,
      {
        auth: runner.auth,
        body: toolCallBody(token, setup.investigationId, 1, rawUpload.json, {
          arguments_object_key: argsKey,
        }),
      },
    );
    expect(recorded.status).toBe(201);
    const noRaw = await h.api(
      "POST",
      `/api/v1/jobs/${setup.jobId}/tool-calls`,
      {
        auth: runner.auth,
        body: toolCallBody(
          token,
          setup.investigationId,
          2,
          {
            object_key: `projects/${p}/investigations/${setup.investigationId}/raw/missing-2.json`,
            sha256: sha256("x"),
            size: 1,
          },
          { evidence_id: "ev-2" },
        ),
      },
    );
    expect(noRaw.status).toBe(201);
    const bundle = await uploadArtifact(
      h,
      runner,
      setup.jobId,
      token,
      "bundle",
      "bundle.json",
      Buffer.from("{}"),
    );
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
              title: "first",
              body: "b1",
              evidence_ids: [],
              tool_call_seqs: [1],
              limitations: [],
              source: "upstream",
            },
            {
              class: "unknown",
              title: "second",
              body: "b2",
              evidence_ids: [],
              tool_call_seqs: [],
              limitations: [],
              source: "policy",
            },
          ],
        },
      },
    );
    expect(findings.status).toBe(201);
    expect(
      (await complete(h, runner, setup.jobId, token, "succeeded")).status,
    ).toBe(200);
    return { ...setup, raw, artifactId: bundle.json.artifact_id as string };
  };

  const startJob = async (path: string, body?: unknown) => {
    await cancelQueuedJobs(h, owner, p);
    const created = await h.api("POST", `/api/v1/projects/${p}/${path}`, {
      auth: owner.auth,
      ...(body === undefined ? {} : { body }),
    });
    expect(created.status).toBe(202);
    const claimed = await claimOne(h, runner);
    expect(claimed.jobId).toBe(created.json.id);
    return { jobId: created.json.id as string, token: claimed.token };
  };

  /** Frees the runner's concurrency slot once a test is done with a leased job. */
  const finish = async (job: { jobId: string; token: number }) => {
    await transition(h, runner, job.jobId, job.token, "running");
    expect(
      (await complete(h, runner, job.jobId, job.token, "succeeded")).status,
    ).toBe(200);
  };

  it("anchors compare jobs to the left investigation so the runner can record results", async () => {
    const a = await finishedInvestigation("left.asar");
    const b = await finishedInvestigation("right.asar");
    await cancelQueuedJobs(h, owner, p);
    const created = await h.api("POST", `/api/v1/projects/${p}/comparisons`, {
      auth: owner.auth,
      body: {
        tool: "compare_artifacts",
        left: { kind: "artifact", artifact_id: a.artifactId },
        right: {
          kind: "retained-evidence",
          evidence_id: "ev-1",
          investigation_id: b.investigationId,
        },
        runner_id: runner.id,
      },
    });
    expect(created.status).toBe(202);
    const stored = await h.repos.jobs.findById(created.json.id);
    expect(stored?.input).toMatchObject({
      investigation_id: a.investigationId,
      left_investigation_id: a.investigationId,
      right_investigation_id: b.investigationId,
    });

    const claimed = await claimOne(h, runner);
    expect(claimed.jobId).toBe(created.json.id);
    const token = claimed.token;
    expect(
      (await transition(h, runner, created.json.id, token, "running")).status,
    ).toBe(200);
    const raw = Buffer.from('{"diff":[]}');
    const upload = await uploadArtifact(
      h,
      runner,
      created.json.id,
      token,
      "raw_result",
      "9.json",
      raw,
    );
    expect(upload.status).toBe(201);
    expect(upload.json.object_key).toMatch(
      new RegExp(
        `^projects/${p}/investigations/${a.investigationId}/raw/[0-9a-f-]{36}\\.json$`,
      ),
    );
    const call = await h.api(
      "POST",
      `/api/v1/jobs/${created.json.id}/tool-calls`,
      {
        auth: runner.auth,
        body: toolCallBody(token, a.investigationId, 1, upload.json, {
          evidence_id: "ev-cmp",
          upstream_session_id: "compare-session",
        }),
      },
    );
    expect(call.status).toBe(201);
    // The anchor already holds seq 1 and 2 from its own run; the compare
    // session's first call is appended after them rather than colliding.
    expect(call.json).toMatchObject({ seq: 3, upstream_seq: 1 });
    expect(upload.json.object_key).not.toBe(
      (await h.repos.toolCalls.findBySeq(a.investigationId, 1))
        ?.raw_result_object_key,
    );
    const recorded = await h.repos.toolCalls.findBySeq(a.investigationId, 3);
    expect(recorded?.job_id).toBe(created.json.id);
    await complete(h, runner, created.json.id, token, "succeeded");
  });

  it("allocates seq per investigation when two sessions both record upstream_seq 1", async () => {
    await cancelQueuedJobs(h, owner, p);
    const setup = await startInvestigation(h, owner, p, {
      name: "twosessions.asar",
      runnerId: runner.id,
    });
    const claimed = await claimOne(h, runner);
    const token = claimed.token;
    await transition(h, runner, setup.jobId, token, "running");
    const record = async (session: string, text: string) => {
      const raw = Buffer.from(JSON.stringify({ session: text }));
      const upload = await uploadArtifact(
        h,
        runner,
        setup.jobId,
        token,
        "raw_result",
        "r.json",
        raw,
      );
      expect(upload.status).toBe(201);
      const body = toolCallBody(token, setup.investigationId, 1, upload.json, {
        upstream_session_id: session,
        evidence_id: `ev-${session}`,
      });
      const post = () =>
        h.api("POST", `/api/v1/jobs/${setup.jobId}/tool-calls`, {
          auth: runner.auth,
          body,
        });
      return { raw, upload, post };
    };
    const first = await record("session-one", "one");
    const second = await record("session-two", "two");
    expect(first.upload.json.object_key).not.toBe(
      second.upload.json.object_key,
    );

    const a = await first.post();
    const b = await second.post();
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.json).toMatchObject({
      seq: 1,
      upstream_seq: 1,
      upstream_session_id: "session-one",
    });
    expect(b.json).toMatchObject({
      seq: 2,
      upstream_seq: 1,
      upstream_session_id: "session-two",
    });
    const replay = await first.post();
    expect(replay.status).toBe(201);
    expect(replay.json.id).toBe(a.json.id);
    expect(replay.json.seq).toBe(1);

    const list = await h.api(
      "GET",
      `/api/v1/projects/${p}/investigations/${setup.investigationId}/tool-calls`,
      {
        auth: owner.auth,
      },
    );
    expect(list.json.items.map((c: { seq: number }) => c.seq)).toEqual([1, 2]);
    for (const [call, recorded] of [
      [a, first],
      [b, second],
    ] as const) {
      const raw = await h.api(
        "GET",
        `/api/v1/projects/${p}/investigations/${setup.investigationId}/tool-calls/${call.json.id}/raw`,
        { auth: owner.auth },
      );
      expect(raw.status).toBe(200);
      expect(raw.raw).toBe(recorded.raw.toString());
    }
    expect(
      (await complete(h, runner, setup.jobId, token, "succeeded")).status,
    ).toBe(200);
  });

  it("keeps the calls and raw results of two sessions on one investigation apart", async () => {
    const a = await finishedInvestigation("sessions.asar");
    const requeued = await startJob(
      `investigations/${a.investigationId}/exports`,
    );
    await transition(h, runner, requeued.jobId, requeued.token, "running");
    // A second session reuses upstream_seq 1 of its own session.
    const rawB = Buffer.from('{"session":"b"}');
    const upload = await uploadArtifact(
      h,
      runner,
      requeued.jobId,
      requeued.token,
      "raw_result",
      "r.json",
      rawB,
    );
    expect(upload.status).toBe(201);
    const body = toolCallBody(
      requeued.token,
      a.investigationId,
      1,
      upload.json,
      {
        upstream_session_id: "session-b",
        evidence_id: "ev-b",
      },
    );
    const first = await h.api(
      "POST",
      `/api/v1/jobs/${requeued.jobId}/tool-calls`,
      {
        auth: runner.auth,
        body,
      },
    );
    expect(first.status).toBe(201);
    expect(first.json.seq).toBe(3);
    const retry = await h.api(
      "POST",
      `/api/v1/jobs/${requeued.jobId}/tool-calls`,
      {
        auth: runner.auth,
        body,
      },
    );
    expect(retry.status).toBe(201);
    expect(retry.json.id).toBe(first.json.id);
    expect(retry.json.seq).toBe(3);

    const calls = await h.repos.toolCalls.listByInvestigation(
      a.investigationId,
    );
    expect(calls.map((c) => [c.seq, c.upstream_seq])).toEqual([
      [1, 1],
      [2, 2],
      [3, 1],
    ]);
    const original = await inputs(
      requeued.jobId,
      requeued.token,
      `raw-${a.investigationId}-1`,
    );
    expect(original.raw).toBe(a.raw.toString());
    const second = await inputs(
      requeued.jobId,
      requeued.token,
      `raw-${a.investigationId}-3`,
    );
    expect(second.raw).toBe(rawB.toString());
    await complete(h, runner, requeued.jobId, requeued.token, "succeeded");
  });

  it("serves the investigation record, findings, tool calls and artifacts as a job input", async () => {
    const a = await finishedInvestigation("record.asar");
    const exp = await startJob(`investigations/${a.investigationId}/exports`);
    const response = await inputs(
      exp.jobId,
      exp.token,
      `investigation-${a.investigationId}`,
    );
    expect(response.status).toBe(200);
    expect(String(response.headers["content-type"])).toContain(
      "application/json",
    );
    const view = await h.api(
      "GET",
      `/api/v1/projects/${p}/investigations/${a.investigationId}`,
      {
        auth: owner.auth,
      },
    );
    // The body is exactly the shared runner-input contract.
    expect(investigationIndexSchema.safeParse(response.json).success).toBe(
      true,
    );
    expect(response.json.investigation).toEqual(view.json);
    expect(
      response.json.findings.map((f: { title: string }) => f.title),
    ).toEqual(["first", "second"]);
    expect(response.json.tool_calls).toEqual([
      expect.objectContaining({
        seq: 1,
        tool_name: "analyze_javascript_application",
        arguments: { path: "/app" },
        has_raw: true,
        derived: { normalized_result_keys: ["files"] },
        started_at: expect.any(String),
      }),
      expect.objectContaining({ seq: 2, arguments: null, has_raw: false }),
    ]);
    expect(response.json.artifacts).toEqual([
      expect.objectContaining({
        id: a.artifactId,
        kind: "bundle",
        name: "bundle.json",
        sha256: sha256("{}"),
        size: 2,
        created_at: expect.any(String),
      }),
    ]);
    await finish(exp);
  });

  it("streams a stored raw result and 404s when it is absent", async () => {
    const a = await finishedInvestigation("rawinput.asar");
    const exp = await startJob(`investigations/${a.investigationId}/exports`);
    const ok = await inputs(exp.jobId, exp.token, `raw-${a.investigationId}-1`);
    expect(ok.status).toBe(200);
    expect(ok.raw).toBe(a.raw.toString());
    const missing = await inputs(
      exp.jobId,
      exp.token,
      `raw-${a.investigationId}-2`,
    );
    expect(missing.status).toBe(404);
    const never = await inputs(
      exp.jobId,
      exp.token,
      `raw-${a.investigationId}-77`,
    );
    expect(never.status).toBe(404);
    await finish(exp);
  });

  it("does not serve another project's investigation or its raw results", async () => {
    const mine = await finishedInvestigation("mine.asar");
    const foreignProject = (
      await h.api("POST", "/api/v1/projects", {
        auth: stranger.auth,
        body: { slug: "foreign", name: "F" },
      })
    ).json.id as string;
    const foreignRunner = await createRunner(
      h,
      stranger,
      foreignProject,
      "foreign-runner",
    );
    await registerRunner(h, foreignRunner, reportFor("foreign-runner"));
    const foreignTarget = await h.api(
      "POST",
      `/api/v1/projects/${foreignProject}/targets/uploads`,
      {
        auth: stranger.auth,
        payload: Buffer.from("foreign-bytes"),
        headers: {
          "content-type": "application/octet-stream",
          "x-target-name": "foreign.asar",
        },
      },
    );
    const foreignInvestigation = await h.api(
      "POST",
      `/api/v1/projects/${foreignProject}/investigations`,
      {
        auth: stranger.auth,
        body: { target_id: foreignTarget.json.id, question: "q" },
      },
    );
    expect(foreignInvestigation.status).toBe(201);
    const foreignClaim = await claimOne(h, foreignRunner);
    for (const name of [
      `investigation-${mine.investigationId}`,
      `raw-${mine.investigationId}-1`,
    ]) {
      const denied = await inputs(
        foreignClaim.jobId,
        foreignClaim.token,
        name,
        foreignRunner.auth,
      );
      expect(denied.status, name).toBe(404);
      expect(denied.raw, name).not.toContain("mine.asar");
    }
    // The foreign runner's own investigation is served to it.
    const own = await inputs(
      foreignClaim.jobId,
      foreignClaim.token,
      `investigation-${foreignInvestigation.json.id}`,
      foreignRunner.auth,
    );
    expect(own.status).toBe(200);
    expect(own.json.tool_calls).toEqual([]);
    const malformed = await inputs(
      foreignClaim.jobId,
      foreignClaim.token,
      "investigation-not-a-uuid",
      foreignRunner.auth,
    );
    expect(malformed.status).toBe(404);
  });
});
