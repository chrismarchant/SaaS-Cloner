import { createHash, randomBytes } from "node:crypto";
import {
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
import {
  DEFAULT_SECRET_ENV_NAMES,
  redactorFromEnvironment,
  validateRestoreStepArguments,
} from "@rea-web/contracts";
import { verifyIntegrity } from "@rea-web/recovery";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  S3_OPTIONS,
  type S3CaptureOptions,
  type S3OptionsCarrier,
} from "../src/collectors/assets/s3Connection.js";
import {
  type BuildDefinition,
  type CaptureResult,
  type CollectorContext,
  type PreservationPlanBody,
  capturePackage,
  planPreservation,
} from "../src/index.js";
import { type MockS3, startMockS3 } from "./mockS3.js";
import { runRestoreSteps } from "./fixtureBuild.js";

const sha = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");

const KEY_ID = "AKIAFIXTUREKEYID012345";
const SECRET = "fixture-secret-access-key-value-0123456789";
const TOKEN = "fixture-session-token-value-0123456789";
const SERVICE_ROLE = "fixture-service-role-key-value-0123456789";
const RUNNER_ID = "0194f1e0-0000-7000-8000-000000000001";

type AssetsDecl = Extract<
  BuildDefinition["components"][number],
  { kind: "assets" }
>;

interface Harness {
  ctx: CollectorContext & S3OptionsCarrier;
  logs: { level: string; message: string; fields: unknown }[];
  controller: AbortController;
}

interface Manifested {
  plan: PreservationPlanBody;
  result: CaptureResult;
  pkg: string;
  h: Harness;
}

let root = "";
let counter = 0;
let mock: MockS3;
const extraMocks: MockS3[] = [];

const makeHarness = (
  env: Record<string, string | undefined>,
  s3: S3CaptureOptions,
  localPaths: Map<string, string> = new Map(),
): Harness => {
  const logs: Harness["logs"] = [];
  const controller = new AbortController();
  counter += 1;
  return {
    logs,
    controller,
    ctx: {
      workspace: join(root, `ws${counter}`),
      env,
      signal: controller.signal,
      log: (level, message, fields) => logs.push({ level, message, fields }),
      redactor: redactorFromEnvironment(env, [...DEFAULT_SECRET_ENV_NAMES]),
      localPaths,
      now: () => new Date(),
      [S3_OPTIONS]: s3,
    },
  };
};

const buildOf = (components: AssetsDecl[]): BuildDefinition => ({
  id: "build-s3",
  name: "S3 Build",
  description: "S3 asset capture",
  project_slug: "s3-build",
  source: {
    kind: "runner_local",
    runner_id: RUNNER_ID,
    path_hash: sha("unused"),
    include_working_tree: false,
    include_lfs: false,
    include_submodules: false,
  },
  components,
});

const s3Decl = (
  over: Partial<{
    id: string;
    bucket: string;
    prefix: string;
    endpoint_env_name: string | undefined;
  }> = {},
): AssetsDecl => ({
  kind: "assets",
  id: over.id ?? "bucket",
  source: {
    kind: "s3",
    bucket: over.bucket ?? "backups",
    prefix: over.prefix ?? "uploads",
    ...("endpoint_env_name" in over
      ? over.endpoint_env_name === undefined
        ? {}
        : { endpoint_env_name: over.endpoint_env_name }
      : { endpoint_env_name: "FIX_S3_ENDPOINT" }),
    credentials_env_prefix: "FIX_S3",
  },
});

const supabaseDecl = (buckets: string[], id = "storage"): AssetsDecl => ({
  kind: "assets",
  id,
  source: {
    kind: "supabase_storage",
    project_ref: "abcdefghijklmnopqrst",
    buckets,
    credentials_env_prefix: "SUPA",
  },
});

const s3Env = (
  over: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  FIX_S3_ACCESS_KEY_ID: KEY_ID,
  FIX_S3_SECRET_ACCESS_KEY: SECRET,
  FIX_S3_SESSION_TOKEN: TOKEN,
  FIX_S3_ENDPOINT: mock.endpoint,
  ...over,
});

const run = async (
  components: AssetsDecl[],
  env: Record<string, string | undefined>,
  s3: S3CaptureOptions = { allowLoopbackEndpoint: true, maxAttempts: 1 },
  localPaths?: Map<string, string>,
): Promise<Manifested> => {
  const h = makeHarness(env, s3, localPaths);
  await mkdir(h.ctx.workspace, { recursive: true });
  const build = buildOf(components);
  const plan = await planPreservation(build, h.ctx);
  const pkg = join(root, `pkg${counter}`);
  const result = await capturePackage(build, plan, h.ctx, {
    stagingDir: pkg,
    producerVersion: "0.0.0-test",
  });
  for (const c of result.manifest.components)
    for (const step of c.restore.steps)
      expect(validateRestoreStepArguments(step), `${c.id}/${step.id}`).toEqual({
        ok: true,
      });
  return { plan, result, pkg: result.root, h };
};

