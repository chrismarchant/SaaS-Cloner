import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BuildJobInput } from "@rea-web/contracts";
import {
  assertSourceAllowed,
  declaredEnvironment,
  SourceRefusedError,
} from "../src/preservation/execute.js";
import {
  localPathHash,
  resolveLocalPaths,
} from "../src/preservation/localPaths.js";

const build = (url: string): BuildJobInput => ({
  id: "0192f1a0-0000-7000-8000-000000000001",
  name: "b",
  description: "",
  project_slug: "default",
  source: {
    kind: "git",
    url,
    ref: "HEAD",
    include_working_tree: false,
    include_lfs: true,
    include_submodules: true,
  },
  components: [{ kind: "source", id: "main" }],
});

describe("preservation source boundary", () => {
  it("refuses host paths, file URLs, plain http, embedded credentials and private hosts", async () => {
    for (const url of [
      "/home/runner/private-repo",
      "../repo",
      "file:///etc",
      "http://git.example.com/repo.git",
      "https://user:token@git.example.com/repo.git",
      "https://127.0.0.1/repo.git",
      "https://169.254.169.254/latest",
      "https://[::1]/repo.git",
      "ext::sh -c touch% /tmp/pwned",
      "ssh://git@10.0.0.5/repo.git",
    ])
      await expect(assertSourceAllowed(build(url)), url).rejects.toBeInstanceOf(
        SourceRefusedError,
      );
  });

  it("accepts remote https and ssh (including scp-like) URLs on public addresses", async () => {
    for (const url of [
      "https://140.82.112.3/org/repo.git",
      "git@140.82.112.3:org/repo.git",
      "ssh://git@140.82.112.3/org/repo.git",
    ])
      await expect(assertSourceAllowed(build(url))).resolves.toBeUndefined();
  });

  it("resolves only allowlisted local paths, by real path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rea-web-local-"));
    try {
      const link = join(dir, "link");
      await symlink(dir, link);
      const map = await resolveLocalPaths([link, join(dir, "missing")]);
      expect([...map.values()]).toEqual([dir]);
      expect(map.get(localPathHash(dir))).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes collectors only the environment names the build declares", () => {
    const names = declaredEnvironment([
      { kind: "source", id: "main" },
      {
        kind: "data",
        id: "db",
        engine: "postgresql",
        connection_env_name: "APP_DATABASE_URL",
        invariants: [],
      },
    ]);
    expect(names.secret).toEqual(["APP_DATABASE_URL"]);
    expect(names.plain).not.toContain("REA_WEB_RUNNER_TOKEN");
    const storage = declaredEnvironment([
      {
        kind: "assets",
        id: "files",
        source: {
          kind: "supabase_storage",
          project_ref: "abcd",
          buckets: ["avatars"],
          credentials_env_prefix: "SB",
        },
      },
    ]);
    expect(storage.secret).toEqual(
      expect.arrayContaining(["SB_ACCESS_KEY_ID", "SB_SECRET_ACCESS_KEY"]),
    );
    expect(storage.plain).toEqual(
      expect.arrayContaining(["SB_REGION", "SB_ENDPOINT"]),
    );
  });
});
