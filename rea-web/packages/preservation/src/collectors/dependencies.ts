import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { type RestoreStep, validateRelativePath } from "@rea-web/contracts";
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
import {
  type TreeEntry,
  hostOf,
  jsonText,
  listTree,
  redactUrl,
  stepOf,
  unique,
  urlUserinfo,
  writeStaged,
} from "../util.js";

type DepsDecl = Extract<ComponentDeclaration, { kind: "dependencies" }>;
type Manifest = import("@rea-web/contracts").RecoveryManifest;

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "go.sum",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
]);
const isLockfile = (name: string): boolean =>
  LOCKFILE_NAMES.has(name) || /^requirements.*\.txt$/u.test(name);

const MANAGER_BY_LOCKFILE: Record<string, string> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "poetry.lock": "poetry",
  "Pipfile.lock": "pipenv",
  "uv.lock": "uv",
  "go.sum": "go",
  "Cargo.lock": "cargo",
  "Gemfile.lock": "bundler",
  "composer.lock": "composer",
};
const managerOf = (name: string): string | null =>
  /^requirements.*\.txt$/u.test(name)
    ? "pip"
    : (MANAGER_BY_LOCKFILE[name] ?? null);

const DEFAULT_REGISTRY: Record<string, string> = {
  npm: "https://registry.npmjs.org/",
  pnpm: "https://registry.npmjs.org/",
  yarn: "https://registry.npmjs.org/",
  pip: "https://pypi.org/simple/",
  poetry: "https://pypi.org/simple/",
  pipenv: "https://pypi.org/simple/",
  uv: "https://pypi.org/simple/",
  cargo: "https://index.crates.io/",
  go: "https://proxy.golang.org/",
  bundler: "https://rubygems.org/",
  composer: "https://repo.packagist.org/",
};

const readText = async (
  path: string,
  max = 2 * 1024 * 1024,
): Promise<string | null> => {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > max) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
};

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#")) ?? "";

export interface RuntimeFinding {
  name: string;
  version: string;
  source: string;
}

