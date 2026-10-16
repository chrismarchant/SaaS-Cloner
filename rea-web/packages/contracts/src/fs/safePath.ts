import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

export type PathRejection =
  | { kind: "absolute" }
  | { kind: "traversal" }
  | { kind: "empty" }
  | { kind: "control_characters" }
  | { kind: "too_long"; length: number }
  | { kind: "reserved_name"; name: string };

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu;

/**
 * Validate an archive member or manifest-relative path and return its
 * normalised POSIX form. Rejects absolute paths, parent traversal, control
 * characters, overlong paths and Windows reserved names.
 */
export const validateRelativePath = (
  member: string,
  options: { readonly maxLength?: number } = {},
): { ok: true; path: string } | { ok: false; rejection: PathRejection } => {
  if (member.length === 0) return { ok: false, rejection: { kind: "empty" } };
  const maxLength = options.maxLength ?? 1024;
  if (member.length > maxLength)
    return {
      ok: false,
      rejection: { kind: "too_long", length: member.length },
    };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(member))
    return { ok: false, rejection: { kind: "control_characters" } };
  const posix = member.replaceAll("\\", "/");
  if (posix.startsWith("/") || /^[a-zA-Z]:/u.test(posix) || isAbsolute(posix))
    return { ok: false, rejection: { kind: "absolute" } };
  const segments = posix.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === ".."))
    return { ok: false, rejection: { kind: "traversal" } };
  for (const segment of segments) {
    if (WINDOWS_RESERVED.test(segment))
      return { ok: false, rejection: { kind: "reserved_name", name: segment } };
  }
  if (segments.length === 0) return { ok: false, rejection: { kind: "empty" } };
  return { ok: true, path: segments.join("/") };
};

/** Resolve `member` under `root` and confirm containment after normalisation. */
export const resolveWithin = (
  root: string,
  member: string,
): { ok: true; path: string } | { ok: false; rejection: PathRejection } => {
  const validated = validateRelativePath(member);
  if (!validated.ok) return validated;
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, ...validated.path.split("/"));
  const rel = relative(absoluteRoot, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    return { ok: false, rejection: { kind: "traversal" } };
  return { ok: true, path: normalize(target) };
};

export const isWithin = (root: string, candidate: string): boolean => {
  const rel = relative(resolve(root), resolve(candidate));
  return (
    rel !== "" &&
    !rel.startsWith(`..${sep}`) &&
    rel !== ".." &&
    !isAbsolute(rel)
  );
};

export interface ArchiveLimits {
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
  readonly maxCompressionRatio: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 50_000,
  maxEntryBytes: 2 * 1024 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
};

export type ArchiveRejection =
  | { kind: "too_many_entries"; count: number }
  | { kind: "entry_too_large"; path: string; bytes: number }
  | { kind: "total_too_large"; bytes: number }
  | { kind: "ratio_exceeded"; ratio: number }
  | { kind: "link_entry"; path: string }
  | { kind: "unsafe_member_path"; path: string; rejection: PathRejection };

/**
 * Incremental archive admission state. Feed each entry's header before
 * extracting its bytes; feed byte counts as they stream.
 */
export class ArchiveAdmission {
  private entries = 0;
  private totalBytes = 0;
  private compressedBytes = 0;
  constructor(
    private readonly limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
  ) {}

  admitEntry(entry: {
    readonly path: string;
    readonly declaredBytes: number | null;
    readonly compressedBytes: number | null;
    readonly type: "file" | "directory" | "symlink" | "hardlink" | "other";
  }): { ok: true; path: string } | { ok: false; rejection: ArchiveRejection } {
    this.entries += 1;
    if (this.entries > this.limits.maxEntries)
      return {
        ok: false,
        rejection: { kind: "too_many_entries", count: this.entries },
      };
    if (entry.type === "symlink" || entry.type === "hardlink")
      return { ok: false, rejection: { kind: "link_entry", path: entry.path } };
    const validated = validateRelativePath(entry.path);
    if (!validated.ok)
      return {
        ok: false,
        rejection: {
          kind: "unsafe_member_path",
          path: entry.path,
          rejection: validated.rejection,
        },
      };
    if (
      entry.declaredBytes !== null &&
      entry.declaredBytes > this.limits.maxEntryBytes
    )
      return {
        ok: false,
        rejection: {
          kind: "entry_too_large",
          path: entry.path,
          bytes: entry.declaredBytes,
        },
      };
    if (entry.compressedBytes !== null)
      this.compressedBytes += entry.compressedBytes;
    return { ok: true, path: validated.path };
  }

  admitBytes(
    bytes: number,
  ): { ok: true } | { ok: false; rejection: ArchiveRejection } {
    this.totalBytes += bytes;
    if (this.totalBytes > this.limits.maxTotalBytes)
      return {
        ok: false,
        rejection: { kind: "total_too_large", bytes: this.totalBytes },
      };
    if (this.compressedBytes > 0) {
      const ratio = this.totalBytes / this.compressedBytes;
      if (
        ratio > this.limits.maxCompressionRatio &&
        this.totalBytes > 1024 * 1024
      )
        return { ok: false, rejection: { kind: "ratio_exceeded", ratio } };
    }
    return { ok: true };
  }

  get stats(): {
    entries: number;
    totalBytes: number;
    compressedBytes: number;
  } {
    return {
      entries: this.entries,
      totalBytes: this.totalBytes,
      compressedBytes: this.compressedBytes,
    };
  }
}
