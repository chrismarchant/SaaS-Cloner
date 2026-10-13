import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { restoreReportSchema } from "@rea-web/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateSigningKeyPair,
  restorePackage,
  signManifest,
  verifyPackage,
  createPackageBuilder,
} from "../src/index.js";
import {
  BUILD,
  CREATED_AT,
  PACKAGE_ID,
  PRODUCER,
  cleanupTempDirs,
  flipByte,
  makeTempDir,
} from "./helpers.js";
import {
  ADMIN_URL,
  HAS_DATABASE,
  baseOptions,
  createScratchDatabase,
  emptyDir,
  makePackage,
  nodeRun,
  scopeOf,
} from "./verifyFixture.js";

afterEach(cleanupTempDirs);

const MARKER = nodeRun("require('fs').writeFileSync('ran.txt', 'x')");

describe("integrity first", () => {
  it("verifies an untouched package and says so for every file", async () => {
    const { root } = await makePackage({ steps: [] });
    const report = await verifyPackage(root, { verifierVersion: "1.2.3" });
    expect(restoreReportSchema.safeParse(report).success).toBe(true);
    expect(report.overall).toBe("integrity_verified");
    expect(report.scopes.map((s) => [s.scope, s.status])).toEqual([
      ["integrity", "integrity_verified"],
    ]);
    expect(report.verifier).toMatchObject({
      name: "rea-recover",
      version: "1.2.3",
    });
    expect(report.manifest_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.guards.disabled_schedules).toEqual(["nightly"]);
    expect(report.guards.disabled_webhooks).toEqual([
      "https://hooks.example.com/x",
    ]);
    expect(report.network_required.verdict).toBe("unknown");
  });

  it("blocks every requested scope, and runs nothing, after one flipped byte", async () => {
    const { root } = await makePackage({
      steps: [
        { id: "build", scope: "clean_build", run: MARKER },
        { id: "data", scope: "data_restore", run: MARKER },
        { id: "check", scope: "behavior", run: MARKER },
      ],
    });
    await flipByte(join(root, "source/main/hello.txt"), 0);
    const target = await emptyDir("target");
    const report = await restorePackage(
      root,
      baseOptions({
        scopes: ["clean_build", "data_restore", "behavior"],
        target,
      }),
    );
    expect(report.scopes.map((s) => [s.scope, s.status])).toEqual([
      ["integrity", "blocked"],
      ["clean_build", "blocked"],
      ["data_restore", "blocked"],
      ["behavior", "blocked"],
    ]);
    expect(scopeOf(report, "integrity").detail).toContain(
      "source/main/hello.txt",
    );
    expect(scopeOf(report, "clean_build").detail).toContain("integrity");
    expect(report.overall).toBe("blocked");
    expect(report.scopes.flatMap((s) => s.steps)).toEqual([]);
    expect(await readdir(target)).toEqual([]);
  });

  it("blocks when the manifest is not readable", async () => {
    const dir = await emptyDir("nopkg");
    const report = await verifyPackage(dir, { verifierVersion: "x" });
    expect(restoreReportSchema.safeParse(report).success).toBe(true);
    expect(report.overall).toBe("blocked");
    expect(report.package_id).toBe("unknown");
  });

  it("checks the detached signature when a public key is supplied", async () => {
    const keys = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const workDir = await makeTempDir("signed");
    const builder = await createPackageBuilder({
      stagingDir: join(workDir, "package"),
    });
    builder.addComponent({
      id: "source:main",
      kind: "source",
      title: "s",
      status: "captured",
      captured_at: null,
      method: "m",
      root: "source/main/",
      restore: { steps: [] },
      limitations: [],
      omissions: [],
      details: {},
    });
    await builder.addFile("source:main", "source/main/a.txt", "a");
    builder.setSignature({
      algorithm: "ed25519",
      public_key_id: keys.keyId,
      detached_path: "manifest.json.sig",
    });
    await builder.finalize({
      packageId: PACKAGE_ID,
      build: BUILD,
      producer: PRODUCER,
      createdAt: CREATED_AT,
    });
    await signManifest(builder.root, keys.privateKeyPem, keys.publicKeyPem);

    const unchecked = await verifyPackage(builder.root, {
      verifierVersion: "x",
    });
    expect(scopeOf(unchecked, "integrity").detail).toContain("not verified");
    const good = await verifyPackage(builder.root, {
      verifierVersion: "x",
      publicKeyPem: keys.publicKeyPem,
    });
    expect(good.overall).toBe("integrity_verified");
    expect(scopeOf(good, "integrity").detail).toContain("signature valid");
    const bad = await verifyPackage(builder.root, {
      verifierVersion: "x",
      publicKeyPem: other.publicKeyPem,
    });
    expect(bad.overall).toBe("blocked");
    expect(scopeOf(bad, "integrity").detail).toContain("signature");
  });
});

