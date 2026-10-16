import { describe, expect, it } from "vitest";
import {
  COMPONENT_KINDS,
  VERIFICATION_STATUSES,
  type Job,
} from "@rea-web/contracts/browser";
import {
  bodyFromDraft,
  draftFromDefinition,
  emptyBuildDraft,
  gitUrlConcern,
  newComponent,
  type BuildDefinition,
  type BuildDraft,
} from "../src/lib/buildDraft";
import { describeComponent, describeSource } from "../src/lib/buildView";
import { jobsWhere, producedId } from "../src/lib/buildJobs";
import { parseRecipients, readEncryption } from "../src/lib/exportView";
import {
  filterFiles,
  imageLabel,
  manifestTotals,
  parseManifest,
  windowLabel,
} from "../src/lib/manifestView";
import {
  COMPONENT_STATUS_WORDING,
  VERIFICATION_STATUS_WORDING,
  componentStatusWording,
  consistencyWording,
  networkWording,
  verificationStatusWording,
} from "../src/lib/recoveryWording";
import { restoreCommands } from "../src/lib/restoreCommands";
import { virtualWindow } from "../src/lib/virtual";

const RUNNER = "01970000-0000-7000-8000-000000000001";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const INV = "01970000-0000-7000-8000-0000000000aa";

/** A definition that uses every component kind and every asset source. */
const definition = (): BuildDefinition => ({
  name: "Everything",
  description: "All kinds",
  source: {
    kind: "runner_local",
    runner_id: RUNNER,
    path_hash: HASH_A,
    include_working_tree: true,
    include_lfs: false,
    include_submodules: true,
  },
  runner_id: RUNNER,
  components: [
    { kind: "source", id: "main" },
    {
      kind: "dependencies",
      id: "deps",
      lockfiles: ["package-lock.json", "web/pnpm-lock.yaml"],
      container_images: ["redis:7"],
    },
    {
      kind: "data",
      id: "db",
      engine: "postgresql",
      connection_env_name: "APP_DATABASE_URL",
      invariants: [
        { id: "notes", sql: "select count(*) from notes", expect: 3 },
        { id: "flag", sql: "select true", expect: true },
        { id: "name", sql: "select 'x'", expect: "x" },
        { id: "nothing", sql: "select null", expect: null },
        { id: "free", sql: "select 1" },
      ],
    },
    {
      kind: "assets",
      id: "uploads",
      source: { kind: "runner_local", runner_id: RUNNER, path_hash: HASH_B },
    },
    {
      kind: "assets",
      id: "bucket",
      source: {
        kind: "s3",
        bucket: "media",
        prefix: "u/",
        endpoint_env_name: "S3_ENDPOINT",
        credentials_env_prefix: "MEDIA_S3",
      },
    },
    {
      kind: "assets",
      id: "storage",
      source: {
        kind: "supabase_storage",
        project_ref: "abcd",
        buckets: ["avatars", "docs"],
        credentials_env_prefix: "SUPA",
      },
    },
    {
      kind: "infrastructure",
      id: "infra",
      descriptor: { services: [{ name: "web" }], domains: ["a.example"] },
    },
    { kind: "integrations", id: "integ", descriptor: { providers: [] } },
    {
      kind: "product",
      id: "prd",
      source_component_id: "main",
      name: "Product",
      rea_target_ids: [INV],
    },
    { kind: "artifacts", id: "evidence", investigation_ids: [INV] },
  ],
});

let counter = 0;
const uid = (): string => `t${++counter}`;

const bodyOf = (draft: BuildDraft) => {
  const result = bodyFromDraft(draft);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.body;
};

