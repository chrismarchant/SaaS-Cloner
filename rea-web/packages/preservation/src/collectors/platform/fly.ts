import { commandFact } from "./command.js";
import { Node, isEnvName } from "./reader.js";
import {
  type Extraction,
  type ExtractInput,
  type HealthFact,
  type ServiceFact,
  type VolumeFact,
  emptyExtraction,
  emptyHealth,
  serviceName,
} from "./types.js";

interface FlyCheck {
  health: HealthFact;
  processes: string[];
}

interface FlyListener {
  source: "http_service" | "services";
  internal_port: number | null;
  protocol: string | null;
  processes: string[];
  ports: {
    port: number | null;
    handlers: string[];
    force_https: boolean | null;
  }[];
  force_https: boolean | null;
  auto_stop_machines: string | null;
  auto_start_machines: boolean | null;
  min_machines_running: number | null;
}

const readCheck = (
  node: Node,
  kind: "http" | "tcp",
  processes: string[],
): FlyCheck => ({
  processes,
  health: {
    ...emptyHealth(),
    kind,
    path: node.str("path") ?? null,
    method: node.str("method") ?? null,
    protocol: node.str("protocol") ?? null,
    interval: node.text("interval") ?? null,
    timeout: node.text("timeout") ?? null,
    grace_period: node.text("grace_period") ?? null,
  },
});

const readListener = (
  node: Node,
  source: FlyListener["source"],
): FlyListener => ({
  source,
  internal_port: node.num("internal_port") ?? null,
  protocol: node.str("protocol") ?? null,
  processes: node.strList("processes") ?? [],
  ports: (node.objList("ports") ?? []).map((p) => ({
    port: p.num("port") ?? null,
    handlers: p.strList("handlers") ?? [],
    force_https: p.bool("force_https") ?? null,
  })),
  force_https: node.bool("force_https") ?? null,
  auto_stop_machines: node.text("auto_stop_machines") ?? null,
  auto_start_machines: node.bool("auto_start_machines") ?? null,
  min_machines_running: node.num("min_machines_running") ?? null,
});

interface FlyChecks {
  listeners: FlyListener[];
  checks: FlyCheck[];
}

const readNetwork = (root: Node): FlyChecks => {
  const listeners: FlyListener[] = [];
  const checks: FlyCheck[] = [];
  const http = root.obj("http_service");
  if (http !== undefined) {
    const listener = readListener(http, "http_service");
    listeners.push(listener);
    for (const c of http.objList("checks") ?? [])
      checks.push(readCheck(c, "http", listener.processes));
  }
  for (const svc of root.objList("services") ?? []) {
    const listener = readListener(svc, "services");
    listeners.push(listener);
    for (const c of svc.objList("http_checks") ?? [])
      checks.push(readCheck(c, "http", listener.processes));
    for (const c of svc.objList("tcp_checks") ?? [])
      checks.push(readCheck(c, "tcp", listener.processes));
  }
  for (const { node } of root.children("checks") ?? [])
    checks.push(
      readCheck(node, node.str("type") === "tcp" ? "tcp" : "http", []),
    );
  return { listeners, checks };
};

interface FlyMount {
  volume: VolumeFact;
  processes: string[];
}

const readMounts = (root: Node): FlyMount[] =>
  (root.objList("mounts") ?? []).map((m) => ({
    processes: m.strList("processes") ?? [],
    volume: {
      name: m.str("source") ?? "",
      mount_path: m.str("destination") ?? null,
      size_gb: null,
      initial_size: m.text("initial_size") ?? null,
    },
  }));

const appliesTo = (processes: readonly string[], group: string): boolean =>
  processes.length === 0 || processes.includes(group);

const readEnvNames = (root: Node): { name: string; key: string }[] =>
  (root.names("env") ?? [])
    .filter(isEnvName)
    .map((name) => ({ name, key: `env.${name}` }));

const readBuild = (root: Node): Record<string, unknown> | null => {
  const build = root.obj("build");
  if (build === undefined) return null;
  return {
    builder: build.str("builder") ?? null,
    buildpacks: build.strList("buildpacks") ?? [],
    image: build.str("image") ?? null,
    dockerfile: build.str("dockerfile") ?? null,
    ignorefile: build.str("ignorefile") ?? null,
    arg_names: build.names("args") ?? [],
  };
};

