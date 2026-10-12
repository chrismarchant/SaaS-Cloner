import { describe, expect, it } from "vitest";
import {
  RECOVERY_FORMAT,
  RECOVERY_FORMAT_VERSION,
  recoveryManifestJsonSchema,
  recoveryManifestSchema,
  validateRestoreStepArguments,
  type RecoveryManifest,
  type RestoreStep,
} from "./manifest.js";

export const minimalManifest = (): RecoveryManifest => ({
  format: RECOVERY_FORMAT,
  format_version: RECOVERY_FORMAT_VERSION,
  package_id: "0192f1a0-0000-7000-8000-000000000001",
  build: {
    id: "build-1",
    name: "Example",
    project_slug: "example",
    description: "",
  },
  created_at: "2026-10-12T00:00:00.000Z",
  producer: {
    name: "rea-web",
    version: "0.1.0",
    upstream_rea: {
      package_version: "6.4.0",
      source_sha: "c22111eca2c4bc84a084f12711f405b3e7422a40",
      catalog_digest: null,
    },
    tools: [{ name: "git", version: "2.43.0" }],
  },
  source_revisions: [
    {
      repository: "main",
      remote_url_redacted: "https://github.com/example/example.git",
      head_sha: "0123456789abcdef0123456789abcdef01234567",
      refs: [
        {
          name: "refs/heads/main",
          sha: "0123456789abcdef0123456789abcdef01234567",
        },
      ],
      submodules: [],
      lfs: { count: 0, bytes: 0, included: true },
      working_tree: { included: false, dirty_files: 0, untracked_files: 0 },
    },
  ],
  components: [
    {
      id: "source:main",
      kind: "source",
      title: "Source",
      status: "captured",
      captured_at: {
        start: "2026-10-12T00:00:00.000Z",
        end: "2026-10-12T00:00:01.000Z",
      },
      method: "git bundle --all",
      root: "source/main/",
      entries: 1,
      bytes: 1024,
      restore: {
        steps: [
          {
            id: "clone",
            title: "Clone from bundle",
            run: [
              "git",
              "clone",
              "{{package_root}}/source/main/repo.bundle",
              "{{target}}",
            ],
            env_names: [],
            requires: ["git>=2.30"],
            network: "none",
            scope: "clean_build",
          },
        ],
      },
      limitations: [],
      omissions: [],
      details: {},
    },
  ],
  relationships: [],
  files: [
    {
      path: "source/main/repo.bundle",
      size: 1024,
      sha256: "a".repeat(64),
      component_id: "source:main",
    },
  ],
  dependencies: {
    runtimes: [],
    package_managers: [],
    container_images: [],
    registries: [],
    system_packages: [],
  },
  manual_prerequisites: [],
  secrets: { mode: "names_only", names: ["DATABASE_URL"] },
  consistency: {
    strategy: "sequential",
    window: null,
    classification: "unknown",
    gaps: [],
  },
  verification: {
    scope: ["integrity"],
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

describe("recoveryManifestSchema", () => {
  it("accepts a minimal valid manifest", () => {
    expect(recoveryManifestSchema.safeParse(minimalManifest()).success).toBe(
      true,
    );
  });

  it("rejects a wrong format marker, bad hashes and key material", () => {
    const wrongFormat = { ...minimalManifest(), format: "other" };
    expect(recoveryManifestSchema.safeParse(wrongFormat).success).toBe(false);
    const badHash = minimalManifest();
    (badHash.files[0] as { sha256: string }).sha256 = "nothex";
    expect(recoveryManifestSchema.safeParse(badHash).success).toBe(false);
    const keyInside = {
      ...minimalManifest(),
      encryption: {
        scheme: "aes-256-gcm-envelope",
        recipients: ["k1"],
        key_location: "inside",
      },
    };
    expect(recoveryManifestSchema.safeParse(keyInside).success).toBe(false);
  });

  it("exports a draft 2020-12 JSON schema", () => {
    const schema = recoveryManifestJsonSchema() as {
      $schema?: string;
      properties?: Record<string, unknown>;
    };
    expect(schema.$schema).toContain("2020-12");
    expect(schema.properties).toHaveProperty("format");
    expect(schema.properties).toHaveProperty("restore_guards");
  });
});

describe("validateRestoreStepArguments", () => {
  const step = (run: string[]): RestoreStep => ({
    id: "s",
    title: "s",
    run,
    env_names: [],
    requires: [],
    network: "none",
    scope: "clean_build",
  });
  it("accepts argument arrays with known placeholders", () => {
    expect(
      validateRestoreStepArguments(
        step([
          "git",
          "clone",
          "{{package_root}}/source/repo.bundle",
          "{{target}}",
        ]),
      ),
    ).toEqual({ ok: true });
  });
  it("rejects shell interpreters and unknown placeholders", () => {
    expect(
      validateRestoreStepArguments(step(["sh", "-c", "rm -rf /"])).ok,
    ).toBe(false);
    expect(validateRestoreStepArguments(step(["bash", "x.sh"])).ok).toBe(false);
    expect(
      validateRestoreStepArguments(step(["cp", "{{home}}/x", "y"])).ok,
    ).toBe(false);
  });
});
