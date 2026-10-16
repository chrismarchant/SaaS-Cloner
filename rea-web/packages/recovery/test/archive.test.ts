import {
  access,
  readFile,
  readdir,
  symlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  IntegrityError,
  PackageFormatError,
  packExport,
  unpackExport,
  verifyIntegrity,
} from "../src/index.js";
import {
  buildFixture,
  cleanupTempDirs,
  makeTempDir,
  rawTar,
  type RawEntry,
} from "./helpers.js";

afterEach(cleanupTempDirs);

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe("packExport / unpackExport", () => {
  it("packs deterministically", async () => {
    const { root } = await buildFixture();
    const out = await makeTempDir("out");
    const a = await packExport(root, join(out, "a.tar"));
    const b = await packExport(root, join(out, "b.tar"));
    expect(a.sha256).toBe(b.sha256);
    expect(a.size).toBe(b.size);
    const ga = await packExport(root, join(out, "a.tgz"), { gzip: true });
    const gb = await packExport(root, join(out, "b.tgz"), { gzip: true });
    expect(ga.sha256).toBe(gb.sha256);
    expect(ga.size).toBeLessThan(a.size + 1024);
  });

  it("round-trips and the unpacked copy verifies and repacks identically", async () => {
    const { root } = await buildFixture();
    const out = await makeTempDir("out");
    for (const gzip of [false, true]) {
      const packed = await packExport(
        root,
        join(out, gzip ? "p.tgz" : "p.tar"),
        { gzip },
      );
      const dest = await makeTempDir("dest");
      const unpacked = await unpackExport(packed.path, dest);
      expect(unpacked.root).toBe(join(dest, "fixture-package"));
      expect(unpacked.entries).toBeGreaterThanOrEqual(3);
      const report = await verifyIntegrity(unpacked.root);
      expect(report.ok).toBe(true);
      expect(report.checked).toBe(3);
      expect(await readFile(join(unpacked.root, "manifest.json"))).toEqual(
        await readFile(join(root, "manifest.json")),
      );
      const again = await packExport(
        unpacked.root,
        join(out, `again-${gzip}.tar`),
        { gzip },
      );
      expect(again.sha256).toBe(packed.sha256);
      // nothing but the package directory is left behind
      expect(await readdir(dest)).toEqual(["fixture-package"]);
    }
  });

  it("normalises metadata in the archive", async () => {
    const { root } = await buildFixture();
    const out = await makeTempDir("out");
    const packed = await packExport(root, join(out, "p.tar"));
    const tar = await import("tar");
    const seen: {
      path: string;
      uid: number | undefined;
      gid: number | undefined;
      mtime: string | undefined;
      type: string;
    }[] = [];
    await tar.list({
      file: packed.path,
      onReadEntry: (e) =>
        seen.push({
          path: e.path,
          uid: e.uid,
          gid: e.gid,
          mtime: e.mtime?.toISOString(),
          type: e.type,
        }),
    });
    expect(seen[0]?.path).toBe("fixture-package/");
    const members = seen.slice(1).map((e) => e.path);
    expect(members).toEqual([...members].sort());
    for (const e of seen) {
      expect(e.mtime).toBe("2026-03-01T12:00:00.000Z");
      expect(e.uid ?? 0).toBe(0);
      expect(e.gid ?? 0).toBe(0);
      expect(["File", "Directory"]).toContain(e.type);
    }
  });

  it("refuses to export symlinks and outputs inside the package", async () => {
    const { root } = await buildFixture();
    const out = await makeTempDir("out");
    await expect(packExport(root, join(root, "inside.tar"))).rejects.toThrow(
      PackageFormatError,
    );
    await symlink("/etc/hostname", join(root, "source/main/link"));
    await expect(packExport(root, join(out, "p.tar"))).rejects.toThrow(
      IntegrityError,
    );
    expect(await exists(join(out, "p.tar"))).toBe(false);
    expect((await readdir(out)).length).toBe(0);
  });

  it("refuses to unpack over an existing directory", async () => {
    const { root } = await buildFixture();
    const out = await makeTempDir("out");
    const packed = await packExport(root, join(out, "p.tar"));
    const dest = await makeTempDir("dest");
    await unpackExport(packed.path, dest);
    await expect(unpackExport(packed.path, dest)).rejects.toThrow();
    expect(await readdir(dest)).toEqual(["fixture-package"]);
  });
});

