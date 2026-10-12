import { afterAll, beforeAll, expect, it } from "vitest";
import { uuidv7 } from "@rea-web/contracts";
import {
  type TestDatabase,
  createTestDatabase,
  describeDb,
} from "./testDatabase.js";
import { jobInput, seedProject, seedRunner } from "./fixtures.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeDb("job support and domain record repositories", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.drop();
  });

  async function jobFixture() {
    const w = await seedProject(t.repos);
    const job = await t.repos.jobs.create(jobInput(w.project.id));
    return { ...w, job };
  }

  it("idempotency: store, find, first writer wins, purge", async () => {
    const { user, project } = await seedProject(t.repos);
    const base = {
      principal_id: user.id,
      project_id: project.id,
      key: "k-1",
      request_hash: "h1",
      status_code: 201,
    };
    expect(await t.repos.idempotency.find(user.id, "k-1")).toBeNull();
    const stored = await t.repos.idempotency.store({
      ...base,
      response: { id: "abc", list: [1, 2] },
    });
    expect(stored).toMatchObject({
      request_hash: "h1",
      status_code: 201,
      response: { id: "abc", list: [1, 2] },
    });
    expect(await t.repos.idempotency.find(user.id, "k-1")).toEqual(stored);

    const second = await t.repos.idempotency.store({
      ...base,
      request_hash: "h2",
      status_code: 500,
      response: "other",
    });
    expect(second.request_hash).toBe("h1");
    // Arrays and null responses survive the JSONB round trip.
    const arr = await t.repos.idempotency.store({
      ...base,
      key: "k-2",
      response: [1, 2],
    });
    expect(arr.response).toEqual([1, 2]);

    await t.db.query(
      "UPDATE idempotency_records SET created_at = now() - interval '2 days' WHERE idempotency_key = 'k-1'",
    );
    expect(await t.repos.idempotency.purgeOlderThan(24 * 3_600_000)).toBe(1);
    expect(await t.repos.idempotency.find(user.id, "k-1")).toBeNull();
    expect(await t.repos.idempotency.find(user.id, "k-2")).not.toBeNull();
  });

  it("effect ledger: start/complete/fail, completed steps are not restarted", async () => {
    const { job } = await jobFixture();
    const L = t.repos.effectLedger;
    expect(await L.get(job.id, "s")).toBeNull();
    expect(await L.hasStarted(job.id)).toBe(false);

    const started = await L.start(job.id, "s", 1, { target: "device" });
    expect(started).toMatchObject({
      status: "started",
      attempt: 1,
      detail: { target: "device" },
    });
    expect(await L.hasStarted(job.id)).toBe(true);

    const failed = await L.fail(job.id, "s", { error: "boom" });
    expect(failed).toMatchObject({
      status: "failed",
      detail: { target: "device", error: "boom" },
    });
    expect(await L.hasStarted(job.id)).toBe(false);

    const retried = await L.start(job.id, "s", 2, { retry: true });
    expect(retried).toMatchObject({
      status: "started",
      attempt: 2,
      detail: { retry: true },
    });
    const done = await L.complete(job.id, "s", { ok: 1 });
    expect(done?.status).toBe("completed");
    const again = await L.start(job.id, "s", 3);
    expect(again).toMatchObject({ status: "completed", attempt: 2 });
    expect(await L.complete(job.id, "missing")).toBeNull();
  });

  it("approvals: pending, single decision, delivery", async () => {
    const { job, user } = await jobFixture();
    const A = t.repos.approvals;
    const a1 = await A.create({
      job_id: job.id,
      tool: "run_binary",
      arguments: { path: "x" },
      effects: ["executesForeignCode"],
      reason: "policy",
    });
    const a2 = await A.create({
      approval_id: "appr-2",
      job_id: job.id,
      tool: "adb_install",
      arguments: {},
      reason: "policy",
    });
    expect(a2.effects).toEqual([]);
    expect(
      (await A.pendingForJob(job.id)).map((a) => a.approval_id).sort(),
    ).toEqual([a1.approval_id, "appr-2"].sort());
    expect(await A.undeliveredDecisions(job.id)).toEqual([]);

    const decided = await A.decide(a1.approval_id, {
      decision: "approved",
      decided_by: user.id,
    });
    expect(decided).toMatchObject({
      decision: "approved",
      decided_by: user.id,
    });
    expect(
      await A.decide(a1.approval_id, {
        decision: "rejected",
        decided_by: user.id,
      }),
    ).toBeNull();
    expect((await A.find(a1.approval_id))?.decision).toBe("approved");
    expect(
      await A.decide("nope", { decision: "approved", decided_by: user.id }),
    ).toBeNull();

    expect((await A.pendingForJob(job.id)).map((a) => a.approval_id)).toEqual([
      "appr-2",
    ]);
    const undelivered = await A.undeliveredDecisions(job.id);
    expect(undelivered.map((a) => a.approval_id)).toEqual([a1.approval_id]);
    expect(await A.markDelivered(undelivered.map((a) => a.approval_id))).toBe(
      1,
    );
    expect(await A.undeliveredDecisions(job.id)).toEqual([]);
    expect(await A.markDelivered([])).toBe(0);
  });

  it("investigations, tool calls, evidence and findings", async () => {
    const { user, project, job } = await jobFixture();
    const { repos } = t;
    const target = await repos.targets.create({
      project_id: project.id,
      kind: "url",
      name: "t",
      class: "web",
      url: "https://example.test",
    });
    const inv = await repos.investigations.create({
      project_id: project.id,
      target_id: target.id,
      question: "what?",
      policy: { mode: "static_only" },
      created_by: user.id,
    });
    expect(inv).toMatchObject({
      status: "pending",
      job_id: null,
      routing: null,
    });
    expect(await repos.investigations.findById(project.id, inv.id)).toEqual(
      inv,
    );
    expect(await repos.investigations.findById(uuidv7(), inv.id)).toBeNull();

    await sleep(2);
    const withJob = await repos.investigations.setJob(inv.id, job.id);
    expect(withJob?.job_id).toBe(job.id);
    expect(Date.parse(withJob?.updated_at ?? "")).toBeGreaterThanOrEqual(
      Date.parse(inv.updated_at),
    );
    expect((await repos.investigations.findByJobId(job.id))?.id).toBe(inv.id);
    expect(
      (await repos.investigations.setStatus(inv.id, "running"))?.status,
    ).toBe("running");
    expect(
      (
        await repos.investigations.setRouting(inv.id, {
          first_tool: "open_binary",
        })
      )?.routing,
    ).toEqual({ first_tool: "open_binary" });
    expect(
      (await repos.investigations.setUpstreamIdentity(inv.id, { version: "1" }))
        ?.upstream_identity,
    ).toEqual({ version: "1" });
    expect(
      (await repos.investigations.list(project.id, { status: "running" }))
        .items,
    ).toHaveLength(1);
    expect(
      (await repos.investigations.list(project.id, { status: "failed" })).items,
    ).toHaveLength(0);

    const call = (seq: number, extra: object = {}) => ({
      investigation_id: inv.id,
      job_id: job.id,
      seq,
      tool_name: "open_binary",
      upstream_session_id: "sess",
      raw_result_object_key: `raw/${seq}.json`,
      raw_result_sha256: "ab".repeat(32),
      raw_result_bytes: 1234,
      evidence_id: `ev-${seq}`,
      effects: ["idempotent"],
      duration_ms: 12,
      started_at: new Date(),
      ...extra,
    });
    const first = await repos.toolCalls.create(
      call(1, { derived: { keys: ["a"] } }),
    );
    expect(first).toMatchObject({
      seq: 1,
      raw_result_bytes: 1234,
      is_error: false,
      effects: ["idempotent"],
      derived: { keys: ["a"] },
    });
    // A retried upload of the same seq returns the stored row.
    const retry = await repos.toolCalls.create(
      call(1, { tool_name: "different" }),
    );
    expect(retry.id).toBe(first.id);
    expect(retry.tool_name).toBe("open_binary");
    await repos.toolCalls.create(call(2));
    await repos.toolCalls.create(call(3, { is_error: true }));
    expect(
      (await repos.toolCalls.listByInvestigation(inv.id)).map((c) => c.seq),
    ).toEqual([1, 2, 3]);
    expect(
      (
        await repos.toolCalls.listByInvestigation(inv.id, {
          afterSeq: 1,
          limit: 1,
        })
      ).map((c) => c.seq),
    ).toEqual([2]);
    expect((await repos.toolCalls.findBySeq(inv.id, 3))?.is_error).toBe(true);
    expect((await repos.toolCalls.findByEvidenceId(inv.id, "ev-2"))?.seq).toBe(
      2,
    );
    expect((await repos.toolCalls.findById(first.id))?.seq).toBe(1);

    const artifact = await repos.evidenceArtifacts.create({
      investigation_id: inv.id,
      kind: "bundle",
      name: "bundle.json",
      object_key: "k",
      sha256: "cd".repeat(32),
      size: 99,
    });
    expect(artifact.size).toBe(99);
    expect(
      (await repos.evidenceArtifacts.findById(inv.id, artifact.id))?.name,
    ).toBe("bundle.json");
    expect(
      await repos.evidenceArtifacts.listByInvestigation(inv.id, {
        kind: "export",
      }),
    ).toEqual([]);
    expect(
      await repos.evidenceArtifacts.listByInvestigation(inv.id),
    ).toHaveLength(1);

    const findings = await repos.findings.createMany([
      {
        investigation_id: inv.id,
        class: "fact",
        title: "f1",
        body: "b",
        evidence_ids: ["ev-1"],
        tool_call_seqs: [1],
        source: "upstream",
      },
      {
        investigation_id: inv.id,
        class: "unknown",
        title: "u1",
        body: "b",
        limitations: ["no provider"],
        source: "policy",
      },
      {
        investigation_id: inv.id,
        class: "fact",
        title: "f2",
        body: "b",
        source: "model",
      },
    ]);
    expect(findings[0]).toMatchObject({
      evidence_ids: ["ev-1"],
      tool_call_seqs: [1],
      limitations: [],
    });
    expect(
      (await repos.findings.listByInvestigation(inv.id)).map((f) => f.title),
    ).toEqual(["f1", "u1", "f2"]);
    expect(
      (await repos.findings.listByInvestigation(inv.id, { class: "fact" })).map(
        (f) => f.title,
      ),
    ).toEqual(["f1", "f2"]);
    expect(
      (await repos.findings.findById(inv.id, findings[1]?.id ?? ""))
        ?.limitations,
    ).toEqual(["no provider"]);
  });

  it("builds, plans, captures, verifications and exports with project scoping", async () => {
    const { repos } = t;
    const { user, project } = await seedProject(repos);
    const { project: other } = await seedProject(repos);
    const runner = await seedRunner(repos, project.id);
    const job = (
      kind:
        | "preservation.plan"
        | "preservation.capture"
        | "recovery.verify"
        | "recovery.export",
    ) => repos.jobs.create(jobInput(project.id, { kind }));

    const build = await repos.builds.create({
      project_id: project.id,
      name: "app",
      source: { repo: "x" },
      components: [{ kind: "git" }],
      created_by: user.id,
    });
    expect(build).toMatchObject({
      description: "",
      components: [{ kind: "git" }],
    });
    expect(await repos.builds.findById(other.id, build.id)).toBeNull();
    expect(
      (await repos.builds.list(project.id)).items.map((b) => b.id),
    ).toEqual([build.id]);

    const planJob = await job("preservation.plan");
    const plan = await repos.plans.create({
      build_id: build.id,
      job_id: planJob.id,
    });
    expect(plan.plan).toBeNull();
    const planned = await repos.plans.setPlan(plan.id, {
      plan: { components: [] },
      runner_id: runner.id,
    });
    expect(planned).toMatchObject({
      plan: { components: [] },
      runner_id: runner.id,
    });
    expect((await repos.plans.findByJobId(planJob.id))?.id).toBe(plan.id);
    expect(await repos.plans.findById(other.id, plan.id)).toBeNull();
    expect((await repos.plans.findById(project.id, plan.id))?.id).toBe(plan.id);
    expect((await repos.plans.listByBuild(build.id)).items).toHaveLength(1);

    const captureJob = await job("preservation.capture");
    const capture = await repos.captures.create({
      build_id: build.id,
      plan_id: plan.id,
      job_id: captureJob.id,
    });
    expect(capture).toMatchObject({
      status: "pending",
      component_statuses: {},
      started_at: null,
    });
    const started = new Date();
    const updated = await repos.captures.update(capture.id, {
      status: "completed",
      manifest_object_key: "m.json",
      manifest_sha256: "ef".repeat(32),
      consistency: "inconsistent",
      component_statuses: { git: "ok" },
      started_at: started,
      finished_at: started.toISOString(),
    });
    expect(updated).toMatchObject({
      status: "completed",
      consistency: "inconsistent",
      component_statuses: { git: "ok" },
      started_at: started.toISOString(),
    });
    // A patch that sets nothing leaves the row alone; explicit null clears a column.
    expect((await repos.captures.update(capture.id, {}))?.status).toBe(
      "completed",
    );
    expect(
      (await repos.captures.update(capture.id, { consistency: null }))
        ?.consistency,
    ).toBeNull();
    expect(
      await repos.captures.update(uuidv7(), { status: "failed" }),
    ).toBeNull();
    expect(await repos.captures.findById(other.id, capture.id)).toBeNull();
    expect((await repos.captures.findByJobId(captureJob.id))?.id).toBe(
      capture.id,
    );
    expect(
      (await repos.captures.listByBuild(build.id)).map((c) => c.id),
    ).toEqual([capture.id]);

    const verifyJob = await job("recovery.verify");
    const verification = await repos.verifications.create({
      capture_id: capture.id,
      job_id: verifyJob.id,
      scope: { kind: "full" },
    });
    const verified = await repos.verifications.update(verification.id, {
      results: [{ step: "hash", ok: true }],
      network_required: { hosts: [] },
      overall: "pass",
    });
    expect(verified).toMatchObject({
      results: [{ step: "hash", ok: true }],
      overall: "pass",
      network_required: { hosts: [] },
    });
    expect(
      (
        await repos.verifications.update(verification.id, {
          network_required: null,
        })
      )?.network_required,
    ).toBeNull();
    expect(
      (await repos.verifications.findById(project.id, verification.id))?.id,
    ).toBe(verification.id);
    expect(
      await repos.verifications.findById(other.id, verification.id),
    ).toBeNull();
    expect((await repos.verifications.findByJobId(verifyJob.id))?.id).toBe(
      verification.id,
    );
    expect(
      (await repos.verifications.listByCapture(capture.id)).items,
    ).toHaveLength(1);

    const exportJob = await job("recovery.export");
    const exp = await repos.exports.create({
      capture_id: capture.id,
      job_id: exportJob.id,
    });
    expect(exp.status).toBe("pending");
    const exported = await repos.exports.update(exp.id, {
      status: "completed",
      object_key: "e.tar",
      sha256: "01".repeat(32),
      size: 5_000_000_000,
      signature: { alg: "ed25519" },
      encryption: { alg: "age" },
    });
    expect(exported).toMatchObject({
      status: "completed",
      size: 5_000_000_000,
      signature: { alg: "ed25519" },
      encryption: { alg: "age" },
    });
    expect((await repos.exports.findById(project.id, exp.id))?.id).toBe(exp.id);
    expect(await repos.exports.findById(other.id, exp.id)).toBeNull();
    expect((await repos.exports.findByJobId(exportJob.id))?.id).toBe(exp.id);
    expect((await repos.exports.listByCapture(capture.id)).items).toHaveLength(
      1,
    );
  });
});
