import type { RestoreStep } from "@rea-web/contracts";
import type { InfrastructureDescriptor } from "../../descriptors.js";
import type { Omission } from "../../types.js";
import { isLoopbackHost, safeSegment, stepOf } from "../../util.js";
import { type CommandFact, stepVerdict } from "./command.js";
import { type ManualItem, supabasePrerequisites } from "./guidance.js";
import { httpHost } from "./reader.js";
import { RAILWAY_IAC_LIMITATION } from "./scan.js";
import type {
  HealthFact,
  PlatformFile,
  PlatformScan,
  ScheduleFact,
  ServiceFact,
} from "./types.js";

type DescriptorService = InfrastructureDescriptor["services"][number];

export interface PlatformEnvName {
  name: string;
  source: { kind: "platform_config"; file: string; key: string };
}

export interface ServiceConflict {
  service: string;
  field: "build_command" | "start_command" | "region" | "health_check_path";
  descriptor: string;
  platform: string;
  platform_source: string;
  resolution: string;
}

export type BuildRestore =
  | { kind: "none" }
  | { kind: "step"; step_id: string }
  | { kind: "manual"; reason: string; detail: string | null }
  | { kind: "covered_by_descriptor" }
  | { kind: "conflict_with_descriptor" };

export interface PlatformMerge {
  services: Record<string, unknown>[];
  conflicts: ServiceConflict[];
  schedules: Record<string, unknown>[];
  health: Record<string, unknown>[];
  envNames: PlatformEnvName[];
  steps: RestoreStep[];
  manual: ManualItem[];
  omissions: Omission[];
  limitations: string[];
  blockedHosts: string[];
  scheduleNames: string[];
  /** Body of platform.json, or null when the checkout had no platform file. */
  platformJson: Record<string, unknown> | null;
  details: Record<string, unknown>;
}

export interface MergeInput {
  /** Component id, for manual prerequisite ids. */
  cid: string;
  scan: PlatformScan;
  descriptor: InfrastructureDescriptor;
  /** Restore-step working directory of the captured source. */
  sourceCwd: string;
  redact: (text: string) => string;
}

const DECLARED = "declared" as const;
const PACKAGE_INSTALLERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "pip",
  "pip3",
  "poetry",
  "uv",
  "bundle",
  "cargo",
  "go",
  "composer",
]);
const INSTALL_VERBS = new Set(["install", "ci", "add", "sync", "fetch", "get"]);

const sourceOf = (file: PlatformFile): string => `platform-config:${file.path}`;

const compact = (value: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null));

const commandFields = (key: string, fact: CommandFact | null) => ({
  [key]: fact?.argv ?? null,
  [`${key}_text`]: fact?.text ?? null,
  [`${key}_issue`]: fact?.issue ?? null,
});

const normalizedText = (text: string): string =>
  text.trim().replace(/\s+/gu, " ");

const networkFor = (argv: readonly string[]): RestoreStep["network"] =>
  PACKAGE_INSTALLERS.has(argv[0] ?? "") && INSTALL_VERBS.has(argv[1] ?? "")
    ? "registry"
    : "none";

function detectConflicts(
  desc: DescriptorService,
  service: ServiceFact,
  source: string,
): ServiceConflict[] {
  const out: ServiceConflict[] = [];
  const note = (
    field: ServiceConflict["field"],
    descriptor: string,
    platform: string,
  ): void => {
    if (normalizedText(descriptor) !== normalizedText(platform))
      out.push({
        service: desc.name,
        field,
        descriptor,
        platform,
        platform_source: source,
        resolution:
          "Both values are kept; the user descriptor was not changed and wins for restore steps.",
      });
  };
  if (desc.build_command !== null && service.build_command !== null)
    note(
      "build_command",
      desc.build_command.join(" "),
      service.build_command.text,
    );
  if (desc.start_command !== null && service.start_command !== null)
    note(
      "start_command",
      desc.start_command.join(" "),
      service.start_command.text,
    );
  if (desc.region !== null && service.region !== null)
    note("region", desc.region, service.region);
  if (
    desc.health_check?.path !== undefined &&
    service.health_check?.path != null
  )
    note(
      "health_check_path",
      desc.health_check.path,
      service.health_check.path,
    );
  return out;
}

class Merger {
  readonly out: PlatformMerge = {
    services: [],
    conflicts: [],
    schedules: [],
    health: [],
    envNames: [],
    steps: [],
    manual: [],
    omissions: [],
    limitations: [],
    blockedHosts: [],
    scheduleNames: [],
    platformJson: null,
    details: {},
  };
  private readonly stepIds = new Set<string>();