interface Listing {
  source: string;
  point_in_time_snapshot: boolean;
  captured_at: { start: string; end: string };
  objects: {
    bucket: string;
    key: string;
    path: string;
    size: number;
    sha256: string;
    etag: string | null;
    last_modified: string | null;
    content_type: string;
  }[];
  skipped: { bucket: string; key: string; reason: string; benign: boolean }[];
  totals: { objects: number; bytes: number; skipped: number };
}

const listingOf = async (pkg: string, id: string): Promise<Listing> =>
  JSON.parse(
    await readFile(join(pkg, "assets", id, "objects.json"), "utf8"),
  ) as Listing;

const walk = async (dir: string, prefix = ""): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walk(join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out.sort();
};

const component = (m: Manifested, id: string) => {
  const c = m.result.manifest.components.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no component ${id}`);
  return c;
};

const BIG = randomBytes(70_000);
const DEEP = randomBytes(5000);

const seed = (): void => {
  mock.put("backups", "uploads/a.txt", "alpha\n", "text/plain");
  mock.put("backups", "uploads/nested/deep/b.bin", DEEP);
  mock.put("backups", "uploads/nested/c.json", '{"c":1}', "application/json");
  mock.put("backups", "uploads/d.png", BIG, "image/png");
  mock.put("backups", "uploads/e.txt", "echo\n", "text/plain");
  mock.put("backups", "uploads/f.txt", "foxtrot\n", "text/plain");
  mock.put("backups", "uploads/empty.dat", "", "application/octet-stream");
  mock.put("backups", "uploads/nested/", "", "application/x-directory");
  mock.put("backups", "outside/z.txt", "not under the prefix\n");
};

const secretsIn = async (dir: string): Promise<string[]> => {
  const hits: string[] = [];
  for (const rel of await walk(dir)) {
    const data = await readFile(join(dir, rel));
    for (const secret of [KEY_ID, SECRET, TOKEN, SERVICE_ROLE])
      if (data.includes(secret))
        hits.push(`${rel} contains ${secret.slice(0, 8)}`);
  }
  return hits;
};

const assertNoSecrets = async (m: Manifested): Promise<void> => {
  expect(await secretsIn(m.pkg)).toEqual([]);
  const text = JSON.stringify({
    plan: m.plan,
    result: m.result,
    logs: m.h.logs,
  });
  for (const secret of [KEY_ID, SECRET, TOKEN, SERVICE_ROLE])
    expect(text).not.toContain(secret);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pres-s3-"));
  mock = await startMockS3(["backups"], { pageSize: 2 });
});

afterEach(async () => {
  await mock.close();
  for (const m of extraMocks.splice(0)) await m.close();
  await rm(root, { recursive: true, force: true });
});

describe("S3 plan", () => {
  it("checks credentials by name, lists with MaxKeys=1 and estimates the bytes", async () => {
    seed();
    const h = makeHarness(s3Env(), {
      allowLoopbackEndpoint: true,
      pageSize: 2,
    });
    await mkdir(h.ctx.workspace, { recursive: true });
    const plan = await planPreservation(buildOf([s3Decl()]), h.ctx);
    const c = plan.components[0];
    expect(c).toMatchObject({
      id: "assets:bucket",
      collector: "s3",
      method: "s3 list+get",
      feasible: true,
    });
    const listed = [...mock.buckets.get("backups")!.entries()].filter(([k]) =>
      k.startsWith("uploads/"),
    );
    expect(c?.estimated_bytes).toBe(
      listed.reduce((n, [, o]) => n + o.body.length, 0),
    );
    expect(c?.permissions.every((p) => p.ok)).toBe(true);
    expect(c?.permissions.map((p) => p.check).join("\n")).toMatch(
      /FIX_S3_ACCESS_KEY_ID \/ FIX_S3_SECRET_ACCESS_KEY/u,
    );
    expect(mock.requests[0]).toMatch(/max-keys=1/u);
    // 8 keys at 2 per page: the estimate paginated.
    expect(
      mock.requests.filter((r) => r.includes("continuation-token")).length,
    ).toBeGreaterThanOrEqual(3);
    expect(c?.omissions.map((o) => o.what).join(" ")).toMatch(/ACLs/u);
    expect(JSON.stringify(plan)).not.toContain(SECRET);
    expect(JSON.stringify(plan)).not.toContain(KEY_ID);
  });

  it("reports a null estimate with a reason when the listing exceeds the page limit", async () => {
    seed();
    const h = makeHarness(s3Env(), {
      allowLoopbackEndpoint: true,
      pageSize: 2,
      estimatePageLimit: 2,
    });
    await mkdir(h.ctx.workspace, { recursive: true });
    const plan = await planPreservation(buildOf([s3Decl()]), h.ctx);
    const c = plan.components[0];
    expect(c?.estimated_bytes).toBeNull();
    expect(c?.feasible).toBe(true);
    expect(
      c?.permissions.find((p) => p.check === "size estimate")?.detail,
    ).toMatch(/unknown: .*within 2 pages/u);
  });

  it("is infeasible, naming the variables, when credentials are missing", async () => {
    const h = makeHarness(
      s3Env({
        FIX_S3_ACCESS_KEY_ID: undefined,
        FIX_S3_SECRET_ACCESS_KEY: undefined,
      }),
      { allowLoopbackEndpoint: true },
    );
    await mkdir(h.ctx.workspace, { recursive: true });
    const plan = await planPreservation(buildOf([s3Decl()]), h.ctx);
    const c = plan.components[0];
    expect(c?.feasible).toBe(false);
    expect(JSON.stringify(c)).toContain("FIX_S3_ACCESS_KEY_ID");
    expect(mock.requests).toEqual([]);
  });

  it("is infeasible when the bucket denies listing", async () => {
    seed();
    mock.denyList.add("backups");
    const h = makeHarness(s3Env(), {
      allowLoopbackEndpoint: true,
      maxAttempts: 1,
    });
    await mkdir(h.ctx.workspace, { recursive: true });
    const plan = await planPreservation(buildOf([s3Decl()]), h.ctx);
    expect(plan.components[0]?.feasible).toBe(false);
    expect(plan.components[0]?.estimated_bytes).toBeNull();
  });
});

describe("S3 capture", () => {
  it("captures nested keys across pages with verified hashes and a restorable layout", async () => {
    seed();
    const m = await run([s3Decl()], s3Env());
    expect(m.result.componentStatuses["assets:bucket"]).toBe("captured");
    const c = component(m, "assets:bucket");
    expect(c.method).toBe("s3 list+get");
    const listing = await listingOf(m.pkg, "bucket");
    expect(listing.source).toBe("s3");
    expect(listing.point_in_time_snapshot).toBe(false);
    expect(listing.objects.map((o) => o.path)).toEqual([
      "a.txt",
      "d.png",
      "e.txt",
      "empty.dat",
      "f.txt",
      "nested/c.json",
      "nested/deep/b.bin",
    ]);
    for (const o of listing.objects) {
      const bytes = await readFile(
        join(m.pkg, "assets/bucket/objects", o.path),
      );
      expect(sha(bytes)).toBe(o.sha256);
      expect(bytes.length).toBe(o.size);
      expect(o.key).toBe(`uploads/${o.path}`);
      expect(o.bucket).toBe("backups");
      expect(o.etag).toMatch(/^"[0-9a-f]{32}"$/u);
      expect(Date.parse(o.last_modified ?? "")).not.toBeNaN();
      expect(sha(mock.buckets.get("backups")!.get(o.key)!.body)).toBe(o.sha256);
    }
    const byPath = new Map(listing.objects.map((o) => [o.path, o]));
    expect(byPath.get("d.png")?.content_type).toBe("image/png");
    expect(byPath.get("nested/c.json")?.content_type).toBe("application/json");
    expect(byPath.get("d.png")?.size).toBe(BIG.length);
    // The zero-byte directory placeholder is recorded as skipped, not an omission.
    expect(listing.skipped).toEqual([
      expect.objectContaining({ key: "uploads/nested/", benign: true }),
    ]);
    expect(c.omissions).toEqual([]);
    expect((await walk(join(m.pkg, "assets/bucket/objects"))).sort()).toEqual(
      listing.objects.map((o) => o.path).sort(),
    );
    // More than one list page was needed, and only the prefix was listed.
    expect(
      mock.requests.filter((r) => r.includes("list-type=2")).length,
    ).toBeGreaterThanOrEqual(4);
    expect(mock.requests.some((r) => r.includes("outside"))).toBe(false);
    // Window and snapshot honesty.
    expect(c.captured_at).not.toBeNull();
    expect(Date.parse(c.captured_at?.start ?? "")).toBeLessThanOrEqual(
      Date.parse(c.captured_at?.end ?? ""),
    );
    expect(listing.captured_at).toEqual(c.captured_at);
    expect(c.limitations.join(" ")).toMatch(
      /no point-in-time snapshot.*may or may not be included/u,
    );
    expect(m.result.consistency).toBe("single_point");
    expect(
      m.result.manifest.manual_prerequisites.find(
        (p) => p.component_id === "assets:bucket",
      ),
    ).toMatchObject({
      title: "Recreate S3 bucket backups",
      reason: expect.stringMatching(
        /ACLs and metadata other than content-type/u,
      ),
    });
    expect(c.entries).toBe(8);
    expect((await verifyIntegrity(m.pkg)).ok).toBe(true);
    await assertNoSecrets(m);
  });

  it("restores byte for byte with the cp step", async () => {
    seed();
    const m = await run([s3Decl()], s3Env());
    const steps = component(m, "assets:bucket").restore.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]?.run).toEqual([
      "cp",
      "-R",
      "{{package_root}}/assets/bucket/objects/.",
      "{{assets_root}}/bucket/",
    ]);
    const assetsRoot = join(root, "assets-root");
    await mkdir(assetsRoot, { recursive: true });
    await runRestoreSteps(steps, {
      target: root,
      packageRoot: m.pkg,
      assetsRoot,
    });
    const listing = await listingOf(m.pkg, "bucket");
    for (const o of listing.objects)
      expect(sha(await readFile(join(assetsRoot, "bucket", o.path)))).toBe(
        o.sha256,
      );
    expect(await readFile(join(assetsRoot, "bucket/a.txt"), "utf8")).toBe(
      "alpha\n",
    );
  });

  it("skips unsafe keys with a reason and still captures the rest", async () => {
    const put = (key: string, body = "x"): void =>
      mock.put("backups", key, body);
    put("../x");
    put("/abs");
    put("bad\u0000name");
    put("back\\slash");
    put("./dot");
    put("dir/", "");
    put("Case.txt", "upper");
    put("case.txt", "lower");
    put("file", "is a file");
    put("file/child", "under a file");
    put("ok/file.txt", "fine");
    const m = await run([s3Decl({ prefix: "" })], s3Env());
    expect(m.result.componentStatuses["assets:bucket"]).toBe("partial");
    const listing = await listingOf(m.pkg, "bucket");
    expect(listing.objects.map((o) => o.path).sort()).toEqual(
      ["Case.txt", "file", "ok/file.txt"].sort(),
    );
    const reasons = new Map(listing.skipped.map((s) => [s.key, s]));
    expect(reasons.get("../x")?.reason).toMatch(
      /not a safe relative path \(traversal\)/u,
    );
    expect(reasons.get("/abs")?.reason).toMatch(/\(absolute\)/u);
    expect(reasons.get("bad\u0000name")?.reason).toMatch(/control_characters/u);
    expect(reasons.get("back\\slash")?.reason).toMatch(/canonical/u);
    expect(reasons.get("./dot")?.reason).toMatch(/canonical/u);
    expect(reasons.get("dir/")?.benign).toBe(true);
    expect(reasons.get("case.txt")?.reason).toMatch(
      /collides case-insensitively/u,
    );
    expect(reasons.get("file/child")?.reason).toMatch(
      /cannot be stored as a file/u,
    );
    const what = component(m, "assets:bucket").omissions.map((o) => o.what);
    expect(what.some((w) => w.includes("../x"))).toBe(true);
    expect(what.some((w) => w.includes("dir/"))).toBe(false);
    for (const o of component(m, "assets:bucket").omissions)
      expect(o.reason.length).toBeGreaterThan(10);
    // Nothing escaped the objects directory.
    const files = await walk(m.pkg);
    expect(files.some((f) => f.endsWith("/x") || f === "x")).toBe(false);
    expect(files.filter((f) => !f.startsWith("assets/bucket/"))).not.toContain(
      "abs",
    );
  });

  it("decodes URL-encoded keys, and leaves keys alone when the service does not encode", async () => {
    mock.put("backups", "uploads/héllo wörld+1.txt", "unicode");
    mock.put("backups", "uploads/100%+done.txt", "percent");
    const encoded = await run([s3Decl()], s3Env());
    const a = await listingOf(encoded.pkg, "bucket");
    expect(a.objects.map((o) => o.key).sort()).toEqual([
      "uploads/100%+done.txt",
      "uploads/héllo wörld+1.txt",
    ]);
    expect(
      await readFile(
        join(encoded.pkg, "assets/bucket/objects/héllo wörld+1.txt"),
        "utf8",
      ),
    ).toBe("unicode");

    const raw = await startMockS3(["backups"], { encodeKeys: false });
    extraMocks.push(raw);
    raw.put("backups", "uploads/100%+done.txt", "percent");
    raw.put("backups", "uploads/a b.txt", "space");
    const m = await run([s3Decl()], s3Env({ FIX_S3_ENDPOINT: raw.endpoint }));
    const b = await listingOf(m.pkg, "bucket");
    expect(b.objects.map((o) => o.key).sort()).toEqual([
      "uploads/100%+done.txt",
      "uploads/a b.txt",
    ]);
  });

  it("skips an object whose received size differs from the listing", async () => {
    seed();
    mock.listedSize.set("backups/uploads/e.txt", 999);
    const m = await run([s3Decl()], s3Env());
    expect(m.result.componentStatuses["assets:bucket"]).toBe("partial");
    const listing = await listingOf(m.pkg, "bucket");
    expect(listing.objects.map((o) => o.path)).not.toContain("e.txt");
    expect(
      listing.skipped.find((s) => s.key === "uploads/e.txt")?.reason,
    ).toMatch(
      /size changed since it was listed \(listed 999 bytes, received 5\)/u,
    );
    expect(await walk(join(m.pkg, "assets/bucket/objects"))).not.toContain(
      "e.txt",
    );
  });

  it("stops at the object limit with a partial component and a named omission", async () => {
    seed();
    const m = await run([s3Decl()], s3Env(), {
      allowLoopbackEndpoint: true,
      maxObjects: 3,
      pageSize: 2,
    });
    expect(m.result.componentStatuses["assets:bucket"]).toBe("partial");
    const listing = await listingOf(m.pkg, "bucket");
    expect(listing.objects).toHaveLength(3);
    const c = component(m, "assets:bucket");
    expect(c.omissions[0]?.what).toMatch(/3-object limit/u);
    expect(c.omissions[0]?.remediation).toMatch(/prefix|limit/u);
    expect(c.omissions[0]?.reason).toMatch(/not examined/u);
    expect((await walk(join(m.pkg, "assets/bucket/objects"))).sort()).toEqual(
      listing.objects.map((o) => o.path).sort(),
    );
  });

  it("stops before exceeding the byte limit", async () => {
    seed();
    const m = await run([s3Decl()], s3Env(), {
      allowLoopbackEndpoint: true,
      maxBytes: 100,
    });
    expect(m.result.componentStatuses["assets:bucket"]).toBe("partial");
    const listing = await listingOf(m.pkg, "bucket");
    expect(listing.objects.map((o) => o.path)).toEqual(["a.txt"]);
    expect(component(m, "assets:bucket").omissions[0]?.what).toMatch(
      /100-byte limit/u,
    );
  });

  it("keeps verified files and deletes the half-written one on a mid-capture network failure", async () => {
    seed();
    mock.dropGet.add("backups/uploads/d.png");
    const m = await run([s3Decl()], s3Env());
    expect(m.result.componentStatuses["assets:bucket"]).toBe("partial");
    const listing = await listingOf(m.pkg, "bucket");
    expect(listing.objects.map((o) => o.path)).toEqual(["a.txt"]);
    expect(await walk(join(m.pkg, "assets/bucket/objects"))).toEqual(["a.txt"]);
    const c = component(m, "assets:bucket");
    expect(c.omissions[0]?.reason).toMatch(/network/u);
    expect(c.omissions[0]?.reason).toMatch(
      /written before the failure are complete/u,
    );
    expect(c.restore.steps).toHaveLength(1);
    expect((await verifyIntegrity(m.pkg)).ok).toBe(true);
  });

  it("blocks when the endpoint cannot be reached at all", async () => {
    const dead = await startMockS3(["backups"]);
    const endpoint = dead.endpoint;
    await dead.close();
    const m = await run([s3Decl()], s3Env({ FIX_S3_ENDPOINT: endpoint }));
    expect(m.result.componentStatuses["assets:bucket"]).toBe("blocked");
    expect(component(m, "assets:bucket").omissions[0]?.remediation).toMatch(
      /network access/u,
    );
  });

  it("stops promptly when the job signal aborts", async () => {
    seed();
    const h = makeHarness(s3Env(), {
      allowLoopbackEndpoint: true,
      maxAttempts: 1,
    });
    await mkdir(h.ctx.workspace, { recursive: true });
    mock.onRequest = (line) => {
      if (line.includes("d.png")) h.controller.abort();
    };
    const build = buildOf([s3Decl()]);
    const plan = {
      components: [],
      consistency_strategy: "",
      known_omissions: [],
    };
    await expect(
      capturePackage(build, plan, h.ctx, {
        stagingDir: join(root, "aborted"),
        producerVersion: "0.0.0-test",
      }),
    ).rejects.toThrow();
    expect(mock.requests.some((r) => r.includes("e.txt"))).toBe(false);
  });
});

describe("S3 failures block one component and nothing else", () => {
  const localDir = async (): Promise<Map<string, string>> => {
    const dir = join(root, "local-assets");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "keep.txt"), "kept\n");
    return new Map([[sha(dir), dir]]);
  };
  const localDecl = (): AssetsDecl => ({
    kind: "assets",
    id: "local",
    source: {
      kind: "runner_local",
      runner_id: RUNNER_ID,
      path_hash: sha(join(root, "local-assets")),
    },
  });

  it("blocks with specific remediation when access is denied, and redacts the service message", async () => {
    seed();
    mock.denyAll = true;
    mock.denyMessage = `denied for ${KEY_ID} using ${SECRET}`;
    const m = await run(
      [localDecl(), s3Decl()],
      s3Env(),
      undefined,
      await localDir(),
    );
    expect(m.result.componentStatuses["assets:bucket"]).toBe("blocked");
    expect(m.result.componentStatuses["assets:local"]).toBe("captured");
    const entry = m.result.manifest.missing_or_blocked.find(
      (x) => x.component_id === "assets:bucket",
    );
    expect(entry?.status).toBe("blocked");
    expect(entry?.reason).toMatch(/Access denied/u);
    expect(entry?.remediation).toMatch(
      /FIX_S3_ACCESS_KEY_ID.*s3:ListBucket.*s3:GetObject/u,
    );
    expect(
      await readFile(join(m.pkg, "assets/local/objects/keep.txt"), "utf8"),
    ).toBe("kept\n");
    await assertNoSecrets(m);
    expect(m.result.manifest.secrets.names).toEqual(
      expect.arrayContaining([
        "FIX_S3_ACCESS_KEY_ID",
        "FIX_S3_SECRET_ACCESS_KEY",
      ]),
    );
  });

  it("blocks when the bucket does not exist", async () => {
    const m = await run(
      [localDecl(), s3Decl({ bucket: "ghost" })],
      s3Env(),
      undefined,
      await localDir(),
    );
    expect(m.result.componentStatuses["assets:bucket"]).toBe("blocked");
    expect(m.result.componentStatuses["assets:local"]).toBe("captured");
    const entry = m.result.manifest.missing_or_blocked.find(
      (x) => x.component_id === "assets:bucket",
    );
    expect(entry?.reason).toMatch(/Bucket ghost does not exist/u);
    expect(entry?.remediation).toMatch(/bucket name/u);
  });

  it("blocks when every object read is denied", async () => {
    seed();
    for (const key of mock.buckets.get("backups")?.keys() ?? [])
      mock.denyGet.add(`backups/${key}`);
    const m = await run([s3Decl()], s3Env());
    expect(m.result.componentStatuses["assets:bucket"]).toBe("blocked");
  });

  it("keeps going when a single object read is denied", async () => {
    seed();
    mock.denyGet.add("backups/uploads/e.txt");
    const m = await run([s3Decl()], s3Env());
    expect(m.result.componentStatuses["assets:bucket"]).toBe("partial");
    const listing = await listingOf(m.pkg, "bucket");
    expect(listing.objects).toHaveLength(6);
    expect(
      listing.skipped.find((s) => s.key === "uploads/e.txt")?.reason,
    ).toMatch(/read denied/u);
  });

  it("blocks when credentials are not set, naming the variables", async () => {
    seed();
    const m = await run(
      [localDecl(), s3Decl()],
      s3Env({ FIX_S3_SECRET_ACCESS_KEY: undefined }),
      undefined,
      await localDir(),
    );
    expect(m.result.componentStatuses["assets:bucket"]).toBe("blocked");
    expect(m.result.componentStatuses["assets:local"]).toBe("captured");
    const entry = m.result.manifest.missing_or_blocked.find(
      (x) => x.component_id === "assets:bucket",
    );
    expect(entry?.reason).toContain("FIX_S3_SECRET_ACCESS_KEY");
    expect(mock.requests).toEqual([]);
  });

  it("blocks when the declared endpoint variable is unset instead of using AWS", async () => {
    const m = await run([s3Decl()], s3Env({ FIX_S3_ENDPOINT: undefined }));
    expect(m.result.componentStatuses["assets:bucket"]).toBe("blocked");
    expect(component(m, "assets:bucket").omissions[0]?.reason).toMatch(
      /FIX_S3_ENDPOINT/u,
    );
  });
});

describe("endpoint safety guard", () => {
  it("refuses a loopback endpoint unless the test-only option is set", async () => {
    seed();
    const m = await run([s3Decl()], s3Env(), { maxAttempts: 1 });
    expect(m.result.componentStatuses["assets:bucket"]).toBe("blocked");
    expect(m.plan.components[0]?.feasible).toBe(false);
    const entry = m.result.manifest.missing_or_blocked.find(
      (x) => x.component_id === "assets:bucket",
    );
    expect(entry?.reason).toMatch(/network safety guard/u);
    expect(entry?.reason).toMatch(/https is required|private, loopback/u);
    expect(mock.requests).toEqual([]);
  });

  it.each([
    ["https://10.1.2.3/", /private, loopback or reserved address 10\.1\.2\.3/u],
    ["https://169.254.169.254/", /169\.254\.169\.254/u],
    ["https://user:pw@example.com/", /embedded credentials/u],
    ["http://example.com/", /https is required/u],
    ["https://localhost/", /local or internal name/u],
  ])("refuses endpoint %s", async (endpoint, reason) => {
    const m = await run([s3Decl()], s3Env({ FIX_S3_ENDPOINT: endpoint }), {
      maxAttempts: 1,
    });
    expect(m.result.componentStatuses["assets:bucket"]).toBe("blocked");
    expect(component(m, "assets:bucket").omissions[0]?.reason).toMatch(reason);
    await assertNoSecrets(m);
  });

  it("refuses a default endpoint that resolves to a private address", async () => {
    const resolver = (): Promise<{ address: string }[]> =>
      Promise.resolve([{ address: "10.0.0.5" }]);
    const aws = await run([s3Decl({ endpoint_env_name: undefined })], s3Env(), {
      resolver,
      maxAttempts: 1,
    });
    expect(aws.result.componentStatuses["assets:bucket"]).toBe("blocked");
    expect(component(aws, "assets:bucket").omissions[0]?.reason).toMatch(
      /resolves to the private, loopback or reserved address 10\.0\.0\.5/u,
    );
    const supa = await run(
      [supabaseDecl(["avatars"])],
      { SUPA_ACCESS_KEY_ID: KEY_ID, SUPA_SECRET_ACCESS_KEY: SECRET },
      { resolver, maxAttempts: 1 },
    );
    expect(supa.result.componentStatuses["assets:storage"]).toBe("blocked");
    expect(component(supa, "assets:storage").omissions[0]?.reason).toMatch(
      /10\.0\.0\.5/u,
    );
    expect(supa.plan.components[0]?.feasible).toBe(false);
    expect(mock.requests).toEqual([]);
  });

  it("refuses a hostname that resolves to loopback even over https", async () => {
    const m = await run(
      [s3Decl()],
      s3Env({ FIX_S3_ENDPOINT: "https://storage.example.com" }),
      {
        resolver: () => Promise.resolve([{ address: "127.0.0.1" }]),
        maxAttempts: 1,
      },
    );
    expect(m.result.componentStatuses["assets:bucket"]).toBe("blocked");
    expect(component(m, "assets:bucket").omissions[0]?.reason).toMatch(
      /127\.0\.0\.1/u,
    );
  });
});

describe("Supabase Storage", () => {
  let supa: MockS3;
  beforeEach(async () => {
    supa = await startMockS3(["avatars", "docs"], {
      pageSize: 2,
      basePath: "/storage/v1/s3",
    });
    extraMocks.push(supa);
    for (const [i, name] of ["one.png", "two.png", "three.png"].entries())
      supa.put("avatars", `u/${name}`, randomBytes(300 + i), "image/png");
    supa.put("avatars", "top.txt", "top\n", "text/plain");
    supa.put("docs", "guide/readme.md", "# readme\n", "text/markdown");
    supa.put("docs", "guide/deep/x.pdf", randomBytes(4000), "application/pdf");
  });

  const env = (
    over: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> => ({
    SUPA_ACCESS_KEY_ID: KEY_ID,
    SUPA_SECRET_ACCESS_KEY: SECRET,
    SUPA_SERVICE_ROLE_KEY: SERVICE_ROLE,
    SUPA_ENDPOINT: supa.endpoint,
    ...over,
  });

  it("captures each listed bucket below objects/<bucket>/ through the endpoint override", async () => {
    const m = await run([supabaseDecl(["avatars", "docs"])], env(), {
      allowLoopbackEndpoint: true,
      pageSize: 2,
      maxAttempts: 1,
    });
    expect(m.result.componentStatuses["assets:storage"]).toBe("captured");
    const listing = await listingOf(m.pkg, "storage");
    expect(listing.source).toBe("supabase_storage");
    expect(listing.objects.map((o) => o.path)).toEqual([
      "avatars/top.txt",
      "avatars/u/one.png",
      "avatars/u/three.png",
      "avatars/u/two.png",
      "docs/guide/deep/x.pdf",
      "docs/guide/readme.md",
    ]);
    for (const o of listing.objects) {
      expect(
        sha(await readFile(join(m.pkg, "assets/storage/objects", o.path))),
      ).toBe(o.sha256);
      expect(sha(supa.buckets.get(o.bucket)!.get(o.key)!.body)).toBe(o.sha256);
    }
    // S3 access keys are used, never the service role key; default region.
    expect([...supa.accessKeyIds]).toEqual([KEY_ID]);
    expect(supa.authorizations.every((a) => a.includes("/us-east-1/s3/"))).toBe(
      true,
    );
    expect(supa.requests.every((r) => r.includes("/storage/v1/s3/"))).toBe(
      true,
    );
    const c = component(m, "assets:storage");
    expect(c.limitations.join(" ")).toMatch(/no point-in-time snapshot/u);
    const manual = m.result.manifest.manual_prerequisites.filter(
      (p) => p.component_id === "assets:storage",
    );
    expect(manual.map((p) => p.title).join(" | ")).toMatch(
      /Recreate Supabase Storage buckets avatars, docs.*policies/u,
    );
    expect(manual.map((p) => p.reason).join(" ")).toMatch(
      /public\/private.*Row Level Security/su,
    );
    // Restore reproduces <id>/<bucket>/...
    const assetsRoot = join(root, "assets-root");
    await mkdir(assetsRoot, { recursive: true });
    await runRestoreSteps(c.restore.steps, {
      target: root,
      packageRoot: m.pkg,
      assetsRoot,
    });
    for (const o of listing.objects)
      expect(sha(await readFile(join(assetsRoot, "storage", o.path)))).toBe(
        o.sha256,
      );
    expect((await verifyIntegrity(m.pkg)).ok).toBe(true);
    await assertNoSecrets(m);
  });

  it("uses SUPA_REGION when set", async () => {
    const m = await run(
      [supabaseDecl(["avatars"])],
      env({ SUPA_REGION: "eu-west-2" }),
      { allowLoopbackEndpoint: true, maxAttempts: 1 },
    );
    expect(m.result.componentStatuses["assets:storage"]).toBe("captured");
    expect(supa.authorizations.every((a) => a.includes("/eu-west-2/s3/"))).toBe(
      true,
    );
  });

  it("is blocked, naming the variables and the dashboard path, when the access keys are absent", async () => {
    const m = await run(
      [supabaseDecl(["avatars"])],
      env({ SUPA_ACCESS_KEY_ID: undefined, SUPA_SECRET_ACCESS_KEY: undefined }),
      { allowLoopbackEndpoint: true },
    );
    expect(m.result.componentStatuses["assets:storage"]).toBe("blocked");
    const entry = m.result.manifest.missing_or_blocked.find(
      (x) => x.component_id === "assets:storage",
    );
    expect(entry?.reason).toMatch(
      /SUPA_ACCESS_KEY_ID and SUPA_SECRET_ACCESS_KEY/u,
    );
    expect(entry?.remediation).toMatch(/Storage -> S3 connection/u);
    expect(entry?.remediation).toMatch(/service role key.*not used/u);
    expect(supa.requests).toEqual([]);
    await assertNoSecrets(m);
  });

  it("captures the reachable buckets and reports a missing one", async () => {
    const m = await run([supabaseDecl(["avatars", "ghost", "a/b"])], env(), {
      allowLoopbackEndpoint: true,
      maxAttempts: 1,
    });
    expect(m.result.componentStatuses["assets:storage"]).toBe("partial");
    const c = component(m, "assets:storage");
    expect(c.omissions.map((o) => o.what).join(" | ")).toMatch(
      /ghost.*incomplete|bucket "a\/b"/su,
    );
    expect(c.omissions.some((o) => /ghost/u.test(o.what))).toBe(true);
    expect(c.omissions.some((o) => /"a\/b"/u.test(o.what))).toBe(true);
    const listing = await listingOf(m.pkg, "storage");
    expect(listing.objects.every((o) => o.bucket === "avatars")).toBe(true);
    expect(listing.objects).toHaveLength(4);
  });

  it("is blocked when no buckets are declared", async () => {
    const m = await run([supabaseDecl([])], env(), {
      allowLoopbackEndpoint: true,
    });
    expect(m.result.componentStatuses["assets:storage"]).toBe("blocked");
    expect(component(m, "assets:storage").omissions[0]?.reason).toMatch(
      /No buckets are declared/u,
    );
  });
});

describe("mixed builds", () => {
  it("captures a runner_local and an S3 asset in one build with one recovery window", async () => {
    seed();
    const dir = join(root, "local-assets");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub/l.txt"), "local\n");
    const m = await run(
      [
        {
          kind: "assets",
          id: "local",
          source: {
            kind: "runner_local",
            runner_id: RUNNER_ID,
            path_hash: sha(dir),
          },
        },
        s3Decl(),
      ],
      s3Env(),
      { allowLoopbackEndpoint: true, maxAttempts: 1 },
      new Map([[sha(dir), dir]]),
    );
    expect(m.result.componentStatuses).toEqual({
      "assets:local": "captured",
      "assets:bucket": "captured",
    });
    expect(m.result.consistency).toBe("single_point");
    const assetsRoot = join(root, "assets-root");
    await mkdir(assetsRoot, { recursive: true });
    for (const id of ["assets:local", "assets:bucket"])
      await runRestoreSteps(component(m, id).restore.steps, {
        target: root,
        packageRoot: m.pkg,
        assetsRoot,
      });
    expect(await readFile(join(assetsRoot, "local/sub/l.txt"), "utf8")).toBe(
      "local\n",
    );
    expect(await readFile(join(assetsRoot, "bucket/a.txt"), "utf8")).toBe(
      "alpha\n",
    );
    expect(
      (await stat(join(m.pkg, "assets/local/objects.json"))).isFile(),
    ).toBe(true);
    expect((await verifyIntegrity(m.pkg)).ok).toBe(true);
    await assertNoSecrets(m);
  });
});
