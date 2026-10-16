import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateRestoreStepArguments } from "@rea-web/contracts";
import { verifyIntegrity } from "@rea-web/recovery";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type PlatformCapture,
  capturePlatformFixture,
  sha256Of,
} from "./platformFixture.js";

let root = "";
const SHELL_REASON = "shell syntax; not executable without a shell";

interface ServicesDoc {
  services: Record<string, any>[];
  conflicts: Record<string, any>[];
  detected_platform_config: string[];
}
interface PlatformDoc {
  files: {
    platform: string;
    path: string;
    sha256: string;
    confidence: string;
    status: string;
    parsed: Record<string, any> | null;
    unknown_keys: string[];
    limitations: string[];
    parse_error: string | null;
  }[];
}

const component = (c: PlatformCapture, id: string) => {
  const found = c.result.manifest.components.find((x) => x.id === id);
  if (found === undefined) throw new Error(`no component ${id}`);
  return found;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "plat-cap-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("platform configuration in a captured package", () => {
  let c: PlatformCapture;
  const infra = () => component(c, "infrastructure:infra");

  beforeAll(async () => {
    c = await capturePlatformFixture({
      root,
      name: "full",
      integrations: true,
      descriptor: {
        services: [
          // Same name as the Procfile processes: one disagrees, one agrees.
          { name: "web", start_command: ["node", "server.js"] },
          { name: "worker", start_command: ["node", "dist/worker.js"] },
          // Same name as services/worker/railway.toml: the build commands differ.
          {
            name: "railway:services/worker",
            build_command: ["npm", "run", "compile"],
          },
        ],
        schedules: [
          {
            name: "nightly-cleanup",
            cron: "0 3 * * *",
            command: ["node", "c.js"],
          },
        ],
        domains: ["www.acme.example"],
      },
    });
  }, 120_000);

  it("captures the package and keeps its integrity", async () => {
    expect(infra().status).toBe("captured");
    expect((await verifyIntegrity(c.pkg)).ok).toBe(true);
    expect(infra().details["platform_config"]).toMatchObject({
      services: 10,
      conflicts: 2,
      shell_build_commands: 1,
    });
  });

  it("writes platform.json with provenance hashes, unknown keys and limitations", async () => {
    const doc = await c.json<PlatformDoc>("infrastructure/platform.json");
    expect(doc.files.map((f) => `${f.platform}:${f.path}`)).toEqual([
      "railway:.railway/railway.ts",
      "procfile:Procfile",
      "fly:fly.toml",
      "netlify:netlify.toml",
      "railway:railway.json",
      "railway:services/worker/railway.toml",
      "supabase:supabase/config.toml",
      "vercel:vercel.json",
    ]);
    // The hash is of the file as committed, so it can be checked against the source bundle.
    const { readFile } = await import("node:fs/promises");
    for (const f of doc.files) {
      expect(f.sha256).toBe(sha256Of(await readFile(join(c.repo, f.path))));
      expect(f.status).not.toBe("unparsed");
    }
    const railway = doc.files.find((f) => f.path === "railway.json");
    expect(railway?.unknown_keys).toEqual(["experimental"]);
    expect(railway?.confidence).toBe("declared");
    const iac = doc.files.find((f) => f.path === ".railway/railway.ts");
    expect(iac).toMatchObject({ confidence: "inferred", status: "present" });
    expect(iac?.limitations).toEqual([
      "TypeScript IaC not evaluated during capture; restore operators must run `railway config plan` against it",
    ]);
    expect(infra().limitations).toContain(iac?.limitations[0]);
    const supabase = doc.files.find((f) => f.platform === "supabase");
    expect(supabase?.unknown_keys).toEqual(
      expect.arrayContaining(["realtime", "studio"]),
    );
  });

  it("merges commands into services.json beside the descriptor entries and records conflicts", async () => {
    const doc = await c.json<ServicesDoc>("infrastructure/services.json");
    const bySource = (prefix: string) =>
      doc.services.filter((s) => String(s["source"]).startsWith(prefix));
    expect(bySource("descriptor").map((s) => s["name"])).toEqual([
      "web",
      "worker",
      "railway:services/worker",
    ]);
    for (const s of doc.services) expect(s["confidence"]).toBe("declared");
    expect(
      bySource("descriptor").find((s) => s["name"] === "web"),
    ).toMatchObject({ start_command: ["node", "server.js"] });
    const platform = (name: string, path: string) =>
      doc.services.find(
        (s) => s["name"] === name && s["source"] === `platform-config:${path}`,
      );
    expect(platform("vercel", "vercel.json")).toMatchObject({
      build_command: ["next", "build"],
      build_command_text: "next build",
      build_restore: { kind: "step" },
      regions: ["fra1", "iad1"],
    });
    expect(platform("railway", "railway.json")).toMatchObject({
      build_command: null,
      build_command_text: "npm ci && npm run build",
      build_command_issue: SHELL_REASON,
      start_command: ["node", "dist/server.js"],
      health_check: { path: "/healthz", timeout_seconds: 120 },
      region: "us-west2",
      regions: ["europe-west4-drams3a", "us-west2"],
      build_restore: { kind: "manual", reason: SHELL_REASON },
    });
    expect(platform("acme-api:app", "fly.toml")).toMatchObject({
      region: "iad",
      volumes: [{ name: "acme_data", mount_path: "/data" }],
      start_command: ["node", "dist/server.js"],
      health_check: { path: "/healthz" },
    });
    expect(platform("web", "Procfile")).toMatchObject({
      start_command: null,
      start_command_text: 'node dist/server.js --port "$PORT"',
      start_command_issue: SHELL_REASON,
    });
    // Both entries for the same name are kept; the conflicts are listed, not resolved.
    expect(
      doc.conflicts.map((x) => [
        x["service"],
        x["field"],
        x["platform_source"],
      ]),
    ).toEqual([
      ["web", "start_command", "platform-config:Procfile"],
      [
        "railway:services/worker",
        "build_command",
        "platform-config:services/worker/railway.toml",
      ],
    ]);
    expect(doc.conflicts[1]).toMatchObject({
      descriptor: "npm run compile",
      platform: "npm run build:worker",
    });
    expect(platform("worker", "Procfile")).toBeDefined();
    expect(doc.detected_platform_config).toContain("Procfile");
    expect(infra().details["platform_config"]).toMatchObject({ conflicts: 2 });
  });

  it("turns simple build commands into valid clean_build steps and nothing else", () => {
    const steps = infra().restore.steps.filter((s) =>
      s.id.startsWith("platform-"),
    );
    expect(steps.map((s) => [s.id, s.run, s.cwd, s.scope])).toEqual([
      [
        "platform-netlify-netlify-build",
        ["npm", "run", "build"],
        "{{target}}/main/web",
        "clean_build",
      ],
      [
        "platform-vercel-vercel-build",
        ["next", "build"],
        "{{target}}/main",
        "clean_build",
      ],
    ]);
    for (const s of infra().restore.steps)
      expect(validateRestoreStepArguments(s), s.id).toEqual({ ok: true });
    // The conflicting worker build is not run twice; only the descriptor's would be.
    expect(infra().restore.steps.map((s) => s.id)).not.toContain(
      "platform-railway-railway:services/worker-build",
    );
  });

  it("makes shell-syntax build commands manual prerequisites with the verbatim command", () => {
    const manual = c.result.manifest.manual_prerequisites.filter((m) =>
      m.id.includes(":platform-build-"),
    );
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({
      title: "Run the railway build by hand",
      component_id: "infrastructure:infra",
    });
    expect(manual[0]?.reason).toContain(SHELL_REASON);
    expect(manual[0]?.reason).toContain("'&' or '&&'");
    expect(manual[0]?.instructions).toContain("npm ci && npm run build");
    const stepRuns = c.result.manifest.components.flatMap((x) =>
      x.restore.steps.map((s) => s.run.join(" ")),
    );
    expect(stepRuns.join("\n")).not.toContain("npm ci");
  });

  it("asks for a decision when platform and descriptor disagree on a build command", () => {
    const m = c.result.manifest.manual_prerequisites.find((x) =>
      x.id.includes(":platform-conflict-"),
    );
    expect(m?.instructions).toContain("Descriptor: npm run compile");
    expect(m?.instructions).toContain(
      "Platform configuration: npm run build:worker",
    );
  });

  it("puts schedules into schedules.json and the restore guards", async () => {
    const doc = await c.json<{ schedules: Record<string, any>[] }>(
      "infrastructure/schedules.json",
    );
    const names = doc.schedules.map((s) => s["name"]).sort();
    expect(names).toEqual([
      "netlify:function:nightly-report",
      "netlify:function:sync-crm",
      "nightly-cleanup",
      "railway:cron",
      "railway:cron@staging",
      "vercel:cron:/api/cron/cleanup",
      "vercel:cron:/api/cron/digest",
    ]);
    expect(
      doc.schedules.find((s) => s["name"] === "railway:cron"),
    ).toMatchObject({
      cron: "0 */6 * * *",
      command: ["node", "dist/server.js"],
      source: "platform-config:railway.json",
      confidence: "declared",
    });
    expect(
      doc.schedules.find((s) => s["name"] === "nightly-cleanup"),
    ).toMatchObject({
      source: "descriptor",
    });
    expect(
      doc.schedules.find((s) =>
        s["name"].startsWith("vercel:cron:/api/cron/d"),
      ),
    ).toMatchObject({
      http_path: "/api/cron/digest",
      command: null,
    });
    expect(c.result.manifest.restore_guards.disabled_schedules).toEqual(names);
  });

  it("puts hosts from configuration into blocked_hosts, but not loopback addresses", () => {
    const hosts = c.result.manifest.restore_guards.blocked_hosts;
    expect(hosts).toEqual(
      expect.arrayContaining([
        "app.acme.example",
        "staging.acme.example",
        "legacy.acme.example",
        "api.acme.example",
        "www.acme.example",
      ]),
    );
    expect(hosts).not.toContain("localhost");
    expect(hosts.some((h) => h.includes("*"))).toBe(false);
  });

  it("records env var names with their platform-config source, never values", async () => {
    const names = await c.json<{
      names: {
        name: string;
        sources: { kind: string; file?: string; key?: string }[];
      }[];
    }>("infrastructure/env-names.json");
    const sourcesOf = (name: string) =>
      names.names.find((n) => n.name === name)?.sources ?? [];
    expect(sourcesOf("LOG_LEVEL")).toEqual([
      { kind: "platform_config", file: "fly.toml", key: "env.LOG_LEVEL" },
    ]);
    expect(sourcesOf("NODE_VERSION")).toEqual([
      {
        kind: "platform_config",
        file: "netlify.toml",
        key: "build.environment.NODE_VERSION",
      },
    ]);
    expect(sourcesOf("SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET")).toEqual([
      {
        kind: "platform_config",
        file: "supabase/config.toml",
        key: "auth.external.google.secret",
      },
    ]);
    expect(sourcesOf("SMTP_PASSWORD")).toHaveLength(1);
    // Edge function code is scanned by the existing env-name scan.
    expect(sourcesOf("STRIPE_WEBHOOK_SECRET")).toEqual([
      { kind: "code", file: "supabase/functions/stripe-webhook/index.ts" },
    ]);
    expect(c.result.manifest.secrets.names).toEqual(
      expect.arrayContaining([
        "SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET",
        "LOG_LEVEL",
      ]),
    );
  });

  it("makes the Supabase prerequisites specific: providers, redirect URLs, functions, buckets", () => {
    const prereqs = c.result.manifest.manual_prerequisites.filter((m) =>
      m.id.includes(":supabase-config-"),
    );
    expect(prereqs.map((m) => m.title).sort()).toEqual([
      "Match Supabase project settings from supabase/config.toml",
      "Recreate Supabase Auth settings from supabase/config.toml",
      "Recreate Supabase Storage buckets (avatars, invoices)",
      "Redeploy Supabase Edge Functions (send-welcome, stripe-webhook)",
    ]);
    const auth = prereqs.find((m) => m.id.includes("config-auth"));
    const text = `${auth?.reason} ${auth?.instructions}`;
    expect(text).toContain("github, google");
    expect(text).not.toContain("apple");
    for (const url of [
      "https://app.acme.example/",
      "https://app.acme.example/auth/callback",
      "https://staging.acme.example/**",
    ])
      expect(text).toContain(url);
    expect(text).toContain("SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET");
    expect(text).toContain("app.acme.example, staging.acme.example");
    const functions = prereqs.find((m) => m.id.includes("config-functions"));
    expect(functions?.reason).toContain("send-welcome, stripe-webhook");
    expect(functions?.instructions).toContain(
      "stripe-webhook set verify_jwt = false",
    );
    expect(functions?.reason).not.toContain("_shared");
    const buckets = prereqs.find((m) => m.id.includes("config-storage"));
    expect(buckets?.reason).toContain("avatars (public, limit 5MiB");
    expect(buckets?.reason).toContain("invoices (private");
    const project = prereqs.find((m) => m.id.includes("config-project"));
    expect(project?.reason).toContain("Postgres major version 15");
    expect(project?.reason).toContain("acme-app");
  });

  it("also feeds the Supabase facts into the integrations component", async () => {
    const doc = await c.json<{
      providers: {
        name: string;
        inferred: boolean;
        evidence: { file: string; dependency: string }[];
        platform_config: { path: string }[];
      }[];
    }>("integrations/integrations.json");
    const supabase = doc.providers.find((p) => p.name === "Supabase");
    expect(supabase).toMatchObject({
      inferred: true,
      evidence: [
        { file: "supabase/config.toml", dependency: "supabase/config.toml" },
      ],
      platform_config: [{ path: "supabase/config.toml" }],
    });
    const manual = c.result.manifest.manual_prerequisites.find(
      (m) => m.id === "integrations:integ:supabase",
    );
    expect(manual?.instructions).toContain(
      "OAuth providers enabled: github, google",
    );
    expect(manual?.instructions).toContain(
      "Edge Functions: send-welcome, stripe-webhook",
    );
    expect(manual?.instructions).toContain(
      "Storage buckets: avatars, invoices",
    );
  });
});

