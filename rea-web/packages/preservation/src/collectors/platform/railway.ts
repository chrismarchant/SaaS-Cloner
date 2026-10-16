import type { CommandFact } from "./command.js";
import { Node, commandAt, commandsAt } from "./reader.js";
import {
  type Extraction,
  type ExtractInput,
  type HealthFact,
  type ScheduleFact,
  type ServiceFact,
  emptyExtraction,
  emptyHealth,
  serviceName,
} from "./types.js";

/** The `build` and `deploy` sections of a Railway config, base or per environment. */
export interface RailwaySection {
  build: {
    builder: string | null;
    build_command: CommandFact | null;
    dockerfile_path: string | null;
    watch_patterns: string[];
  } | null;
  deploy: {
    start_command: CommandFact | null;
    pre_deploy_commands: CommandFact[];
    healthcheck_path: string | null;
    healthcheck_timeout_seconds: number | null;
    cron_schedule: string | null;
    restart_policy_type: string | null;
    restart_policy_max_retries: number | null;
    num_replicas: number | null;
    region: string | null;
    multi_region: { region: string; num_replicas: number | null }[];
    sleep_application: boolean | null;
  } | null;
}

const readBuild = (node: Node): RailwaySection["build"] => {
  const build = node.obj("build");
  if (build === undefined) return null;
  return {
    builder: build.str("builder") ?? null,
    build_command: commandAt(build, "buildCommand") ?? null,
    dockerfile_path: build.str("dockerfilePath") ?? null,
    watch_patterns: build.strList("watchPatterns") ?? [],
  };
};

const readMultiRegion = (
  deploy: Node,
): { region: string; num_replicas: number | null }[] => {
  const regions = deploy.children("multiRegionConfig") ?? [];
  return regions
    .map(({ name, node }) => ({
      region: name,
      num_replicas: node.num("numReplicas") ?? null,
    }))
    .sort((a, b) => (a.region < b.region ? -1 : 1));
};

const readDeploy = (node: Node): RailwaySection["deploy"] => {
  const deploy = node.obj("deploy");
  if (deploy === undefined) return null;
  return {
    start_command: commandAt(deploy, "startCommand") ?? null,
    pre_deploy_commands: commandsAt(deploy, "preDeployCommand"),
    healthcheck_path: deploy.str("healthcheckPath") ?? null,
    healthcheck_timeout_seconds: deploy.num("healthcheckTimeout") ?? null,
    cron_schedule: deploy.str("cronSchedule") ?? null,
    restart_policy_type: deploy.str("restartPolicyType") ?? null,
    restart_policy_max_retries: deploy.num("restartPolicyMaxRetries") ?? null,
    num_replicas: deploy.num("numReplicas") ?? null,
    region: deploy.str("region") ?? null,
    multi_region: readMultiRegion(deploy),
    sleep_application: deploy.bool("sleepApplication") ?? null,
  };
};

export const readRailwaySection = (node: Node): RailwaySection => ({
  build: readBuild(node),
  deploy: readDeploy(node),
});

export interface RailwayDocument {
  schema: string | null;
  base: RailwaySection;
  environments: { name: string; section: RailwaySection }[];
}

/** Railway's JSON and TOML share one schema: `build`, `deploy` and `environments.<name>`. */
export const readRailway = (root: Node): RailwayDocument => ({
  schema: root.str("$schema") ?? null,
  base: readRailwaySection(root),
  environments: (root.children("environments") ?? [])
    .map(({ name, node }) => ({ name, section: readRailwaySection(node) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1)),
});

export const railwayHealth = (section: RailwaySection): HealthFact | null => {
  const deploy = section.deploy;
  if (deploy === null || deploy.healthcheck_path === null) return null;
  return {
    ...emptyHealth(),
    kind: "http",
    path: deploy.healthcheck_path,
    timeout_seconds: deploy.healthcheck_timeout_seconds,
  };
};

export const railwaySchedule = (
  section: RailwaySection,
  name: string,
): ScheduleFact | null => {
  const cron = section.deploy?.cron_schedule ?? null;
  if (cron === null) return null;
  return {
    name,
    cron,
    command: section.deploy?.start_command ?? null,
    http_path: null,
  };
};

const settingsOf = (section: RailwaySection): Record<string, unknown> => {
  const d = section.deploy;
  return {
    builder: section.build?.builder ?? null,
    dockerfile_path: section.build?.dockerfile_path ?? null,
    watch_patterns: section.build?.watch_patterns ?? [],
    pre_deploy_commands: d?.pre_deploy_commands ?? [],
    restart_policy_type: d?.restart_policy_type ?? null,
    restart_policy_max_retries: d?.restart_policy_max_retries ?? null,
    num_replicas: d?.num_replicas ?? null,
    multi_region: d?.multi_region ?? [],
    sleep_application: d?.sleep_application ?? null,
  };
};

const regionsOf = (section: RailwaySection): string[] => {
  const d = section.deploy;
  if (d === null) return [];
  const names = d.multi_region.map((r) => r.region);
  return d.region === null || names.includes(d.region)
    ? names
    : [d.region, ...names];
};

export function extractRailway(input: ExtractInput): Extraction {
  const out = emptyExtraction();
  const root = Node.root(input.doc, input.audit);
  if (root === null) {
    out.limitations.push("The document is not an object; nothing was read.");
    return out;
  }
  const doc = readRailway(root);
  const name = serviceName("railway", input.dir);
  out.parsed = {
    schema: doc.schema,
    build: doc.base.build,
    deploy: doc.base.deploy,
    environments: Object.fromEntries(
      doc.environments.map((e) => [e.name, e.section]),
    ),
  };
  const deploy = doc.base.deploy;
  const service: ServiceFact = {
    name,
    kind:
      deploy?.cron_schedule === undefined || deploy.cron_schedule === null
        ? "service"
        : "cron",
    build_command: doc.base.build?.build_command ?? null,
    start_command: deploy?.start_command ?? null,
    dir: input.dir,
    health_check: railwayHealth(doc.base),
    region: deploy?.region ?? null,
    regions: regionsOf(doc.base),
    volumes: [],
    depends_on: [],
    settings: {
      ...settingsOf(doc.base),
      environment_overrides: doc.environments.map((e) => e.name),
    },
  };
  out.services.push(service);
  const base = railwaySchedule(doc.base, `${name}:cron`);
  if (base !== null) out.schedules.push(base);
  for (const env of doc.environments) {
    const schedule = railwaySchedule(env.section, `${name}:cron@${env.name}`);
    if (schedule !== null) out.schedules.push(schedule);
  }
  if (doc.environments.length > 0)
    out.limitations.push(
      "Environment overrides are recorded but only the base configuration becomes services and restore steps.",
    );
  return out;
}