describe("restore guards", () => {
  const BUILD_STEP = {
    id: "build",
    scope: "clean_build" as const,
    run: MARKER,
  };

  it("refuses a missing or non-empty target", async () => {
    const { root } = await makePackage({ steps: [BUILD_STEP] });
    const full = await emptyDir("full");
    await writeFile(join(full, "keep.txt"), "x");
    const nonEmpty = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target: full }),
    );
    expect(scopeOf(nonEmpty, "clean_build")).toMatchObject({
      status: "blocked",
    });
    expect(scopeOf(nonEmpty, "clean_build").detail).toContain("not empty");
    expect(await readdir(full)).toEqual(["keep.txt"]);

    const missing = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target: join(full, "nope") }),
    );
    expect(scopeOf(missing, "clean_build").detail).toContain("does not exist");
    const none = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"] }),
    );
    expect(scopeOf(none, "clean_build").detail).toContain("--target");
  });

  it("refuses a target, assets root or report path inside the package", async () => {
    const { root } = await makePackage({ steps: [BUILD_STEP] });
    const inside = join(root, "scratch");
    await mkdir(inside);
    const target = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target: inside }),
    );
    expect(scopeOf(target, "clean_build").detail).toContain(
      "inside the package",
    );
    const outside = await emptyDir("outside");
    const assets = await restorePackage(
      root,
      baseOptions({
        scopes: ["clean_build"],
        target: outside,
        assetsRoot: join(root, "assets"),
      }),
    );
    expect(scopeOf(assets, "clean_build").detail).toContain("assets root");
    expect(await readdir(root)).not.toContain("assets");
    const report = await restorePackage(
      root,
      baseOptions({
        scopes: ["clean_build"],
        target: outside,
        reportPath: join(root, "recovery", "report.json"),
      }),
    );
    // integrity held, the restore scope did not: the mixed-scope rule applies
    expect(report.overall).toBe("partial");
    expect(scopeOf(report, "clean_build").detail).toContain("report path");
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses a target reached through a symlink into the package", async () => {
    const { root } = await makePackage({ steps: [BUILD_STEP] });
    const dir = await emptyDir("links");
    const link = join(dir, "link");
    await mkdir(join(root, "scratch"));
    await symlink(join(root, "scratch"), link);
    const report = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target: link }),
    );
    expect(scopeOf(report, "clean_build").detail).toContain(
      "inside the package",
    );
  });

  it("accepts --allow-production but refuses it in verification", async () => {
    const { root } = await makePackage({ steps: [BUILD_STEP] });
    const target = await emptyDir("prod");
    const restore = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target, allowProduction: true }),
    );
    expect(restore.overall).toBe("blocked");
    expect(scopeOf(restore, "clean_build").detail).toContain(
      "allow-production",
    );
    expect(await readdir(target)).toEqual([]);
    const verify = await verifyPackage(root, {
      verifierVersion: "x",
      allowProduction: true,
    });
    expect(verify.overall).toBe("blocked");
    expect(scopeOf(verify, "integrity").detail).toContain("allow-production");
  });

  it("blocks data_restore for a blocked database host (case, trailing dot)", async () => {
    const { root } = await makePackage({
      steps: [
        {
          id: "restore",
          scope: "data_restore",
          run: nodeRun("process.exit(0)", "{{database_url}}"),
          network: "database",
        },
      ],
      blockedHosts: ["db.prod.example.com"],
    });
    const target = await emptyDir("host");
    const report = await restorePackage(
      root,
      baseOptions({
        scopes: ["data_restore"],
        target,
        databaseUrl: "postgres://app:secretpw99@DB.Prod.Example.COM.:5432/app",
      }),
    );
    const scope = scopeOf(report, "data_restore");
    expect(scope.status).toBe("blocked");
    expect(scope.detail).toContain("blocked_hosts");
    expect(scope.detail).toContain("db.prod.example.com");
    expect(scope.steps).toEqual([]);
    expect(report.guards.database_host).toBe("db.prod.example.com");
    expect(JSON.stringify(report)).not.toContain("secretpw99");
  });

  it("blocks data_restore when no database was supplied or the URL is unusable", async () => {
    const { root } = await makePackage({
      steps: [
        {
          id: "restore",
          scope: "data_restore",
          run: nodeRun("process.exit(0)"),
          network: "database",
        },
      ],
    });
    const target = await emptyDir("nodb");
    const none = await restorePackage(
      root,
      baseOptions({ scopes: ["data_restore"], target }),
    );
    expect(scopeOf(none, "data_restore").detail).toContain("database-url-env");
    const bad = await restorePackage(
      root,
      baseOptions({
        scopes: ["data_restore"],
        target,
        databaseUrl: "mysql://u:hunter2hunter2@h/db",
      }),
    );
    expect(scopeOf(bad, "data_restore").detail).toContain("postgres");
    expect(JSON.stringify(bad)).not.toContain("hunter2");
  });

  it.skipIf(!HAS_DATABASE)(
    "refuses a database that already holds tables",
    async () => {
      const db = await createScratchDatabase();
      try {
        const { execFileSync } = await import("node:child_process");
        execFileSync(
          "psql",
          [
            "-X",
            "-q",
            "--dbname",
            db.url.replace(`:${db.password}`, ""),
            "-c",
            "create table leftover (id int)",
          ],
          { env: { PATH: process.env["PATH"] ?? "", PGPASSWORD: db.password } },
        );
        const { root } = await makePackage({
          steps: [
            {
              id: "restore",
              scope: "data_restore",
              run: nodeRun(MARKER[2] ?? ""),
              network: "database",
            },
          ],
        });
        const target = await emptyDir("nonemptydb");
        const report = await restorePackage(
          root,
          baseOptions({
            scopes: ["data_restore"],
            target,
            databaseUrl: db.url,
          }),
        );
        const scope = scopeOf(report, "data_restore");
        expect(scope.status).toBe("blocked");
        expect(scope.detail).toContain("not empty");
        expect(scope.steps).toEqual([]);
        expect(await readdir(target)).toEqual([]);
        expect(JSON.stringify(report)).not.toContain(db.password);
      } finally {
        await db.drop();
      }
      expect(ADMIN_URL).not.toBe("");
    },
  );
});

