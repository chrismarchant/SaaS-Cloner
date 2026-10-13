import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  preservationPlanSchema,
  restoreStepSchema,
  validateRestoreStepArguments,
  type RecoveryManifest,
} from "@rea-web/contracts";
import { readPackage, verifyIntegrity } from "@rea-web/recovery";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CaptureResult,
  type PreservationPlanBody,
  capturePackage,
  planPreservation,
  runCommand,
} from "../src/index.js";
import {
  type FixtureBuild,
  type TestContext,
  createFixtureBuild,
  describeDb,
  fullBuild,
  makeContext,
  queryScalar,
  runRestoreSteps,
} from "./fixtureBuild.js";

let root = "";
let fx: FixtureBuild;
let tc: TestContext;
let plan: PreservationPlanBody;
let result: CaptureResult;
let pkg = "";

const sha = (b: Buffer | string): string =>
  createHash("sha256").update(b).digest("hex");
const component = (id: string): RecoveryManifest["components"][number] => {
  const c = result.manifest.components.find((x) => x.id === id);
  if (c === undefined) throw new Error(`component ${id} missing`);
  return c;
};
const readJson = async <T>(rel: string): Promise<T> =>
  JSON.parse(await readFile(join(pkg, rel), "utf8")) as T;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

describeDb("preservation capture", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pres-main-"));
    fx = await createFixtureBuild(join(root, "fx"));
    tc = makeContext(join(root, "ws"), fx);
    await mkdir(join(root, "ws"), { recursive: true });
    const build = fullBuild(fx);
    plan = await planPreservation(build, tc.ctx);
    pkg = join(root, "pkg");
    result = await capturePackage(build, plan, tc.ctx, {
      stagingDir: pkg,
      producerVersion: "0.0.0-test",
    });
  }, 180_000);

  afterAll(async () => {
    await fx?.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  describe("plan", () => {
    it("reports every component feasible with concrete checks", () => {
      expect(
        preservationPlanSchema.shape.components.safeParse(plan.components)
          .success,
      ).toBe(true);
      expect(plan.components.map((c) => c.id)).toEqual([
        "source:main",
        "dependencies:deps",
        "data:db",
        "assets:uploads",
        "infrastructure:infra",
        "integrations:integ",
        "product:prd",
        "artifacts:evidence",
      ]);
      for (const c of plan.components) {
        expect(c.feasible, `${c.id}: ${JSON.stringify(c.permissions)}`).toBe(
          true,
        );
        expect(c.permissions.length).toBeGreaterThan(0);
        expect(c.method.length).toBeGreaterThan(0);
      }
      const data = plan.components.find((c) => c.id === "data:db");
      expect(data?.estimated_bytes).toBeGreaterThan(0);
      expect(data?.permissions.map((p) => p.check).join()).toContain(
        "FIXTURE_DATABASE_URL",
      );
      expect(
        plan.components
          .find((c) => c.id === "assets:uploads")
          ?.omissions.map((o) => o.what)
          .join(),
      ).toContain("symbolic links");
    });

    it("states the consistency strategy and the known omissions", () => {
      expect(plan.consistency_strategy).toMatch(/pg_dump/u);
      expect(plan.consistency_strategy).toMatch(/60 s/u);
      expect(plan.consistency_strategy).toMatch(/inconsistent/u);
      expect(plan.known_omissions.length).toBeGreaterThan(0);
    });
  });

  describe("package", () => {
    it("validates, passes integrity and labels the recovery point", async () => {
      const { manifest } = await readPackage(pkg);
      expect(manifest.package_id).toBe(result.manifest.package_id);
      const report = await verifyIntegrity(pkg);
      expect(report, JSON.stringify(report)).toMatchObject({
        ok: true,
        mismatched: [],
        missing: [],
        extra: [],
      });
      expect(result.componentStatuses).toEqual({
        "source:main": "captured",
        "dependencies:deps": "captured",
        "data:db": "captured",
        "assets:uploads": "partial",
        "infrastructure:infra": "captured",
        "integrations:integ": "captured",
        "product:prd": "captured",
        "artifacts:evidence": "manual",
      });
      expect(result.consistency).toBe("single_point");
      expect(manifest.consistency.window).not.toBeNull();
      expect(manifest.verification.results[0]).toMatchObject({
        scope: "integrity",
        status: "captured",
      });
      expect(manifest.verification.network_required.verdict).toBe("yes");
      expect(manifest.restore_guards.default_network).toBe("deny");
    });

    it("records the tools actually used with versions", () => {
      const tools = Object.fromEntries(
        result.manifest.producer.tools.map((t) => [t.name, t.version]),
      );
      expect(tools["git"]).toMatch(/^2\./u);
      expect(tools["pg_dump"]).toMatch(/^\d+\.\d+/u);
      expect(tools["python3"]).toMatch(/^3\./u);
      const data = component("data:db").details;
      expect(data["pg_dump_version"]).toMatch(/pg_dump \(PostgreSQL\) \d+/u);
      expect(String(data["server_version"])).toMatch(/^\d+/u);
    });

    it("documents every component in RECOVERY.md", async () => {
      const guide = await readFile(join(pkg, "RECOVERY.md"), "utf8");
      for (const c of result.manifest.components)
        expect(guide, c.id).toContain(c.id);
    });

    it("emits only valid restore steps", () => {
      let steps = 0;
      for (const c of result.manifest.components)
        for (const s of c.restore.steps) {
          steps += 1;
          expect(restoreStepSchema.safeParse(s).success).toBe(true);
          expect(validateRestoreStepArguments(s)).toEqual({ ok: true });
          expect(s.run[0]).not.toMatch(/^(sh|bash|cmd|powershell)$/u);
        }
      expect(steps).toBeGreaterThan(8);
      for (const s of component("source:main").restore.steps)
        expect(s.network).toBe("none");
      expect(component("data:db").restore.steps[0]?.network).toBe("database");
      expect(component("dependencies:deps").restore.steps[0]).toMatchObject({
        run: ["npm", "ci", "--ignore-scripts"],
        network: "registry",
        requires: ["npm"],
        cwd: "{{target}}/main",
      });
    });

    it("never lets the fixture secrets reach the package, manifest, logs or plan", async () => {
      const needles = [
        fx.secretMarker,
        fx.databasePassword,
        fx.databaseUrl,
        "npm_fixture_token_should_never_appear",
        "query_secret_value",
      ];
      const haystacks: [string, Buffer][] = [];
      for (const file of await walk(pkg))
        haystacks.push([file, await readFile(file)]);
      haystacks.push(
        ["logs", Buffer.from(JSON.stringify(tc.logs))],
        ["plan", Buffer.from(JSON.stringify(plan))],
        ["result", Buffer.from(JSON.stringify(result))],
      );
      for (const [name, data] of haystacks)
        for (const needle of needles)
          expect(
            data.includes(Buffer.from(needle)),
            `${needle.slice(0, 12)}... found in ${name}`,
          ).toBe(false);
      expect(haystacks.length).toBeGreaterThan(20);
      expect(result.manifest.secrets.mode).toBe("names_only");
    });
  });

  describe("source", () => {
    it("writes a verifiable bundle with refs, exact revision, submodule and LFS", async () => {
      const verify = await runCommand([
        "git",
        "bundle",
        "verify",
        join(pkg, "source/main/repo.bundle"),
      ]);
      expect(verify.exitCode, verify.stderr).toBe(0);
      const rev = result.manifest.source_revisions[0];
      expect(rev?.head_sha).toBe(fx.headSha);
      expect(rev?.refs.map((r) => r.name)).toEqual(
        expect.arrayContaining([
          "refs/heads/main",
          "refs/heads/feature/search",
          "refs/tags/v1.0.0",
          "HEAD",
        ]),
      );
      expect(rev?.submodules).toEqual([
        expect.objectContaining({ path: "vendor/lib", sha: fx.submoduleSha }),
      ]);
      expect(rev?.working_tree).toEqual({
        included: true,
        dirty_files: 1,
        untracked_files: 2,
      });
      const heads = await runCommand([
        "git",
        "bundle",
        "list-heads",
        join(pkg, "source/main/submodules/vendor_lib.bundle"),
      ]);
      expect(heads.stdout).toContain(fx.submoduleSha);
      if (fx.lfsWorks) {
        expect(rev?.lfs.included).toBe(true);
        expect(rev?.lfs.count).toBe(1);
        expect(rev?.lfs.bytes).toBe(4096);
      } else {
        expect(
          component("source:main")
            .omissions.map((o) => o.what)
            .join(),
        ).toMatch(/LFS/u);
      }
    });

    it("restores byte-for-byte from the package alone and never includes .env", async () => {
      const target = join(root, "restore-source");
      await mkdir(target, { recursive: true });
      await runRestoreSteps(component("source:main").restore.steps, {
        target,
        packageRoot: pkg,
      });
      const checkout = join(target, "main");
      const head = await runCommand([
        "git",
        "-C",
        checkout,
        "rev-parse",
        "HEAD",
      ]);
      expect(head.stdout.trim()).toBe(fx.headSha);
      expect(await readFile(join(checkout, "src/routes.js"), "utf8")).toBe(
        await readFile(join(fx.repoPath, "src/routes.js"), "utf8"),
      );
      expect(await readFile(join(checkout, "notes/todo.txt"), "utf8")).toBe(
        "remember to rotate keys\n",
      );
      expect(
        Buffer.compare(
          await readFile(join(checkout, "scratch.dat")),
          fx.expected.untrackedBytes,
        ),
      ).toBe(0);
      expect(
        await readFile(join(checkout, "vendor/lib/lib.js"), "utf8"),
      ).toContain("fixture-lib");
      const sub = await runCommand([
        "git",
        "-C",
        join(checkout, "vendor/lib"),
        "rev-parse",
        "HEAD",
      ]);
      expect(sub.stdout.trim()).toBe(fx.submoduleSha);
      if (fx.lfsWorks)
        expect(sha(await readFile(join(checkout, "assets/net.model")))).toBe(
          fx.lfsOid,
        );
      for (const file of await walk(checkout)) {
        expect(file.endsWith("/.env")).toBe(false);
        if (!file.includes("/.git/"))
          expect(
            (await readFile(file)).includes(Buffer.from(fx.secretMarker)),
          ).toBe(false);
      }
      await expect(stat(join(checkout, ".env"))).rejects.toThrow();
    });

    it("builds the restored checkout with the declared build and behavior steps", async () => {
      const target = join(root, "restore-source");
      const infra = component("infrastructure:infra").restore.steps;
      const done = await runRestoreSteps(infra, { target, packageRoot: pkg });
      expect(done.map((d) => d.id)).toEqual([
        "infra-web-build",
        "behavior-build-output",
      ]);
      expect(await readFile(join(target, "main/dist/out.txt"), "utf8")).toBe(
        "built ok\n",
      );
    });

    it("installs from the captured lockfile (zero-dependency npm project)", async () => {
      const npm = await runCommand(["npm", "--version"]);
      if (npm.exitCode !== 0) return;
      const target = join(root, "restore-source");
      const done = await runRestoreSteps(
        component("dependencies:deps").restore.steps,
        { target, packageRoot: pkg },
      );
      expect(done).toHaveLength(1);
    });
  });

  describe("dependencies", () => {
    it("captures lockfiles, toolchain pins, images and registries without credentials", async () => {
      expect(
        await readFile(
          join(pkg, "dependencies/deps/lockfiles/package-lock.json"),
          "utf8",
        ),
      ).toBe(await readFile(join(fx.repoPath, "package-lock.json"), "utf8"));
      const deps = result.manifest.dependencies;
      expect(deps.runtimes).toEqual(
        expect.arrayContaining([
          { name: "node", version: "22", source: ".nvmrc" },
        ]),
      );
      expect(deps.package_managers).toEqual([
        { name: "npm", version: "10.9.0", lockfile: "package-lock.json" },
      ]);
      expect(deps.container_images).toEqual(
        expect.arrayContaining([
          { ref: "node:22", digest: `sha256:${"a1".repeat(32)}` },
          { ref: "redis:7", digest: null },
        ]),
      );
      expect(deps.registries).toEqual([
        {
          url: "https://registry.example.com/npm/",
          required_for: expect.any(Array),
          credentials_required: true,
        },
      ]);
      const c = component("dependencies:deps");
      expect(c.limitations.join(" ")).toMatch(/not vendored/u);
      expect(c.limitations.join(" ")).toMatch(/not pinned by digest/u);
      expect(
        result.manifest.verification.network_required.reasons.join(" "),
      ).toMatch(/registry/u);
    });
  });

  describe("data", () => {
    it("restores into a second database and reproduces the captured invariant", async () => {
      const invariants = await readJson<
        {
          id: string;
          sql: string;
          expected_at_capture: string | null;
          declared_expect: number;
        }[]
      >("data/db/invariants.json");
      expect(invariants).toEqual([
        expect.objectContaining({
          id: "notes-count",
          sql: "select count(*) from notes",
          expected_at_capture: "3",
          declared_expect: 3,
          matches_declared: true,
          stable_during_capture: true,
        }),
      ]);
      const scratch = await fx.createScratchDatabase();
      await runRestoreSteps(component("data:db").restore.steps, {
        target: root,
        packageRoot: pkg,
        databaseUrl: scratch.url,
      });
      expect(await queryScalar(scratch.url, invariants[0]?.sql ?? "")).toBe(
        invariants[0]?.expected_at_capture,
      );
      expect(
        await queryScalar(
          scratch.url,
          "select notes from note_counts where account_id = 1",
        ),
      ).toBe("2");
    });

    it("stores schema and roles, and records snapshot details", async () => {
      expect(await readFile(join(pkg, "data/db/schema.sql"), "utf8")).toMatch(
        /CREATE TABLE public\.notes/u,
      );
      expect(await readFile(join(pkg, "data/db/roles.sql"), "utf8")).toMatch(
        /CREATE ROLE/u,
      );
      expect(
        await readFile(join(pkg, "data/db/roles.sql"), "utf8"),
      ).not.toMatch(/PASSWORD/u);
      const c = component("data:db");
      expect(c.method).toBe("pg_dump -Fc (single snapshot)");
      expect(c.captured_at).not.toBeNull();
      expect(c.details).toMatchObject({ roles_included: true, tables: 2 });
      expect(result.manifest.restore_guards.blocked_hosts).toEqual([
        "app.example.com",
      ]);
    });
  });

  describe("assets", () => {
    it("hashes every object and reports the skipped symlink", async () => {
      const listing = await readJson<{
        objects: {
          path: string;
          size: number;
          sha256: string;
          mtime: string;
          content_type: string;
        }[];
        skipped: { rel: string; reason: string }[];
      }>("assets/uploads/objects.json");
      expect(listing.objects.map((o) => o.path)).toEqual([
        "top.csv",
        "uploads/2026/avatar.png",
        "uploads/2026/report.pdf",
        "uploads/readme.txt",
      ]);
      for (const o of listing.objects) {
        const data = await readFile(
          join(pkg, "assets/uploads/objects", o.path),
        );
        expect(sha(data)).toBe(o.sha256);
        expect(data.length).toBe(o.size);
        expect(sha(await readFile(join(fx.assetsPath, o.path)))).toBe(o.sha256);
      }
      expect(
        listing.objects.find((o) => o.path.endsWith(".png"))?.content_type,
      ).toBe("image/png");
      expect(listing.skipped).toEqual([
        expect.objectContaining({ rel: "uploads/escape-link" }),
      ]);
      expect(component("assets:uploads").omissions[0]?.what).toContain(
        "escape-link",
      );
      expect(
        (await readdir(join(pkg, "assets/uploads/objects/uploads"))).includes(
          "escape-link",
        ),
      ).toBe(false);
    });

    it("restores the asset tree with cp", async () => {
      const assetsRoot = join(root, "assets-root");
      await mkdir(assetsRoot, { recursive: true });
      await runRestoreSteps(component("assets:uploads").restore.steps, {
        target: root,
        packageRoot: pkg,
        assetsRoot,
      });
      expect(
        await readFile(join(assetsRoot, "uploads/uploads/readme.txt"), "utf8"),
      ).toBe("user uploads\n");
    });
  });

  describe("infrastructure and integrations", () => {
    it("records env var names with their sources, never values", async () => {
      const names = await readJson<{
        names: { name: string; sources: { kind: string; file?: string }[] }[];
      }>("infrastructure/env-names.json");
      const byName = new Map(
        names.names.map((n) => [n.name, n.sources.map((s) => s.kind)]),
      );
      expect(byName.get("DATABASE_URL")).toEqual(
        expect.arrayContaining(["code", "env_example"]),
      );
      expect(byName.get("STRIPE_SECRET_KEY")).toEqual(
        expect.arrayContaining(["code", "env_example", "secret_ref"]),
      );
      expect(byName.get("PORT")).toEqual(
        expect.arrayContaining(["declared", "code"]),
      );
      expect(byName.get("BUILD_ID")).toEqual(["dockerfile"]);
      expect(result.manifest.secrets.names).toEqual(
        expect.arrayContaining([
          "DATABASE_URL",
          "STRIPE_SECRET_KEY",
          "FIXTURE_DATABASE_URL",
        ]),
      );
      const services = await readJson<{ detected_platform_config: string[] }>(
        "infrastructure/services.json",
      );
      expect(services.detected_platform_config).toEqual([]);
      for (const f of ["schedules", "domains", "health", "behavior-checks"])
        await stat(join(pkg, `infrastructure/${f}.json`));
      expect(result.manifest.restore_guards.disabled_schedules).toEqual([
        "nightly-cleanup",
      ]);
      expect(
        (
          await readJson<{
            checks: { expect_exit: number; timeout_ms: number }[];
          }>("infrastructure/behavior-checks.json")
        ).checks[0],
      ).toMatchObject({ expect_exit: 0, timeout_ms: 30000 });
    });

    it("makes providers manual prerequisites and flags inferred SDKs", async () => {
      const doc = await readJson<{
        providers: {
          name: string;
          origin: string;
          inferred: boolean;
          webhooks: { url: string }[];
          evidence: { dependency: string }[];
        }[];
      }>("integrations/integrations.json");
      const stripe = doc.providers.find((p) => p.name === "Stripe");
      expect(stripe).toMatchObject({
        origin: "declared",
        inferred: false,
        webhooks: [{ url: "https://app.example.com/webhooks/stripe" }],
      });
      expect(stripe?.evidence.map((e) => e.dependency)).toContain("stripe");
      expect(doc.providers.find((p) => p.name === "Twilio")).toMatchObject({
        origin: "inferred",
        inferred: true,
      });
      const manual = result.manifest.manual_prerequisites.map((m) => m.id);
      expect(manual).toEqual(
        expect.arrayContaining([
          "integrations:integ:stripe",
          "integrations:integ:twilio",
        ]),
      );
      expect(result.manifest.restore_guards.disabled_webhooks).toEqual([
        "https://app.example.com/webhooks/stripe",
      ]);
    });
  });

  describe("product and artifacts", () => {
    it("runs Code-to-PRD and states what the PRD is not", async () => {
      const analysis = await readJson<{
        project: { root: string };
        apis: { endpoints: { path: string }[] };
      }>("product/prd/analysis.json");
      expect(analysis.project.root).toBe(".");
      expect(analysis.apis.endpoints.map((e) => e.path)).toContain(
        "/api/notes",
      );
      expect(JSON.stringify(analysis)).not.toContain(tc.ctx.workspace);
      const readme = await readFile(join(pkg, "product/prd/README.md"), "utf8");
      expect(readme).toMatch(/static analysis/u);
      expect(readme).toMatch(/not an exact-source backup/u);
      expect(
        await readFile(
          join(pkg, "product/prd/prd/appendix/api-inventory.md"),
          "utf8",
        ),
      ).toContain("/api/notes");
      const details = component("product:prd").details;
      expect(details["analyzer_sha256"]).toBe(
        sha(
          await readFile(
            fileURLToPath(
              new URL(
                "../../../third_party/code-to-prd/scripts/codebase_analyzer.py",
                import.meta.url,
              ),
            ),
          ),
        ),
      );
      expect(details["pinned_revision"]).toBe(
        "19392f7a08264ed00486a251f5b2098321771f94",
      );
      expect(component("product:prd").restore.steps).toEqual([]);
      expect(
        await readFile(join(pkg, "licenses/code-to-prd-MIT.txt"), "utf8"),
      ).toContain("MIT License");
    });

    it("records investigations as manual with the export remediation", () => {
      expect(result.manifest.missing_or_blocked).toContainEqual(
        expect.objectContaining({
          component_id: "artifacts:evidence",
          status: "manual",
          remediation: expect.stringMatching(
            /export evidence bundles from the investigation export screen/iu,
          ),
        }),
      );
      expect(
        result.manifest.missing_or_blocked.find(
          (m) => m.component_id === "assets:uploads",
        )?.status,
      ).toBe("missing");
    });
  });
});