async function findRuntimes(files: TreeEntry[]): Promise<RuntimeFinding[]> {
  const out: RuntimeFinding[] = [];
  const add = (name: string, version: string, source: string): void => {
    if (version !== "") out.push({ name, version, source });
  };
  for (const f of files.slice(0)) {
    const name = basename(f.rel);
    if (out.length > 400) break;
    switch (name) {
      case ".nvmrc":
      case ".node-version": {
        const t = await readText(f.abs, 4096);
        if (t !== null) add("node", firstLine(t).replace(/^v/u, ""), f.rel);
        break;
      }
      case ".python-version": {
        const t = await readText(f.abs, 4096);
        if (t !== null) add("python", firstLine(t), f.rel);
        break;
      }
      case ".ruby-version": {
        const t = await readText(f.abs, 4096);
        if (t !== null) add("ruby", firstLine(t), f.rel);
        break;
      }
      case ".tool-versions": {
        const t = await readText(f.abs, 65536);
        for (const line of (t ?? "").split("\n")) {
          const m = /^\s*([A-Za-z0-9_.-]+)\s+([^\s#]+)/u.exec(line);
          if (m !== null) add(m[1] as string, m[2] as string, f.rel);
        }
        break;
      }
      case "package.json": {
        const t = await readText(f.abs);
        try {
          const pkg = JSON.parse(t ?? "null") as Record<string, unknown> | null;
          const engines = pkg?.["engines"];
          if (engines !== null && typeof engines === "object")
            for (const [k, v] of Object.entries(engines))
              if (typeof v === "string") add(k, v, `${f.rel}#engines`);
        } catch {
          // not parseable: no runtime recorded from it
        }
        break;
      }
      case "go.mod": {
        const t = await readText(f.abs, 262144);
        const m = /^go\s+(\S+)/mu.exec(t ?? "");
        if (m !== null) add("go", m[1] as string, f.rel);
        break;
      }
      case "rust-toolchain":
      case "rust-toolchain.toml": {
        const t = await readText(f.abs, 65536);
        const m = /channel\s*=\s*["']([^"']+)["']/u.exec(t ?? "");
        add("rust", m?.[1] ?? firstLine(t ?? ""), f.rel);
        break;
      }
      default:
    }
  }
  return out;
}

interface PackageManagerPin {
  name: string;
  version: string | null;
}
async function packageManagerPins(
  files: TreeEntry[],
): Promise<Map<string, PackageManagerPin>> {
  const pins = new Map<string, PackageManagerPin>();
  for (const f of files) {
    if (basename(f.rel) !== "package.json") continue;
    try {
      const pkg = JSON.parse((await readText(f.abs)) ?? "null") as {
        packageManager?: unknown;
      } | null;
      const m =
        typeof pkg?.packageManager === "string"
          ? /^([a-z]+)@([^+]+)/u.exec(pkg.packageManager)
          : null;
      if (m !== null)
        pins.set(posix.dirname(f.rel), {
          name: m[1] as string,
          version: m[2] as string,
        });
    } catch {
      // ignore unparseable package.json
    }
  }
  return pins;
}

interface ImageFinding {
  ref: string;
  digest: string | null;
  source: string;
  note: string | null;
}

export const parseImageRef = (
  raw: string,
): { ref: string; digest: string | null } => {
  const at = raw.indexOf("@");
  if (at < 0) return { ref: raw, digest: null };
  const digest = raw.slice(at + 1);
  return {
    ref: raw.slice(0, at),
    digest: /^sha256:[0-9a-f]{64}$/u.test(digest) ? digest : null,
  };
};

export const imagesFromDockerfile = (
  text: string,
  source: string,
): ImageFinding[] => {
  const stages = new Set<string>();
  const found: ImageFinding[] = [];
  const logical = text.replace(/\\\r?\n/gu, " ").split("\n");
  for (const line of logical) {
    const m = /^\s*FROM\s+(?:--[^\s]+\s+)*(\S+)(?:\s+AS\s+(\S+))?/iu.exec(line);
    if (m === null) continue;
    const image = m[1] as string;
    if (m[2] !== undefined) stages.add(m[2].toLowerCase());
    if (image.toLowerCase() === "scratch" || stages.has(image.toLowerCase())) {
      if (m[2] !== undefined) stages.add(m[2].toLowerCase());
      continue;
    }
    const { ref, digest } = parseImageRef(image);
    found.push({
      ref,
      digest,
      source,
      note: image.includes("$")
        ? "reference uses a build argument and is resolved at build time"
        : digest === null
          ? "not pinned by digest; the image behind this tag can change"
          : null,
    });
  }
  return found;
};

type Family = "npm" | "pip";
const familyOf = (manager: string): Family | null =>
  ["npm", "pnpm", "yarn"].includes(manager)
    ? "npm"
    : ["pip", "poetry", "pipenv", "uv"].includes(manager)
      ? "pip"
      : null;

interface RegistryFinding {
  family: Family;
  url: string;
  required_for: Set<string>;
  credentials_required: boolean;
}

const parseNpmrc = (text: string, source: string): RegistryFinding[] => {
  const authHosts = new Set<string>();
  let globalAuth = false;
  const urls: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/gu, "");
    if (/(^|:)registry$/u.test(key)) urls.push(value);
    else if (
      /_(authToken|auth|password)$/u.test(key) ||
      key.endsWith(":username")
    ) {
      if (key.startsWith("//"))
        authHosts.add(key.slice(2).split(/[/:]/u)[0]?.toLowerCase() ?? "");
      else globalAuth = true;
    }
  }
  return urls.map((u) => ({
    family: "npm" as const,
    url: redactUrl(u),
    required_for: new Set([`npm-family installs (${source})`]),
    credentials_required:
      urlUserinfo(u) !== null ||
      authHosts.has(hostOf(u) ?? "\0") ||
      (globalAuth && authHosts.size === 0),
  }));
};