describe("tool preflight", () => {
  it("blocks the scope, runs nothing, and names a missing tool", async () => {
    const { root } = await makePackage({
      steps: [
        { id: "first", scope: "clean_build", run: MARKER },
        {
          id: "second",
          scope: "clean_build",
          run: nodeRun("process.exit(0)"),
          requires: ["definitely-not-a-real-tool-xyz"],
        },
      ],
    });
    const target = await emptyDir("tools");
    const report = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target }),
    );
    const scope = scopeOf(report, "clean_build");
    expect(scope.status).toBe("blocked");
    expect(scope.missing_tools).toEqual(["definitely-not-a-real-tool-xyz"]);
    expect(scope.steps).toEqual([]);
    expect(await readdir(target)).toEqual([]);
  });

  it("blocks when a tool is older than the declared minimum", async () => {
    const { root } = await makePackage({
      steps: [
        {
          id: "needs-new-git",
          scope: "clean_build",
          run: nodeRun("process.exit(0)"),
          requires: ["git>=99.1"],
        },
      ],
    });
    const target = await emptyDir("old");
    const report = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target }),
    );
    const scope = scopeOf(report, "clean_build");
    expect(scope.status).toBe("blocked");
    expect(scope.missing_tools).toHaveLength(1);
    expect(scope.missing_tools[0]).toMatch(/^git>=99\.1 \(found \d+\.\d+/u);
  });

  it("blocks a program that is on no PATH even if undeclared", async () => {
    const { root } = await makePackage({
      steps: [
        {
          id: "ghost",
          scope: "clean_build",
          run: ["no-such-program-abc", "--go"],
        },
      ],
    });
    const target = await emptyDir("ghost");
    const report = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target }),
    );
    expect(scopeOf(report, "clean_build")).toMatchObject({
      status: "blocked",
      missing_tools: ["no-such-program-abc"],
    });
  });

  it("accepts a satisfied minimum version", async () => {
    const { root } = await makePackage({
      steps: [
        {
          id: "ok",
          scope: "clean_build",
          run: nodeRun("process.exit(0)"),
          requires: ["git>=1.0", "node"],
        },
      ],
    });
    const target = await emptyDir("okver");
    const report = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target }),
    );
    expect(scopeOf(report, "clean_build").status).toBe("clean_build_verified");
  });
});
