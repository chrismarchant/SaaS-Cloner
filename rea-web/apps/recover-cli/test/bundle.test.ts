import { execFile, execFileSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { restoreReportSchema } from "@rea-web/contracts";
import {
  createPackageBuilder,
  encryptExport,
  generateRecoveryKey,
  packExport,
} from "@rea-web/recovery";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const APP_DIR = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

let scratch = "";
let bundle = "";
let pkgDir = "";
let tarPath = "";

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the copied bundle from an unrelated directory with PATH as the only variable. */
const rea = async (
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<Result> => {
  try {
    const r = await run(process.execPath, [bundle, ...args], {
      cwd: scratch,
      env: { PATH: process.env["PATH"] ?? "", ...extraEnv },
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

const tempDir = async (label: string): Promise<string> => {
  const dir = await mkdtemp(join(scratch, `${label}-`));
  return dir;
};

async function buildPackage(root: string): Promise<void> {
  const builder = await createPackageBuilder({ stagingDir: root });
  builder.addComponent({
    id: "source:main",
    kind: "source",
    title: "Source",
    status: "captured",
    captured_at: null,
    method: "fixture",
    root: "source/main/",
    restore: {
      steps: [
        {
          id: "write",
          title: "Write a file into the target",
          run: [
            "node",
            "-e",
            "require('fs').writeFileSync('restored.txt', process.env.GREETING ?? 'unset')",
          ],
          env_names: ["GREETING"],
          requires: ["node>=22"],
          network: "none",
          scope: "clean_build",
        },
      ],
    },
    limitations: [],
    omissions: [],
    details: {},
  });
  await builder.addFile("source:main", "source/main/a.txt", "alpha\n");
  builder.setRestoreGuards({
    blocked_hosts: [],
    disabled_schedules: [],
    disabled_webhooks: [],
    default_network: "deny",
  });
  await builder.finalize({
    packageId: "6f1d0b52-3c1e-4a5e-9a37-0d4a3b8c2f10",
    build: {
      id: "b",
      name: "Synthetic",
      project_slug: "synthetic",
      description: "",
    },
    producer: {
      name: "rea-web",
      version: "0.1.0",
      upstream_rea: null,
      tools: [],
    },
    createdAt: "2026-03-01T12:00:00.000Z",
  });
}

beforeAll(async () => {
  // 1. Build the bundle (project references first, then esbuild).
  const tsc = require.resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-b"], { cwd: APP_DIR });
  execFileSync(process.execPath, ["build.mjs"], { cwd: APP_DIR });

  // 2. Copy only the bundle into an otherwise empty directory.
  scratch = await mkdtemp(join(tmpdir(), "rea-recover-bundle-"));
  const home = join(scratch, "only-the-bundle");
  await mkdir(home);
  bundle = join(home, "rea-recover.mjs");
  await copyFile(join(APP_DIR, "dist", "rea-recover.mjs"), bundle);

  pkgDir = join(scratch, "fixture-package");
  await buildPackage(pkgDir);
  tarPath = join(scratch, "fixture-package.tar");
  await packExport(pkgDir, tarPath);
}, 120_000);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("rea-recover bundle", () => {
  it("is a single file that imports only Node built-ins", async () => {
    expect(await readdir(join(scratch, "only-the-bundle"))).toEqual([
      "rea-recover.mjs",
    ]);
    const text = await readFile(bundle, "utf8");
    expect(text.startsWith("#!/usr/bin/env node\n")).toBe(true);
    const imports = [
      ...text.matchAll(/^import[^"'\n]*["']([^"']+)["']/gmu),
    ].map((m) => m[1]);
    for (const spec of imports)
      expect(builtinModules, `import ${spec}`).toContain(
        (spec ?? "").replace(/^node:/u, ""),
      );
  });

  it("verifies a package with only PATH in the environment, from another directory", async () => {
    const r = await rea(["verify", pkgDir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("integrity");
    expect(r.stdout).toContain("integrity_verified");
    expect(r.stdout).toContain("overall: integrity_verified");
    expect(r.stdout).toContain("6f1d0b52-3c1e-4a5e-9a37-0d4a3b8c2f10");
    expect(r.stderr).toBe("");
  });

  it("verifies a tar export and writes a schema-valid report outside the package", async () => {
    const report = join(scratch, "verify-report.json");
    const r = await rea(["verify", tarPath, "--report", report]);
    expect(r.code).toBe(0);
    const parsed = restoreReportSchema.parse(
      JSON.parse(await readFile(report, "utf8")),
    );
    expect(parsed.overall).toBe("integrity_verified");
    expect(parsed.verifier).toMatchObject({
      name: "rea-recover",
      version: "0.1.0",
    });
    expect(r.stdout).toContain(`report written to ${report}`);
  });

  it("refuses to write the report inside the package", async () => {
    const r = await rea([
      "verify",
      pkgDir,
      "--report",
      join(pkgDir, "report.json"),
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("outside the package");
    expect(await readdir(pkgDir)).not.toContain("report.json");
  });

  it("exits 3 with integrity blocked when a payload byte changed", async () => {
    const copy = await tempDir("tampered");
    const tamperedPkg = join(copy, "pkg");
    await buildPackage(tamperedPkg);
    await writeFile(join(tamperedPkg, "source/main/a.txt"), "alphA\n");
    const r = await rea(["verify", tamperedPkg]);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("blocked");
    expect(r.stdout).toContain("source/main/a.txt");
  });

  it("restores into an empty target, passing declared env names only from --env-file", async () => {
    const target = await tempDir("target");
    const envFile = join(scratch, "restore.env");
    await writeFile(
      envFile,
      "# operator supplied\nGREETING=hello from env-file\nIGNORED=1\n",
    );
    const report = join(scratch, "restore-report.json");
    const r = await rea([
      "restore",
      tarPath,
      "--scope",
      "clean_build",
      "--target",
      target,
      "--env-file",
      envFile,
      "--report",
      report,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("overall: clean_build_verified");
    expect(await readFile(join(target, "restored.txt"), "utf8")).toBe(
      "hello from env-file",
    );
    const parsed = restoreReportSchema.parse(
      JSON.parse(await readFile(report, "utf8")),
    );
    expect(parsed.network_required.verdict).toMatch(/^(no|unknown)$/u);
    expect(JSON.stringify(parsed)).not.toContain("hello from env-file");
  });

  it("exits 4 for a non-empty target (integrity held, restore refused) and 1 for usage errors", async () => {
    const full = await tempDir("full");
    await writeFile(join(full, "x"), "x");
    const blocked = await rea([
      "restore",
      pkgDir,
      "--scope",
      "clean_build",
      "--target",
      full,
    ]);
    expect(blocked.code).toBe(4); // integrity held, the restore scope was refused
    expect(blocked.stdout).toContain("not empty");
    expect((await rea(["restore", pkgDir, "--target", full])).code).toBe(1);
    expect(
      (await rea(["restore", pkgDir, "--scope", "nonsense", "--target", full]))
        .code,
    ).toBe(1);
    expect((await rea(["frobnicate"])).code).toBe(1);
    const missingEnv = await rea([
      "restore",
      pkgDir,
      "--scope",
      "data_restore",
      "--target",
      full,
      "--database-url-env",
      "NOPE",
    ]);
    expect(missingEnv.code).toBe(1);
    expect(missingEnv.stderr).toContain("NOPE");
  });

  it("accepts --allow-production and refuses it", async () => {
    const target = await tempDir("prod");
    const r = await rea([
      "restore",
      pkgDir,
      "--scope",
      "clean_build",
      "--target",
      target,
      "--allow-production",
    ]);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("allow-production");
    expect(await readdir(target)).toEqual([]);
  });

  it("prints its version and help", async () => {
    const v = await rea(["--version"]);
    expect(v).toMatchObject({ code: 0, stdout: "rea-recover 0.1.0\n" });
    const h = await rea(["--help"]);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("rea-recover verify");
    expect(h.stdout).toContain("--database-url-env");
  });

  it("unpacks a plain export into an empty directory and refuses a non-empty one", async () => {
    const out = join(await tempDir("unpack"), "out");
    const r = await rea(["unpack", tarPath, "--out", out]);
    expect(r.code).toBe(0);
    expect((await rea(["verify", join(out, "fixture-package")])).code).toBe(0);
    const again = await rea(["unpack", tarPath, "--out", out]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("not empty");
  });

  it("unpacks an encrypted export only with its key, which must live outside the output", async () => {
    const key = generateRecoveryKey();
    const enc = join(scratch, "fixture-package.tar.enc");
    await encryptExport(tarPath, enc, key);
    const keyFile = join(scratch, "recovery.key");
    await writeFile(keyFile, `${key.keyBase64}\n`);

    expect(
      (await rea(["unpack", enc, "--out", join(scratch, "enc-none")])).code,
    ).toBe(1);
    const out = join(await tempDir("enc"), "out");
    const r = await rea(["unpack", enc, "--out", out, "--key-file", keyFile]);
    expect(r.code).toBe(0);
    expect((await rea(["verify", join(out, "fixture-package")])).code).toBe(0);

    const inside = join(await tempDir("encinside"), "out");
    await mkdir(inside, { recursive: true });
    const insideKey = join(inside, "recovery.key");
    await writeFile(insideKey, `${key.keyBase64}\n`);
    const refused = await rea([
      "unpack",
      enc,
      "--out",
      inside,
      "--key-file",
      insideKey,
    ]);
    expect(refused.code).toBe(1);
  });
});
