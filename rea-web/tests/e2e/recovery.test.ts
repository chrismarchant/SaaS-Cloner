/**
 * Gate G04: standalone restore and clean verification. The package is built
 * at test time from the preservation fixture, exported as a tar, and restored
 * by the verifier embedded in that package, from a directory that holds
 * nothing else, with PATH and one database-URL variable as the environment.
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type RestoreReport, restoreReportSchema } from "@rea-web/contracts";
import { capturePackage, planPreservation } from "@rea-web/preservation";
import { materializeGeneratedFiles, packExport } from "@rea-web/recovery";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HAS_DATABASE,
  createFixtureBuild,
  fullBuild,
  makeContext,
  type FixtureBuild,
} from "../../packages/preservation/test/fixtureBuild.js";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_DIR = join(ROOT, "apps/recover-cli");
const expectations = JSON.parse(
  await readFile(join(ROOT, "fixtures/recovery/expectations.json"), "utf8"),
) as {
  scopes: string[];
  overall: string;
  package_dir_name: string;
  source_id: string;
  invariant: { id: string; expected: string };
  restored_files: Record<string, string>;
  absent_from_restored_tree: string[];
};

const haveTool = (name: string): boolean => {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const missing = ["git", "psql", "pg_dump", "pg_restore", "npm"].filter(
  (t) => !haveTool(t),
);
if (!HAS_DATABASE || missing.length > 0)
  console.warn(
    `recovery e2e skipped: ${HAS_DATABASE ? `missing tools ${missing.join(", ")}` : "REA_WEB_TEST_DATABASE_URL is not set"}`,
  );
const describeRecovery =
  HAS_DATABASE && missing.length === 0 ? describe : describe.skip;

interface Cli {
  code: number;
  stdout: string;
  stderr: string;
}

const sha256 = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");

describeRecovery("clean restore from an exported package alone", () => {
  let scratch = "";
  let fx: FixtureBuild;
  let distBundle = "";
  let cleanDir = "";
  let unpacked = "";
  let embedded = "";
  let embeddedSha = "";
  let packageSha = "";
  let dbUrl = "";
  let dbPassword = "";
  const cleanup: (() => Promise<void>)[] = [];

  const psqlAdmin = async (sql: string): Promise<void> => {
    const url = new URL(fx.adminDatabaseUrl);
    const password = decodeURIComponent(url.password);
    url.password = "";
    await run(
      "psql",
      [
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "--dbname",
        url.toString(),
        "-c",
        sql,
      ],
      { env: { PATH: process.env["PATH"] ?? "", PGPASSWORD: password } },
    );
  };

  const newDisposableDatabase = async (): Promise<{
    url: string;
    password: string;
  }> => {
    const suffix = randomBytes(5).toString("hex");
    const role = `rec_role_${suffix}`;
    const name = `rec_db_${suffix}`;
    const password = `rec_pw_${randomBytes(12).toString("hex")}`;
    await psqlAdmin(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    await psqlAdmin(`CREATE DATABASE ${name} OWNER ${role}`);
    cleanup.push(async () => {
      await psqlAdmin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await psqlAdmin(`DROP ROLE IF EXISTS ${role}`);
    });
    const u = new URL(fx.adminDatabaseUrl);
    u.pathname = `/${name}`;
    u.username = role;
    u.password = password;
    return { url: u.toString(), password };
  };

  const countNotes = async (url: string, password: string): Promise<string> => {
    const u = new URL(url);
    u.password = "";
    const r = await run(
      "psql",
      [
        "-X",
        "-A",
        "-t",
        "-q",
        "--dbname",
        u.toString(),
        "-c",
        "select count(*) from notes",
      ],
      { env: { PATH: process.env["PATH"] ?? "", PGPASSWORD: password } },
    );
    return r.stdout.trim();
  };

  /** Run a copy of the bundle with PATH (and optional extras) as the whole environment. */
  const node = async (
    script: string,
    args: string[],
    env: Record<string, string> = {},
  ): Promise<Cli> => {
    try {
      const r = await run(process.execPath, [script, ...args], {
        cwd: cleanDir,
        env: { PATH: process.env["PATH"] ?? "", ...env },
        maxBuffer: 32 * 1024 * 1024,
      });
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return {
        code: e.code ?? -1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      };
    }
  };

  const readReport = async (path: string): Promise<RestoreReport> =>
    restoreReportSchema.parse(JSON.parse(await readFile(path, "utf8")));

  const emptyTarget = async (label: string): Promise<string> => {
    const dir = await mkdtemp(join(cleanDir, `${label}-`));
    return dir;
  };

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "rea-recovery-e2e-"));

    // Build the verifier bundle exactly as `npm run build` does.
    const tsc = require.resolve("typescript/bin/tsc");
    execFileSync(
      process.execPath,
      [tsc, "-b", "packages/preservation", "apps/recover-cli"],
      { cwd: ROOT },
    );
    execFileSync(process.execPath, ["build.mjs"], { cwd: CLI_DIR });
    distBundle = join(CLI_DIR, "dist", "rea-recover.mjs");

    // 1. Capture the preservation fixture with the bundle embedded.
    fx = await createFixtureBuild(join(scratch, "fx"));
    const tc = makeContext(join(scratch, "ws"), fx);
    await mkdir(join(scratch, "ws"), { recursive: true });
    const build = fullBuild(fx);
    const plan = await planPreservation(build, tc.ctx);
    const pkg = join(scratch, expectations.package_dir_name);
    const captured = await capturePackage(build, plan, tc.ctx, {
      stagingDir: pkg,
      producerVersion: "0.0.0-e2e",
      verifierBundlePath: distBundle,
    });
    packageSha = sha256(await readFile(join(pkg, "manifest.json")));

    // 2. Export, 3. move only the tar into a fresh directory.
    const exportDir = join(scratch, "export");
    await mkdir(exportDir);
    const exported = await packExport(pkg, join(exportDir, "package.tar"));
    cleanDir = join(scratch, "clean");
    await mkdir(cleanDir);
    await cp(exported.path, join(cleanDir, "package.tar"));
    expect(
      captured.manifest.files.some(
        (f) => f.path === "recovery/rea-recover.mjs",
      ),
    ).toBe(true);

    // Remove everything the restore must not be able to lean on.
    await rm(pkg, { recursive: true, force: true });
    await rm(exportDir, { recursive: true, force: true });

    // 4. Unpack with a lone copy of the bundle.
    const lone = join(cleanDir, "lone");
    await mkdir(lone);
    await cp(distBundle, join(lone, "rea-recover.mjs"));
    unpacked = join(cleanDir, "unpacked");
    const unpack = await node(join(lone, "rea-recover.mjs"), [
      "unpack",
      join(cleanDir, "package.tar"),
      "--out",
      unpacked,
    ]);
    expect(unpack.code, unpack.stderr).toBe(0);
    embedded = join(
      unpacked,
      expectations.package_dir_name,
      "recovery",
      "rea-recover.mjs",
    );
    embeddedSha = sha256(await readFile(embedded));

    const db = await newDisposableDatabase();
    dbUrl = db.url;
    dbPassword = db.password;
  }, 300_000);

  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
    await fx?.cleanup();
    await rm(scratch, { recursive: true, force: true });
  });

  const packageRoot = (): string =>
    join(unpacked, expectations.package_dir_name);

  it("embeds the same verifier that was built", async () => {
    expect(embeddedSha).toBe(sha256(await readFile(distBundle)));
    const lone = await node(distBundle, ["--version"]);
    const inPackage = await node(embedded, ["--version"]);
    expect(inPackage.code).toBe(0);
    expect(inPackage.stdout).toBe(lone.stdout);
    expect(inPackage.stdout).toMatch(/^rea-recover \d+\.\d+\.\d+/u);
  });

  describe("positive restore", () => {
    let report: RestoreReport;
    let cli: Cli;
    let target = "";
    let reportPath = "";

    beforeAll(async () => {
      target = await emptyTarget("target");
      reportPath = join(cleanDir, "r.json");
      cli = await node(
        embedded,
        [
          "restore",
          packageRoot(),
          "--scope",
          expectations.scopes.join(","),
          "--target",
          target,
          "--database-url-env",
          "X",
          "--allow-network",
          "registry",
          "--report",
          reportPath,
        ],
        { X: dbUrl },
      );
      report = await readReport(reportPath);
    }, 300_000);

    it("verifies every scope", () => {
      expect(cli.code, `${cli.stdout}\n${cli.stderr}`).toBe(0);
      expect(report.scopes.map((s) => [s.scope, s.status])).toEqual([
        ["integrity", "integrity_verified"],
        ["clean_build", "clean_build_verified"],
        ["data_restore", "data_restore_verified"],
        ["behavior", "behavior_verified"],
      ]);
      expect(report.overall).toBe(expectations.overall);
      expect(report.manifest_sha256).toBe(packageSha);
      expect(cli.stdout).toContain(`overall: ${expectations.overall}`);
    });

    it("reproduces the working tree byte for byte and leaves .env behind", async () => {
      const checkout = join(target, expectations.source_id);
      const files = expectations.restored_files;
      const read = (rel: string): Promise<Buffer> =>
        readFile(join(checkout, rel));
      expect(await read(files["modified"] as string)).toEqual(
        await readFile(join(fx.repoPath, files["modified"] as string)),
      );
      expect((await read(files["untracked_text"] as string)).toString()).toBe(
        "remember to rotate keys\n",
      );
      expect(
        Buffer.compare(
          await read(files["untracked_binary"] as string),
          fx.expected.untrackedBytes,
        ),
      ).toBe(0);
      expect(
        (
          await read(files["built_by_behavior_prerequisite"] as string)
        ).toString(),
      ).toBe("built ok\n");
      const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
        encoding: "utf8",
      });
      expect(head.trim()).toBe(fx.headSha);
      for (const absent of expectations.absent_from_restored_tree)
        await expect(stat(join(checkout, absent))).rejects.toThrow();
    });

    it("holds the captured invariant in the restored database", async () => {
      const data = report.scopes.find((s) => s.scope === "data_restore");
      expect(data?.invariants).toEqual([
        expect.objectContaining({
          id: expectations.invariant.id,
          expected: expectations.invariant.expected,
          actual: expectations.invariant.expected,
          ok: true,
        }),
      ]);
      expect(await countNotes(dbUrl, dbPassword)).toBe(
        expectations.invariant.expected,
      );
      const assets = join(target, ".rea-assets");
      expect((await readdir(assets)).length).toBeGreaterThan(0);
    });

    it("reports the network facts that were actually enforced", () => {
      const steps = report.scopes.flatMap((s) => s.steps);
      expect(steps.length).toBeGreaterThan(0);
      const available = report.network_isolation.available;
      for (const step of steps) {
        expect(step.status).toBe("passed");
        if (step.network === "none")
          expect(step.network_isolated, step.step_id).toBe(available);
        // database steps use TCP here, and registry steps are allowed out
        if (step.network === "registry" || step.network === "database")
          expect(step.network_isolated, step.step_id).toBe(false);
      }
      expect(steps.some((s) => s.network === "registry")).toBe(true);
      // the fixture's `npm ci` step is emitted even with zero dependencies
      expect(report.network_required.verdict).toBe("yes");
      expect(report.network_required.reasons.join(" ")).toContain("registry");
      expect(report.network_isolation.mechanism).toBe(
        available ? "linux-network-namespace" : "none",
      );
      expect(report.guards.disabled_schedules).toContain("nightly-cleanup");
    });

    it("never leaks the fixture secret or the database password", async () => {
      const everything = [
        await readFile(reportPath, "utf8"),
        cli.stdout,
        cli.stderr,
      ].join("\n");
      expect(everything).not.toContain(fx.secretMarker);
      expect(everything).not.toContain("npm_fixture_token_should_never_appear");
      expect(everything).not.toContain(dbPassword);
      expect(everything).not.toContain(dbUrl);
    });
  });

  describe("negative cases", () => {
    const copyPackage = async (label: string): Promise<string> => {
      const dir = join(cleanDir, label);
      await cp(packageRoot(), dir, { recursive: true });
      return dir;
    };

    it("blocks everything, with exit code 3, when one payload byte changed", async () => {
      const tampered = await copyPackage("tampered");
      const manifest = JSON.parse(
        await readFile(join(tampered, "manifest.json"), "utf8"),
      ) as {
        files: { path: string; size: number }[];
      };
      const victim = manifest.files.find(
        (f) => f.path.startsWith("source/") && f.size > 0,
      );
      expect(victim).toBeDefined();
      const victimPath = join(tampered, ...(victim?.path ?? "").split("/"));
      const bytes = await readFile(victimPath);
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      await writeFile(victimPath, bytes);

      const target = await emptyTarget("tamper-target");
      const reportPath = join(cleanDir, "tamper.json");
      const cli = await node(
        join(tampered, "recovery", "rea-recover.mjs"),
        [
          "restore",
          tampered,
          "--scope",
          "clean_build,data_restore,behavior",
          "--target",
          target,
          "--database-url-env",
          "X",
          "--allow-network",
          "registry",
          "--report",
          reportPath,
        ],
        { X: dbUrl },
      );
      expect(cli.code, cli.stdout).toBe(3);
      const report = await readReport(reportPath);
      expect(report.scopes.map((s) => s.status)).toEqual([
        "blocked",
        "blocked",
        "blocked",
        "blocked",
      ]);
      expect(report.scopes[0]?.detail).toContain(victim?.path ?? "?");
      expect(report.overall).toBe("blocked");
      expect(report.scopes.flatMap((s) => s.steps)).toEqual([]);
      expect(await readdir(target)).toEqual([]);
    });

    it("blocks data_restore when the package lists the database host as blocked", async () => {
      const guarded = await copyPackage("guarded");
      const manifestPath = join(guarded, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        restore_guards: { blocked_hosts: string[] };
      };
      manifest.restore_guards.blocked_hosts.push(new URL(dbUrl).hostname);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await materializeGeneratedFiles(guarded);

      const db = await newDisposableDatabase();
      const target = await emptyTarget("host-target");
      const reportPath = join(cleanDir, "host.json");
      const cli = await node(
        join(guarded, "recovery", "rea-recover.mjs"),
        [
          "restore",
          guarded,
          "--scope",
          "data_restore",
          "--target",
          target,
          "--database-url-env",
          "X",
          "--report",
          reportPath,
        ],
        { X: db.url },
      );
      const report = await readReport(reportPath);
      const scope = report.scopes.find((s) => s.scope === "data_restore");
      expect(scope?.status).toBe("blocked");
      expect(scope?.detail).toContain("blocked_hosts");
      expect(scope?.steps).toEqual([]);
      expect(report.scopes[0]?.status).toBe("integrity_verified");
      expect(cli.code).toBe(4);
      expect(
        await countNotes(db.url, db.password).catch(() => "no table"),
      ).toBe("no table");
      expect(
        `${cli.stdout}${cli.stderr}${JSON.stringify(report)}`,
      ).not.toContain(db.password);
    });

    it("blocks the scope with a registry step unless --allow-network registry is given", async () => {
      const target = await emptyTarget("registry-target");
      const reportPath = join(cleanDir, "registry.json");
      const cli = await node(embedded, [
        "restore",
        packageRoot(),
        "--scope",
        "clean_build",
        "--target",
        target,
        "--report",
        reportPath,
      ]);
      expect(cli.code, cli.stdout).toBe(4);
      const report = await readReport(reportPath);
      const scope = report.scopes.find((s) => s.scope === "clean_build");
      expect(scope?.status).toBe("blocked");
      expect(scope?.detail).toContain("package registry");
      expect(
        scope?.steps.some(
          (s) => s.network === "registry" && s.status === "blocked",
        ),
      ).toBe(true);
      expect(report.network_required.verdict).toBe("yes");
      expect(await readdir(target)).toEqual([]);
    });
  });
});