describe("build form <-> request body", () => {
  it("round-trips every component kind and asset source", () => {
    const original = definition();
    expect(
      COMPONENT_KINDS.every((kind) =>
        original.components.some((c) => c.kind === kind),
      ),
    ).toBe(true);
    const draft = draftFromDefinition(original, uid);
    expect(bodyOf(draft)).toEqual(original);
  });

  it("fills contract defaults explicitly and omits blank optional fields", () => {
    const draft: BuildDraft = {
      ...emptyBuildDraft(),
      name: "  Minimal  ",
      source: {
        kind: "git",
        url: " https://example.test/app.git ",
        ref: "",
        includeWorkingTree: false,
        includeLfs: true,
        includeSubmodules: true,
      },
    };
    expect(bodyOf(draft)).toEqual({
      name: "Minimal",
      description: "",
      source: {
        kind: "git",
        url: "https://example.test/app.git",
        ref: "HEAD",
        include_working_tree: false,
        include_lfs: true,
        include_submodules: true,
      },
      components: [{ kind: "source", id: "main" }],
    });
  });

  it("keeps connection variable names as names and never invents values", () => {
    const body = JSON.stringify(bodyOf(draftFromDefinition(definition(), uid)));
    expect(body).toContain("APP_DATABASE_URL");
    expect(body).not.toMatch(/postgres(ql)?:\/\//u);
  });

  it("reports every problem with the contract's own words and its component", () => {
    const draft = draftFromDefinition(definition(), uid);
    const data = draft.components.findIndex((c) => c.kind === "data");
    const infra = draft.components.findIndex(
      (c) => c.kind === "infrastructure",
    );
    const result = bodyFromDraft({
      ...draft,
      name: "",
      components: draft.components.map((c, index) =>
        index === data && c.kind === "data"
          ? { ...c, connectionEnvName: "postgres://u:p@h/db" }
          : index === infra && c.kind === "infrastructure"
            ? { ...c, descriptor: "{ not json" }
            : c,
      ),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const byPath = new Map(result.problems.map((p) => [p.path, p]));
    expect(byPath.has("name")).toBe(true);
    expect(
      byPath.get(`components.${data}.connection_env_name`)?.component,
    ).toBe(data);
    expect(byPath.get(`components.${infra}.descriptor`)?.message).toMatch(
      /^Not valid JSON/u,
    );
  });

  it("requires a descriptor to be a JSON object", () => {
    const draft = draftFromDefinition(definition(), uid);
    const result = bodyFromDraft({
      ...draft,
      components: draft.components.map((c) =>
        c.kind === "integrations" ? { ...c, descriptor: "[1]" } : c,
      ),
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.problems.map((p) => p.message)).toContain(
        "Must be a JSON object",
      );
  });

  it("rejects a non-numeric number expectation and a duplicate component", () => {
    const draft = draftFromDefinition(definition(), uid);
    const result = bodyFromDraft({
      ...draft,
      components: [
        ...draft.components.map((c) =>
          c.kind === "data"
            ? {
                ...c,
                invariants: c.invariants.map((i, n) =>
                  n === 0 ? { ...i, expect: "three" } : i,
                ),
              }
            : c,
        ),
        newComponent("source", { id: "main" }),
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const messages = result.problems.map((p) => p.message);
    expect(messages).toContain("Not a number");
    expect(
      messages.some((m) => m.startsWith("Duplicate component source:main")),
    ).toBe(true);
  });

  it("flags host paths and embedded passwords in a git URL, not ordinary URLs", () => {
    expect(gitUrlConcern("/home/me/repo")).toMatch(/path on a host/u);
    expect(gitUrlConcern("file:///srv/repo")).toMatch(/path on a host/u);
    expect(gitUrlConcern("https://user:secret@example.test/a.git")).toMatch(
      /password/u,
    );
    expect(gitUrlConcern("https://example.test/a.git")).toBeNull();
    expect(gitUrlConcern("ssh://git@example.test/a.git")).toBeNull();
    expect(gitUrlConcern("git@example.test:a/b.git")).toBeNull();
    expect(gitUrlConcern("")).toBeNull();
  });

  it("describes a stored definition as text rows", () => {
    const original = definition();
    expect(describeSource(original.source).map((r) => r.label)).toContain(
      "Path hash",
    );
    const db = original.components.find((c) => c.kind === "data");
    const rows = db === undefined ? [] : describeComponent(db);
    expect(
      rows.find((r) => r.label === "Connection variable name")?.value,
    ).toBe("APP_DATABASE_URL");
    expect(rows.find((r) => r.label === "Invariant notes")?.value).toContain(
      "3",
    );
  });
});

describe("recovery wording", () => {
  const everyWording = () => [
    ...Object.values(COMPONENT_STATUS_WORDING),
    ...Object.values(VERIFICATION_STATUS_WORDING),
    ...(["single_point", "inconsistent", "unknown", null] as const).map(
      consistencyWording,
    ),
    ...(["yes", "no", "unknown", null] as const).map(networkWording),
  ];

  it("never renders a percentage or a score", () => {
    for (const wording of everyWording()) {
      expect(`${wording.label} ${wording.meaning}`).not.toMatch(
        /%|percent|score/iu,
      );
      expect(`${wording.label} ${wording.meaning}`).not.toMatch(
        /\d+\s*(of|\/)\s*\d+/u,
      );
    }
  });

  it("words every status of the vocabulary", () => {
    for (const status of VERIFICATION_STATUSES)
      expect(VERIFICATION_STATUS_WORDING[status]).toBeDefined();
  });

  it("keeps blocked, partial and failed honest, and unknown is not a pass", () => {
    expect(verificationStatusWording("blocked").tone).not.toBe("ok");
    expect(verificationStatusWording("blocked").meaning).toMatch(
      /not a failure of the job/u,
    );
    expect(verificationStatusWording("partial").tone).toBe("warn");
    expect(verificationStatusWording("failed").tone).toBe("bad");
    expect(componentStatusWording("blocked").tone).toBe("bad");
    expect(consistencyWording("unknown").tone).not.toBe("ok");
    expect(consistencyWording("unknown").meaning).toMatch(/not a pass/u);
    expect(consistencyWording("single_point").label).toBe("single point");
    expect(consistencyWording("inconsistent").label).toBe("inconsistent");
    expect(networkWording("unknown").tone).not.toBe("ok");
  });

  it("does not upgrade a classification or status it does not know", () => {
    expect(consistencyWording("perfect").tone).toBe("neutral");
    expect(consistencyWording(null).label).toBe("not classified");
    expect(verificationStatusWording("fully_verified").tone).toBe("neutral");
  });
});

const manifest = () => ({
  format: "rea-web-recovery",
  format_version: 1,
  package_id: "01970000-0000-7000-8000-0000000000bb",
  build: { id: "b", name: "n", project_slug: "p", description: "" },
  created_at: "2026-01-01T00:00:00Z",
  producer: {
    name: "rea-web",
    version: "0.1.0",
    upstream_rea: null,
    tools: [],
  },
  source_revisions: [],
  components: [
    {
      id: "source:main",
      kind: "source",
      title: "Source",
      status: "captured",
      captured_at: {
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-01T00:00:01Z",
      },
      method: "git bundle --all",
      root: "source/main/",
      entries: 1,
      bytes: 10,
      restore: {
        steps: [
          {
            id: "clone",
            title: "Clone",
            run: ["git", "clone"],
            scope: "clean_build",
            network: "none",
          },
          {
            id: "install",
            title: "Install",
            run: ["npm", "ci"],
            scope: "clean_build",
            network: "registry",
          },
        ],
      },
    },
    {
      id: "data:db",
      kind: "data",
      title: "Database",
      status: "partial",
      captured_at: null,
      method: "pg_dump -Fc",
      root: "data/db/",
      entries: 1,
      bytes: 20,
      restore: {
        steps: [
          {
            id: "restore",
            title: "Restore",
            run: ["pg_restore"],
            scope: "data_restore",
            network: "database",
          },
        ],
      },
    },
    {
      id: "assets:uploads",
      kind: "assets",
      title: "Uploads",
      status: "captured",
      captured_at: null,
      method: "copy",
      root: "assets/uploads/",
      entries: 1,
      bytes: 5,
      restore: { steps: [] },
    },
  ],
  relationships: [],
  files: [
    {
      path: "source/main/repo.bundle",
      size: 10,
      sha256: "1".repeat(64),
      component_id: "source:main",
    },
    {
      path: "data/db/dump.pgc",
      size: 20,
      sha256: "2".repeat(64),
      component_id: "data:db",
    },
  ],
  dependencies: {
    runtimes: [],
    package_managers: [],
    container_images: [{ ref: "redis:7", digest: null }],
    registries: [],
    system_packages: [],
  },
  manual_prerequisites: [],
  secrets: { mode: "names_only", names: ["APP_DATABASE_URL"] },
  consistency: {
    strategy: "s",
    window: null,
    classification: "unknown",
    gaps: [],
  },
  verification: {
    scope: [],
    results: [],
    network_required: { verdict: "unknown", reasons: [] },
  },
  missing_or_blocked: [],
  restore_guards: {
    blocked_hosts: [],
    disabled_schedules: [],
    disabled_webhooks: [],
    default_network: "deny",
  },
});

describe("manifest helpers", () => {
  it("parses a valid manifest with the contract schema and reports issues otherwise", () => {
    expect(parseManifest(manifest()).ok).toBe(true);
    const broken = parseManifest({ ...manifest(), format: "other" });
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.issues[0]).toMatch(/^format:/u);
    expect(parseManifest(null).ok).toBe(false);
  });

  it("says when an image is not pinned and when no window was recorded", () => {
    expect(imageLabel({ ref: "redis:7", digest: null })).toBe(
      "redis:7 (not pinned)",
    );
    expect(imageLabel({ ref: "redis:7", digest: "sha256:abc" })).toBe(
      "redis:7 @ sha256:abc",
    );
    expect(windowLabel(null)).toBe("no window recorded");
    expect(windowLabel({ start: "a", end: "b" })).toBe("a to b");
  });

  it("totals files and component statuses", () => {
    const parsed = parseManifest(manifest());
    if (!parsed.ok) throw new Error("manifest should parse");
    expect(manifestTotals(parsed.manifest)).toEqual({
      files: 2,
      fileBytes: 30,
      componentsByStatus: { captured: 2, partial: 1 },
    });
  });

  it("filters files by path and component", () => {
    const parsed = parseManifest(manifest());
    if (!parsed.ok) throw new Error("manifest should parse");
    const { files } = parsed.manifest;
    expect(filterFiles(files, "", "")).toBe(files);
    expect(filterFiles(files, "DUMP", "").map((f) => f.path)).toEqual([
      "data/db/dump.pgc",
    ]);
    expect(filterFiles(files, "", "source:main")).toHaveLength(1);
    expect(filterFiles(files, "dump", "source:main")).toHaveLength(0);
  });

  it("builds restore commands from the manifest with argument names only", () => {
    const parsed = parseManifest(manifest());
    if (!parsed.ok) throw new Error("manifest should parse");
    const plain = restoreCommands(parsed.manifest, null);
    expect(plain.unpack).toBe(
      "rea-recover unpack <export-file> --out <empty-dir>",
    );
    expect(plain.restore).toBe(
      "rea-recover restore <unpacked-package-dir> --scope clean_build,data_restore --target <empty-dir> --database-url-env RESTORE_DATABASE_URL --assets-root <empty-dir> --allow-network registry",
    );
    expect(plain.databaseUrlEnv).toBe("RESTORE_DATABASE_URL");
    const sealed = restoreCommands(parsed.manifest, { recipients: ["key-1"] });
    expect(sealed.unpack).toContain("--key-file <key-file>");
    expect(sealed.notes.join(" ")).toContain("key-1");
    for (const text of [
      plain.unpack,
      plain.restore,
      sealed.unpack,
      ...plain.notes,
    ])
      expect(text).not.toMatch(/:\/\/|APP_DATABASE_URL/u);
  });
});

describe("export records", () => {
  it("reads an encryption record with the manifest's own schema", () => {
    expect(readEncryption(null)).toEqual({ state: "plain" });
    expect(
      readEncryption({
        scheme: "aes-256-gcm-envelope",
        recipients: ["k1", "k2"],
        key_location: "external",
      }),
    ).toEqual({
      state: "encrypted",
      scheme: "aes-256-gcm-envelope",
      recipients: ["k1", "k2"],
      keyLocation: "external",
    });
  });

  it("shows an encryption record it does not recognise instead of guessing", () => {
    const raw = { scheme: "rot13", recipients: [], key_location: "inside" };
    expect(readEncryption(raw)).toEqual({ state: "unrecognised", raw });
  });

  it("splits recipient key ids on lines, commas and spaces without duplicates", () => {
    expect(parseRecipients("a, b\nc  a\n\n")).toEqual(["a", "b", "c"]);
    expect(parseRecipients("  ")).toEqual([]);
  });
});

describe("job lookup and windowing", () => {
  const job = (id: string, created: string, input: Record<string, unknown>) =>
    ({ id, created_at: created, input }) as unknown as Job;

  it("finds the jobs of one resource, newest first, by their input", () => {
    const jobs = [
      job("1", "2026-01-01", { build_id: "b1", plan_id: "p1" }),
      job("2", "2026-01-03", { build_id: "b1", plan_id: "p2" }),
      job("3", "2026-01-02", { build_id: "b2", plan_id: "p3" }),
    ];
    expect(jobsWhere(jobs, "build_id", "b1").map((j) => j.id)).toEqual([
      "2",
      "1",
    ]);
    expect(producedId(jobs[1] as Job, "plan_id")).toBe("p2");
    expect(producedId(jobs[1] as Job, "capture_id")).toBeNull();
  });

  it("renders only the rows near the viewport", () => {
    expect(
      virtualWindow({
        scrollTop: 0,
        viewportHeight: 300,
        rowHeight: 30,
        count: 0,
      }),
    ).toEqual({
      start: 0,
      end: 0,
      totalHeight: 0,
    });
    const top = virtualWindow({
      scrollTop: 0,
      viewportHeight: 300,
      rowHeight: 30,
      count: 100_000,
      overscan: 5,
    });
    expect(top.start).toBe(0);
    expect(top.end).toBeLessThan(25);
    expect(top.totalHeight).toBe(3_000_000);
    const middle = virtualWindow({
      scrollTop: 30_000,
      viewportHeight: 300,
      rowHeight: 30,
      count: 100_000,
      overscan: 5,
    });
    expect(middle.start).toBe(995);
    expect(middle.end - middle.start).toBeLessThan(30);
    const end = virtualWindow({
      scrollTop: 99_999_999,
      viewportHeight: 300,
      rowHeight: 30,
      count: 50,
    });
    expect(end.end).toBe(50);
    expect(
      virtualWindow({
        scrollTop: 0,
        viewportHeight: 300,
        rowHeight: 30,
        count: 3,
      }).end,
    ).toBe(3);
  });
});
