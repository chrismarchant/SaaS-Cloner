import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Redactor, RestoreStep } from "@rea-web/contracts";
import {
  type InfrastructureDescriptor,
  infrastructureDescriptorSchema,
  parseDescriptor,
} from "../descriptors.js";
import {
  type CaptureRuntime,
  type CollectorOutcome,
  type Runtime,
  blockedOutcome,
  emptyOutcome,
} from "../runtime.js";
import {
  type ComponentDeclaration,
  type ComponentPlan,
  type Omission,
  componentId,
} from "../types.js";
import { type PlatformMerge, mergePlatform } from "./platform/merge.js";
import { scanPlatformConfig } from "./platform/scan.js";
import type { PlatformScan } from "./platform/types.js";
import {
  type TreeEntry,
  componentRoot,
  hostnamesIn,
  jsonText,
  listTree,
  stepOf,
  unique,
  writeStaged,
} from "../util.js";

type InfraDecl = Extract<ComponentDeclaration, { kind: "infrastructure" }>;

const ENV_NAME = "([A-Z_][A-Z0-9_]*)";
const CODE_PATTERNS: RegExp[] = [
  new RegExp(String.raw`process\.env\.${ENV_NAME}`, "gu"),
  new RegExp(String.raw`process\.env\[\s*["']${ENV_NAME}["']\s*\]`, "gu"),
  new RegExp(String.raw`import\.meta\.env\.${ENV_NAME}`, "gu"),
  new RegExp(String.raw`Deno\.env\.get\(\s*["']${ENV_NAME}["']`, "gu"),
  new RegExp(String.raw`os\.environ\[\s*["']${ENV_NAME}["']\s*\]`, "gu"),
  new RegExp(String.raw`os\.environ\.get\(\s*["']${ENV_NAME}["']`, "gu"),
  new RegExp(String.raw`os\.getenv\(\s*["']${ENV_NAME}["']`, "gu"),
  new RegExp(String.raw`os\.(?:Getenv|LookupEnv)\(\s*"${ENV_NAME}"`, "gu"),
  new RegExp(String.raw`ENV(?:\[\s*|\.fetch\(\s*)["']${ENV_NAME}["']`, "gu"),
  new RegExp(String.raw`env::var\(\s*"${ENV_NAME}"`, "gu"),
  new RegExp(String.raw`getenv\(\s*["']${ENV_NAME}["']`, "gu"),
  new RegExp(String.raw`\$_ENV\[\s*["']${ENV_NAME}["']`, "gu"),
];
const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|php|java|kt)$/u;
const ENV_EXAMPLE =
  /^(?:\.env\.(?:.+\.)?(?:example|sample|template)|(?:example|sample)\.env)$/u;
const PLATFORM_FILES = new Set([
  "railway.json",
  "railway.toml",
  "fly.toml",
  "vercel.json",
  "netlify.toml",
  "Procfile",
  "render.yaml",
  "app.json",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yaml",
  "compose.yml",
  "nixpacks.toml",
  "heroku.yml",
  "serverless.yml",
]);

export interface EnvNameSource {
  kind:
    | "declared"
    | "secret_ref"
    | "code"
    | "env_example"
    | "dockerfile"
    | "data_connection"
    | "platform_config";
  file?: string;
  store?: string;
  /** Where in the file the name appears (platform configuration only). */
  key?: string;
}

export interface SourceScan {
  names: Map<string, EnvNameSource[]>;
  platformFiles: string[];
  scanned: number;
  truncated: boolean;
}

const addName = (
  map: Map<string, EnvNameSource[]>,
  name: string,
  source: EnvNameSource,
): void => {
  const list = map.get(name) ?? [];
  if (
    list.length < 6 &&
    !list.some(
      (s) =>
        s.kind === source.kind &&
        s.file === source.file &&
        s.key === source.key,
    )
  )
    list.push(source);
  map.set(name, list);
};

const readSmall = async (f: TreeEntry): Promise<string | null> => {
  if (f.size > 1024 * 1024) return null;
  try {
    return await readFile(f.abs, "utf8");
  } catch {
    return null;
  }
};