  constructor(private readonly input: MergeInput) {}

  private stepId(base: string): string {
    const clean = base.replace(/[^A-Za-z0-9_-]/gu, "_");
    let id = clean;
    for (let n = 2; this.stepIds.has(id); n += 1) id = `${clean}-${n}`;
    this.stepIds.add(id);
    return id;
  }

  private cwdFor(dir: string): string {
    return dir === "" ? this.input.sourceCwd : `${this.input.sourceCwd}/${dir}`;
  }

  /** Decide what a service's build command becomes: a restore step, a manual prerequisite, or nothing. */
  private planBuild(
    file: PlatformFile,
    service: ServiceFact,
    desc: DescriptorService | undefined,
  ): BuildRestore {
    const fact = service.build_command;
    if (fact === null) return { kind: "none" };
    if (desc?.build_command != null) {
      return normalizedText(desc.build_command.join(" ")) ===
        normalizedText(fact.text)
        ? { kind: "covered_by_descriptor" }
        : { kind: "conflict_with_descriptor" };
    }
    const id = this.stepId(`platform-${file.platform}-${service.name}-build`);
    const title = `Build ${service.name} (${sourceOf(file)})`;
    const cwd = this.cwdFor(service.dir);
    const verdict = stepVerdict(fact, { id, title, cwd, scope: "clean_build" });
    if (!verdict.ok) {
      this.stepIds.delete(id);
      this.out.manual.push(this.buildManual(file, service, fact, verdict));
      return { kind: "manual", reason: verdict.reason, detail: verdict.detail };
    }
    const argv = fact.argv as string[];
    this.out.steps.push(
      stepOf({
        id,
        title,
        run: argv,
        cwd,
        requires: [argv[0] as string],
        network: networkFor(argv),
        scope: "clean_build",
      }),
    );
    return { kind: "step", step_id: id };
  }

  private buildManual(
    file: PlatformFile,
    service: ServiceFact,
    fact: CommandFact,
    verdict: { reason: string; detail: string | null },
  ): ManualItem {
    const where = service.dir === "" ? "the repository root" : service.dir;
    return {
      id: `${this.input.cid}:platform-build-${safeSegment(`${file.path}-${service.name}`)}`,
      title: `Run the ${service.name} build by hand`,
      reason: this.input.redact(
        `The build command in ${file.path} was not turned into a restore step: ${verdict.reason}${verdict.detail === null ? "" : ` (${verdict.detail})`}.`,
      ),
      instructions: this.input.redact(
        `On the restored source, in ${where}, run this command verbatim in a shell you trust, with outbound network limited to what the build needs: ${fact.text}`,
      ),
      component_id: this.input.cid,
    };
  }

  private conflictManual(
    file: PlatformFile,
    service: ServiceFact,
    conflict: ServiceConflict,
  ): ManualItem {
    return {
      id: `${this.input.cid}:platform-conflict-${safeSegment(`${file.path}-${service.name}`)}`,
      title: `Choose the ${service.name} build command`,
      reason: this.input.redact(
        `The user descriptor and ${file.path} declare different build commands for ${service.name}. Only the descriptor's command is a restore step.`,
      ),
      instructions: this.input.redact(
        `Descriptor: ${conflict.descriptor}. Platform configuration: ${conflict.platform}. Decide which one reflects the build, and run the other by hand if it matters.`,
      ),
      component_id: this.input.cid,
    };
  }

  private addService(file: PlatformFile, service: ServiceFact): void {
    const desc = this.input.descriptor.services.find(
      (d) => d.name.toLowerCase() === service.name.toLowerCase(),
    );
    const conflicts =
      desc === undefined ? [] : detectConflicts(desc, service, sourceOf(file));
    this.out.conflicts.push(...conflicts);
    const buildRestore = this.planBuild(file, service, desc);
    const buildConflict = conflicts.find((c) => c.field === "build_command");
    if (buildConflict !== undefined)
      this.out.manual.push(this.conflictManual(file, service, buildConflict));
    this.out.services.push({
      name: service.name,
      kind: service.kind,
      ...commandFields("build_command", service.build_command),
      ...commandFields("start_command", service.start_command),
      health_check:
        service.health_check === null ? null : compact(service.health_check),
      region: service.region,
      regions: service.regions,
      volumes: service.volumes,
      depends_on: service.depends_on,
      platform: file.platform,
      config_dir: service.dir,
      settings: service.settings,
      build_restore: buildRestore,
      source: sourceOf(file),
      confidence: DECLARED,
    });
    if (service.health_check !== null)
      this.out.health.push(
        this.healthEntry(file, service.name, service.health_check),
      );
  }

