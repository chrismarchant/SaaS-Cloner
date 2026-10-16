import { afterAll, beforeAll, expect, it } from "vitest";
import {
  captureCoverageSchema,
  captureSchema,
  createPlanResponseSchema,
  exportSchema,
  preservationPlanSchema,
  verificationSchema,
} from "@rea-web/contracts";
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
  sha256,
  transition,
  uploadArtifact,
} from "./helpers/flow.js";
import { minimalManifest } from "./helpers/manifest.js";

const planBody = {
  components: [
    {
      id: "source:main",
      kind: "source",
      collector: "git",
      permissions: [],
      estimated_bytes: 1,
      dependencies: [],
      method: "git bundle --all",
      omissions: [],
      feasible: true,
    },
  ],
  consistency_strategy: "source only",
  known_omissions: [],
};

const KEY_ID = "ab".repeat(32);

describeDb("build resource lists, report and signature downloads", () => {
  let h: Harness;
  let owner: Account;
  let viewer: Account;
  let outsider: Account;
  let p: string;
  let runner: RunnerHandle;
  let b: string;
  const base = () => `/api/v1/projects/${p}`;
  const get = (path: string, account: Account = owner) =>
    h.api("GET", `${base()}${path}`, { auth: account.auth });
  const post = (path: string, body: unknown) =>
    h.api("POST", `${base()}${path}`, { auth: owner.auth, body });

  /** Claims the only queued job, runs it, and lets `finish` complete it. */
  const runJob = async (
    jobId: string,
    finish: (token: number) => Promise<unknown>,
  ) => {
    const claimed = await claimOne(h, runner);
    expect(claimed.jobId).toBe(jobId);
    await transition(h, runner, jobId, claimed.token, "running");
    await finish(claimed.token);
  };

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.register("lists@example.com");
    viewer = await h.register("lists-viewer@example.com");
    outsider = await h.register("lists-outsider@example.com");
    p = owner.defaultProjectId as string;
    expect(
      (await post("/members", { email: viewer.email, role: "viewer" })).status,
    ).toBe(200);
    runner = await createRunner(h, owner, p, "lists-runner");
    await registerRunner(h, runner, reportFor("lists-runner"));
    const build = await post("/builds", {
      name: "notes",
      source: { kind: "git", url: "https://git.example.test/notes.git" },
      components: [{ kind: "source", id: "main" }],
    });
    b = build.json.id;
  });
  afterAll(async () => {
    await h.close();
  });

  it("returns the plan id and job id from every create route", async () => {
    const planned = await post(`/builds/${b}/plans`, {});
    expect(planned.status).toBe(202);
    const created = createPlanResponseSchema.parse(planned.json);
    expect(created.job_id).toBe(created.id);
    expect(created.plan_id).not.toBe(created.job_id);

    await runJob(created.job_id, (token) =>
      complete(h, runner, created.job_id, token, "succeeded", {
        plan: planBody,
      }),
    );

    // The plan list is newest first, paginated, and shows the produced plan.
    const second = createPlanResponseSchema.parse(
      (await post(`/builds/${b}/plans`, {})).json,
    );
    const firstPage = await get(`/builds/${b}/plans?limit=1`);
    expect(firstPage.status).toBe(200);
    expect(firstPage.json.items.map((x: any) => x.id)).toEqual([
      second.plan_id,
    ]);
    expect(firstPage.json.items[0].status).toBe("pending");
    expect(firstPage.json.next_cursor).toEqual(expect.any(String));
    const nextPage = await get(
      `/builds/${b}/plans?limit=1&cursor=${firstPage.json.next_cursor}`,
    );
    const produced = preservationPlanSchema.parse(nextPage.json.items[0]);
    expect(produced).toMatchObject({
      id: created.plan_id,
      job_id: created.job_id,
      status: "completed",
    });
    expect(produced.components).toHaveLength(1);
    expect(nextPage.json.next_cursor).toBeNull();
    // Cancel the second plan's job so it cannot be claimed by later steps.
    await h.api("POST", `${base()}/jobs/${second.job_id}/cancel`, {
      auth: owner.auth,
    });
    // The plan is addressed by its id, not by the id of the job that makes it.
    expect((await get(`/builds/${b}/plans/${created.job_id}`)).status).toBe(
      404,
    );
    expect((await get(`/builds/${b}/plans/${created.plan_id}`)).status).toBe(
      200,
    );
  });

  it("lists captures, serves coverage from the stored manifest, and refuses it before there is one", async () => {
    const plans = (await get(`/builds/${b}/plans`)).json.items as Array<{
      id: string;
      status: string;
    }>;
    const planId = plans.find((x) => x.status === "completed")?.id as string;

    const manifest = minimalManifest();
    manifest.missing_or_blocked = [
      {
        component_id: "data:db",
        status: "blocked",
        reason: "database: no read-only credential",
        remediation: "Supply DATABASE_URL on the runner",
      },
    ];
    const manifestBytes = Buffer.from(JSON.stringify(manifest));

    const first = await post(`/builds/${b}/captures`, { plan_id: planId });
    expect(first.status).toBe(202);
    expect(first.json).toMatchObject({
      plan_id: planId,
      status: "pending",
    });
    expect(first.json.job_id).toEqual(expect.any(String));
    const firstId = first.json.id as string;
    expect(
      (await get(`/builds/${b}/captures/${firstId}/coverage`)).json.error
        .details.reason,
    ).toBe("manifest_not_ready");

    await runJob(first.json.job_id, async (token) => {
      expect(
        (
          await uploadArtifact(
            h,
            runner,
            first.json.job_id,
            token,
            "capture_manifest",
            "manifest.json",
            manifestBytes,
          )
        ).status,
      ).toBe(201);
      await complete(h, runner, first.json.job_id, token, "succeeded", {
        capture: {
          consistency: "single_point",
          component_statuses: {
            "source:main": "captured",
            "data:db": "blocked",
          },
          manifest_sha256: sha256(manifestBytes),
          package_id: manifest.package_id,
          files: 1,
          bytes: 1,
        },
      });
    });

    const coverage = captureCoverageSchema.parse(
      (await get(`/builds/${b}/captures/${firstId}/coverage`)).json,
    );
    expect(coverage.components).toEqual({
      "source:main": "captured",
      "data:db": "blocked",
    });
    expect(coverage.missing_or_blocked).toEqual(manifest.missing_or_blocked);

    const second = await post(`/builds/${b}/captures`, { plan_id: planId });
    expect(second.status).toBe(202);
    await h.api("POST", `${base()}/jobs/${second.json.job_id}/cancel`, {
      auth: owner.auth,
    });

    const page = await get(`/builds/${b}/captures?limit=1`);
    expect(page.status).toBe(200);
    expect(page.json.items.map((x: any) => x.id)).toEqual([second.json.id]);
    expect(page.json.items[0].status).toBe("cancelled");
    const rest = await get(
      `/builds/${b}/captures?limit=1&cursor=${page.json.next_cursor}`,
    );
    expect(captureSchema.parse(rest.json.items[0])).toMatchObject({
      id: firstId,
      status: "completed",
    });
    expect(rest.json.next_cursor).toBeNull();
    expect((await get(`/builds/${b}/captures?cursor=%25%25`)).status).toBe(400);
    expect(
      (
        await get(
          `/builds/${b}/captures?cursor=${Buffer.from("not-a-uuid").toString("base64url")}`,
        )
      ).status,
    ).toBe(400);
  });

  it("derives a verification's status and serves its report only from its own prefix", async () => {
    const capture = (await get(`/builds/${b}/captures`)).json.items.find(
      (x: any) => x.status === "completed",
    );
    const c = capture.id as string;
    const url = (v: string) => `/builds/${b}/captures/${c}/verifications/${v}`;
    const reportBytes = Buffer.from(
      JSON.stringify({ format: "rea-web-recovery-report" }),
    );
    const result = (key: string | null) => ({
      verification: {
        results: [
          {
            scope: "integrity",
            status: "integrity_verified",
            detail: "ok",
            performed_at: new Date().toISOString(),
            evidence_object_key: key,
          },
        ],
        network_required: { verdict: "no", reasons: [] },
        overall: "integrity_verified",
      },
    });

    // 1. A verification with a report.
    const good = await post(`/builds/${b}/captures/${c}/verifications`, {
      scope: ["integrity"],
    });
    expect(good.status).toBe(202);
    expect(good.json).toMatchObject({ status: "pending", overall: null });
    const goodId = good.json.id as string;
    const early = await get(`${url(goodId)}/report`);
    expect(early.status).toBe(409);
    expect(early.json.error.details).toMatchObject({
      reason: "report_not_ready",
    });
    await runJob(good.json.job_id, async (token) => {
      const uploaded = await uploadArtifact(
        h,
        runner,
        good.json.job_id,
        token,
        "verification_evidence",
        "restore-report.json",
        reportBytes,
      );
      expect(uploaded.status).toBe(201);
      await complete(
        h,
        runner,
        good.json.job_id,
        token,
        "succeeded",
        result(uploaded.json.object_key),
      );
    });
    const view = verificationSchema.parse((await get(url(goodId))).json);
    expect(view).toMatchObject({ status: "completed" });
    const report = await get(`${url(goodId)}/report`);
    expect(report.status).toBe(200);
    expect(report.raw).toBe(reportBytes.toString());
    expect(report.headers["content-type"]).toContain("application/json");

    // 2. A job that failed leaves no report.
    const failed = await post(`/builds/${b}/captures/${c}/verifications`, {
      scope: ["integrity"],
    });
    await runJob(failed.json.job_id, (token) =>
      complete(h, runner, failed.json.job_id, token, "failed", null, {
        code: "x",
        message: "the restore failed",
        retryable: false,
      }),
    );
    expect((await get(url(failed.json.id))).json).toMatchObject({
      status: "failed",
    });
    const missing = await get(`${url(failed.json.id)}/report`);
    expect(missing.status).toBe(404);

    // 3. A recorded key outside the verification's prefix is never served.
    const foreign = await post(`/builds/${b}/captures/${c}/verifications`, {
      scope: ["integrity"],
    });
    const manifestKey = `projects/${p}/builds/${b}/captures/${c}/manifest.json`;
    await runJob(foreign.json.job_id, (token) =>
      complete(
        h,
        runner,
        foreign.json.job_id,
        token,
        "succeeded",
        result(manifestKey),
      ),
    );
    const refused = await get(`${url(foreign.json.id)}/report`);
    expect(refused.status).toBe(404);
    expect(refused.raw).not.toContain('rea-web-recovery"');

    // Lists are newest first and authorised for viewers only inside the project.
    const list = await get(`/builds/${b}/captures/${c}/verifications?limit=2`);
    expect(list.json.items.map((x: any) => x.id)).toEqual([
      foreign.json.id,
      failed.json.id,
    ]);
    expect(list.json.items.map((x: any) => x.status)).toEqual([
      "completed",
      "failed",
    ]);
    const tail = await get(
      `/builds/${b}/captures/${c}/verifications?limit=2&cursor=${list.json.next_cursor}`,
    );
    expect(tail.json.items.map((x: any) => x.id)).toEqual([goodId]);
    expect(
      (await get(`/builds/${b}/captures/${c}/verifications`, viewer)).status,
    ).toBe(200);
    expect(
      (await get(`/builds/${b}/captures/${c}/verifications`, outsider)).status,
    ).toBe(404);
    expect((await get(`${url(goodId)}/report`, outsider)).status).toBe(404);
    expect((await get(`${url(goodId)}/report`, viewer)).status).toBe(200);
  });

  it("lists exports with an optional capture filter and serves a signature only for a signed export", async () => {
    const captures = (await get(`/builds/${b}/captures`)).json.items as Array<{
      id: string;
      status: string;
    }>;
    const c = captures.find((x) => x.status === "completed")?.id as string;
    const other = captures.find((x) => x.status !== "completed")?.id as string;
    const archive = Buffer.from("tar bytes");
    const signature = {
      format: "rea-web-export-signature",
      version: 1,
      algorithm: "ed25519",
      public_key_id: KEY_ID,
      archive_sha256: sha256(archive),
      signed_at: new Date().toISOString(),
      signature: "c2ln",
    };
    const signatureBytes = Buffer.from(`${JSON.stringify(signature)}\n`);

    const signed = await post(`/builds/${b}/captures/${c}/exports`, {
      sign_with_key_id: KEY_ID,
    });
    expect(signed.status).toBe(202);
    expect(signed.json).toMatchObject({ capture_id: c, status: "pending" });
    const signedUrl = `/builds/${b}/exports/${signed.json.id}/signature`;
    const early = await get(signedUrl);
    expect(early.status).toBe(409);
    expect(early.json.error.details.reason).toBe("signature_not_ready");

    await runJob(signed.json.job_id, async (token) => {
      await uploadArtifact(
        h,
        runner,
        signed.json.job_id,
        token,
        "export_archive",
        "export.tar",
        archive,
      );
      const sig = await uploadArtifact(
        h,
        runner,
        signed.json.job_id,
        token,
        "export_signature",
        "export.sig.json",
        signatureBytes,
      );
      const { signature: _value, ...summary } = signature;
      await complete(h, runner, signed.json.job_id, token, "succeeded", {
        export: {
          signature: {
            ...summary,
            object_key: sig.json.object_key,
            sha256: sig.json.sha256,
            size: sig.json.size,
          },
          encryption: null,
        },
      });
    });
    const served = await get(signedUrl);
    expect(served.status).toBe(200);
    expect(served.raw).toBe(signatureBytes.toString());
    expect(served.headers["x-content-sha256"]).toBe(sha256(signatureBytes));
    expect((await get(signedUrl, viewer)).status).toBe(200);
    expect((await get(signedUrl, outsider)).status).toBe(404);

    const unsigned = await post(`/builds/${b}/captures/${c}/exports`, {});
    await runJob(unsigned.json.job_id, async (token) => {
      await uploadArtifact(
        h,
        runner,
        unsigned.json.job_id,
        token,
        "export_archive",
        "export.tar",
        archive,
      );
      await complete(h, runner, unsigned.json.job_id, token, "succeeded", {
        export: { signature: null, encryption: null },
      });
    });
    const notSigned = await get(
      `/builds/${b}/exports/${unsigned.json.id}/signature`,
    );
    expect(notSigned.status).toBe(404);
    expect(notSigned.json.error.details.reason).toBe("not_signed");

    // Listing: newest first across the build, filtered by capture on request.
    const all = await get(`/builds/${b}/exports`);
    expect(all.json.items.map((x: any) => exportSchema.parse(x).id)).toEqual([
      unsigned.json.id,
      signed.json.id,
    ]);
    expect(all.json.items.map((x: any) => x.status)).toEqual([
      "completed",
      "completed",
    ]);
    const paged = await get(`/builds/${b}/exports?limit=1`);
    expect(paged.json.items).toHaveLength(1);
    const rest = await get(
      `/builds/${b}/exports?limit=1&cursor=${paged.json.next_cursor}`,
    );
    expect(rest.json.items.map((x: any) => x.id)).toEqual([signed.json.id]);
    expect(
      (await get(`/builds/${b}/exports?capture_id=${c}`)).json.items,
    ).toHaveLength(2);
    expect(
      (await get(`/builds/${b}/exports?capture_id=${other}`)).json.items,
    ).toEqual([]);
    expect(
      (
        await get(
          `/builds/${b}/exports?capture_id=0192f1a0-0000-7000-8000-00000000dead`,
        )
      ).status,
    ).toBe(404);
    expect((await get(`/builds/${b}/exports`, viewer)).status).toBe(200);
    expect((await get(`/builds/${b}/exports`, outsider)).status).toBe(404);
    expect((await get(`/builds/${b}/plans`, outsider)).status).toBe(404);
    expect((await get(`/builds/${b}/captures`, outsider)).status).toBe(404);
    // Another build's id never reveals this build's resources.
    const otherBuild = (
      await post("/builds", {
        name: "other",
        source: { kind: "git", url: "https://git.example.test/o.git" },
        components: [{ kind: "source", id: "main" }],
      })
    ).json.id;
    expect(
      (await get(`/builds/${otherBuild}/exports/${signed.json.id}/signature`))
        .status,
    ).toBe(404);
    expect((await get(`/builds/${otherBuild}/exports`)).json.items).toEqual([]);
  });
});
