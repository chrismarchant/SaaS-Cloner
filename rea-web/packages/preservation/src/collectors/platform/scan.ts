import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path/posix";
import { type TreeEntry, type TreeListing, sha256File } from "../../util.js";
import { extractFly } from "./fly.js";
import { extractNetlify } from "./netlify.js";
import { extractProcfile, parseProcfile } from "./procfile.js";
import { Audit } from "./reader.js";
import { extractRailway } from "./railway.js";
import { extractSupabase } from "./supabase.js";
import { parseToml } from "./toml.js";
import type {
  Extraction,
  ExtractInput,
  PlatformFile,
  PlatformName,
  PlatformScan,
} from "./types.js";
import { extractVercel } from "./vercel.js";

const MAX_BYTES = 1024 * 1024;
const MAX_UNKNOWN_KEYS = 200;

export const RAILWAY_IAC_LIMITATION =
  "TypeScript IaC not evaluated during capture; restore operators must run `railway config plan` against it";

type Format = "json" | "toml" | "procfile";

interface Handler {
  platform: PlatformName;
  format: Format;
  matches: (rel: string) => boolean;
  extract: (input: ExtractInput) => Extraction;
}

const named =
  (...names: string[]) =>
  (rel: string): boolean =>
    names.includes(basename(rel));

const HANDLERS: Handler[] = [
  {
    platform: "railway",
    format: "json",
    matches: named("railway.json"),
    extract: extractRailway,
  },
  {
    platform: "railway",
    format: "toml",
    matches: named("railway.toml"),
    extract: extractRailway,
  },
  {
    platform: "fly",
    format: "toml",
    matches: named("fly.toml"),
    extract: extractFly,
  },
  {
    platform: "vercel",
    format: "json",
    matches: named("vercel.json"),
    extract: extractVercel,
  },
  {
    platform: "netlify",
    format: "toml",
    matches: named("netlify.toml"),
    extract: extractNetlify,
  },
  {
    platform: "procfile",
    format: "procfile",
    matches: named("Procfile"),
    extract: extractProcfile,
  },
  {
    platform: "supabase",
    format: "toml",
    matches: (rel) =>
      basename(rel) === "config.toml" && basename(dirname(rel)) === "supabase",
    extract: extractSupabase,
  },
];

const isRailwayIac = (rel: string): boolean =>
  rel === ".railway/railway.ts" || rel.endsWith("/.railway/railway.ts");

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const parseJson = (text: string): Parsed<unknown> => {
  try {
    const value: unknown = JSON.parse(text.replace(/^﻿/u, ""));
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return {
        ok: false,
        error: "invalid JSON: top-level value is not an object",
      };
    return { ok: true, value };
  } catch (error) {
    // The engine's message quotes file content; only the position is kept.
    const message = error instanceof Error ? error.message : "";
    const at = /position (\d+)/u.exec(message)?.[1];
    if (at !== undefined) {
      const before = text.slice(0, Number(at));
      const line = before.split("\n").length;
      const column = Number(at) - before.lastIndexOf("\n");
      return {
        ok: false,
        error: `invalid JSON at line ${line}, column ${column}`,
      };
    }
    return {
      ok: false,
      error: /end of JSON/iu.test(message)
        ? "invalid JSON: unexpected end of input"
        : "invalid JSON",
    };
  }
};

const parseDocument = (format: Format, text: string): Parsed<unknown> => {
  if (format === "json") return parseJson(text);
  if (format === "toml") {
    const result = parseToml(text);
    return result.ok
      ? { ok: true, value: result.value }
      : { ok: false, error: result.error };
  }
  const result = parseProcfile(text);
  return result.ok
    ? { ok: true, value: result.entries }
    : { ok: false, error: result.error };
};

