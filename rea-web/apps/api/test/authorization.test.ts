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
  uploadBytes,
} from "./helpers/harness.js";

describeDb("project authorization", () => {
  let h: Harness;
  let owner: Account;
  let outsider: Account;
  let viewer: Account;
  let member: Account;
  let admin: Account;
  let p1: string;
  let p2: string;
  let targetId: string;
  let investigationId: string;
  let jobId: string;
  let runnerA: RunnerHandle;
  let runnerB: RunnerHandle;
  const base = (p: string) => `/api/v1/projects/${p}`;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.register("owner@example.com");
    p1 = owner.defaultProjectId as string;
    outsider = await h.register("outsider@example.com");
    viewer = await h.register("viewer@example.com");
    member = await h.register("member@example.com");
    admin = await h.register("admin@example.com");
    for (const [account, role] of [
      [viewer, "viewer"],
      [member, "member"],
      [admin, "admin"],
    ] as const) {
      const response = await h.api("POST", `${base(p1)}/members`, {
        auth: owner.auth,
        body: { email: account.email, role },
      });
      expect(response.status).toBe(200);
    }
    const project2 = await h.api("POST", "/api/v1/projects", {
      auth: outsider.auth,
      body: { slug: "other", name: "Other" },
    });
    expect(project2.status).toBe(201);
    p2 = project2.json.id;

    const upload = await uploadBytes(
      h,
      owner,
      p1,
      "app.bin",
      Buffer.from("MZ....hello"),
    );
    expect(upload.status).toBe(201);
    targetId = upload.json.id;
    const investigation = await h.api("POST", `${base(p1)}/investigations`, {
      auth: owner.auth,
      body: { target_id: targetId, question: "what does it do?" },
    });
    expect(investigation.status).toBe(201);
    investigationId = investigation.json.id;
    jobId = investigation.json.job_id;

    runnerA = await createRunner(h, owner, p1, "runner-a");
    runnerB = await createRunner(h, outsider, p2, "runner-b");
    await registerRunner(h, runnerA, reportFor("runner-a"));
    await registerRunner(h, runnerB, reportFor("runner-b"));
  });
  afterAll(async () => {
    await h.close();
  });

  it("lets a viewer read but not write", async () => {
    const list = await h.api("GET", `${base(p1)}/targets`, {
      auth: viewer.auth,
    });
    expect(list.status).toBe(200);
    const write = await uploadBytes(h, viewer, p1, "x.bin", Buffer.from("x"));
    expect(write.status).toBe(403);
    expect(write.json.error.code).toBe("forbidden");
    const cancel = await h.api("POST", `${base(p1)}/jobs/${jobId}/cancel`, {
      auth: viewer.auth,
    });
    expect(cancel.status).toBe(403);
    const investigation = await h.api("POST", `${base(p1)}/investigations`, {
      auth: viewer.auth,
      body: { target_id: targetId, question: "q" },
    });
    expect(investigation.status).toBe(403);
  });

  it("enforces member, admin and owner thresholds", async () => {
    const memberUpload = await uploadBytes(
      h,
      member,
      p1,
      "m.bin",
      Buffer.from("m"),
    );
    expect(memberUpload.status).toBe(201);
    const memberRunner = await h.api("POST", `${base(p1)}/runners`, {
      auth: member.auth,
      body: { name: "nope" },
    });
    expect(memberRunner.status).toBe(403);
    const memberDelete = await h.api(
      "DELETE",
      `${base(p1)}/targets/${memberUpload.json.id}`,
      {
        auth: member.auth,
      },
    );
    expect(memberDelete.status).toBe(403);
    const adminRunner = await h.api("POST", `${base(p1)}/runners`, {
      auth: admin.auth,
      body: { name: "by-admin" },
    });
    expect(adminRunner.status).toBe(201);
    const adminGrantsOwner = await h.api("POST", `${base(p1)}/members`, {
      auth: admin.auth,
      body: { email: viewer.email, role: "owner" },
    });
    expect(adminGrantsOwner.status).toBe(403);
    const lastOwner = await h.api("POST", `${base(p1)}/members`, {
      auth: owner.auth,
      body: { email: owner.email, role: "member" },
    });
    expect(lastOwner.status).toBe(409);
  });

  it("hides another project's resources behind 404 on every resource type", async () => {
    const paths = [
      `${base(p1)}`,
      `${base(p1)}/targets`,
      `${base(p1)}/targets/${targetId}`,
      `${base(p1)}/targets/${targetId}/routing`,
      `${base(p1)}/investigations`,
      `${base(p1)}/investigations/${investigationId}`,
      `${base(p1)}/investigations/${investigationId}/findings`,
      `${base(p1)}/investigations/${investigationId}/tool-calls`,
      `${base(p1)}/jobs`,
      `${base(p1)}/jobs/${jobId}`,
      `${base(p1)}/jobs/${jobId}/approvals`,
      `${base(p1)}/runners`,
      `${base(p1)}/runners/${runnerA.id}/capabilities`,
      `${base(p1)}/tools`,
      `${base(p1)}/members`,
      `${base(p1)}/builds`,
    ];
    for (const path of paths) {
      const response = await h.api("GET", path, { auth: outsider.auth });
      expect(response.status, path).toBe(404);
      expect(response.json.error.code, path).toBe("not_found");
    }
    const post = await h.api("POST", `${base(p1)}/investigations`, {
      auth: outsider.auth,
      body: { target_id: targetId, question: "q" },
    });
    expect(post.status).toBe(404);
  });

  it("scopes ids to the project in the path, not just to the membership", async () => {
    // outsider is a member of p2 and presents p1's ids under p2.
    for (const path of [
      `${base(p2)}/targets/${targetId}`,
      `${base(p2)}/investigations/${investigationId}`,
      `${base(p2)}/jobs/${jobId}`,
      `${base(p2)}/runners/${runnerA.id}/capabilities`,
      `${base(p2)}/jobs/${jobId}/events`,
    ]) {
      const response = await h.api("GET", path, { auth: outsider.auth });
      expect(response.status, path).toBe(404);
    }
    const cancel = await h.api("POST", `${base(p2)}/jobs/${jobId}/cancel`, {
      auth: outsider.auth,
    });
    expect(cancel.status).toBe(404);
    const stillQueued = await h.repos.jobs.findById(jobId);
    expect(stillQueued?.state).toBe("queued");
    const investigation = await h.api("POST", `${base(p2)}/investigations`, {
      auth: outsider.auth,
      body: { target_id: targetId, question: "q" },
    });
    expect(investigation.status).toBe(404);
  });

  it("rejects an SSE request for another project's job before streaming", async () => {
    const response = await h.api("GET", `${base(p1)}/jobs/${jobId}/events`, {
      auth: outsider.auth,
      headers: { accept: "text/event-stream" },
    });
    expect(response.status).toBe(404);
    expect(String(response.headers["content-type"])).toContain(
      "application/json",
    );
    const anonymous = await h.api("GET", `${base(p1)}/jobs/${jobId}/events`, {
      headers: { accept: "text/event-stream" },
    });
    expect(anonymous.status).toBe(401);
  });

  it("keeps user and runner credentials apart", async () => {
    const runnerOnUserRoute = await h.api("GET", `${base(p1)}/targets`, {
      auth: runnerA.auth,
    });
    expect(runnerOnUserRoute.status).toBe(401);
    const userOnRunnerRoute = await h.api(
      "POST",
      `/api/v1/runners/${runnerA.id}/claim`,
      {
        auth: owner.auth,
        body: { wait_ms: 0 },
      },
    );
    expect(userOnRunnerRoute.status).toBe(401);
    const cookieOnRunnerRoute = await h.api(
      "POST",
      "/api/v1/runners/register",
      {
        auth: { cookie: owner.cookie },
        body: reportFor("x"),
      },
    );
    expect(cookieOnRunnerRoute.status).toBe(401);
  });

  it("confines runners to their own id, project and leases", async () => {
    const wrongId = await h.api("POST", `/api/v1/runners/${runnerB.id}/claim`, {
      auth: runnerA.auth,
      body: { wait_ms: 0 },
    });
    expect(wrongId.status).toBe(403);
    const heartbeatWrongId = await h.api(
      "POST",
      `/api/v1/runners/${runnerB.id}/heartbeat`,
      {
        auth: runnerA.auth,
        body: { leases: [] },
      },
    );
    expect(heartbeatWrongId.status).toBe(403);
    // runnerB belongs to p2: p1's job does not exist for it.
    const foreignJob = await h.api("POST", `/api/v1/jobs/${jobId}/events`, {
      auth: runnerB.auth,
      body: { fencing_token: 1, events: [{ kind: "job.log", payload: {} }] },
    });
    expect(foreignJob.status).toBe(404);
    const foreignInput = await h.api(
      "GET",
      `/api/v1/jobs/${jobId}/inputs/target`,
      {
        auth: runnerB.auth,
        headers: { "x-fencing-token": "1" },
      },
    );
    expect(foreignInput.status).toBe(404);
    const events = await h.repos.jobEvents.listAfter(jobId, 0);
    expect(events.map((e) => e.kind)).toEqual(["job.created"]);
  });

  it("does not leak existence through the viewer's runner list across projects", async () => {
    const list = await h.api("GET", `${base(p2)}/runners`, {
      auth: outsider.auth,
    });
    expect(list.status).toBe(200);
    expect(list.json.items.map((r: { id: string }) => r.id)).toEqual([
      runnerB.id,
    ]);
  });

  it("revoking a runner invalidates its token", async () => {
    const created = await createRunner(h, owner, p1, "to-revoke");
    await registerRunner(h, created, reportFor("to-revoke"));
    const revoke = await h.api("DELETE", `${base(p1)}/runners/${created.id}`, {
      auth: owner.auth,
    });
    expect(revoke.status).toBe(200);
    const claim = await h.api("POST", `/api/v1/runners/${created.id}/claim`, {
      auth: created.auth,
      body: { wait_ms: 0 },
    });
    expect(claim.status).toBe(401);
  });
});