/** Environment variable NAMES used by the source; values are never read into the result. */
export async function scanEnvNames(files: TreeEntry[]): Promise<SourceScan> {
  const scan: SourceScan = {
    names: new Map(),
    platformFiles: [],
    scanned: 0,
    truncated: false,
  };
  for (const f of files) {
    const name = basename(f.rel);
    if (PLATFORM_FILES.has(name)) scan.platformFiles.push(f.rel);
    const isDocker =
      name === "Dockerfile" ||
      name.startsWith("Dockerfile.") ||
      name.endsWith(".Dockerfile");
    if (!CODE_EXT.test(name) && !ENV_EXAMPLE.test(name) && !isDocker) continue;
    if (scan.scanned >= 20_000) {
      scan.truncated = true;
      break;
    }
    const text = await readSmall(f);
    if (text === null) continue;
    scan.scanned += 1;
    if (ENV_EXAMPLE.test(name)) {
      for (const m of text.matchAll(
        /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/gmu,
      ))
        addName(scan.names, m[1] as string, {
          kind: "env_example",
          file: f.rel,
        });
    } else if (isDocker) {
      for (const m of text.matchAll(/^\s*ARG\s+([A-Z_][A-Z0-9_]*)/gmu))
        addName(scan.names, m[1] as string, {
          kind: "dockerfile",
          file: f.rel,
        });
      for (const line of text.matchAll(/^\s*ENV\s+(.+)$/gmu))
        for (const m of (line[1] as string).matchAll(
          /(?:^|\s)([A-Z_][A-Z0-9_]*)=/gu,
        ))
          addName(scan.names, m[1] as string, {
            kind: "dockerfile",
            file: f.rel,
          });
      for (const m of text.matchAll(/^\s*ENV\s+([A-Z_][A-Z0-9_]*)\s+\S/gmu))
        addName(scan.names, m[1] as string, {
          kind: "dockerfile",
          file: f.rel,
        });
    } else {
      for (const pattern of CODE_PATTERNS)
        for (const m of text.matchAll(pattern))
          addName(scan.names, m[1] as string, { kind: "code", file: f.rel });
    }
  }
  return scan;
}

export async function plan(
  decl: InfraDecl,
  rt: Runtime,
): Promise<ComponentPlan> {
  const parsed = parseDescriptor(
    infrastructureDescriptorSchema,
    decl.descriptor,
  );
  const source = rt.build.components.find((c) => c.kind === "source");
  const omissions: Omission[] = [];
  return {
    id: componentId(decl),
    kind: "infrastructure",
    collector: "infrastructure",
    permissions: [
      {
        check: "descriptor valid",
        ok: parsed.ok,
        detail: parsed.ok
          ? `${parsed.value.services.length} services, ${parsed.value.schedules.length} schedules, ${parsed.value.behavior_checks.length} behavior checks`
          : parsed.issues.join("; "),
      },
    ],
    estimated_bytes: null,
    dependencies: source === undefined ? [] : [componentId(source)],
    method:
      "descriptor validation, env-name scan and platform-config parse of the captured checkout",
    omissions:
      source === undefined
        ? [
            {
              what: "Detected environment variable names",
              reason:
                "No source component is declared, so the checkout cannot be scanned.",
              remediation: "Declare a source component.",
            },
          ]
        : omissions,
    feasible: parsed.ok,
  };
}

const withSourceCwd = (rt: Runtime, srcId: string | null): string =>
  srcId === null ? "{{target}}" : `{{target}}/${srcId}`;

interface FilesInput {
  stage: string;
  root: string;
  redactor: Redactor;
  descriptor: InfrastructureDescriptor;
  platform: PlatformMerge;
  detectedPlatformConfig: string[];
  names: { name: string; sources: EnvNameSource[] }[];
}

/** User-descriptor entries are tagged so platform-config entries can sit beside them. */
const FROM_DESCRIPTOR = { source: "descriptor", confidence: "declared" };

async function writeFiles(input: FilesInput): Promise<void> {
  const { descriptor: d, platform } = input;
  const j = (rel: string, value: unknown) =>
    writeStaged(
      input.stage,
      `${input.root}${rel}`,
      jsonText(value, input.redactor),
    );
  await j("services.json", {
    services: [
      ...d.services.map((s) => ({ ...s, ...FROM_DESCRIPTOR })),
      ...platform.services,
    ],
    conflicts: platform.conflicts,
    detected_platform_config: input.detectedPlatformConfig,
  });
  await j("env-names.json", {
    note: "Names only. Values are never exported.",
    names: input.names,
  });
  await j("schedules.json", {
    schedules: [
      ...d.schedules.map((x) => ({ ...x, ...FROM_DESCRIPTOR })),
      ...platform.schedules,
    ],
  });
  await j("domains.json", { domains: d.domains });
  await j("health.json", {
    checks: [
      ...d.services
        .filter((s) => s.health_check !== null)
        .map((s) => ({
          service: s.name,
          ...s.health_check,
          ...FROM_DESCRIPTOR,
        })),
      ...platform.health,
    ],
  });
  await j("behavior-checks.json", { checks: d.behavior_checks });
  if (platform.platformJson !== null)
    await j("platform.json", platform.platformJson);
}

function restoreSteps(
  d: InfrastructureDescriptor,
  platformSteps: RestoreStep[],
  sourceCwd: string,
): RestoreStep[] {
  const steps: RestoreStep[] = [];
  for (const s of d.services)
    if (s.build_command !== null)
      steps.push(
        stepOf({
          id: `infra-${s.name}-build`.replace(/[^A-Za-z0-9_-]/gu, "_"),
          title: `Build service ${s.name}`,
          run: s.build_command,
          cwd: sourceCwd,
          requires: [s.build_command[0] as string],
          network: "none",
          scope: "clean_build",
        }),
      );
  steps.push(...platformSteps);
  for (const c of d.behavior_checks)
    steps.push(
      stepOf({
        id: `behavior-${c.id}`.replace(/[^A-Za-z0-9_.-]/gu, "_"),
        title: c.title,
        run: c.run,
        cwd: c.cwd === "source" ? sourceCwd : "{{package_root}}",
        requires: [c.run[0] as string],
        network: "none",
        scope: "behavior",
      }),
    );
  return steps;
}