const parseYarnrc = (text: string, source: string): RegistryFinding[] => {
  const creds = /npmAuth(Token|Ident)\s*:/u.test(text);
  const urls = [
    ...text.matchAll(/npmRegistryServer\s*:\s*["']?([^\s"']+)/gu),
  ].map((m) => m[1] as string);
  return urls.map((u) => ({
    family: "npm" as const,
    url: redactUrl(u),
    required_for: new Set([`yarn installs (${source})`]),
    credentials_required: creds || urlUserinfo(u) !== null,
  }));
};

/** `--index-url` / `-i` / `--extra-index-url` options inside a requirements file. */
const parseRequirementsIndexes = (
  text: string,
  source: string,
): RegistryFinding[] =>
  [
    ...text.matchAll(/^\s*(?:--index-url|--extra-index-url|-i)[=\s]+(\S+)/gmu),
  ].map((m) => ({
    family: "pip" as const,
    url: redactUrl(m[1] as string),
    required_for: new Set([`pip installs (${source})`]),
    credentials_required: urlUserinfo(m[1] as string) !== null,
  }));

const parsePipConf = (text: string, source: string): RegistryFinding[] =>
  [...text.matchAll(/^\s*(?:extra-)?index-url\s*[=:]\s*(\S+)/gmu)].map((m) => ({
    family: "pip" as const,
    url: redactUrl(m[1] as string),
    required_for: new Set([`pip installs (${source})`]),
    credentials_required: urlUserinfo(m[1] as string) !== null,
  }));

async function findRegistries(files: TreeEntry[]): Promise<RegistryFinding[]> {
  const found: RegistryFinding[] = [];
  for (const f of files) {
    const name = basename(f.rel);
    if (/^requirements.*\.txt$/u.test(name)) {
      const text = await readText(f.abs, 262144);
      if (text !== null) found.push(...parseRequirementsIndexes(text, f.rel));
    } else if (
      name === ".npmrc" ||
      name === ".yarnrc.yml" ||
      name === ".yarnrc" ||
      name === "pip.conf" ||
      name === "pip.ini"
    ) {
      const text = await readText(f.abs, 262144);
      if (text === null) continue;
      if (name === ".npmrc") found.push(...parseNpmrc(text, f.rel));
      else if (name === ".yarnrc.yml") found.push(...parseYarnrc(text, f.rel));
      else if (name === ".yarnrc")
        found.push(
          ...[...text.matchAll(/^\s*registry\s+"?([^\s"]+)/gmu)].map((m) => ({
            family: "npm" as const,
            url: redactUrl(m[1] as string),
            required_for: new Set([`yarn installs (${f.rel})`]),
            credentials_required: urlUserinfo(m[1] as string) !== null,
          })),
        );
      else found.push(...parsePipConf(text, f.rel));
    }
  }
  return found;
}

export async function plan(
  decl: DepsDecl,
  rt: Runtime,
): Promise<ComponentPlan> {
  const source = rt.build.components.find((c) => c.kind === "source");
  return {
    id: componentId(decl),
    kind: "dependencies",
    collector: "dependencies",
    permissions: [
      {
        check: "source component declared",
        ok: source !== undefined,
        detail:
          source === undefined
            ? "declare a source component; dependencies are read from its captured checkout"
            : `reads lockfiles from ${componentId(source)}`,
      },
    ],
    estimated_bytes: null,
    dependencies: source === undefined ? [] : [componentId(source)],
    method:
      "scan captured checkout for lockfiles, toolchain pins, container images and registries",
    omissions: [
      {
        what: "Dependency payloads (packages, base image layers)",
        reason:
          "Lockfiles and image digests are recorded; the packages themselves are not vendored.",
        remediation:
          "Keep the package registries and container registry reachable at restore time, or vendor dependencies into the repository.",
      },
    ],
    feasible: source !== undefined,
  };
}

interface LockEntry {
  rel: string;
  dir: string;
  name: string;
}

const restoreStepFor = (
  lock: LockEntry,
  srcId: string,
  index: number,
  yarnBerry: boolean,
): RestoreStep | null => {
  const cwd =
    lock.dir === "."
      ? `{{target}}/${srcId}`
      : `{{target}}/${srcId}/${lock.dir}`;
  const common = {
    cwd,
    network: "registry" as const,
    scope: "clean_build" as const,
  };
  const id = `deps-${index}`;
  switch (managerOf(lock.name)) {
    case "npm":
      return stepOf({
        ...common,
        id,
        title: `Install npm dependencies in ${lock.dir} from ${lock.name}`,
        run: ["npm", "ci", "--ignore-scripts"],
        requires: ["npm"],
      });
    case "pnpm":
      return stepOf({
        ...common,
        id,
        title: `Install pnpm dependencies in ${lock.dir}`,
        run: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
        requires: ["pnpm"],
      });
    case "yarn":
      return stepOf({
        ...common,
        id,
        title: `Install yarn dependencies in ${lock.dir}`,
        run: yarnBerry
          ? ["yarn", "install", "--immutable", "--mode=skip-build"]
          : ["yarn", "install", "--frozen-lockfile", "--ignore-scripts"],
        requires: ["yarn"],
      });
    case "pip":
      return lock.name === "requirements.txt"
        ? stepOf({
            ...common,
            id,
            title: `Install Python requirements in ${lock.dir}`,
            run: [
              "python3",
              "-m",
              "pip",
              "install",
              "--no-input",
              "-r",
              "requirements.txt",
            ],
            requires: ["python3"],
          })
        : null;
    default:
      return null;
  }
};