describe("a platform file that does not parse", () => {
  it("makes the component partial with an omission naming the file, and still reads the rest", async () => {
    const c = await capturePlatformFixture({
      root,
      name: "malformed",
      overrides: {
        "fly.toml": 'app = "acme"\n[http_service\ninternal_port = 8080\n',
        "vercel.json": '{ "buildCommand": "next build", }',
      },
    });
    const infra = component(c, "infrastructure:infra");
    expect(infra.status).toBe("partial");
    expect(infra.omissions.map((o) => o.what)).toEqual([
      "Platform configuration fly.toml",
      "Platform configuration vercel.json",
    ]);
    expect(infra.omissions[0]?.reason).toBe(
      "fly file could not be parsed (invalid TOML at line 2, column 14: expected ']'); nothing was inferred from it.",
    );
    expect(infra.omissions[1]?.reason).toMatch(
      /^vercel file could not be parsed \(invalid JSON at line 1, column \d+\)/u,
    );
    const doc = await c.json<PlatformDoc>("infrastructure/platform.json");
    const fly = doc.files.find((f) => f.path === "fly.toml");
    expect(fly).toMatchObject({
      status: "unparsed",
      parsed: null,
      parse_error: "invalid TOML at line 2, column 14: expected ']'",
    });
    expect(fly?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const services = await c.json<ServicesDoc>("infrastructure/services.json");
    expect(services.services.map((s) => s["source"])).not.toContain(
      "platform-config:fly.toml",
    );
    expect(services.services.map((s) => s["source"])).toContain(
      "platform-config:railway.json",
    );
    expect(
      c.result.manifest.missing_or_blocked
        .filter((m) => m.component_id === "infrastructure:infra")
        .map((m) => m.reason)
        .join("\n"),
    ).toContain("Platform configuration fly.toml");
    expect((await verifyIntegrity(c.pkg)).ok).toBe(true);
  }, 120_000);
});

describe("values never reach the package", () => {
  it("records env(...) reference names without any value, anywhere in the package", async () => {
    const markers = {
      SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET: "gsecret_marker_6f1d2c",
      SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET: "ghsecret_marker_91ab3e",
      SMTP_PASSWORD: "smtp_marker_77c0de",
      LOG_LEVEL: "fly_env_value_marker_0badf00d",
    };
    const literal = "literal_apple_secret_marker_5e5e5e";
    const flyValue = "fly_env_literal_value_marker_a1b2c3";
    const c = await capturePlatformFixture({
      root,
      name: "secrets",
      integrations: true,
      env: markers,
      overrides: {
        "supabase/config.toml": [
          'project_id = "acme-app"',
          "[auth]",
          'site_url = "https://app.acme.example"',
          "[auth.external.google]",
          "enabled = true",
          'client_id = "env(GOOGLE_ID)"',
          'secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"',
          "[auth.external.apple]",
          "enabled = true",
          `secret = "${literal}"`,
          "[auth.email.smtp]",
          'pass = "env(SMTP_PASSWORD)"',
          "",
        ].join("\n"),
        "fly.toml": `app = "acme"\n[env]\nSOME_SETTING = "${flyValue}"\n[build.args]\nTOKEN_ARG = "${flyValue}"\n`,
      },
    });
    const names = await c.json<{ names: { name: string }[] }>(
      "infrastructure/env-names.json",
    );
    const all = names.names.map((n) => n.name);
    expect(all).toEqual(
      expect.arrayContaining([
        "GOOGLE_ID",
        "SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET",
        "SMTP_PASSWORD",
        "SOME_SETTING",
      ]),
    );
    const doc = await c.json<PlatformDoc>("infrastructure/platform.json");
    const supabase = doc.files.find((f) => f.platform === "supabase");
    const apple = supabase?.parsed?.["auth"].providers.find(
      (p: { name: string }) => p.name === "apple",
    );
    expect(apple).toMatchObject({ enabled: true, secret: { kind: "literal" } });
    expect(JSON.stringify(apple)).not.toContain(literal);
    const prereq = c.result.manifest.manual_prerequisites.find((m) =>
      m.id.includes("config-auth"),
    );
    expect(prereq?.instructions).toContain(
      "written as a literal in the file and was deliberately not recorded",
    );

    const files = await c.allFiles();
    expect(files.length).toBeGreaterThan(10);
    for (const [rel, bytes] of files)
      for (const secret of [...Object.values(markers), literal, flyValue])
        expect(bytes.includes(Buffer.from(secret)), `${secret} in ${rel}`).toBe(
          false,
        );
  }, 120_000);
});