  private healthEntry(
    file: PlatformFile,
    service: string,
    health: HealthFact,
  ): Record<string, unknown> {
    return {
      service,
      ...compact(health),
      source: sourceOf(file),
      confidence: DECLARED,
    };
  }

  private addSchedule(file: PlatformFile, schedule: ScheduleFact): void {
    this.out.schedules.push({
      name: schedule.name,
      cron: schedule.cron,
      ...commandFields("command", schedule.command),
      http_path: schedule.http_path,
      source: sourceOf(file),
      confidence: DECLARED,
    });
    this.out.scheduleNames.push(schedule.name);
  }

  private addFile(file: PlatformFile): void {
    if (file.status === "unparsed") {
      this.out.omissions.push({
        what: `Platform configuration ${file.path}`,
        reason: `${file.platform} file could not be parsed (${this.input.redact(file.parse_error ?? "unknown error")}); nothing was inferred from it.`,
        remediation:
          "Fix the file so that it parses (an unmodified copy is in the source component) and capture again.",
      });
      return;
    }
    if (file.platform === "railway" && file.status === "present") {
      this.out.limitations.push(RAILWAY_IAC_LIMITATION);
      this.out.manual.push({
        id: `${this.input.cid}:platform-railway-iac-${safeSegment(file.path)}`,
        title: "Evaluate the Railway TypeScript infrastructure-as-code",
        reason: `${file.path} defines Railway infrastructure in TypeScript. It was detected but not executed, so the services, variables and domains it defines are not recorded.`,
        instructions:
          "In the restore environment, against a Railway project you own (never production), run `railway config plan` against the file and review the plan before applying anything.",
        component_id: this.input.cid,
      });
      return;
    }
    const x = file.extraction;
    if (x === null) return;
    this.out.limitations.push(...x.limitations);
    for (const s of x.services) this.addService(file, s);
    for (const s of x.schedules) this.addSchedule(file, s);
    for (const e of x.env_names)
      this.out.envNames.push({
        name: e.name,
        source: { kind: "platform_config", file: file.path, key: e.key },
      });
    for (const u of x.hosts) {
      const host = httpHost(u);
      if (host !== null && !isLoopbackHost(host))
        this.out.blockedHosts.push(host);
    }
    if (x.supabase !== null)
      this.out.manual.push(
        ...supabasePrerequisites(this.input.cid, x.supabase),
      );
  }

  run(): PlatformMerge {
    const { scan } = this.input;
    for (const file of scan.files) this.addFile(file);
    for (const u of scan.unread)
      this.out.omissions.push({
        what: `Platform configuration ${u.path}`,
        reason: `not read: ${u.reason}`,
        remediation:
          "Replace the link with the file itself in the source and capture again.",
      });
    if (scan.files.length > 0)
      this.out.limitations.push(
        "Service working directories are the directory of each config file; root-directory settings made in a platform dashboard are not visible.",
      );
    this.out.limitations = [...new Set(this.out.limitations)];
    this.out.blockedHosts = [...new Set(this.out.blockedHosts)].sort();
    this.out.platformJson = this.platformJson();
    this.out.details = this.details();
    return this.out;
  }

  private platformJson(): Record<string, unknown> | null {
    const { scan } = this.input;
    if (scan.files.length === 0 && scan.unread.length === 0) return null;
    return {
      note: "Facts read from platform configuration files in the captured source with format-aware parsers. Nothing was executed and no platform API was called. 'declared' facts come from a file the platform reads; 'inferred' facts record presence only.",
      files: scan.files.map((f) => ({
        platform: f.platform,
        path: f.path,
        sha256: f.sha256,
        confidence: f.confidence,
        status: f.status,
        parsed: f.parsed,
        unknown_keys: f.unknown_keys,
        limitations: f.limitations,
        parse_error: f.parse_error,
      })),
      unread: scan.unread,
    };
  }

  private details(): Record<string, unknown> {
    const { scan } = this.input;
    return {
      files: scan.files.map((f) => ({
        platform: f.platform,
        path: f.path,
        sha256: f.sha256,
        status: f.status,
      })),
      services: this.out.services.length,
      conflicts: this.out.conflicts.length,
      shell_build_commands: this.out.manual.filter((m) =>
        m.id.includes(":platform-build-"),
      ).length,
      unknown_keys: scan.files.reduce((n, f) => n + f.unknown_keys.length, 0),
    };
  }
}

/** Combine platform-config facts with the user descriptor; neither overwrites the other. */
export const mergePlatform = (input: MergeInput): PlatformMerge =>
  new Merger(input).run();
