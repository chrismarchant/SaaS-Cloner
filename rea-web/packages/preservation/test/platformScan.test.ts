import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHELL_SYNTAX_REASON } from "../src/collectors/platform/command.js";
import { scanPlatformConfig } from "../src/collectors/platform/scan.js";
import type {
  PlatformFile,
  PlatformScan,
} from "../src/collectors/platform/types.js";
import { listTree } from "../src/util.js";
import { materializePlatformFixture, sha256Of } from "./platformFixture.js";

describe("platform scanner on the fixture", () => {
  let dir = "";
  let scan: PlatformScan;
  const file = (path: string): PlatformFile => {
    const f = scan.files.find((x) => x.path === path);
    if (f === undefined) throw new Error(`${path} not scanned`);
    return f;
  };
  const parsed = (path: string): Record<string, any> =>
    file(path).parsed as Record<string, any>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "plat-scan-"));
    await materializePlatformFixture(dir);
    scan = await scanPlatformConfig(await listTree(dir));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("finds every platform file and records the SHA-256 of its bytes", async () => {
    expect(scan.files.map((f) => `${f.platform}:${f.path}`)).toEqual([
      "railway:.railway/railway.ts",
      "procfile:Procfile",
      "fly:fly.toml",
      "netlify:netlify.toml",
      "railway:railway.json",
      "railway:services/worker/railway.toml",
      "supabase:supabase/config.toml",
      "vercel:vercel.json",
    ]);
    expect(scan.unread).toEqual([]);
    for (const f of scan.files)
      expect(f.sha256).toBe(sha256Of(await readFile(join(dir, f.path))));
  });

  it("reads railway.json: build, deploy, regions and environment overrides", () => {
    const r = parsed("railway.json");
    expect(r["schema"]).toBe("https://railway.com/railway.schema.json");
    expect(r["build"]).toMatchObject({
      builder: "NIXPACKS",
      build_command: {
        text: "npm ci && npm run build",
        argv: null,
        issue: SHELL_SYNTAX_REASON,
        detail: "'&' or '&&'",
      },
      watch_patterns: ["src/**", "package.json"],
    });
    expect(r["deploy"]).toMatchObject({
      start_command: { argv: ["node", "dist/server.js"] },
      pre_deploy_commands: [{ argv: ["npm", "run", "migrate"] }],
      healthcheck_path: "/healthz",
      healthcheck_timeout_seconds: 120,
      cron_schedule: "0 */6 * * *",
      restart_policy_type: "ON_FAILURE",
      restart_policy_max_retries: 5,
      num_replicas: 2,
      region: "us-west2",
      sleep_application: false,
      multi_region: [
        { region: "europe-west4-drams3a", num_replicas: 1 },
        { region: "us-west2", num_replicas: 1 },
      ],
    });
    expect(r["environments"]["staging"]["deploy"]).toMatchObject({
      start_command: { text: "node dist/server.js --staging" },
      cron_schedule: "*/30 * * * *",
      num_replicas: 1,
    });
    expect(file("railway.json").unknown_keys).toEqual(["experimental"]);
  });

  it("reads railway.toml with the same schema", () => {
    const f = file("services/worker/railway.toml");
    expect(f.parsed).toMatchObject({
      build: {
        builder: "RAILPACK",
        build_command: { argv: ["npm", "run", "build:worker"] },
      },
      deploy: {
        start_command: { argv: ["node", "dist/worker.js"] },
        healthcheck_path: "/ready",
        region: "europe-west4-drams3a",
      },
    });
    expect(f.unknown_keys).toEqual([]);
    expect(f.extraction?.services[0]).toMatchObject({
      name: "railway:services/worker",
      dir: "services/worker",
    });
  });

  it("records the Railway TypeScript IaC as an inferred, unevaluated fact", () => {
    expect(file(".railway/railway.ts")).toMatchObject({
      platform: "railway",
      confidence: "inferred",
      status: "present",
      parsed: { present: true, language: "typescript", evaluated: false },
      limitations: [
        "TypeScript IaC not evaluated during capture; restore operators must run `railway config plan` against it",
      ],
    });
  });

  it("reads fly.toml: names only for env, services, checks, mounts, processes, release command", () => {
    const f = parsed("fly.toml");
    expect(f).toMatchObject({
      app: "acme-api",
      primary_region: "iad",
      build: { dockerfile: "Dockerfile", arg_names: ["NODE_VERSION"] },
      env_names: ["LOG_LEVEL", "PORT", "PUBLIC_API_URL"],
      processes: {
        app: { argv: ["node", "dist/server.js"] },
        worker: { argv: ["node", "dist/worker.js"] },
      },
      http_service: {
        internal_port: 8080,
        force_https: true,
        processes: ["app"],
      },
      services: [
        { internal_port: 5000, ports: [{ port: 5000, handlers: ["tls"] }] },
      ],
      mounts: [{ name: "acme_data", mount_path: "/data", initial_size: "3gb" }],
      deploy: { release_command: { argv: ["node", "scripts/migrate.js"] } },
    });
    expect(f["checks"]).toEqual([
      expect.objectContaining({
        kind: "http",
        path: "/healthz",
        timeout: "5s",
      }),
      expect.objectContaining({ kind: "tcp", interval: "15s" }),
    ]);
    // Values of [env] and [build.args] are never read.
    expect(JSON.stringify(file("fly.toml"))).not.toMatch(
      /8080"|api\.acme\.example|"22"/u,
    );
    expect(file("fly.toml").unknown_keys).toEqual(["statics"]);
    expect(
      file("fly.toml").extraction?.services.map((s) => [
        s.name,
        s.kind,
        s.volumes.length,
      ]),
    ).toEqual([
      ["acme-api:app", "web", 1],
      ["acme-api:worker", "worker", 0],
    ]);
  });

  it("reads vercel.json: framework, commands, crons, function regions and external destinations", () => {
    expect(parsed("vercel.json")).toMatchObject({
      framework: "nextjs",
      build_command: { argv: ["next", "build"] },
      install_command: { argv: ["npm", "ci"] },
      output_directory: ".next",
      regions: ["fra1", "iad1"],
      functions: [
        { pattern: "api/**/*.ts", regions: ["iad1", "fra1"], max_duration: 30 },
      ],
      crons: [
        { path: "/api/cron/digest", schedule: "0 8 * * 1-5" },
        { path: "/api/cron/cleanup", schedule: "30 2 * * *" },
      ],
      rewrites: { count: 2 },
      redirects: { count: 1 },
      external_destinations: [{ host: "legacy.acme.example" }],
    });
    expect(file("vercel.json").unknown_keys).toEqual(["cleanUrls"]);
  });

  it("reads netlify.toml: build, redirects count and scheduled functions", () => {
    const n = parsed("netlify.toml");
    expect(n["build"]).toMatchObject({
      base: "web",
      command: { argv: ["npm", "run", "build"] },
      publish: "dist",
      env_names: ["NEXT_PUBLIC_SITE_URL", "NODE_VERSION"],
    });
    expect(n["redirects"]).toEqual({ count: 2 });
    expect(n["functions"]).toEqual({
      directory: null,
      node_bundler: "esbuild",
      scheduled: [
        { name: "nightly-report", schedule: "@daily" },
        { name: "sync-crm", schedule: "*/15 * * * *" },
      ],
    });
    expect(n["external_destinations"]).toMatchObject([
      { host: "api.acme.example" },
    ]);
    expect(file("netlify.toml").extraction?.services[0]?.dir).toBe("web");
  });

  it("reads the Procfile as tokens with the original line", () => {
    expect(parsed("Procfile")["processes"]).toMatchObject([
      {
        process_type: "web",
        line_number: 2,
        original_line: 'web: node dist/server.js --port "$PORT"',
        command: {
          argv: null,
          issue: SHELL_SYNTAX_REASON,
          text: 'node dist/server.js --port "$PORT"',
        },
      },
      { process_type: "worker", command: { argv: ["node", "dist/worker.js"] } },
      { process_type: "release" },
      {
        process_type: "scheduler",
        command: { argv: ["node", "jobs/run.js", "nightly"] },
      },
    ]);
  });

  it("reads supabase/config.toml: providers, URLs, buckets, functions; references by name only", () => {
    const s = parsed("supabase/config.toml");
    expect(s).toMatchObject({
      project_id: "acme-app",
      api: { port: 54321, schemas: ["public", "graphql_public"] },
      db: { major_version: 15 },
      enabled_providers: ["github", "google"],
      edge_runtime: { enabled: true, policy: "per_worker" },
      analytics: { enabled: true, backend: "postgres" },
    });
    expect(s["auth"].site_url).toMatchObject({
      url: "https://app.acme.example/",
      host: "app.acme.example",
    });
    expect(
      s["auth"].additional_redirect_urls.map((u: { url: string }) => u.url),
    ).toEqual([
      "https://app.acme.example/auth/callback",
      "https://staging.acme.example/**",
      "http://localhost:3000/auth/callback",
    ]);
    const google = s["auth"].providers.find(
      (p: { name: string }) => p.name === "google",
    );
    expect(google).toMatchObject({
      enabled: true,
      client_id: {
        kind: "env",
        name: "SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID",
      },
      secret: { kind: "env", name: "SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET" },
    });
    expect(
      s["auth"].providers.find((p: { name: string }) => p.name === "apple"),
    ).toMatchObject({
      enabled: false,
      secret: { kind: "absent" },
    });
    expect(s["storage"].buckets).toEqual([
      {
        name: "avatars",
        public: true,
        file_size_limit: "5MiB",
        allowed_mime_types: ["image/png", "image/jpeg"],
      },
      {
        name: "invoices",
        public: false,
        file_size_limit: "20MiB",
        allowed_mime_types: ["application/pdf"],
      },
    ]);
    expect(s["functions"]).toEqual([
      {
        name: "send-welcome",
        origin: "directory",
        verify_jwt: null,
        enabled: null,
        entrypoint: null,
      },
      {
        name: "stripe-webhook",
        origin: "both",
        verify_jwt: false,
        enabled: null,
        entrypoint: null,
      },
    ]);
    expect(
      s["env_references"].map((r: { name: string }) => r.name).sort(),
    ).toEqual([
      "SMTP_PASSWORD",
      "SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID",
      "SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET",
      "SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID",
      "SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET",
    ]);
    expect(file("supabase/config.toml").unknown_keys).toEqual(
      expect.arrayContaining([
        "realtime",
        "studio",
        "auth.email",
        "auth.jwt_expiry",
        "api.max_rows",
        "storage.enabled",
      ]),
    );
  });

  it("lists type mismatches as unknown keys without quoting the value", async () => {
    const bad = await mkdtemp(join(tmpdir(), "plat-type-"));
    try {
      await writeFile(
        join(bad, "railway.json"),
        JSON.stringify({
          deploy: { startCommand: 42, numReplicas: "secret-looking-text" },
        }),
      );
      const out = await scanPlatformConfig(await listTree(bad));
      expect(out.files[0]?.unknown_keys).toEqual([
        "deploy.numReplicas (expected number, found string)",
        "deploy.startCommand (expected string, found number)",
      ]);
      expect(JSON.stringify(out.files[0])).not.toMatch(/secret-looking-text/u);
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });

  it("reports a platform file that is a symbolic link instead of following it", async () => {
    const dirLink = await mkdtemp(join(tmpdir(), "plat-link-"));
    try {
      await symlink("/etc/hostname", join(dirLink, "fly.toml"));
      const out = await scanPlatformConfig(await listTree(dirLink));
      expect(out.files).toEqual([]);
      expect(out.unread).toEqual([
        { path: "fly.toml", reason: "symbolic link (never followed)" },
      ]);
    } finally {
      await rm(dirLink, { recursive: true, force: true });
    }
  });

  it("reports a platform file that does not parse with a position and no content", async () => {
    const bad = await mkdtemp(join(tmpdir(), "plat-bad-"));
    try {
      await writeFile(
        join(bad, "fly.toml"),
        'app = "x"\ntoken = "sk_live_leak_me" extra\n',
      );
      await writeFile(
        join(bad, "vercel.json"),
        '{\n  "buildCommand": "sk_live_leak_me",\n}\n',
      );
      await writeFile(join(bad, "Procfile"), "not a procfile line\n");
      await writeFile(join(bad, "railway.json"), "[1, 2]");
      const out = await scanPlatformConfig(await listTree(bad));
      expect(out.files.map((f) => [f.path, f.status])).toEqual([
        ["Procfile", "unparsed"],
        ["fly.toml", "unparsed"],
        ["railway.json", "unparsed"],
        ["vercel.json", "unparsed"],
      ]);
      expect(
        Object.fromEntries(out.files.map((f) => [f.path, f.parse_error])),
      ).toEqual({
        Procfile:
          "invalid Procfile at line 1: expected '<process type>: <command>'",
        "fly.toml": "invalid TOML at line 2, column 27: expected end of line",
        "railway.json": "invalid JSON: top-level value is not an object",
        "vercel.json": "invalid JSON at line 3, column 1",
      });
      for (const f of out.files) {
        expect(f.parsed).toBeNull();
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(JSON.stringify(f)).not.toMatch(/sk_live_leak_me/u);
      }
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });
});
