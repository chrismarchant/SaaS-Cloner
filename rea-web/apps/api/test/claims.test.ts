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
  startInvestigation,
  transition,
} from "./helpers/flow.js";

describeDb("claiming", () => {
  let h: Harness;
  let owner: Account;
  let p: string;
  beforeAll(async () => {
    h = await createHarness();
    owner = await h.register("claims@example.com");
    p = owner.defaultProjectId as string;
  });
  afterAll(async () => {
    await h.close();
  });

  it("requires a registered capability report", async () => {
    const fresh = await createRunner(h, owner, p, "unregistered");
    const response = await claim(h, fresh, 0);
    expect(response.status).toBe(409);
    expect(response.json.error.code).toBe("capability_unavailable");
  });

  it("wakes a waiting long-poll when a matching job is created", async () => {
    const runner = await createRunner(h, owner, p, "waiter");
    await registerRunner(h, runner, reportFor("waiter"));
    const started = Date.now();
    const pending = claim(h, runner, 5000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const setup = await startInvestigation(h, owner, p, {
      runnerId: runner.id,
      name: "wake.asar",
    });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.json.job.id).toBe(setup.jobId);
    expect(Date.now() - started).toBeLessThan(4000);
    const token = response.json.fencing_token as number;
    expect(
      (await transition(h, runner, setup.jobId, token, "running")).status,
    ).toBe(200);
    expect(
      (await complete(h, runner, setup.jobId, token, "succeeded")).status,
    ).toBe(200);
  });

  it("ends a long-poll with 204 once wait_ms elapses", async () => {
    const runner = await createRunner(h, owner, p, "idle");
    await registerRunner(h, runner, reportFor("idle"));
    const started = Date.now();
    const response = await claim(h, runner, 300);
    expect(response.status).toBe(204);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("only offers jobs whose requirements the runner's report satisfies", async () => {
    const limited = await createRunner(h, owner, p, "limited");
    await registerRunner(
      h,
      limited,
      reportFor("limited", (report) => {
        for (const group of report.tool_availability.groups) {
          if (group.names.includes("analyze_javascript_application")) {
            group.available = false;
            group.reason = "provider_missing";
            group.remediation = "install it";
          }
        }
      }),
    );
    const setup = await startInvestigation(h, owner, p, {
      runnerId: limited.id,
      name: "needs-tool.asar",
    });
    expect((await claim(h, limited, 0)).status).toBe(204);
    const queued = await h.repos.jobs.findById(setup.jobId);
    expect(queued?.state).toBe("queued");
    const capable = await createRunner(h, owner, p, "capable");
    await registerRunner(h, capable, reportFor("capable"));
    // Preferred-runner jobs are reserved for that runner even if another could run them.
    expect((await claim(h, capable, 0)).status).toBe(204);
  });

  it("reserves preferred-runner jobs and serves the oldest first", async () => {
    const a = await createRunner(h, owner, p, "pref-a");
    const b = await createRunner(h, owner, p, "pref-b");
    await registerRunner(h, a, reportFor("pref-a"));
    await registerRunner(h, b, reportFor("pref-b"));
    // drain anything left over from earlier tests
    for (const runner of [a, b])
      for (;;) {
        if ((await claim(h, runner, 0)).status !== 200) break;
      }
    const forB = await startInvestigation(h, owner, p, {
      runnerId: b.id,
      name: "for-b.asar",
    });
    const anyOne = await startInvestigation(h, owner, p, {
      name: "any-1.asar",
    });
    const anyTwo = await startInvestigation(h, owner, p, {
      name: "any-2.asar",
    });
    const firstForA = await claimOne(h, a);
    expect(firstForA.jobId).toBe(anyOne.jobId);
    const forBClaim = await claimOne(h, b);
    expect(forBClaim.jobId).toBe(forB.jobId);
    expect((await claimOne(h, b)).jobId).toBe(anyTwo.jobId);
  });

  it("respects max_concurrent_jobs", async () => {
    const solo = await createRunner(h, owner, p, "solo");
    await registerRunner(
      h,
      solo,
      reportFor("solo", (r) => {
        r.max_concurrent_jobs = 1;
      }),
    );
    const one = await startInvestigation(h, owner, p, {
      runnerId: solo.id,
      name: "solo-1.asar",
    });
    const two = await startInvestigation(h, owner, p, {
      runnerId: solo.id,
      name: "solo-2.asar",
    });
    const first = await claimOne(h, solo);
    expect(first.jobId).toBe(one.jobId);
    expect((await claim(h, solo, 0)).status).toBe(204);
    expect(
      (await transition(h, solo, one.jobId, first.token, "running")).status,
    ).toBe(200);
    expect(
      (await complete(h, solo, one.jobId, first.token, "succeeded")).status,
    ).toBe(200);
    expect((await claimOne(h, solo)).jobId).toBe(two.jobId);
  });

  it("never offers a job from another project", async () => {
    const other = await h.register("claims-other@example.com");
    const otherProject = (
      await h.api("POST", "/api/v1/projects", {
        auth: other.auth,
        body: { slug: "claims-other", name: "o" },
      })
    ).json.id as string;
    const foreign = await createRunner(h, other, otherProject, "foreign");
    await registerRunner(h, foreign, reportFor("foreign"));
    await startInvestigation(h, owner, p, { name: "mine.asar" });
    expect((await claim(h, foreign, 0)).status).toBe(204);
  });

  it("registers runner-local targets idempotently and pins investigations to that runner", async () => {
    const fresh = await h.api("POST", "/api/v1/projects", {
      auth: owner.auth,
      body: { slug: "local-targets", name: "Local targets" },
    });
    const p = fresh.json.id as string;
    const local = await createRunner(h, owner, p, "local-runner");
    const other = await createRunner(h, owner, p, "other-runner");
    await registerRunner(h, local, reportFor("local-runner"));
    await registerRunner(h, other, reportFor("other-runner"));
    const entry = {
      name: "Secret.app",
      path_hash: "a".repeat(64),
      kind: "asar",
      sha256: null,
      size: null,
      project_id: p,
    };
    const register = (runner: RunnerHandle, targets: unknown[]) =>
      h.api("POST", `/api/v1/runners/${runner.id}/local-targets`, {
        auth: runner.auth,
        body: { targets },
      });
    const first = await register(local, [entry]);
    expect(first.status).toBe(200);
    expect(first.json.items[0]).toMatchObject({
      kind: "runner_local",
      class: "asar",
      runner_id: local.id,
    });
    expect(first.raw).not.toContain("runner_path_hash");
    const again = await register(local, [entry]);
    expect(again.json.items[0].id).toBe(first.json.items[0].id);
    const wrongProject = await register(local, [
      { ...entry, project_id: "0190b0a0-0000-7000-8000-000000000000" },
    ]);
    expect(wrongProject.status).toBe(403);

    const targetId = first.json.items[0].id as string;
    const mismatch = await h.api(
      "POST",
      `/api/v1/projects/${p}/investigations`,
      {
        auth: owner.auth,
        body: { target_id: targetId, question: "q", runner_id: other.id },
      },
    );
    expect(mismatch.status).toBe(400);
    const pinned = await h.api("POST", `/api/v1/projects/${p}/investigations`, {
      auth: owner.auth,
      body: { target_id: targetId, question: "q" },
    });
    expect(pinned.status).toBe(201);
    const job = await h.repos.jobs.findById(pinned.json.job_id);
    expect(job?.preferred_runner_id).toBe(local.id);
    const routing = await h.api(
      "GET",
      `/api/v1/projects/${p}/targets/${targetId}/routing`,
      {
        auth: owner.auth,
      },
    );
    expect(
      routing.json.candidate_runners.map(
        (c: { runner_id: string }) => c.runner_id,
      ),
    ).toEqual([local.id]);
    const inputs = await claimOne(h, local);
    expect(inputs.jobId).toBe(pinned.json.job_id);
    const target = await h.api(
      "GET",
      `/api/v1/jobs/${inputs.jobId}/inputs/target`,
      {
        auth: local.auth,
        headers: { "x-fencing-token": String(inputs.token) },
      },
    );
    expect(target.status).toBe(200);
    expect(target.json).toMatchObject({
      kind: "runner_local",
      name: "Secret.app",
    });
  });
});
