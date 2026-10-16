import { commandAt, Node, isEnvName, urlFact, httpHost } from "./reader.js";
import {
  type Extraction,
  type ExtractInput,
  type ScheduleFact,
  type UrlFact,
  emptyExtraction,
  serviceName,
} from "./types.js";

/** Absolute http(s) destinations of rewrites and redirects: upstream hosts of the app. */
export const destinationUrls = (
  nodes: readonly Node[],
  key: string,
): UrlFact[] =>
  nodes.flatMap((n) => {
    const raw = n.str(key);
    if (raw === undefined) return [];
    const fact = urlFact(raw);
    return httpHost(fact) === null ? [] : [fact];
  });

const readFunctions = (root: Node) =>
  (root.children("functions") ?? []).map(({ name, node }) => ({
    pattern: name,
    regions: node.strList("regions") ?? [],
    memory: node.num("memory") ?? null,
    max_duration: node.num("maxDuration") ?? null,
    runtime: node.str("runtime") ?? null,
  }));

export function extractVercel(input: ExtractInput): Extraction {
  const out = emptyExtraction();
  const root = Node.root(input.doc, input.audit);
  if (root === null) {
    out.limitations.push("The document is not an object; nothing was read.");
    return out;
  }
  const buildCommand = commandAt(root, "buildCommand") ?? null;
  const installCommand = commandAt(root, "installCommand") ?? null;
  const functions = readFunctions(root);
  const regions = [
    ...new Set([
      ...(root.strList("regions") ?? []),
      ...functions.flatMap((f) => f.regions),
    ]),
  ].sort();
  const crons = (root.objList("crons") ?? []).flatMap((c) => {
    const path = c.str("path");
    const schedule = c.str("schedule");
    return path === undefined || schedule === undefined
      ? []
      : [{ path, schedule }];
  });
  const rewrites = root.objList("rewrites") ?? [];
  const redirects = root.objList("redirects") ?? [];
  const headers = root.objList("headers") ?? [];
  const envNames = [
    ...(root.names("env") ?? []).map((name) => ({ name, key: `env.${name}` })),
    ...(root.obj("build")?.names("env") ?? []).map((name) => ({
      name,
      key: `build.env.${name}`,
    })),
  ].filter((e) => isEnvName(e.name));
  const hosts = [
    ...destinationUrls(rewrites, "destination"),
    ...destinationUrls(redirects, "destination"),
  ];
  for (const rule of [...rewrites, ...redirects, ...headers]) rule.counted();
  out.parsed = {
    schema: root.str("$schema") ?? null,
    name: root.str("name") ?? null,
    framework: root.str("framework") ?? null,
    build_command: buildCommand,
    install_command: installCommand,
    dev_command: commandAt(root, "devCommand") ?? null,
    output_directory: root.str("outputDirectory") ?? null,
    regions,
    functions,
    crons,
    rewrites: { count: rewrites.length },
    redirects: { count: redirects.length },
    headers: { count: headers.length },
    env_names: envNames.map((e) => e.name),
    external_destinations: hosts,
  };
  out.hosts = hosts;
  out.env_names = envNames;
  const name = serviceName("vercel", input.dir);
  out.services.push({
    name,
    kind: "web",
    build_command: buildCommand,
    start_command: null,
    dir: input.dir,
    health_check: null,
    region: null,
    regions,
    volumes: [],
    depends_on: [],
    settings: {
      framework: root.str("framework") ?? null,
      output_directory: root.str("outputDirectory") ?? null,
      install_command: installCommand,
    },
  });
  out.schedules = crons.map((c): ScheduleFact => ({
    name: `${name}:cron:${c.path}`,
    cron: c.schedule,
    command: null,
    http_path: c.path,
  }));
  out.limitations.push(
    "Rewrite, redirect and header rules are counted, not itemised; absolute rewrite and redirect destinations are recorded as hosts.",
  );
  return out;
}
