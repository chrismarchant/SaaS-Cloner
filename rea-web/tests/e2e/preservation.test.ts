/**
 * Preserve workflow end to end through public interfaces: the built API and
 * runner processes, PostgreSQL, a filesystem object store, and the
 * preservation fixture (a real git repository with submodule, LFS and
 * uncommitted work, a PostgreSQL database with its own role, and an assets
 * directory). Local paths reach the runner only through its allowlist.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  captureSchema,
  preservationPlanSchema,
  recoveryManifestSchema,
  restoreReportSchema,
} from "@rea-web/contracts";
import {
  createFixtureBuild,
  DB_ENV_NAME,
  fullBuild,
  HAS_DATABASE,
  type FixtureBuild,
} from "../../packages/preservation/test/fixtureBuild.js";
import { localPathHash } from "../../apps/runner/src/preservation/localPaths.js";
import {
  decryptExport,
  generateRecoveryKey,
  generateSigningKeyPair,
  unpackExport,
  verifyIntegrity,
} from "@rea-web/recovery";
import { REA_WEB_ROOT, Stack, stackUnavailableReason } from "./stack.js";

const unavailable =
  stackUnavailableReason() ?? (HAS_DATABASE ? null : "no database");
if (unavailable) console.warn(`e2e skipped: ${unavailable}`);
const describeStack = unavailable ? describe.skip : describe;

describeStack("preserve workflow through the built API and runner", () => {
  const stack = new Stack();
  let scratch = "";
  let fx: FixtureBuild;
  let project = "";
  let runnerId = "";
  let buildId = "";
  let captureId = "";
  const recoveryKey = generateRecoveryKey();
  const signingKey = generateSigningKeyPair();

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "rea-web-e2e-preserve-"));
    fx = await createFixtureBuild(join(scratch, "fx"));
    await stack.start();
    const registered = await stack.request("POST", "/auth/register", {
      body: {
        email: "preserver@example.test",
        password: "correct horse battery",
      },
    });
    project = registered.json.memberships[0].project_id;
    const runner = await stack.request("POST", `/projects/${project}/runners`, {
      body: { name: "e2e-preserve", labels: [] },
    });
    runnerId = runner.json.id;
    // Recovery keys live in their own directory, outside every package.
    const keysDir = join(scratch, "keys");
    await mkdir(keysDir, { mode: 0o700 });
    await writeFile(
      join(keysDir, `${recoveryKey.keyId}.key`),
      recoveryKey.keyBase64,
      {
        mode: 0o600,
      },
    );
    const signingDir = join(scratch, "signing");
    await mkdir(signingDir, { mode: 0o700 });
    await writeFile(
      join(signingDir, `${signingKey.keyId}.pem`),
      signingKey.privateKeyPem,
      {
        mode: 0o600,
      },
    );
    stack.startRunner(runner.json.token, {
      REA_WEB_RECOVERY_KEYS_DIR: keysDir,
      REA_WEB_EXPORT_SIGNING_KEYS_DIR: signingDir,
      // Restore credentials are separate from the capture credential.
      REA_WEB_VERIFY_DATABASE_ADMIN_URL: fx.adminDatabaseUrl,
      REA_WEB_VERIFY_ALLOW_NETWORK: "registry",
      REA_WEB_RUNNER_LOCAL_TARGET_ALLOWLIST: `${fx.repoPath}:${fx.assetsPath}`,
      // The capture credential lives only on the runner, under the declared name.
      [DB_ENV_NAME]: fx.databaseUrl,
    });
    await stack.waitFor(async () => {
      const list = await stack.request("GET", `/projects/${project}/runners`);
      return list.json.items?.[0]?.status === "online";
    }, 120_000);
  }, 300_000);

  afterAll(async () => {
    await stack.stop();
    await fx?.cleanup();
    await rm(scratch, { recursive: true, force: true });
  });

  const waitForJob = async (jobId: string): Promise<any> => {
    let job: any = null;
    await stack.waitFor(async () => {
      job = (await stack.request("GET", `/projects/${project}/jobs/${jobId}`))
        .json;
      return ["succeeded", "failed", "cancelled"].includes(job?.state);
    }, 300_000);
    return job;
  };

  it("plans and captures a build on the runner, with credentials only on the runner", async () => {
    const declared = fullBuild(fx);
    const repoHash = localPathHash(await realpath(fx.repoPath));
    const assetsHash = localPathHash(await realpath(fx.assetsPath));
    const components = declared.components.map((c) =>
      c.kind === "assets" && c.source.kind === "runner_local"
        ? {
            ...c,
            source: { ...c.source, runner_id: runnerId, path_hash: assetsHash },
          }
        : c,
    );
    const build = await stack.request("POST", `/projects/${project}/builds`, {
      body: {
        name: declared.name,
        description: declared.description,
        source: {
          ...declared.source,
          runner_id: runnerId,
          path_hash: repoHash,
        },
        components,
        runner_id: runnerId,
      },
    });
    expect(build.status, build.text).toBe(201);
    // The build definition stored by the control plane holds no credential.
    expect(build.text).not.toContain(fx.databasePassword);

    const planned = await stack.request(
      "POST",
      `/projects/${project}/builds/${build.json.id}/plans`,
      { body: {} },
    );
    expect(planned.status).toBe(202);
    const planJob = await waitForJob(planned.json.id);
    expect(planJob.state, JSON.stringify(planJob.failure)).toBe("succeeded");
    const plan = preservationPlanSchema.parse(
      (
        await stack.request(
          "GET",
          `/projects/${project}/builds/${build.json.id}/plans/${planned.json.plan_id}`,
        )
      ).json,
    );
    expect(plan.components.find((c) => c.id === "source:main")?.feasible).toBe(
      true,
    );
    expect(plan.components.find((c) => c.id === "data:db")?.feasible).toBe(
      true,
    );

    const captured = await stack.request(
      "POST",
      `/projects/${project}/builds/${build.json.id}/captures`,
      { body: { plan_id: planned.json.plan_id } },
    );
    expect(captured.status).toBe(202);
    const captureJob = await waitForJob(captured.json.job_id);
    expect(captureJob.state, JSON.stringify(captureJob.failure)).toBe(
      "succeeded",
    );
    const capture = captureSchema.parse(
      (
        await stack.request(
          "GET",
          `/projects/${project}/builds/${build.json.id}/captures/${captured.json.id}`,
        )
      ).json,
    );
    expect(capture.status).toBe("completed");
    buildId = build.json.id;
    captureId = captured.json.id;
    expect(capture.component_statuses["source:main"]).toBe("captured");
    expect(capture.component_statuses["data:db"]).toBe("captured");
    const manifestResponse = await stack.request(
      "GET",
      `/projects/${project}/builds/${build.json.id}/captures/${captured.json.id}/manifest`,
    );
    const manifest = recoveryManifestSchema.parse(manifestResponse.json);
    expect(manifest.secrets.mode).toBe("names_only");
    expect(manifest.secrets.names).toContain(DB_ENV_NAME);
    expect(manifest.files.some((f) => f.path.endsWith("repo.bundle"))).toBe(
      true,
    );
    expect(manifest.files.some((f) => f.path.endsWith("dump.pgc"))).toBe(true);
    // The list routes find what was just created, and coverage comes from the manifest.
    const listed = async (path: string) =>
      (
        await stack.request(
          "GET",
          `/projects/${project}/builds/${build.json.id}/${path}`,
        )
      ).json.items.map((item: { id: string }) => item.id);
    expect(await listed("plans")).toEqual([planned.json.plan_id]);
    expect(await listed("captures")).toEqual([captured.json.id]);
    const coverage = await stack.request(
      "GET",
      `/projects/${project}/builds/${build.json.id}/captures/${captured.json.id}/coverage`,
    );
    expect(coverage.json.missing_or_blocked).toEqual(
      manifest.missing_or_blocked,
    );
    // Neither the fixture secret nor the database password left the runner.
    for (const text of [
      manifestResponse.text,
      JSON.stringify(captureJob),
      stack.logs,
    ]) {
      expect(text).not.toContain(fx.secretMarker);
      expect(text).not.toContain(fx.databasePassword);
    }
  });

  const exportCapture = async (body: Record<string, unknown>) => {
    const created = await stack.request(
      "POST",
      `/projects/${project}/builds/${buildId}/captures/${captureId}/exports`,
      { body },
    );
    expect(created.status, created.text).toBe(202);
    const job = await waitForJob(created.json.job_id);
    expect(job.state, JSON.stringify(job.failure)).toBe("succeeded");
    const view = (
      await stack.request(
        "GET",
        `/projects/${project}/builds/${buildId}/exports/${created.json.id}`,
      )
    ).json;
    const response = await fetch(
      `${stack.apiUrl}/api/v1/projects/${project}/builds/${buildId}/exports/${created.json.id}/download`,
      { headers: { cookie: stack.cookie } },
    );
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { view, bytes };
  };

  it("exports the capture as a tar and as an encrypted archive that restore tooling opens", async () => {
    expect(captureId).not.toBe("");
    const plain = await exportCapture({});
    expect(plain.view.status).toBe("completed");
    const tar = join(scratch, "export.tar");
    await writeFile(tar, plain.bytes);
    const unpacked = join(scratch, "unpacked-plain");
    const plainRoot = (await unpackExport(tar, unpacked)).root;
    expect((await verifyIntegrity(plainRoot)).ok).toBe(true);

    const sealed = await exportCapture({
      encrypt_to_recipients: [recoveryKey.keyId],
    });
    expect(sealed.view.encryption).toMatchObject({
      scheme: "aes-256-gcm-envelope",
      recipients: [recoveryKey.keyId],
      key_location: "external",
    });
    // The archive is ciphertext and holds no key material.
    expect(sealed.bytes.includes(Buffer.from(recoveryKey.keyBase64))).toBe(
      false,
    );
    expect(sealed.bytes.includes(Buffer.from("manifest.json"))).toBe(false);
    const encrypted = join(scratch, "export.tar.enc");
    await writeFile(encrypted, sealed.bytes);
    const decrypted = join(scratch, "decrypted.tar");
    await decryptExport(encrypted, decrypted, {
      keyBase64: recoveryKey.keyBase64,
    });
    const opened = join(scratch, "unpacked-sealed");
    const sealedRoot = (await unpackExport(decrypted, opened)).root;
    expect((await verifyIntegrity(sealedRoot)).ok).toBe(true);

    // A key the runner does not hold is refused, not silently skipped.
    const missingKey = await stack.request(
      "POST",
      `/projects/${project}/builds/${buildId}/captures/${captureId}/exports`,
      { body: { encrypt_to_recipients: ["not-a-key-on-this-runner"] } },
    );
    const refused = await waitForJob(missingKey.json.job_id);
    expect(refused.state).toBe("failed");
    expect(refused.failure.message).toContain("not on this runner");
  });

  it("signs an export on the runner and the standalone verifier checks it before unpacking", async () => {
    expect(captureId).not.toBe("");
    const signed = await exportCapture({ sign_with_key_id: signingKey.keyId });
    expect(signed.view.signature).toMatchObject({
      format: "rea-web-export-signature",
      algorithm: "ed25519",
      public_key_id: signingKey.keyId,
      archive_sha256: signed.view.sha256,
    });
    expect(JSON.stringify(signed.view)).not.toContain("PRIVATE KEY");
    const dir = join(scratch, "signed");
    await mkdir(dir);
    const archive = join(dir, "export.tar");
    await writeFile(archive, signed.bytes);
    const sigPath = join(dir, "export.sig.json");
    const {
      object_key: _k,
      sha256: _s,
      size: _z,
      ...document
    } = signed.view.signature;
    await writeFile(sigPath, JSON.stringify(document));
    const publicKey = join(dir, "public.pem");
    await writeFile(publicKey, signingKey.publicKeyPem);
    const bundle = join(REA_WEB_ROOT, "apps/recover-cli/dist/rea-recover.mjs");
    const run = (args: string[]) =>
      spawnSync(process.execPath, [bundle, ...args], {
        encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "" },
      });
    const ok = run([
      "verify",
      archive,
      "--archive-signature",
      sigPath,
      "--archive-key",
      publicKey,
    ]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("archive signature: verified");
    // One flipped byte in the archive: refused before anything is unpacked.
    const tampered = Buffer.from(signed.bytes);
    tampered.writeUInt8((tampered.at(-1) ?? 0) ^ 0xff, tampered.length - 1);
    const bad = join(dir, "tampered.tar");
    await writeFile(bad, tampered);
    const refused = run([
      "verify",
      bad,
      "--archive-signature",
      sigPath,
      "--archive-key",
      publicKey,
    ]);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain("archive digest does not match");
    // A different key is refused too.
    const other = join(dir, "other.pem");
    await writeFile(other, generateSigningKeyPair().publicKeyPem);
    expect(
      run([
        "verify",
        archive,
        "--archive-signature",
        sigPath,
        "--archive-key",
        other,
      ]).status,
    ).toBe(3);
  });

  it("verifies the stored capture by restoring it into a disposable target and database", async () => {
    expect(captureId).not.toBe("");
    const created = await stack.request(
      "POST",
      `/projects/${project}/builds/${buildId}/captures/${captureId}/verifications`,
      {
        body: {
          scope: ["integrity", "clean_build", "data_restore", "behavior"],
        },
      },
    );
    expect(created.status, created.text).toBe(202);
    const job = await waitForJob(created.json.job_id);
    expect(job.state, JSON.stringify(job.failure)).toBe("succeeded");
    const verification = (
      await stack.request(
        "GET",
        `/projects/${project}/builds/${buildId}/captures/${captureId}/verifications/${created.json.id}`,
      )
    ).json;
    expect(
      Object.fromEntries(
        verification.results.map((r: { scope: string; status: string }) => [
          r.scope,
          r.status,
        ]),
      ),
      JSON.stringify(verification.results),
    ).toEqual({
      integrity: "integrity_verified",
      clean_build: "clean_build_verified",
      data_restore: "data_restore_verified",
      behavior: "behavior_verified",
    });
    expect(verification.overall).toBe("behavior_verified");
    expect(verification.status).toBe("completed");
    const report = await stack.request(
      "GET",
      `/projects/${project}/builds/${buildId}/captures/${captureId}/verifications/${created.json.id}/report`,
    );
    expect(report.status, report.text).toBe(200);
    expect(restoreReportSchema.parse(report.json).overall).toBe(
      "behavior_verified",
    );
    expect(report.text).not.toContain(fx.databasePassword);
    const verifications = await stack.request(
      "GET",
      `/projects/${project}/builds/${buildId}/captures/${captureId}/verifications`,
    );
    expect(
      verifications.json.items.map((item: { id: string }) => item.id),
    ).toEqual([created.json.id]);
    // A registry step (npm ci) was needed, so the package is not network-free.
    expect(verification.network_required.verdict).toBe("yes");
    for (const text of [
      JSON.stringify(verification),
      JSON.stringify(job),
      stack.logs,
    ]) {
      expect(text).not.toContain(fx.databasePassword);
      expect(text).not.toContain(fx.secretMarker);
    }
  });

  it("refuses a git source that names a path on the runner host", async () => {
    const build = await stack.request("POST", `/projects/${project}/builds`, {
      body: {
        name: "host path",
        source: { kind: "git", url: fx.repoPath },
        components: [{ kind: "source", id: "main" }],
        runner_id: runnerId,
      },
    });
    expect(build.status).toBe(201);
    const planned = await stack.request(
      "POST",
      `/projects/${project}/builds/${build.json.id}/plans`,
      { body: {} },
    );
    const job = await waitForJob(planned.json.id);
    expect(job.state).toBe("failed");
    expect(job.failure.code).toBe("unsafe_url");
  });
});
