import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  type Redactor,
  type RestoreStep,
  validateRelativePath,
} from "@rea-web/contracts";

const SCP_LIKE =
  /^(?:[^/\s@]+@)?[A-Za-z0-9._-]+:(?!\/\/)(?![A-Za-z]:[\\/])[^\s]*$/u;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

/** Repository URL (any scheme, including file://, or scp-like) as opposed to a plain filesystem path. */
export const isRemoteGitUrl = (value: string): boolean =>
  URL_SCHEME.test(value) ||
  (!value.startsWith("/") && !value.startsWith(".") && SCP_LIKE.test(value));

/** Strip userinfo, query and fragment from a URL or scp-like git address. */
export const redactUrl = (raw: string): string => {
  if (URL_SCHEME.test(raw)) {
    try {
      const url = new URL(raw);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      // fall through to the textual form
    }
  }
  return raw
    .replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@]*@/u, "$1")
    .replace(/^[^/\s@]+@(?=[A-Za-z0-9._-]+:)/u, "")
    .replace(/[?#].*$/u, "");
};

/** Userinfo of a URL, if any (decoded). Never log the result. */
export const urlUserinfo = (
  raw: string,
): { user: string; password: string } | null => {
  if (!URL_SCHEME.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.username === "" && url.password === "") return null;
    return {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  } catch {
    return null;
  }
};

export const hostOf = (raw: string): string | null => {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);
export const isLoopbackHost = (host: string): boolean =>
  LOOPBACK.has(host.toLowerCase()) || host.startsWith("/");

/** Hostnames of every http(s)/ws(s) URL appearing in arbitrary JSON. */
export const hostnamesIn = (value: unknown): string[] => {
  const found = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gu)) {
        const h = hostOf(m[0]);
        if (h !== null) found.add(h);
      }
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v !== null && typeof v === "object")
      Object.values(v as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return [...found];
};

const mapStrings = (value: unknown, fn: (s: string) => string): unknown => {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        mapStrings(v, fn),
      ]),
    );
  return value;
};

/**
 * Layer additional literal secret values (looked up by the collectors from
 * declarations, e.g. a parsed connection password) on top of the caller's
 * redactor so they cannot reach logs, details or errors.
 */
export const extendRedactor = (
  base: Redactor,
  extraValues: readonly string[],
): Redactor => {
  const values = [...new Set(extraValues.filter((v) => v.length >= 4))].sort(
    (a, b) => b.length - a.length,
  );
  const scrub = (text: string): string => {
    let out = text;
    for (const v of values) out = out.split(v).join("[REDACTED]");
    return out;
  };
  return {
    redactText: (text: string) => scrub(base.redactText(text)),
    redactValue: (value: unknown, keyHint?: string) =>
      mapStrings(base.redactValue(value, keyHint), scrub),
  };
};

export const jsonText = (value: unknown, redactor?: Redactor): string =>
  `${JSON.stringify(redactor === undefined ? value : redactor.redactValue(value), null, 2)}\n`;

/** One filesystem-safe path segment derived from arbitrary text. */
export const safeSegment = (text: string): string => {
  const cleaned = text.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^\.+/u, "_");
  const trimmed = cleaned.slice(0, 120);
  return trimmed === "" ? "_" : trimmed;
};

const MEDIA_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".sql": "application/sql",
  ".patch": "text/x-diff",
  ".bundle": "application/x-git-bundle",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".yml": "application/yaml",
  ".yaml": "application/yaml",
  ".toml": "application/toml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pgc": "application/octet-stream",
};

export const guessContentType = (path: string): string =>
  MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

export const stepOf = (
  step: Omit<RestoreStep, "env_names" | "requires" | "network"> &
    Partial<Pick<RestoreStep, "env_names" | "requires" | "network">>,
): RestoreStep => ({
  env_names: [],
  requires: [],
  network: "none",
  ...step,
});

/** Write a staged file (relative to `stageDir`), creating parents. */
export const writeStaged = async (
  stageDir: string,
  relativePath: string,
  body: string | Uint8Array,
): Promise<string> => {
  const v = validateRelativePath(relativePath);
  if (!v.ok)
    throw new Error(`unsafe staged path ${JSON.stringify(relativePath)}`);
  const abs = join(stageDir, ...v.path.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, body);
  return abs;
};

export const sha256File = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
};

export const sha256Text = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

export interface TreeEntry {
  rel: string;
  abs: string;
  size: number;
}

export interface TreeListing {
  files: TreeEntry[];
  /** Entries skipped because they are symlinks or special files. */
  skipped: { rel: string; reason: string }[];
  truncated: boolean;
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
]);

/**
 * Deterministic (codepoint-sorted) listing of regular files below `root`.
 * Symlinks and special files are reported, never followed.
 */
export async function listTree(
  root: string,
  options: { skipDirs?: ReadonlySet<string> | null; maxFiles?: number } = {},
): Promise<TreeListing> {
  const skipDirs =
    options.skipDirs === null
      ? new Set<string>()
      : (options.skipDirs ?? SKIP_DIRS);
  const maxFiles = options.maxFiles ?? 200_000;
  const files: TreeEntry[] = [];
  const skipped: TreeListing["skipped"] = [];
  let truncated = false;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.push({ rel, reason: "symbolic link (never followed)" });
      } else if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        await walk(abs, rel);
      } else if (entry.isFile()) {
        const st = await lstat(abs);
        files.push({ rel, abs, size: st.size });
      } else {
        skipped.push({ rel, reason: "not a regular file" });
      }
    }
  };
  await walk(root, "");
  return { files, skipped, truncated };
}

/** First dotted-number token of a tool's `--version` output. */
export const parseVersion = (text: string): string => {
  const line = text.split("\n", 1)[0] ?? "";
  const m = /(\d+(?:\.\d+)+[^\s)]*)/u.exec(line);
  return m?.[1] ?? (line.trim() || "unknown");
};

export const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

export const toPosix = (path: string): string => path.split("\\").join("/");

/**
 * Package directory of a component. Infrastructure and integrations live at
 * `infrastructure/` and `integrations/` when the build declares exactly one
 * of that kind (the layout in RECOVERY-FORMAT.md); every other component
 * lives at `<kind>/<id>/`.
 */
export const componentRoot = (
  build: { components: readonly { kind: string; id: string }[] },
  decl: { kind: string; id: string },
): string =>
  (decl.kind === "infrastructure" || decl.kind === "integrations") &&
  build.components.filter((c) => c.kind === decl.kind).length === 1
    ? `${decl.kind}/`
    : `${decl.kind}/${decl.id}/`;
