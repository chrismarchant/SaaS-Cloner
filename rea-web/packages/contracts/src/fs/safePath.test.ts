import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ArchiveAdmission,
  isWithin,
  resolveWithin,
  validateRelativePath,
} from "./safePath.js";

const kind = (member: string): string => {
  const result = validateRelativePath(member);
  return result.ok ? `ok:${result.path}` : result.rejection.kind;
};

describe("validateRelativePath", () => {
  it("accepts and normalises safe relative paths", () => {
    expect(kind("a/b/c.txt")).toBe("ok:a/b/c.txt");
    expect(kind("./a/b")).toBe("ok:a/b");
    expect(kind("a\\b\\c")).toBe("ok:a/b/c");
    expect(kind("a//b")).toBe("ok:a/b");
  });

  it("rejects empty, absolute, traversal, control and reserved names", () => {
    expect(kind("")).toBe("empty");
    expect(kind(".")).toBe("empty");
    expect(kind("../x")).toBe("traversal");
    expect(kind("a/../../b")).toBe("traversal");
    expect(kind("/abs")).toBe("absolute");
    expect(kind("C:\\x")).toBe("absolute");
    expect(kind("\\\\server\\share")).toBe("absolute");
    expect(kind("a\u0000b")).toBe("control_characters");
    expect(kind("CON")).toBe("reserved_name");
    expect(kind("a/NUL.txt")).toBe("reserved_name");
    expect(kind("x".repeat(2000))).toBe("too_long");
  });
});

describe("resolveWithin / isWithin", () => {
  const root = resolve("/srv/root");
  it("keeps members under the root", () => {
    const result = resolveWithin(root, "a/b.txt");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path.startsWith(root + sep)).toBe(true);
      expect(isWithin(root, result.path)).toBe(true);
    }
  });
  it("rejects escapes and the root itself", () => {
    expect(resolveWithin(root, "../etc/passwd").ok).toBe(false);
    expect(resolveWithin(root, "/etc/passwd").ok).toBe(false);
    expect(isWithin(root, root)).toBe(false);
    expect(isWithin(root, resolve("/srv/root2/x"))).toBe(false);
    expect(isWithin(root, resolve("/srv"))).toBe(false);
  });
});

describe("ArchiveAdmission", () => {
  const file = (path: string, declaredBytes = 10, compressedBytes = 10) =>
    ({ path, declaredBytes, compressedBytes, type: "file" }) as const;

  it("limits entry count", () => {
    const admission = new ArchiveAdmission({
      maxEntries: 2,
      maxEntryBytes: 1000,
      maxTotalBytes: 1000,
      maxCompressionRatio: 100,
    });
    expect(admission.admitEntry(file("a")).ok).toBe(true);
    expect(admission.admitEntry(file("b")).ok).toBe(true);
    const third = admission.admitEntry(file("c"));
    expect(third.ok ? null : third.rejection.kind).toBe("too_many_entries");
  });

  it("rejects links and unsafe member paths", () => {
    const admission = new ArchiveAdmission();
    const link = admission.admitEntry({
      path: "l",
      declaredBytes: 0,
      compressedBytes: 0,
      type: "symlink",
    });
    expect(link.ok ? null : link.rejection.kind).toBe("link_entry");
    const hard = admission.admitEntry({
      path: "h",
      declaredBytes: 0,
      compressedBytes: 0,
      type: "hardlink",
    });
    expect(hard.ok ? null : hard.rejection.kind).toBe("link_entry");
    const escape = admission.admitEntry(file("../../etc/passwd"));
    expect(escape.ok ? null : escape.rejection.kind).toBe("unsafe_member_path");
  });

  it("rejects oversized entries and totals", () => {
    const admission = new ArchiveAdmission({
      maxEntries: 10,
      maxEntryBytes: 100,
      maxTotalBytes: 150,
      maxCompressionRatio: 1000,
    });
    const big = admission.admitEntry(file("big", 101, 50));
    expect(big.ok ? null : big.rejection.kind).toBe("entry_too_large");
    expect(admission.admitEntry(file("a", 100, 50)).ok).toBe(true);
    expect(admission.admitBytes(100).ok).toBe(true);
    const over = admission.admitBytes(60);
    expect(over.ok ? null : over.rejection.kind).toBe("total_too_large");
  });

  it("rejects extreme compression ratios only past 1 MiB of output", () => {
    const admission = new ArchiveAdmission();
    expect(admission.admitEntry(file("bomb", null as never, 1000)).ok).toBe(
      true,
    );
    expect(admission.admitBytes(512 * 1024).ok).toBe(true);
    const bomb = admission.admitBytes(3 * 1024 * 1024);
    expect(bomb.ok ? null : bomb.rejection.kind).toBe("ratio_exceeded");
    expect(admission.stats.compressedBytes).toBe(1000);
  });
});
