import type { RecoveryManifest } from "@rea-web/contracts";
import type { PackageBuilder } from "@rea-web/recovery";
import { succeeded } from "./exec.js";
import { gitEnv } from "./git.js";
import type { CollectorOutcome, Runtime } from "./runtime.js";
import {
  DEFAULT_CONSISTENCY_WINDOW_MS,
  type CollectorContext,
  type ComponentDeclaration,
  type PreservationPlanBody,
} from "./types.js";
import { consistencyStrategyText } from "./plan.js";
import { parseVersion, unique } from "./util.js";

type Manifest = RecoveryManifest;

export interface ComponentResult {
  decl: ComponentDeclaration;
  cid: string;
  kind: string;
  outcome: CollectorOutcome;
}

const TOOL_VERSION_ARGV: Record<string, string[]> = {
  git: ["git", "--version"],
  "git-lfs": ["git", "lfs", "version"],
  pg_dump: ["pg_dump", "--version"],
  pg_restore: ["pg_restore", "--version"],
  pg_dumpall: ["pg_dumpall", "--version"],
  psql: ["psql", "--version"],
  python3: ["python3", "--version"],
};

/**
 * Cross-component recovery point. `single_point` only when every data and
 * asset component was captured and all their windows fit in one window;
 * `inconsistent` when they were captured too far apart; `unknown` when any of
 * them was not captured or the database was written to during the dump.
 */
