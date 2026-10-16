import { afterAll, beforeAll, expect, it } from "vitest";
import {
  captureSchema,
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

const plan = {
  components: [
    {
      id: "source:main",
      kind: "source",
      collector: "git",
      permissions: [{ check: "git ls-remote", ok: true, detail: "reachable" }],
      estimated_bytes: 1024,
      dependencies: [],
      method: "git bundle --all",
      omissions: [],
      feasible: true,
    },
  ],
  consistency_strategy: "source only; no data or assets declared",
  known_omissions: [],
};

describeDb("preserve and restore lifecycle", () => {
  let h: Harness;
  let owner: Account;
  let p: string;
  let runner: RunnerHandle;
  const base = () => `/api/v1/projects/${p}`;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.register("preserve@example.com");
    p = owner.defaultProjectId as string;
    runner = await createRunner(h, owner, p, "preserve-runner");
    await registerRunner(h, runner, reportFor("preserve-runner"));
  });
  afterAll(async () => {
    await h.close();
  });

  /** Claim the next job, move it to running and return its token. */
  const running = async (jobId: string) => {
    const claimed = await claimOne(h, runner);
    expect(claimed.jobId).toBe(jobId);
    await transition(h, runner, jobId, claimed.token, "running");
    return claimed.token;
  };

  it("plans, captures, verifies and exports a build, refusing results that break the contract", async () => {
    const build = await h.api("POST", `${base()}/builds`, {
      auth: owner.auth,
      body: {
        name: "notes",
        source: { kind: "git", url: "https://git.example.test/notes.git" },
        components: [{ kind: "source", id: "main" }],
      },
    });
    expect(build.status).toBe(201);
    const b = build.json.id as string;

    // Plan.
    const planned = await h.api("POST", `${base()}/builds/${b}/plans`, {
      auth: owner.auth,
      body: {},
    });
    expect(planned.status).toBe(202);
    const planUrl = `${base()}/builds/${b}/plans/${planned.json.plan_id}`;
    expect(
      (await h.api("GET", planUrl, { auth: owner.auth })).json.error.details
        .reason,
    ).toBe("plan_not_ready");
    const planToken = await running(planned.json.id);
    // A result that does not match the plan contract is refused, loudly.
    const malformed = await complete(
      h,
      runner,
      planned.json.id,
      planToken,
      "succeeded",
      {
        plan: { components: "all of them" },
      },
    );
    expect(malformed.status).toBe(400);
    expect(malformed.json.error.code).toBe("validation_failed");
    expect(JSON.stringify(malformed.json.error.details.issues)).toContain(
      "plan.components",
    );
    expect((await h.repos.jobs.findById(planned.json.id))?.state).toBe(
      "running",
    );
    expect(
      (
        await complete(h, runner, planned.json.id, planToken, "succeeded", {
          plan,
        })
      ).status,
    ).toBe(200);
    const planView = preservationPlanSchema.parse(
      (await h.api("GET", planUrl, { auth: owner.auth })).json,
    );
    expect(planView.components[0]?.id).toBe("source:main");

    // Capture.
    const captured = await h.api("POST", `${base()}/builds/${b}/captures`, {
      auth: owner.auth,
      body: { plan_id: planned.json.plan_id },
    });
    expect(captured.status).toBe(202);
    const c = captured.json.id as string;
    const captureToken = await running(captured.json.job_id);
    const bundle = Buffer.from("bundle bytes");
    expect(
      (
        await uploadArtifact(
          h,
          runner,
          captured.json.job_id,
          captureToken,
          "capture_file",
          "source/main/repo.bundle",
          bundle,
        )
      ).status,
    ).toBe(201);
    const manifest = Buffer.from(
      JSON.stringify({ format: "rea-web-recovery" }),
    );
    expect(
      (
        await uploadArtifact(
          h,
          runner,
          captured.json.job_id,
          captureToken,
          "capture_manifest",
          "manifest.json",
          manifest,
        )
      ).status,
    ).toBe(201);
    const captureResult = {
      capture: {
        consistency: "single_point",
        component_statuses: { "source:main": "captured" },
        manifest_sha256: sha256(manifest),
        package_id: "0192f1a0-0000-7000-8000-000000000001",
        files: 2,
        bytes: bundle.length + manifest.length,
      },
    };
    const missingDigest = await complete(
      h,
      runner,
      captured.json.job_id,
      captureToken,
      "succeeded",
      {
        capture: { ...captureResult.capture, manifest_sha256: undefined },
      },
    );
    expect(missingDigest.status).toBe(400);
    expect(
      (
        await complete(
          h,
          runner,
          captured.json.job_id,
          captureToken,
          "succeeded",
          captureResult,
        )
      ).status,
    ).toBe(200);
    const captureView = captureSchema.parse(
      (
        await h.api("GET", `${base()}/builds/${b}/captures/${c}`, {
          auth: owner.auth,
        })
      ).json,
    );
    expect(captureView).toMatchObject({
      status: "completed",
      consistency: "single_point",
      component_statuses: { "source:main": "captured" },
      manifest_sha256: sha256(manifest),
    });
    const served = await h.api(
      "GET",
      `${base()}/builds/${b}/captures/${c}/manifest`,
      {
        auth: owner.auth,
      },
    );
    expect(served.status).toBe(200);
    expect(served.raw).toBe(manifest.toString());

    // Verification.
    const verify = await h.api(
      "POST",
      `${base()}/builds/${b}/captures/${c}/verifications`,
      {
        auth: owner.auth,
        body: { scope: ["integrity"] },
      },
    );
    expect(verify.status).toBe(202);
    const verifyToken = await running(verify.json.job_id);
    const performedAt = new Date().toISOString();
    expect(
      (
        await complete(
          h,
          runner,
          verify.json.job_id,
          verifyToken,
          "succeeded",
          {
            verification: {
              results: [
                {
                  scope: "integrity",
                  status: "integrity_verified",
                  detail: "every file hash matched",
                  performed_at: performedAt,
                  evidence_object_key: null,
                },
              ],
              network_required: { verdict: "no", reasons: [] },
              overall: "integrity_verified",
            },
          },
        )
      ).status,
    ).toBe(200);
    const verification = verificationSchema.parse(
      (
        await h.api(
          "GET",
          `${base()}/builds/${b}/captures/${c}/verifications/${verify.json.id}`,
          {
            auth: owner.auth,
          },
        )
      ).json,
    );
    expect(verification.overall).toBe("integrity_verified");

    // Export.
    const exported = await h.api(
      "POST",
      `${base()}/builds/${b}/captures/${c}/exports`,
      {
        auth: owner.auth,
        body: {},
      },
    );
    expect(exported.status).toBe(202);
    const exportToken = await running(exported.json.job_id);
    const archive = Buffer.from("tar bytes");
    expect(
      (
        await uploadArtifact(
          h,
          runner,
          exported.json.job_id,
          exportToken,
          "export_archive",
          "export.tar",
          archive,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await complete(
          h,
          runner,
          exported.json.job_id,
          exportToken,
          "succeeded",
          {
            export: { signature: null, encryption: null },
          },
        )
      ).status,
    ).toBe(200);
    const exportView = exportSchema.parse(
      (
        await h.api(
          "GET",
          `${base()}/builds/${b}/exports/${exported.json.id}`,
          { auth: owner.auth },
        )
      ).json,
    );
    expect(exportView).toMatchObject({
      status: "completed",
      sha256: sha256(archive),
    });
    const download = await h.api(
      "GET",
      `${base()}/builds/${b}/exports/${exported.json.id}/download`,
      {
        auth: owner.auth,
      },
    );
    expect(download.status).toBe(200);
    expect(download.raw).toBe(archive.toString());
  });
});