export async function capture(
  decl: InfraDecl,
  rt: CaptureRuntime,
): Promise<CollectorOutcome> {
  const cid = componentId(decl);
  const root = componentRoot(rt.build, decl);
  const base = {
    title: `Infrastructure (${decl.id})`,
    method:
      "declared descriptor + env-name scan and platform-config parse of captured checkout",
    root,
  };
  const parsed = parseDescriptor(
    infrastructureDescriptorSchema,
    decl.descriptor,
  );
  if (!parsed.ok)
    return blockedOutcome(base, {
      what: "Infrastructure descriptor",
      reason: `descriptor failed validation: ${parsed.issues.join("; ")}`,
      remediation:
        "Correct the descriptor fields named above and capture again.",
    });
  const d: InfrastructureDescriptor = parsed.value;
  const start = rt.now();
  const omissions: Omission[] = [];
  const limitations: string[] = [
    "Only names of environment variables and secrets are recorded; values are never captured by default.",
    "Environment variable names found by scanning source are heuristic (static text patterns) and may be incomplete or include names that are never set.",
    "Behavior-check exit expectations and timeouts are in behavior-checks.json; restore steps carry only the command.",
  ];
  const co = await rt.checkout(null);
  let scan: SourceScan = {
    names: new Map(),
    platformFiles: [],
    scanned: 0,
    truncated: false,
  };
  let platformScan: PlatformScan = { files: [], unread: [] };
  if (co.ok) {
    const tree = await listTree(co.dir);
    scan = await scanEnvNames(tree.files);
    platformScan = await scanPlatformConfig(tree, {
      redact: (text) => rt.ctx.redactor.redactText(text),
    });
    if (scan.truncated)
      limitations.push("Environment-name scan stopped after 20000 files.");
  } else
    omissions.push({
      what: "Environment variable names detected from source",
      reason: co.reason,
      remediation: co.remediation,
    });

  const stage = await rt.stageDir(cid);
  const srcInfo = co.ok
    ? { declId: co.sourceDeclId, componentId: co.sourceComponentId }
    : ([...rt.sources.values()][0] ?? null);
  const srcDeclId = srcInfo?.declId ?? null;
  const sourceCwd = withSourceCwd(rt, srcDeclId);
  const platform = mergePlatform({
    cid,
    scan: platformScan,
    descriptor: d,
    sourceCwd,
    redact: (text) => rt.ctx.redactor.redactText(text),
  });
  omissions.push(...platform.omissions);
  limitations.push(...platform.limitations);
  const handled = new Set(platformScan.files.map((f) => f.path));
  const unparsedFormats = scan.platformFiles.filter((f) => !handled.has(f));
  if (unparsedFormats.length > 0)
    limitations.push(
      `Platform files detected but not interpreted (no parser for this format): ${unparsedFormats.join(", ")}.`,
    );

  const names = new Map(scan.names);
  for (const n of d.env_names) addName(names, n, { kind: "declared" });
  for (const e of platform.envNames) addName(names, e.name, e.source);
  for (const s of d.secret_refs)
    addName(names, s.name, { kind: "secret_ref", store: s.store });
  for (const c of rt.build.components)
    if (c.kind === "data")
      addName(names, c.connection_env_name, { kind: "data_connection" });
  const nameList = [...names.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, sources]) => ({ name, sources }));

  await writeFiles({
    stage,
    root,
    redactor: rt.ctx.redactor,
    descriptor: d,
    platform,
    detectedPlatformConfig: scan.platformFiles,
    names: nameList,
  });

  const steps = restoreSteps(d, platform.steps, sourceCwd);

  const hosts = unique([
    ...d.domains.map((x) => x.host.toLowerCase()),
    ...hostnamesIn(decl.descriptor),
    ...platform.blockedHosts,
  ]);
  const outcome = emptyOutcome(base);
  return {
    ...outcome,
    status: omissions.length > 0 ? "partial" : "captured",
    limitations,
    omissions,
    restoreSteps: steps,
    capturedAt: { start: start.toISOString(), end: rt.now().toISOString() },
    stageDir: stage,
    secretNames: nameList.map((n) => n.name),
    manual: platform.manual,
    guards: {
      blocked_hosts: hosts,
      disabled_schedules: unique([
        ...d.schedules.map((s) => s.name),
        ...platform.scheduleNames,
      ]),
    },
    relationships:
      srcInfo === null
        ? []
        : [{ from: cid, to: srcInfo.componentId, kind: "depends_on" }],
    details: {
      services: d.services.length,
      schedules: d.schedules.length,
      domains: d.domains.map((x) => x.host),
      env_names: nameList.length,
      env_names_from_source: scan.names.size,
      secret_refs: d.secret_refs.map((s) => ({ name: s.name, store: s.store })),
      behavior_checks: d.behavior_checks.map((c) => c.id),
      detected_platform_config: scan.platformFiles,
      platform_config: platform.details,
      env_values_exported: false,
    },
  };
}