const decode = (bytes: Buffer): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const unparsed = (
  handler: Pick<Handler, "platform">,
  entry: TreeEntry,
  sha256: string,
  error: string,
): PlatformFile => ({
  platform: handler.platform,
  path: entry.rel,
  sha256,
  confidence: "declared",
  status: "unparsed",
  parsed: null,
  unknown_keys: [],
  limitations: [
    "The file is preserved in the source component but its contents were not interpreted.",
  ],
  parse_error: error,
  extraction: null,
});

async function readHandled(
  handler: Handler,
  entry: TreeEntry,
  allPaths: readonly string[],
  redact: (text: string) => string,
): Promise<PlatformFile> {
  if (entry.size > MAX_BYTES)
    return unparsed(
      handler,
      entry,
      await sha256File(entry.abs),
      `file is larger than ${MAX_BYTES} bytes and was not read`,
    );
  const bytes = await readFile(entry.abs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const text = decode(bytes);
  if (text === null)
    return unparsed(handler, entry, sha256, "file is not valid UTF-8");
  const doc = parseDocument(handler.format, text);
  if (!doc.ok) return unparsed(handler, entry, sha256, redact(doc.error));
  const audit = new Audit();
  const extraction = handler.extract({
    path: entry.rel,
    dir: dirname(entry.rel) === "." ? "" : dirname(entry.rel),
    doc: doc.value,
    audit,
    allPaths,
  });
  const unknown = audit.unknownKeys();
  const limitations = [...extraction.limitations];
  if (unknown.length > MAX_UNKNOWN_KEYS)
    limitations.push(
      `${unknown.length - MAX_UNKNOWN_KEYS} further unknown keys are not listed.`,
    );
  extraction.unknown_keys = unknown.slice(0, MAX_UNKNOWN_KEYS);
  return {
    platform: handler.platform,
    path: entry.rel,
    sha256,
    confidence: "declared",
    status: "parsed",
    parsed: extraction.parsed,
    unknown_keys: extraction.unknown_keys,
    limitations,
    parse_error: null,
    extraction,
  };
}

async function readIac(entry: TreeEntry): Promise<PlatformFile> {
  return {
    platform: "railway",
    path: entry.rel,
    sha256: await sha256File(entry.abs),
    confidence: "inferred",
    status: "present",
    parsed: { present: true, language: "typescript", evaluated: false },
    unknown_keys: [],
    limitations: [RAILWAY_IAC_LIMITATION],
    parse_error: null,
    extraction: null,
  };
}

export interface ScanOptions {
  /** Restrict the scan to these platforms; the default is all of them. */
  only?: readonly PlatformName[];
  /** Applied to parse errors before they are returned. */
  redact?: (text: string) => string;
}

/**
 * Read the platform configuration declared in a captured checkout with
 * format-aware parsers. Nothing in the checkout is executed.
 */
export async function scanPlatformConfig(
  tree: TreeListing,
  options: ScanOptions = {},
): Promise<PlatformScan> {
  const redact = options.redact ?? ((text: string) => text);
  const wanted = (platform: PlatformName): boolean =>
    options.only === undefined || options.only.includes(platform);
  const allPaths = tree.files.map((f) => f.rel);
  const files: PlatformFile[] = [];
  for (const entry of tree.files) {
    const handler = HANDLERS.find(
      (h) => wanted(h.platform) && h.matches(entry.rel),
    );
    if (handler !== undefined)
      files.push(await readHandled(handler, entry, allPaths, redact));
    else if (wanted("railway") && isRailwayIac(entry.rel))
      files.push(await readIac(entry));
  }
  const unread = tree.skipped
    .filter(
      (s) =>
        HANDLERS.some((h) => wanted(h.platform) && h.matches(s.rel)) ||
        (wanted("railway") && isRailwayIac(s.rel)),
    )
    .map((s) => ({ path: s.rel, reason: s.reason }));
  files.sort((a, b) =>
    a.path < b.path
      ? -1
      : a.path > b.path
        ? 1
        : a.platform < b.platform
          ? -1
          : 1,
  );
  return { files, unread };
}