export async function capture(
  decl: DepsDecl,
  rt: CaptureRuntime,
): Promise<CollectorOutcome> {
  const cid = componentId(decl);
  const root = `dependencies/${decl.id}/`;
  const base = {
    title: `Dependencies (${decl.id})`,
    method:
      "lockfile, toolchain and registry inventory of the captured checkout",
    root,
  };
  const start = rt.now();
  const co = await rt.checkout(null);
  if (!co.ok)
    return blockedOutcome(base, {
      what: "Dependency inventory",
      reason: co.reason,
      remediation: co.remediation,
    });
  const tree = await listTree(co.dir);
  const stage = await rt.stageDir(cid);
  const omissions: Omission[] = [];
  const limitations: string[] = [
    "Dependency payloads are not vendored: package registries (and any container registry) must be reachable to rebuild. Vendoring dependencies into the package is not implemented.",
  ];

  // Lockfiles.
  const locks: LockEntry[] = [];
  const wanted = new Map<string, TreeEntry>();
  for (const f of tree.files)
    if (isLockfile(basename(f.rel))) wanted.set(f.rel, f);
  for (const declared of decl.lockfiles) {
    const v = validateRelativePath(declared);
    const hit = v.ok ? tree.files.find((f) => f.rel === v.path) : undefined;
    if (hit !== undefined) wanted.set(hit.rel, hit);
    else
      omissions.push({
        what: `Declared lockfile ${declared}`,
        reason: "not present in the captured source checkout",
        remediation: "Commit the lockfile or correct the declared path.",
      });
  }
  const redacted: string[] = [];
  for (const f of [...wanted.values()].sort((a, b) =>
    a.rel < b.rel ? -1 : 1,
  )) {
    rt.ctx.signal.throwIfAborted();
    const dest = `${root}lockfiles/${f.rel}`;
    const text =
      f.size <= 64 * 1024 * 1024
        ? await readText(f.abs, 64 * 1024 * 1024)
        : null;
    const scrubbed = text === null ? null : rt.ctx.redactor.redactText(text);
    if (text !== null && scrubbed !== null && scrubbed !== text) {
      await writeStaged(stage, dest, scrubbed);
      redacted.push(f.rel);
    } else {
      const abs = join(stage, ...dest.split("/"));
      await mkdir(dirname(abs), { recursive: true });
      await copyFile(f.abs, abs);
    }
    locks.push({
      rel: f.rel,
      dir: posix.dirname(f.rel),
      name: basename(f.rel),
    });
  }
  if (redacted.length > 0)
    limitations.push(
      `Credential-like transport secrets were removed from: ${redacted.join(", ")}; the stored copy differs from the repository file.`,
    );
  if (locks.length === 0)
    limitations.push(
      "No lockfile was found in the captured source; builds cannot be reproduced to exact dependency versions.",
    );

  // Toolchain, images, registries.
  const runtimes = await findRuntimes(tree.files);
  const pins = await packageManagerPins(tree.files);
  const managers = new Map<
    string,
    Manifest["dependencies"]["package_managers"][number]
  >();
  for (const l of locks) {
    const name = managerOf(l.name);
    if (name === null) continue;
    const key = `${name}:${l.dir}`;
    if (managers.has(key)) continue;
    const pin = pins.get(l.dir) ?? pins.get(".");
    managers.set(key, {
      name,
      version: pin?.name === name ? pin.version : null,
      lockfile: l.rel,
    });
  }
  const images: ImageFinding[] = [];
  for (const f of tree.files) {
    const n = basename(f.rel);
    if (
      n === "Dockerfile" ||
      n.startsWith("Dockerfile.") ||
      n.endsWith(".Dockerfile")
    ) {
      const t = await readText(f.abs);
      if (t !== null) images.push(...imagesFromDockerfile(t, f.rel));
    }
  }
  for (const declared of decl.container_images) {
    const { ref, digest } = parseImageRef(declared);
    images.push({
      ref,
      digest,
      source: "declared",
      note:
        digest === null
          ? "not pinned by digest; the image behind this tag can change"
          : null,
    });
  }
  for (const i of unique(
    images
      .filter((x) => x.note !== null)
      .map((x) => `${x.ref} (${x.source}): ${x.note}`),
  ))
    limitations.push(`Container image ${i}`);

  const registries = new Map<string, RegistryFinding>();
  const addRegistry = (r: RegistryFinding): void => {
    const existing = registries.get(r.url);
    if (existing === undefined)
      registries.set(r.url, { ...r, required_for: new Set(r.required_for) });
    else {
      for (const x of r.required_for) existing.required_for.add(x);
      existing.credentials_required ||= r.credentials_required;
    }
  };
  const configured = await findRegistries(tree.files);
  configured.forEach(addRegistry);
  for (const name of unique([...managers.values()].map((m) => m.name))) {
    const url = DEFAULT_REGISTRY[name];
    const family = familyOf(name);
    const overridden =
      family !== null && configured.some((c) => c.family === family);
    if (url !== undefined && !overridden)
      addRegistry({
        family: familyOf(name) ?? "npm",
        url,
        required_for: new Set([`${name} installs`]),
        credentials_required: false,
      });
  }
  const registryList = [...registries.values()].map((r) => ({
    url: r.url,
    required_for: [...r.required_for].sort(),
    credentials_required: r.credentials_required,
  }));
  if (registryList.some((r) => r.credentials_required))
    limitations.push(
      "At least one registry requires credentials. They are not stored in this package; supply your own at restore time.",
    );

  // Restore steps.
  const steps: RestoreStep[] = [];
  let n = 0;
  for (const l of locks) {
    const yarnBerry =
      tree.files.some(
        (f) =>
          f.rel === (l.dir === "." ? ".yarnrc.yml" : `${l.dir}/.yarnrc.yml`),
      ) || tree.files.some((f) => f.rel === ".yarnrc.yml");
    const step = restoreStepFor(l, co.sourceDeclId, n, yarnBerry);
    if (step !== null) {
      steps.push({
        ...step,
        id: `${step.id}-${cid.replace(/[^A-Za-z0-9_-]/gu, "_")}`,
      });
      n += 1;
    } else
      limitations.push(
        `No automated install step for ${l.rel} (${managerOf(l.name) ?? "unknown"} manager).`,
      );
  }

  await writeStaged(
    stage,
    `${root}inventory.json`,
    jsonText(
      {
        source_component: co.sourceComponentId,
        source_head_sha: co.headSha,
        lockfiles: locks.map((l) => l.rel),
        runtimes,
        package_managers: [...managers.values()],
        container_images: images.map((i) => ({
          ref: i.ref,
          digest: i.digest,
          source: i.source,
          pinned: i.digest !== null,
        })),
        registries: registryList,
        vendored: false,
      },
      rt.ctx.redactor,
    ),
  );

  const sourceDecl = co.sourceComponentId;
  const outcome = emptyOutcome(base);
  return {
    ...outcome,
    status: omissions.length > 0 ? "partial" : "captured",
    limitations,
    omissions,
    restoreSteps: steps,
    capturedAt: { start: start.toISOString(), end: rt.now().toISOString() },
    stageDir: stage,
    relationships: [{ from: cid, to: sourceDecl, kind: "depends_on" }],
    dependencies: {
      runtimes,
      package_managers: [...managers.values()],
      container_images: images.map((i) => ({ ref: i.ref, digest: i.digest })),
      registries: registryList,
    },
    networkReasons: [
      ...steps.map(
        (s) =>
          `${s.id}: ${s.run.slice(0, 2).join(" ")} contacts the package registry`,
      ),
      ...(registryList.length > 0
        ? [`registries needed: ${registryList.map((r) => r.url).join(", ")}`]
        : []),
      ...(images.length > 0
        ? ["container images must be pulled from their registries"]
        : []),
    ],
    details: {
      lockfiles: locks.map((l) => l.rel),
      lockfiles_redacted: redacted,
      runtimes: runtimes.length,
      package_managers: [...managers.values()].map((m) => m.name),
      container_images: images.length,
      registries: registryList.map((r) => r.url),
      vendored: false,
      network_required_reason:
        "package registries remain necessary; dependencies were not vendored",
      scan_truncated: tree.truncated,
    },
  };
}