describe("hostile archives", () => {
  async function expectRejected(
    entries: readonly RawEntry[] | Buffer,
    kind?: string,
    limits?: Parameters<typeof unpackExport>[2],
    gzip = false,
  ): Promise<{ parent: string; dest: string }> {
    const parent = await makeTempDir("hostile");
    const dest = join(parent, "dest");
    await mkdir(dest);
    const raw = Buffer.isBuffer(entries) ? entries : rawTar(entries);
    const tarPath = join(parent, "hostile.tar");
    await writeFile(tarPath, gzip ? gzipSync(raw) : raw);
    const error = await unpackExport(tarPath, dest, limits).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PackageFormatError);
    if (kind !== undefined)
      expect((error as PackageFormatError).rejection?.kind).toBe(kind);
    // nothing escaped and nothing was left in the destination
    expect((await readdir(parent)).sort()).toEqual(["dest", "hostile.tar"]);
    expect(await readdir(dest)).toEqual([]);
    return { parent, dest };
  }

  const manifestEntry: RawEntry = {
    name: "pkg/manifest.json",
    body: Buffer.from("{}"),
  };

  it("rejects parent traversal", async () => {
    await expectRejected(
      [
        { name: "pkg/", type: "5" },
        manifestEntry,
        { name: "../evil", body: Buffer.from("x") },
      ],
      "unsafe_member_path",
    );
    await expectRejected(
      [manifestEntry, { name: "pkg/../../evil", body: Buffer.from("x") }],
      "unsafe_member_path",
    );
  });

  it("rejects absolute paths", async () => {
    const target = join(await makeTempDir("abs"), "abs-evil");
    await expectRejected(
      [manifestEntry, { name: target, body: Buffer.from("x") }],
      "unsafe_member_path",
    );
    expect(await exists(target)).toBe(false);
  });

  it("rejects symlink and hardlink entries", async () => {
    await expectRejected(
      [manifestEntry, { name: "pkg/link", type: "2", linkname: "/etc/passwd" }],
      "link_entry",
    );
    await expectRejected(
      [
        manifestEntry,
        { name: "pkg/hard", type: "1", linkname: "pkg/manifest.json" },
      ],
      "link_entry",
    );
  });

  it("does not write through a link smuggled ahead of a file", async () => {
    const victim = await makeTempDir("victim");
    await expectRejected(
      [
        { name: "pkg/out", type: "2", linkname: victim },
        { name: "pkg/out/pwned", body: Buffer.from("x") },
      ],
      "link_entry",
    );
    expect(await readdir(victim)).toEqual([]);
  });

  it("rejects device nodes and unknown entry types", async () => {
    await expectRejected([manifestEntry, { name: "pkg/dev", type: "3" }]);
  });

  it("rejects archives with too many entries (60k tiny entries)", async () => {
    const entries: RawEntry[] = [];
    for (let i = 0; i < 60_000; i += 1) entries.push({ name: `pkg/f${i}` });
    await expectRejected(entries, "too_many_entries");
  });

  it("enforces caller limits on entries and entry size", async () => {
    await expectRejected(
      [{ name: "pkg/a" }, { name: "pkg/b" }, { name: "pkg/c" }],
      "too_many_entries",
      {
        limits: {
          maxEntries: 2,
          maxEntryBytes: 1e9,
          maxTotalBytes: 1e9,
          maxCompressionRatio: 200,
        },
      },
    );
    await expectRejected(
      [{ name: "pkg/big", body: Buffer.alloc(4096, 1) }],
      "entry_too_large",
      {
        limits: {
          maxEntries: 10,
          maxEntryBytes: 1024,
          maxTotalBytes: 1e9,
          maxCompressionRatio: 200,
        },
      },
    );
    await expectRejected(
      [
        { name: "pkg/a", body: Buffer.alloc(1024, 1) },
        { name: "pkg/b", body: Buffer.alloc(1024, 2) },
      ],
      "total_too_large",
      {
        limits: {
          maxEntries: 10,
          maxEntryBytes: 1e9,
          maxTotalBytes: 1500,
          maxCompressionRatio: 200,
        },
      },
    );
  });

  it("rejects decompression bombs by expansion ratio", async () => {
    await expectRejected(
      [{ name: "pkg/zeros", body: Buffer.alloc(24 * 1024 * 1024) }],
      "ratio_exceeded",
      undefined,
      true,
    );
  });

  it("rejects multiple top-level entries, top-level files and empty archives", async () => {
    await expectRejected([
      manifestEntry,
      { name: "other/file", body: Buffer.from("x") },
    ]);
    await expectRejected([{ name: "loose-file", body: Buffer.from("x") }]);
    await expectRejected(Buffer.alloc(1024));
  });

  it("rejects garbage and truncated archives", async () => {
    await expectRejected(
      Buffer.from("this is not a tar archive at all".repeat(40)),
    );
    const good = rawTar([
      manifestEntry,
      { name: "pkg/data", body: Buffer.alloc(5000, 7) },
    ]);
    await expectRejected(good.subarray(0, 512 + 512 + 512 + 100));
  });

  it("rejects duplicate members instead of overwriting", async () => {
    await expectRejected([
      { name: "pkg/a", body: Buffer.from("one") },
      { name: "pkg/a", body: Buffer.from("two") },
    ]);
  });

  it("rejects a file/directory collision", async () => {
    await expectRejected([
      { name: "pkg/a", body: Buffer.from("one") },
      { name: "pkg/a/b", body: Buffer.from("two") },
    ]);
  });
});
