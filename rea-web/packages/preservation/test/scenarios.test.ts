import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateRestoreStepArguments } from "@rea-web/contracts";
import { verifyIntegrity } from "@rea-web/recovery";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BuildDefinition,
  type CaptureResult,
  capturePackage,
  planPreservation,
  runCommand,
} from "../src/index.js";
import {
  DB_ENV_NAME,
  RUNNER_ID,
  type FixtureBuild,
  createFixtureBuild,
  describeDb,
  fullBuild,
  makeContext,
  runRestoreSteps,
  sha256Hex,
} from "./fixtureBuild.js";

let root = "";
let fx: FixtureBuild;
let counter = 0;

describeDb("preservation scenarios", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pres-scn-"));
    fx = await createFixtureBuild(join(root, "fx"));
  }, 120_000);

  afterAll(async () => {
    await fx?.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  const run = async (
    build: BuildDefinition,
    extra: Parameters<typeof makeContext>[2] = {},
    options: { consistencyWindowMs?: number } = {},
  ) => {
    counter += 1;
    const ws = join(root, `ws${counter}`);
    await mkdir(ws, { recursive: true });
    const tc = makeContext(ws, fx, extra);
    const plan = await planPreservation(build, tc.ctx);
    const result: CaptureResult = await capturePackage(build, plan, tc.ctx, {
      stagingDir: join(root, `pkg${counter}`),
      producerVersion: "0.0.0-test",
      ...options,
    });
    // Every step any capture emits must pass the contract's validator.
    for (const c of result.manifest.components)
      for (const step of c.restore.steps)
        expect(
          validateRestoreStepArguments(step),
          `${c.id}/${step.id}`,
        ).toEqual({ ok: true });
    return { tc, plan, result, pkg: join(root, `pkg${counter}`) };
  };

  const gitSource = (
    ref: string,
    workingTree = false,
  ): BuildDefinition["source"] => ({
    kind: "git",
    url: fx.repoPath,
    ref,
    include_working_tree: workingTree,
    include_lfs: true,
    include_submodules: true,
  });
  const base = (
    components: BuildDefinition["components"],
    source = gitSource("HEAD"),
  ): BuildDefinition => ({ ...fullBuild(fx), source, components });
  const assetsDecl = (): BuildDefinition["components"][number] => ({
    kind: "assets",
    id: "uploads",
    source: {
      kind: "runner_local",
      runner_id: RUNNER_ID,
      path_hash: sha256Hex(fx.assetsPath),
    },
  });

  describe("Supabase", () => {
    it("separates the database backup from Auth, Storage, Edge Functions, settings and OAuth", async () => {
      const build = base([
        { kind: "source", id: "main" },
        {
          kind: "data",
          id: "db",
          engine: "supabase",
          connection_env_name: DB_ENV_NAME,
          invariants: [],
        },
        {
          kind: "assets",
          id: "bucket",
          source: {
            kind: "supabase_storage",
            project_ref: "abcdefghijklmnop",
            buckets: ["avatars"],
            credentials_env_prefix: "SUPABASE_FIXTURE",
          },
        },
      ]);
      const { result, pkg } = await run(build);
      expect(result.componentStatuses["data:db"]).toBe("partial");
      expect(result.componentStatuses["assets:bucket"]).toBe("manual");
      const titles = result.manifest.manual_prerequisites
        .map((m) => m.title)
        .join(" | ");
      for (const needle of [
        /Auth configuration/u,
        /Storage objects/u,
        /Edge Functions/u,
        /platform settings/u,
        /OAuth provider/u,
      ])
        expect(titles).toMatch(needle);
      expect(
        result.manifest.manual_prerequisites.filter(
          (m) => m.component_id === "data:db",
        ),
      ).toHaveLength(5);
      const manual = result.manifest.missing_or_blocked.filter(
        (m) => m.status === "manual",
      );
      expect(manual.length).toBeGreaterThanOrEqual(6);
      for (const m of manual) expect(m.remediation.length).toBeGreaterThan(20);
      expect(
        result.manifest.components.find((c) => c.id === "data:db")?.restore
          .steps,
      ).toHaveLength(1);
      // The database dump itself is still a real, restorable capture.
      expect((await readdir(join(pkg, "data/db"))).sort()).toEqual([
        "capture.json",
        "dump.pgc",
        "invariants.json",
        "roles.sql",
        "schema.sql",
      ]);
      // Database captured, Storage manual: no cross-component recovery point can be claimed.
      expect(result.consistency).toBe("unknown");
      expect(result.manifest.consistency.gaps.join(" ")).toMatch(
        /assets:bucket/u,
      );
      expect((await verifyIntegrity(pkg)).ok).toBe(true);
    });
  });

  describe("blocked components do not stop the capture", () => {
    it("blocks data when the connection variable is missing, naming it, and still captures the rest", async () => {
      const build = base([
        { kind: "source", id: "main" },
        {
          kind: "data",
          id: "db",
          engine: "postgresql",
          connection_env_name: "MISSING_CAPTURE_DATABASE_URL",
          invariants: [],
        },
        assetsDecl(),
        {
          kind: "product",
          id: "prd",
          source_component_id: "main",
          name: "Fixture",
          rea_target_ids: [],
        },
      ]);
      const { result, plan, pkg } = await run(build);
      expect(result.componentStatuses["data:db"]).toBe("blocked");
      expect(result.componentStatuses["source:main"]).toBe("captured");
      expect(result.componentStatuses["assets:uploads"]).toBe("partial");
      expect(result.componentStatuses["product:prd"]).toBe("captured");
      const entry = result.manifest.missing_or_blocked.find(
        (m) => m.component_id === "data:db",
      );
      expect(entry).toMatchObject({ status: "blocked" });
      expect(entry?.remediation).toContain("MISSING_CAPTURE_DATABASE_URL");
      expect(plan.components.find((c) => c.id === "data:db")?.feasible).toBe(
        false,
      );
      expect(
        plan.components.find((c) => c.id === "data:db")?.permissions[0]?.detail,
      ).toContain("MISSING_CAPTURE_DATABASE_URL");
      expect(result.consistency).toBe("unknown");
      expect(await readdir(join(pkg, "assets/uploads"))).toContain(
        "objects.json",
      );
      expect((await verifyIntegrity(pkg)).ok).toBe(true);
    });

    it("blocks invalid descriptors with the offending field paths and keeps going", async () => {
      const build = base([
        { kind: "source", id: "main" },
        {
          kind: "infrastructure",
          id: "infra",
          descriptor: {
            services: [{ name: "web", start_comand: ["node"] }],
            env_names: ["lower_case"],
          },
        },
        {
          kind: "integrations",
          id: "integ",
          descriptor: { providers: [{ api_version: "1" }] },
        },
      ]);
      const { result, plan } = await run(build);
      expect(result.componentStatuses).toEqual({
        "source:main": "captured",
        "infrastructure:infra": "blocked",
        "integrations:integ": "blocked",
      });
      const reasons = result.manifest.missing_or_blocked
        .map((m) => m.reason)
        .join(" | ");
      expect(reasons).toMatch(/services\.0/u);
      expect(reasons).toMatch(/env_names\.0/u);
      expect(reasons).toMatch(/providers\.0\.name/u);
      expect(
        plan.components.filter((c) => !c.feasible).map((c) => c.id),
      ).toEqual(["infrastructure:infra", "integrations:integ"]);
    });

    it("drops restore steps the manifest forbids instead of failing the capture", async () => {
      const build = base([
        { kind: "source", id: "main" },
        {
          kind: "infrastructure",
          id: "infra",
          descriptor: {
            services: [
              { name: "web", build_command: ["sh", "-c", "npm run build"] },
              { name: "pathsh", build_command: ["/bin/dash", "-c", "x"] },
              {
                name: "wrapped",
                build_command: ["env", "FOO=1", "node", "x.js"],
              },
              {
                name: "timed",
                build_command: ["timeout", "5", "node", "x.js"],
              },
            ],
            behavior_checks: [
              { id: "ok", title: "ok", run: ["node", "--version"] },
            ],
          },
        },
      ]);
      const { result } = await run(build);
      const infra = result.manifest.components.find(
        (c) => c.id === "infrastructure:infra",
      );
      expect(infra?.status).toBe("partial");
      expect(infra?.restore.steps.map((s) => s.id)).toEqual(["behavior-ok"]);
      const reasons = infra?.omissions.map((o) => o.reason).join() ?? "";
      expect(reasons).toMatch(/shell interpreter sh /u);
      expect(reasons).toMatch(/shell interpreter dash /u);
      expect(reasons).toMatch(/launcher env /u);
      expect(reasons).toMatch(/launcher timeout /u);
    });

    it("never leaks a connection password through a failed connection", async () => {
      const password = "hunter2-secret-pw-9f3a";
      const build = base([
        { kind: "source", id: "main" },
        {
          kind: "data",
          id: "db",
          engine: "postgresql",
          connection_env_name: DB_ENV_NAME,
          invariants: [],
        },
      ]);
      const { result, tc, plan, pkg } = await run(build, {
        env: { [DB_ENV_NAME]: `postgres://app:${password}@127.0.0.1:1/appdb` },
      });
      expect(result.componentStatuses["data:db"]).toBe("blocked");
      const everything = JSON.stringify([result.manifest, tc.logs, plan]);
      expect(everything).not.toContain(password);
      for (const file of await readdir(pkg, {
        recursive: true,
        withFileTypes: true,
      }))
        if (file.isFile())
          expect(
            (await readFile(join(file.parentPath, file.name))).includes(
              Buffer.from(password),
            ),
          ).toBe(false);
    });
  });

  describe("consistency", () => {
    it("labels data and assets captured outside the declared window as inconsistent", async () => {
      const build = base([
        {
          kind: "data",
          id: "db",
          engine: "postgresql",
          connection_env_name: DB_ENV_NAME,
          invariants: [],
        },
        assetsDecl(),
      ]);
      const { result } = await run(build, {}, { consistencyWindowMs: 0 });
      expect(result.consistency).toBe("inconsistent");
      expect(result.manifest.consistency.classification).toBe("inconsistent");
      expect(result.manifest.consistency.gaps.join(" ")).toMatch(/window/u);
      expect(result.componentStatuses["data:db"]).toBe("captured");
    });

    it("rejects invariants that are not a single read-only statement and never runs them", async () => {
      const build = base([
        {
          kind: "data",
          id: "db",
          engine: "postgresql",
          connection_env_name: DB_ENV_NAME,
          invariants: [
            { id: "bad", sql: "select 1; select 2", expect: 1 },
            { id: "write", sql: "delete from notes", expect: null },
          ],
        },
      ]);
      const { result, pkg } = await run(build);
      const inv = JSON.parse(
        await readFile(join(pkg, "data/db/invariants.json"), "utf8"),
      ) as { id: string; error?: string; expected_at_capture: string | null }[];
      expect(inv.map((i) => i.error !== undefined)).toEqual([true, true]);
      expect(inv.every((i) => i.expected_at_capture === null)).toBe(true);
      // The rejected writing statement never ran.
      const check = await runCommand([
        "psql",
        "-X",
        "-A",
        "-t",
        "-c",
        "select count(*) from notes",
        `--dbname=${fx.databaseUrl}`,
      ]);
      expect(check.stdout.trim()).toBe("3");
      expect(
        result.manifest.components.find((c) => c.id === "data:db")?.status,
      ).toBe("captured");
    });
  });

  describe("other ecosystems", () => {
    it("detects lockfiles, toolchains, registries and env names without copying credentials", async () => {
      const repo = join(root, "polyglot");
      const files: Record<string, string> = {
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        "apps/web/yarn.lock": "# yarn lockfile v1\n",
        "apps/web/.yarnrc.yml":
          'npmRegistryServer: "https://npm.internal.example/"\nnpmAuthToken: yarn_secret_token_value\n',
        "requirements.txt":
          "--index-url https://deploy:pip_secret_pw@pypi.private.example/simple/\nrequests==2.31.0\n",
        "pip.conf":
          "[global]\nindex-url = https://pypi.internal.example/simple/\nextra-index-url = https://user:extra_pw_secret@extra.example/simple/\n",
        "poetry.lock": "# poetry\n",
        "go.mod": "module example.com/x\n\ngo 1.22\n",
        "go.sum": "",
        "Cargo.lock": "version = 3\n",
        "rust-toolchain.toml": '[toolchain]\nchannel = "1.78.0"\n',
        ".tool-versions": "nodejs 20.11.0\npython 3.12.1\n",
        "Gemfile.lock": "GEM\n",
        "composer.lock": "{}\n",
        "app.py":
          'import os\nTOKEN = os.environ["PY_REQUIRED"]\nOTHER = os.getenv("PY_OPTIONAL")\n',
        "main.go":
          'package main\nimport "os"\nvar _ = os.Getenv("GO_SETTING")\n',
        Procfile: "web: python app.py\n",
        "railway.json": "{}\n",
      };
      await mkdir(repo, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        await mkdir(join(repo, rel, ".."), { recursive: true });
        await writeFile(join(repo, rel), content);
      }
      const env = {
        HOME: process.env["HOME"] ?? "/root",
        GIT_AUTHOR_NAME: "F",
        GIT_AUTHOR_EMAIL: "f@example.com",
        GIT_COMMITTER_NAME: "F",
        GIT_COMMITTER_EMAIL: "f@example.com",
      };
      for (const args of [
        ["init", "-q"],
        ["add", "-A"],
        ["commit", "-q", "-m", "polyglot"],
      ])
        expect(
          (await runCommand(["git", ...args], { cwd: repo, env })).exitCode,
        ).toBe(0);

      const { result, pkg } = await run(
        base(
          [
            { kind: "source", id: "main" },
            {
              kind: "dependencies",
              id: "deps",
              lockfiles: ["missing.lock"],
              container_images: [],
            },
            { kind: "infrastructure", id: "infra", descriptor: {} },
          ],
          {
            kind: "git",
            url: repo,
            ref: "HEAD",
            include_working_tree: false,
            include_lfs: true,
            include_submodules: true,
          },
        ),
      );
      const deps = result.manifest.components.find(
        (c) => c.id === "dependencies:deps",
      );
      expect(deps?.status).toBe("partial");
      expect(deps?.omissions[0]?.what).toContain("missing.lock");
      const steps = Object.fromEntries(
        (deps?.restore.steps ?? []).map((s) => [
          s.run.slice(0, 2).join(" "),
          s,
        ]),
      );
      expect(steps["pnpm install"]).toMatchObject({
        run: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
        cwd: "{{target}}/main",
        network: "registry",
        requires: ["pnpm"],
      });
      expect(steps["yarn install"]).toMatchObject({
        run: ["yarn", "install", "--immutable", "--mode=skip-build"],
        cwd: "{{target}}/main/apps/web",
      });
      expect(steps["python3 -m"]).toMatchObject({
        run: [
          "python3",
          "-m",
          "pip",
          "install",
          "--no-input",
          "-r",
          "requirements.txt",
        ],
        requires: ["python3"],
      });
      const dep = result.manifest.dependencies;
      expect(dep.package_managers.map((m) => m.name).sort()).toEqual([
        "bundler",
        "cargo",
        "composer",
        "go",
        "pip",
        "pnpm",
        "poetry",
        "yarn",
      ]);
      expect(dep.runtimes).toEqual(
        expect.arrayContaining([
          { name: "go", version: "1.22", source: "go.mod" },
          { name: "rust", version: "1.78.0", source: "rust-toolchain.toml" },
          { name: "nodejs", version: "20.11.0", source: ".tool-versions" },
          { name: "python", version: "3.12.1", source: ".tool-versions" },
        ]),
      );
      const registries = Object.fromEntries(
        dep.registries.map((r) => [r.url, r.credentials_required]),
      );
      expect(registries["https://npm.internal.example/"]).toBe(true);
      expect(registries["https://pypi.internal.example/simple/"]).toBe(false);
      expect(registries["https://pypi.private.example/simple/"]).toBe(true);
      expect(registries["https://extra.example/simple/"]).toBe(true);
      expect(deps?.limitations.join(" ")).toMatch(
        /No automated install step for poetry\.lock/u,
      );
      expect(deps?.limitations.join(" ")).toMatch(
        /Credential-like transport secrets were removed from: requirements\.txt/u,
      );
      expect(
        await readFile(
          join(pkg, "dependencies/deps/lockfiles/requirements.txt"),
          "utf8",
        ),
      ).toContain("requests==2.31.0");
      for (const file of await readdir(pkg, {
        recursive: true,
        withFileTypes: true,
      }))
        if (file.isFile()) {
          const bytes = await readFile(join(file.parentPath, file.name));
          for (const secret of [
            "pip_secret_pw",
            "yarn_secret_token_value",
            "extra_pw_secret",
          ])
            expect(
              bytes.includes(Buffer.from(secret)),
              `${secret} in ${file.name}`,
            ).toBe(false);
        }

      const names = JSON.parse(
        await readFile(join(pkg, "infrastructure/env-names.json"), "utf8"),
      ) as { names: { name: string }[] };
      expect(names.names.map((n) => n.name)).toEqual(
        expect.arrayContaining(["PY_REQUIRED", "PY_OPTIONAL", "GO_SETTING"]),
      );
      const services = JSON.parse(
        await readFile(join(pkg, "infrastructure/services.json"), "utf8"),
      ) as { detected_platform_config: string[] };
      expect(services.detected_platform_config.sort()).toEqual([
        "Procfile",
        "railway.json",
      ]);
    });
  });

  describe("cancellation", () => {
    it("stops between components when the job is aborted mid-capture", async () => {
      counter += 1;
      const ws = join(root, `ws${counter}`);
      await mkdir(ws, { recursive: true });
      const tc = makeContext(ws, fx);
      const finished: string[] = [];
      const ctx = {
        ...tc.ctx,
        log: (level: "info" | "warn", message: string) => {
          if (/^component .* captured$/u.test(message)) {
            finished.push(message);
            tc.controller.abort();
          }
          void level;
        },
      };
      const build = base([
        { kind: "source", id: "main" },
        {
          kind: "product",
          id: "prd",
          source_component_id: "main",
          name: "x",
          rea_target_ids: [],
        },
      ]);
      const plan = await planPreservation(build, ctx);
      await expect(
        capturePackage(build, plan, ctx, {
          stagingDir: join(root, `pkg${counter}`),
          producerVersion: "t",
        }),
      ).rejects.toThrow();
      expect(finished).toEqual(["component source:main captured"]);
    });
  });

  describe("source selection", () => {
    it("pins a tag and refuses to pair it with working-tree changes", async () => {
      const tag = (
        await runCommand([
          "git",
          "-C",
          fx.repoPath,
          "rev-parse",
          "v1.0.0^{commit}",
        ])
      ).stdout.trim();
      const { result, pkg } = await run(
        base([{ kind: "source", id: "main" }], gitSource("v1.0.0", true)),
      );
      expect(result.manifest.source_revisions[0]?.head_sha).toBe(tag);
      expect(result.manifest.source_revisions[0]?.head_sha).not.toBe(
        fx.headSha,
      );
      expect(result.componentStatuses["source:main"]).toBe("partial");
      expect(
        result.manifest.components[0]?.omissions.map((o) => o.reason).join(),
      ).toMatch(/relative to HEAD/u);
      expect(result.manifest.source_revisions[0]?.working_tree.included).toBe(
        false,
      );
      expect(
        (await readdir(join(pkg, "source/main"))).includes("worktree.patch"),
      ).toBe(false);
      const checkout = join(root, "tag-checkout");
      await mkdir(checkout, { recursive: true });
      await runRestoreSteps(
        result.manifest.components[0]?.restore.steps ?? [],
        {
          target: checkout,
          packageRoot: pkg,
        },
      );
      expect(
        (
          await runCommand([
            "git",
            "-C",
            join(checkout, "main"),
            "rev-parse",
            "HEAD",
          ])
        ).stdout.trim(),
      ).toBe(tag);
    });

    it("captures a repository URL from a mirror clone and says what a mirror cannot carry", async () => {
      const url = `file://${fx.repoPath}`;
      const source: BuildDefinition["source"] = {
        kind: "git",
        url,
        ref: "main",
        include_working_tree: true,
        include_lfs: true,
        include_submodules: true,
      };
      const { result, pkg } = await run(
        base([{ kind: "source", id: "main" }], source),
      );
      const c = result.manifest.components[0];
      expect(c?.method).toBe("git bundle create --all");
      expect(c?.details["location"]).toBe("remote (mirror clone)");
      expect(result.manifest.source_revisions[0]?.head_sha).toBe(fx.headSha);
      expect(result.manifest.source_revisions[0]?.remote_url_redacted).toBe(
        url,
      );
      expect(result.manifest.source_revisions[0]?.working_tree).toEqual({
        included: false,
        dirty_files: 0,
        untracked_files: 0,
      });
      const reasons = (c?.omissions ?? [])
        .map((o) => `${o.what} ${o.reason}`)
        .join(" | ");
      expect(reasons).toMatch(/Working-tree changes .*mirror clone/u);
      expect(reasons).toMatch(
        /Submodule repository vendor\/lib.*mirror clone/u,
      );
      expect(result.componentStatuses["source:main"]).toBe("partial");
      if (fx.lfsWorks)
        expect(result.manifest.source_revisions[0]?.lfs).toEqual({
          count: 1,
          bytes: 4096,
          included: true,
        });
      const verify = await runCommand([
        "git",
        "bundle",
        "verify",
        join(pkg, "source/main/repo.bundle"),
      ]);
      expect(verify.exitCode).toBe(0);
      expect((await readdir(join(pkg, "source/main"))).sort()).not.toContain(
        "worktree.patch",
      );
    });

    it("reports uninitialised submodules, and honours include_lfs / include_submodules false", async () => {
      const uninit = join(root, "uninit");
      const cloned = await runCommand(
        ["git", "clone", "--quiet", fx.repoPath, uninit],
        { env: { HOME: process.env["HOME"] ?? "/root" } },
      );
      expect(cloned.exitCode, cloned.stderr).toBe(0);
      const a = await run(
        base([{ kind: "source", id: "main" }], {
          kind: "git",
          url: uninit,
          ref: "HEAD",
          include_working_tree: false,
          include_lfs: true,
          include_submodules: true,
        }),
      );
      const sub = a.result.manifest.components[0]?.omissions.find((o) =>
        o.what.startsWith("Submodule repository vendor/lib"),
      );
      expect(sub?.reason).toMatch(/not initialised/u);
      expect(sub?.remediation).toMatch(/git submodule update --init/u);
      expect(a.result.manifest.source_revisions[0]?.submodules).toEqual([
        expect.objectContaining({ path: "vendor/lib", sha: fx.submoduleSha }),
      ]);
      expect(a.result.componentStatuses["source:main"]).toBe("partial");

      const b = await run(
        base([{ kind: "source", id: "main" }], {
          kind: "git",
          url: fx.repoPath,
          ref: "HEAD",
          include_working_tree: false,
          include_lfs: false,
          include_submodules: false,
        }),
      );
      const whats = (b.result.manifest.components[0]?.omissions ?? [])
        .map((o) => o.what)
        .join(" | ");
      expect(whats).toMatch(/Submodule repositories/u);
      if (fx.lfsWorks) expect(whats).toMatch(/Git LFS object payloads/u);
      expect(b.result.manifest.source_revisions[0]?.lfs.included).toBe(false);
      expect((await readdir(join(b.pkg, "source/main"))).sort()).toEqual([
        "repo.bundle",
        "revision.json",
      ]);
    });

    it("reproduces a submodule that moved in the working tree and reports uncommitted work inside it", async () => {
      const repo = join(root, "moved-sub");
      const env = {
        HOME: process.env["HOME"] ?? "/root",
        GIT_AUTHOR_NAME: "F",
        GIT_AUTHOR_EMAIL: "f@example.com",
        GIT_COMMITTER_NAME: "F",
        GIT_COMMITTER_EMAIL: "f@example.com",
      };
      const git = async (cwd: string, ...args: string[]) => {
        const r = await runCommand(
          ["git", "-c", "protocol.file.allow=always", ...args],
          { cwd, env },
        );
        expect(r.exitCode, r.stderr).toBe(0);
        return r.stdout.trim();
      };
      await git(
        root,
        "clone",
        "--quiet",
        "--recurse-submodules",
        fx.repoPath,
        repo,
      );
      const sub = join(repo, "vendor/lib");
      await writeFile(join(sub, "lib.js"), "module.exports = () => 'moved';\n");
      await git(sub, "commit", "--quiet", "-am", "lib: moved");
      const moved = await git(sub, "rev-parse", "HEAD");
      await writeFile(join(sub, "dirty.txt"), "not committed\n");
      const { result, pkg } = await run(
        base([{ kind: "source", id: "main" }], {
          kind: "git",
          url: repo,
          ref: "HEAD",
          include_working_tree: true,
          include_lfs: false,
          include_submodules: true,
        }),
      );
      const rev = result.manifest.source_revisions[0];
      expect(rev?.submodules[0]).toMatchObject({
        path: "vendor/lib",
        sha: fx.submoduleSha,
      });
      expect(
        JSON.parse(
          await readFile(join(pkg, "source/main/revision.json"), "utf8"),
        ).submodules[0],
      ).toMatchObject({ sha: fx.submoduleSha, checked_out_sha: moved });
      expect(
        result.manifest.components[0]?.omissions.map((o) => o.what).join(),
      ).toMatch(/Uncommitted changes inside submodule vendor\/lib/u);
      const checkout = join(root, "moved-restore");
      await mkdir(checkout, { recursive: true });
      await runRestoreSteps(
        result.manifest.components[0]?.restore.steps ?? [],
        { target: checkout, packageRoot: pkg },
      );
      expect(
        (
          await runCommand([
            "git",
            "-C",
            join(checkout, "main/vendor/lib"),
            "rev-parse",
            "HEAD",
          ])
        ).stdout.trim(),
      ).toBe(moved);
      expect(
        await readFile(join(checkout, "main/vendor/lib/lib.js"), "utf8"),
      ).toContain("moved");
    });

    it("blocks an unknown ref and an unresolved runner path", async () => {
      const a = await run(
        base(
          [
            { kind: "source", id: "main" },
            {
              kind: "product",
              id: "prd",
              source_component_id: "main",
              name: "x",
              rea_target_ids: [],
            },
          ],
          gitSource("no-such-ref"),
        ),
      );
      expect(a.result.componentStatuses).toEqual({
        "source:main": "blocked",
        "product:prd": "blocked",
      });
      expect(a.plan.components[0]?.feasible).toBe(false);
      const b = await run(
        base([{ kind: "source", id: "main" }], {
          kind: "runner_local",
          runner_id: RUNNER_ID,
          path_hash: "f".repeat(64),
          include_working_tree: true,
          include_lfs: true,
          include_submodules: true,
        }),
      );
      expect(b.result.componentStatuses["source:main"]).toBe("blocked");
      expect(b.result.manifest.missing_or_blocked[0]?.reason).toMatch(
        /runner did not resolve/u,
      );
    });

    it("rejects declarations that cannot be package paths and honours cancellation", async () => {
      const bad = base([{ kind: "source", id: "../escape" }]);
      counter += 1;
      const ws = join(root, `ws${counter}`);
      await mkdir(ws, { recursive: true });
      const tc = makeContext(ws, fx);
      await expect(
        capturePackage(
          bad,
          { components: [], consistency_strategy: "", known_omissions: [] },
          tc.ctx,
          { stagingDir: join(root, `pkg${counter}`), producerVersion: "t" },
        ),
      ).rejects.toThrow(/package path segment/u);
      const good = base([{ kind: "source", id: "main" }]);
      tc.controller.abort();
      await expect(
        capturePackage(
          good,
          { components: [], consistency_strategy: "", known_omissions: [] },
          tc.ctx,
          {
            stagingDir: join(root, `pkg-abort${counter}`),
            producerVersion: "t",
          },
        ),
      ).rejects.toThrow();
    });
  });
});
