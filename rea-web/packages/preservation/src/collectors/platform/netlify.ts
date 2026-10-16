import { posix } from "node:path";
import type { CommandFact } from "./command.js";
import { Node, commandAt, isEnvName } from "./reader.js";
import {
  type EnvNameFact,
  type Extraction,
  type ExtractInput,
  type ScheduleFact,
  emptyExtraction,
  serviceName,
} from "./types.js";
import { destinationUrls } from "./vercel.js";

/** `build.base` as a directory below the config file; null when it points outside. */
const baseDir = (dir: string, base: string | undefined): string | null => {
  if (base === undefined || base === "" || base === ".") return dir;
  const joined = posix.normalize(posix.join(dir, base));
  if (posix.isAbsolute(base) || joined.startsWith("..")) return null;
  return joined === "." ? "" : joined;
};

const envNamesOf = (node: Node | undefined, prefix: string): EnvNameFact[] =>
  (node?.names("environment") ?? [])
    .filter(isEnvName)
    .map((name) => ({ name, key: `${prefix}environment.${name}` }));

interface NetlifyBuild {
  base: string | undefined;
  command: CommandFact | null;
  publish: string | null;
  env: EnvNameFact[];
  parsed: Record<string, unknown>;
}

const readBuild = (root: Node): NetlifyBuild => {
  const build = root.obj("build");
  const base = build?.str("base");
  const command =
    build === undefined ? null : (commandAt(build, "command") ?? null);
  const publish = build?.str("publish") ?? null;
  const env = envNamesOf(build, "build.");
  return {
    base,
    command,
    publish,
    env,
    parsed: {
      base: base ?? null,
      command,
      publish,
      functions: build?.str("functions") ?? null,
      edge_functions: build?.str("edge_functions") ?? null,
      env_names: env.map((e) => e.name),
    },
  };
};

const readContexts = (root: Node) =>
  (root.children("context") ?? []).map(({ name, node }) => ({
    name,
    command: commandAt(node, "command") ?? null,
    publish: node.str("publish") ?? null,
    env: envNamesOf(node, `context.${name}.`),
  }));

const readFunctions = (root: Node) => {
  const table = root.obj("functions");
  return {
    directory: table?.str("directory") ?? null,
    node_bundler: table?.str("node_bundler") ?? null,
    scheduled: (table?.subtables() ?? []).flatMap(({ name, node }) => {
      const schedule = node.str("schedule");
      return schedule === undefined ? [] : [{ name, schedule }];
    }),
  };
};

export function extractNetlify(input: ExtractInput): Extraction {
  const out = emptyExtraction();
  const root = Node.root(input.doc, input.audit);
  if (root === null) {
    out.limitations.push("The document is not an object; nothing was read.");
    return out;
  }
  const build = readBuild(root);
  const workDir = baseDir(input.dir, build.base);
  if (workDir === null)
    out.limitations.push(
      "build.base points outside the config directory and was not used as a working directory.",
    );
  const redirects = root.objList("redirects") ?? [];
  const headers = root.objList("headers") ?? [];
  const contexts = readContexts(root);
  const functions = readFunctions(root);
  const plugins = (root.objList("plugins") ?? []).flatMap(
    (p) => p.str("package") ?? [],
  );
  const hosts = destinationUrls(redirects, "to");
  for (const rule of [...redirects, ...headers]) rule.counted();
  out.parsed = {
    build: build.parsed,
    contexts: contexts.map((c) => ({
      name: c.name,
      command: c.command,
      publish: c.publish,
      env_names: c.env.map((e) => e.name),
    })),
    redirects: { count: redirects.length },
    headers: { count: headers.length },
    functions,
    plugins,
    external_destinations: hosts,
  };
  out.hosts = hosts;
  out.env_names = [...build.env, ...contexts.flatMap((c) => c.env)];
  const name = serviceName("netlify", input.dir);
  out.services.push({
    name,
    kind: "web",
    build_command: build.command,
    start_command: null,
    dir: workDir ?? input.dir,
    health_check: null,
    region: null,
    regions: [],
    volumes: [],
    depends_on: [],
    settings: { publish: build.publish },
  });
  out.schedules = functions.scheduled.map((f): ScheduleFact => ({
    name: `${name}:function:${f.name}`,
    cron: f.schedule,
    command: null,
    http_path: null,
  }));
  out.limitations.push(
    "Redirect and header rules are counted, not itemised; absolute redirect destinations are recorded as hosts.",
  );
  return out;
}