const readVm = (root: Node): Record<string, unknown>[] =>
  (root.objList("vm") ?? []).map((v) => ({
    size: v.str("size") ?? null,
    memory: v.text("memory") ?? null,
    cpus: v.num("cpus") ?? null,
    cpu_kind: v.str("cpu_kind") ?? null,
    memory_mb: v.num("memory_mb") ?? null,
    processes: v.strList("processes") ?? [],
  }));

const readDeploy = (root: Node): Record<string, unknown> | null => {
  const deploy = root.obj("deploy");
  if (deploy === undefined) return null;
  const release = deploy.str("release_command");
  return {
    release_command: release === undefined ? null : commandFact(release),
    strategy: deploy.str("strategy") ?? null,
    max_unavailable: deploy.text("max_unavailable") ?? null,
    release_command_timeout: deploy.text("release_command_timeout") ?? null,
  };
};

interface FlyApp {
  base: string;
  primaryRegion: string | null;
  processes: Record<string, string>;
  network: FlyChecks;
  mounts: FlyMount[];
  dir: string;
}

/** One service per process group; without [processes] the whole app is one `app` group. */
const flyServices = (app: FlyApp): ServiceFact[] => {
  const groups = Object.keys(app.processes);
  const named =
    groups.length === 0
      ? [{ group: "app", name: app.base }]
      : groups.map((g) => ({ group: g, name: `${app.base}:${g}` }));
  return named.map(({ group, name }) => {
    const text = app.processes[group];
    return {
      name,
      kind: group === "app" || group === "web" ? "web" : "worker",
      build_command: null,
      start_command: text === undefined ? null : commandFact(text),
      dir: app.dir,
      health_check:
        app.network.checks.find((c) => appliesTo(c.processes, group))?.health ??
        null,
      region: app.primaryRegion,
      regions: app.primaryRegion === null ? [] : [app.primaryRegion],
      volumes: app.mounts
        .filter((m) => appliesTo(m.processes, group))
        .map((m) => m.volume),
      depends_on: [],
      settings: {
        process_group: group,
        listeners: app.network.listeners.filter((l) =>
          appliesTo(l.processes, group),
        ),
      },
    };
  });
};

export function extractFly(input: ExtractInput): Extraction {
  const out = emptyExtraction();
  const root = Node.root(input.doc, input.audit);
  if (root === null) {
    out.limitations.push("The document is not an object; nothing was read.");
    return out;
  }
  const appName = root.str("app") ?? null;
  const primaryRegion = root.str("primary_region") ?? null;
  const processes = root.strMap("processes") ?? {};
  const network = readNetwork(root);
  const mounts = readMounts(root);
  const envNames = readEnvNames(root);
  out.parsed = {
    app: appName,
    primary_region: primaryRegion,
    kill_signal: root.str("kill_signal") ?? null,
    kill_timeout: root.text("kill_timeout") ?? null,
    console_command: root.str("console_command") ?? null,
    build: readBuild(root),
    env_names: envNames.map((e) => e.name),
    processes: Object.fromEntries(
      Object.entries(processes).map(([k, v]) => [k, commandFact(v)]),
    ),
    http_service:
      network.listeners.find((l) => l.source === "http_service") ?? null,
    services: network.listeners.filter((l) => l.source === "services"),
    checks: network.checks.map((c) => ({
      ...c.health,
      processes: c.processes,
    })),
    mounts: mounts.map((m) => ({ ...m.volume, processes: m.processes })),
    deploy: readDeploy(root),
    vm: readVm(root),
  };
  out.env_names = envNames;
  out.services = flyServices({
    base: appName ?? serviceName("fly", input.dir),
    primaryRegion,
    processes,
    network,
    mounts,
    dir: input.dir,
  });
  out.limitations.push(
    "[env] values are not recorded; only the variable names are. Secrets set with 'fly secrets' are not part of fly.toml.",
  );
  return out;
}