export const classifyConsistency = (
  results: readonly ComponentResult[],
  windowMs: number,
  strategy: string,
): Manifest["consistency"] => {
  const stateful = results.filter(
    (r) => r.kind === "data" || r.kind === "assets",
  );
  const gaps: string[] = [];
  if (stateful.length === 0)
    return {
      strategy,
      window: null,
      classification: "unknown",
      gaps: [
        "No data or asset component was declared, so no cross-component recovery point exists.",
      ],
    };
  const windows: { start: number; end: number }[] = [];
  for (const r of stateful) {
    const w = r.outcome.capturedAt;
    if (
      r.outcome.status === "blocked" ||
      r.outcome.status === "manual" ||
      w === null
    )
      gaps.push(
        `${r.cid} was not captured (${r.outcome.status}); its state at capture time is unknown, so no single recovery point can be claimed.`,
      );
    else windows.push({ start: Date.parse(w.start), end: Date.parse(w.end) });
    const invariants = r.outcome.details["invariants"];
    const unstable = Array.isArray(invariants)
      ? (
          invariants as { id: string; stable_during_capture: boolean | null }[]
        ).filter((i) => i.stable_during_capture === false)
      : [];
    if (unstable.length > 0)
      gaps.push(
        `${r.cid}: invariants changed while the dump ran (${unstable.map((i) => i.id).join(", ")}), so the database was being written to during capture.`,
      );
  }
  if (windows.length === 0)
    return { strategy, window: null, classification: "unknown", gaps };
  const start = Math.min(...windows.map((w) => w.start));
  const end = Math.max(...windows.map((w) => w.end));
  const window = {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
  if (gaps.length > 0)
    return { strategy, window, classification: "unknown", gaps };
  if (end - start > windowMs)
    return {
      strategy,
      window,
      classification: "inconsistent",
      gaps: [
        `Data and asset captures spanned ${end - start} ms, longer than the ${windowMs} ms window required for a single recovery point.`,
      ],
    };
  return { strategy, window, classification: "single_point", gaps };
};

const aggregateDependencies = (
  outs: readonly CollectorOutcome[],
): Manifest["dependencies"] => {
  const deps: Manifest["dependencies"] = {
    runtimes: [],
    package_managers: [],
    container_images: [],
    registries: [],
    system_packages: [],
  };
  const registries = new Map<
    string,
    Manifest["dependencies"]["registries"][number]
  >();
  for (const d of outs.flatMap((o) =>
    o.dependencies ? [o.dependencies] : [],
  )) {
    deps.runtimes.push(...(d.runtimes ?? []));
    deps.package_managers.push(...(d.package_managers ?? []));
    deps.container_images.push(...(d.container_images ?? []));
    deps.system_packages.push(...(d.system_packages ?? []));
    for (const r of d.registries ?? []) {
      const ex = registries.get(r.url);
      registries.set(r.url, {
        url: r.url,
        required_for: unique([...(ex?.required_for ?? []), ...r.required_for]),
        credentials_required:
          (ex?.credentials_required ?? false) || r.credentials_required,
      });
    }
  }
  deps.registries = [...registries.values()];
  deps.container_images = deps.container_images.filter(
    (img, i, all) =>
      all.findIndex((x) => x.ref === img.ref && x.digest === img.digest) === i,
  );
  return deps;
};

const missingOrBlocked = (
  results: readonly ComponentResult[],
  redact: (text: string) => string,
): Manifest["missing_or_blocked"] => {
  const missing: Manifest["missing_or_blocked"] = [];
  for (const { cid, outcome: o } of results) {
    const manualTitles = new Set((o.manual ?? []).map((m) => m.title));
    for (const om of o.omissions) {
      const status =
        o.status === "blocked"
          ? "blocked"
          : o.status === "manual" || manualTitles.has(om.what)
            ? "manual"
            : "missing";
      missing.push({
        component_id: cid,
        status,
        reason: redact(`${om.what}: ${om.reason}`),
        remediation: redact(om.remediation),
      });
    }
    if (
      (o.status === "blocked" || o.status === "manual") &&
      o.omissions.length === 0
    )
      missing.push({
        component_id: cid,
        status: o.status,
        reason: `${o.title} was not captured (${o.status})`,
        remediation:
          "See the component's limitations and capture again once the prerequisite is met.",
      });
  }
  return missing;
};

/** Versions of the tools the collectors actually used, as reported by the tools. */
export async function toolVersions(
  rt: Runtime,
  outs: readonly CollectorOutcome[],
): Promise<Manifest["producer"]["tools"]> {
  const tools: Manifest["producer"]["tools"] = [];
  for (const name of unique(outs.flatMap((o) => o.tools ?? []))) {
    const argv = TOOL_VERSION_ARGV[name];
    if (argv === undefined) continue;
    const r = await rt.run(argv, { env: gitEnv(), timeoutMs: 15_000 });
    const line = (r.stdout.trim() || r.stderr.trim()).split("\n", 1)[0] ?? "";
    const m = /\d+(?:\.\d+)+/u.exec(line);
    tools.push({
      name,
      version: !succeeded(r)
        ? "unavailable"
        : m === null
          ? parseVersion(line)
          : line.slice(m.index),
    });
  }
  return tools;
}

/** Set every manifest-level fact on the builder from the collectors' outcomes. */
export function applyManifestFacts(
  builder: PackageBuilder,
  results: readonly ComponentResult[],
  options: {
    ctx: CollectorContext;
    plan: PreservationPlanBody;
    windowMs: number;
    now: string;
  },
): Manifest["consistency"] {
  const outs = results.map((r) => r.outcome);
  const ids = new Set(results.map((r) => r.cid));
  builder.setSourceRevisions(
    outs.flatMap((o) => (o.sourceRevision ? [o.sourceRevision] : [])),
  );
  builder.setDependencies(aggregateDependencies(outs));
  builder.setManualPrerequisites([
    ...new Map(
      outs.flatMap((o) => o.manual ?? []).map((m) => [m.id, m]),
    ).values(),
  ]);
  builder.setSecrets({
    mode: "names_only",
    names: unique(outs.flatMap((o) => o.secretNames ?? [])).sort(),
  });
  const guard = (
    pick: "blocked_hosts" | "disabled_schedules" | "disabled_webhooks",
  ): string[] => unique(outs.flatMap((o) => o.guards?.[pick] ?? [])).sort();
  builder.setRestoreGuards({
    blocked_hosts: guard("blocked_hosts"),
    disabled_schedules: guard("disabled_schedules"),
    disabled_webhooks: guard("disabled_webhooks"),
    default_network: "deny",
  });
  for (const rel of outs.flatMap((o) => o.relationships ?? []))
    if (ids.has(rel.from) && ids.has(rel.to)) builder.addRelationship(rel);

  const { plan, windowMs } = options;
  const consistency = classifyConsistency(
    results,
    windowMs,
    windowMs === DEFAULT_CONSISTENCY_WINDOW_MS &&
      plan.consistency_strategy.trim() !== ""
      ? plan.consistency_strategy
      : consistencyStrategyText(windowMs),
  );
  builder.setConsistency(consistency);
  builder.setMissingOrBlocked(
    missingOrBlocked(results, options.ctx.redactor.redactText),
  );

  const registrySteps = outs.flatMap((o) =>
    o.restoreSteps.filter((s) => s.network === "registry"),
  );
  builder.setVerification({
    scope: [],
    results: [
      {
        scope: "integrity",
        status: "captured",
        detail: "files hashed at capture",
        performed_at: options.now,
      },
    ],
    network_required: {
      verdict: registrySteps.length > 0 ? "yes" : "unknown",
      reasons:
        registrySteps.length > 0
          ? unique(outs.flatMap((o) => o.networkReasons ?? []))
          : [
              "Restore network behaviour has not been observed; the standalone verifier determines it from executed steps.",
            ],
    },
  });
  return consistency;
}
