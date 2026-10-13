import { join } from "node:path";
import type { ManifestComponent, RecoveryManifest } from "@rea-web/contracts";
import { openRegularFile } from "../fsutil.js";

const MAX_SPEC_BYTES = 8 * 1024 * 1024;

export interface InvariantSpec {
  readonly id: string;
  readonly sql: string;
  /** Value recorded at capture; null when capture could not evaluate it. */
  readonly expected: string | null;
}

export type InvariantSource =
  | { readonly file: string; readonly invariants: readonly InvariantSpec[] }
  | { readonly file: string; readonly error: string };

export interface BehaviorSpec {
  readonly run: readonly string[];
  readonly expectExit: number;
  readonly timeoutMs: number | null;
}

const readJson = async (root: string, rel: string): Promise<unknown> => {
  const handle = await openRegularFile(join(root, ...rel.split("/")));
  try {
    if ((await handle.stat()).size > MAX_SPEC_BYTES)
      throw new Error(`${rel} is larger than ${MAX_SPEC_BYTES} bytes`);
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
};

const filesNamed = (
  manifest: RecoveryManifest,
  kind: ManifestComponent["kind"],
  name: string,
): string[] => {
  const ids = new Set(
    manifest.components.filter((c) => c.kind === kind).map((c) => c.id),
  );
  return manifest.files
    .filter((f) => ids.has(f.component_id) && f.path.split("/").pop() === name)
    .map((f) => f.path);
};

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

/** Invariants recorded by the data collectors (`data/<id>/invariants.json`). */
export async function loadInvariants(
  root: string,
  manifest: RecoveryManifest,
): Promise<InvariantSource[]> {
  const out: InvariantSource[] = [];
  for (const file of filesNamed(manifest, "data", "invariants.json")) {
    try {
      const json = await readJson(root, file);
      if (!Array.isArray(json)) throw new Error("expected a JSON array");
      const invariants: InvariantSpec[] = json.map((entry, index) => {
        const r = asRecord(entry);
        if (
          r === null ||
          typeof r["id"] !== "string" ||
          typeof r["sql"] !== "string"
        )
          throw new Error(`entry ${index} lacks a string id and sql`);
        const expected = r["expected_at_capture"];
        return {
          id: r["id"],
          sql: r["sql"],
          expected: typeof expected === "string" ? expected : null,
        };
      });
      out.push({ file, invariants });
    } catch (error) {
      out.push({ file, error: (error as Error).message });
    }
  }
  return out;
}

/** Step id the infrastructure collector gives a behavior check. */
export const behaviorStepId = (checkId: string): string =>
  `behavior-${checkId}`.replace(/[^A-Za-z0-9_.-]/gu, "_");

/**
 * Behavior expectations (`infrastructure/<id>/behavior-checks.json`) keyed by
 * restore step id. Steps without a matching record default to exit 0.
 */
export async function loadBehaviorSpecs(
  root: string,
  manifest: RecoveryManifest,
): Promise<Map<string, BehaviorSpec>> {
  const out = new Map<string, BehaviorSpec>();
  for (const file of filesNamed(
    manifest,
    "infrastructure",
    "behavior-checks.json",
  )) {
    try {
      const checks = asRecord(await readJson(root, file))?.["checks"];
      if (!Array.isArray(checks)) continue;
      for (const entry of checks) {
        const r = asRecord(entry);
        const run = r?.["run"];
        if (
          r === null ||
          typeof r["id"] !== "string" ||
          !Array.isArray(run) ||
          !run.every((a) => typeof a === "string")
        )
          continue;
        const exit = r["expect_exit"];
        const timeout = r["timeout_ms"];
        out.set(behaviorStepId(r["id"]), {
          run: run as string[],
          expectExit: Number.isInteger(exit) ? (exit as number) : 0,
          timeoutMs:
            typeof timeout === "number" &&
            Number.isFinite(timeout) &&
            timeout > 0
              ? timeout
              : null,
        });
      }
    } catch {
      // An unreadable spec leaves the defaults; integrity already vouched for the bytes.
    }
  }
  return out;
}
