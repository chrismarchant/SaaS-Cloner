import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type ManifestComponent,
  type ManifestFile,
  type RecoveryManifest,
  recoveryManifestSchema,
} from "@rea-web/contracts";
import { PackageFormatError } from "./errors.js";
import {
  LICENSES_FILE,
  MANIFEST_FILE,
  compareCodepoints,
  isInsideOrEqual,
  openRegularFile,
  requireRelativePath,
  writeFileAtomic,
} from "./fsutil.js";
import {
  PACKAGE_COMPONENT_ID,
  findManifestProblems,
  isReservedPath,
  pathPlacementProblem,
  serializeJson,
} from "./layout.js";
import { writeGeneratedFiles } from "./generated.js";

type Manifest = RecoveryManifest;
export type ComponentInput = Omit<ManifestComponent, "entries" | "bytes">;
export type FileBody = Readable | Uint8Array | string;
export interface FileOptions {
  mediaType?: string;
}
export interface FinalizeMeta {
  packageId?: string;
  build: Manifest["build"];
  producer: Manifest["producer"];
  createdAt?: string;
}

export interface PackageBuilder {
  /** Absolute staging directory created by `createPackageBuilder`. */
  readonly root: string;
  addFile(
    componentId: string,
    relativePath: string,
    body: FileBody,
    opts?: FileOptions,
  ): Promise<ManifestFile>;
  copyFile(
    componentId: string,
    relativePath: string,
    sourceAbsolutePath: string,
    opts?: FileOptions,
  ): Promise<ManifestFile>;
  addComponent(component: ComponentInput): void;
  setSourceRevisions(revs: Manifest["source_revisions"]): void;
  setDependencies(dependencies: Manifest["dependencies"]): void;
  setManualPrerequisites(items: Manifest["manual_prerequisites"]): void;
  setSecrets(secrets: Manifest["secrets"]): void;
  setConsistency(consistency: Manifest["consistency"]): void;
  setVerification(verification: Manifest["verification"]): void;
  setMissingOrBlocked(items: Manifest["missing_or_blocked"]): void;
  setRestoreGuards(guards: Manifest["restore_guards"]): void;
  addRelationship(relationship: Manifest["relationships"][number]): void;
  /** Declare the detached signature; must be called before `finalize`. */
  setSignature(signature: NonNullable<Manifest["signature"]>): void;
  /** Declare how the export will be encrypted (key location is always external). */
  setEncryption(encryption: NonNullable<Manifest["encryption"]>): void;
  /** Third-party notices written to licenses/README.md at finalize. */
  setLicenses(text: string): void;
  finalize(meta: FinalizeMeta): Promise<Manifest>;
}

const EMPTY_STATE = {
  source_revisions: [] as Manifest["source_revisions"],
  dependencies: {
    runtimes: [],
    package_managers: [],
    container_images: [],
    registries: [],
    system_packages: [],
  } as Manifest["dependencies"],
  manual_prerequisites: [] as Manifest["manual_prerequisites"],
  secrets: { mode: "names_only", names: [] } as Manifest["secrets"],
  consistency: {
    strategy: "unspecified",
    window: null,
    classification: "unknown",
    gaps: [],
  } as Manifest["consistency"],
  verification: {
    scope: [],
    results: [],
    network_required: { verdict: "unknown", reasons: [] },
  } as Manifest["verification"],
  missing_or_blocked: [] as Manifest["missing_or_blocked"],
  restore_guards: {
    blocked_hosts: [],
    disabled_schedules: [],
    disabled_webhooks: [],
    default_network: "deny",
  } as Manifest["restore_guards"],
};

const toChunks = (body: FileBody): AsyncIterable<Uint8Array> => {
  if (typeof body === "string" || body instanceof Uint8Array) {
    const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    return (async function* () {
      yield buf;
    })();
  }
  return body as AsyncIterable<Uint8Array>;
};

class Builder implements PackageBuilder {
  readonly root: string;
  private readonly components: ComponentInput[] = [];
  private readonly files = new Map<string, ManifestFile>();
  private readonly claimed = new Set<string>();
  private readonly state = structuredClone(EMPTY_STATE);
  private relationships: Manifest["relationships"] = [];
  private signature: Manifest["signature"];
  private encryption: Manifest["encryption"];
  private licenses: string | undefined;
  private phase: "open" | "closed" = "open";

  constructor(root: string) {
    this.root = root;
  }

  private assertOpen(): void {
    if (this.phase !== "open")
      throw new PackageFormatError("builder is already finalized");
  }

  addComponent(component: ComponentInput): void {
    this.assertOpen();
    if (component.id === PACKAGE_COMPONENT_ID)
      throw new PackageFormatError(
        `component id ${PACKAGE_COMPONENT_ID} is reserved for package-level files`,
      );
    if (this.components.some((c) => c.id === component.id))
      throw new PackageFormatError(`duplicate component id ${component.id}`);
    if (component.root !== "")
      requireRelativePath(
        component.root.replace(/\/+$/u, ""),
        "component root",
      );
    this.components.push(structuredClone(component));
  }

  private claim(componentId: string, relativePath: string): string {
    const path = requireRelativePath(relativePath, "file path");
    if (isReservedPath(path, this.signature?.detached_path))
      throw new PackageFormatError(
        `${path} is written by the packager and cannot be added`,
      );
    const problem = pathPlacementProblem(path, componentId, this.components);
    if (problem !== null) throw new PackageFormatError(problem);
    const key = path.toLowerCase();
    if (this.claimed.has(key))
      throw new PackageFormatError(`duplicate file path ${path}`);
    this.claimed.add(key);
    return path;
  }

  private async record(
    componentId: string,
    relativePath: string,
    open: () => Promise<AsyncIterable<Uint8Array>>,
    opts: FileOptions | undefined,
  ): Promise<ManifestFile> {
    const path = this.claim(componentId, relativePath);
    const abs = join(this.root, ...path.split("/"));
    try {
      await mkdir(dirname(abs), { recursive: true });
      await this.assertContained(dirname(abs));
      const source = await open();
      const { sha256, size } = await writeHashed(abs, source);
      const entry: ManifestFile = {
        path,
        size,
        sha256,
        component_id: componentId,
        ...(opts?.mediaType === undefined
          ? {}
          : { media_type: opts.mediaType }),
      };
      this.files.set(path, entry);
      return entry;
    } catch (error) {
      this.claimed.delete(path.toLowerCase());
      await rm(abs, { force: true });
      throw error;
    }
  }

  private async assertContained(dir: string): Promise<void> {
    const [realRoot, realDir] = await Promise.all([
      realpath(this.root),
      realpath(dir),
    ]);
    if (!isInsideOrEqual(realRoot, realDir))
      throw new PackageFormatError(`${dir} resolves outside the staging root`);
  }

  async addFile(
    componentId: string,
    relativePath: string,
    body: FileBody,
    opts?: FileOptions,
  ): Promise<ManifestFile> {
    this.assertOpen();
    return this.record(
      componentId,
      relativePath,
      () => Promise.resolve(toChunks(body)),
      opts,
    );
  }

  async copyFile(
    componentId: string,
    relativePath: string,
    sourceAbsolutePath: string,
    opts?: FileOptions,
  ): Promise<ManifestFile> {
    this.assertOpen();
    return this.record(
      componentId,
      relativePath,
      async () => {
        const stat = await lstat(sourceAbsolutePath);
        if (stat.isSymbolicLink())
          throw new PackageFormatError(
            `refusing to copy symlink ${sourceAbsolutePath}`,
          );
        const handle = await openRegularFile(sourceAbsolutePath);
        return handle.createReadStream({ autoClose: true });
      },
      opts,
    );
  }

  setSourceRevisions(revs: Manifest["source_revisions"]): void {
    this.assertOpen();
    this.state.source_revisions = structuredClone(revs);
  }
  setDependencies(dependencies: Manifest["dependencies"]): void {
    this.assertOpen();
    this.state.dependencies = structuredClone(dependencies);
  }
  setManualPrerequisites(items: Manifest["manual_prerequisites"]): void {
    this.assertOpen();
    this.state.manual_prerequisites = structuredClone(items);
  }
  setSecrets(secrets: Manifest["secrets"]): void {
    this.assertOpen();
    this.state.secrets = structuredClone(secrets);
  }
  setConsistency(consistency: Manifest["consistency"]): void {
    this.assertOpen();
    this.state.consistency = structuredClone(consistency);
  }
  setVerification(verification: Manifest["verification"]): void {
    this.assertOpen();
    this.state.verification = structuredClone(verification);
  }
  setMissingOrBlocked(items: Manifest["missing_or_blocked"]): void {
    this.assertOpen();
    this.state.missing_or_blocked = structuredClone(items);
  }
  setRestoreGuards(guards: Manifest["restore_guards"]): void {
    this.assertOpen();
    this.state.restore_guards = structuredClone(guards);
  }
  addRelationship(relationship: Manifest["relationships"][number]): void {
    this.assertOpen();
    this.relationships.push({ ...relationship });
  }
  setSignature(signature: NonNullable<Manifest["signature"]>): void {
    this.assertOpen();
    this.signature = { ...signature };
  }
  setEncryption(encryption: NonNullable<Manifest["encryption"]>): void {
    this.assertOpen();
    this.encryption = structuredClone(encryption);
  }
  setLicenses(text: string): void {
    this.assertOpen();
    this.licenses = text;
  }

  /** Draft manifest with computed component totals; validated, not yet written. */
  private draft(meta: FinalizeMeta): Manifest {
    const files = [...this.files.values()].sort((a, b) =>
      compareCodepoints(a.path, b.path),
    );
    const components: ManifestComponent[] = this.components.map((c) => {
      const own = files.filter((f) => f.component_id === c.id);
      return {
        ...structuredClone(c),
        entries: own.length,
        bytes: own.reduce((sum, f) => sum + f.size, 0),
      };
    });
    const candidate = {
      format: "rea-web-recovery",
      format_version: 1,
      package_id: meta.packageId ?? randomUUID(),
      build: meta.build,
      created_at: meta.createdAt ?? new Date().toISOString(),
      producer: meta.producer,
      source_revisions: this.state.source_revisions,
      components,
      relationships: this.relationships,
      files,
      dependencies: this.state.dependencies,
      manual_prerequisites: this.state.manual_prerequisites,
      secrets: this.state.secrets,
      consistency: this.state.consistency,
      verification: this.state.verification,
      missing_or_blocked: this.state.missing_or_blocked,
      restore_guards: this.state.restore_guards,
      ...(this.signature === undefined ? {} : { signature: this.signature }),
      ...(this.encryption === undefined ? {} : { encryption: this.encryption }),
    };
    const parsed = recoveryManifestSchema.safeParse(candidate);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new PackageFormatError(
        `manifest failed validation at ${first?.path.join(".") || "<root>"}: ${first?.message ?? "unknown"}`,
        { cause: parsed.error },
      );
    }
    const problems = findManifestProblems(parsed.data);
    if (problems.length > 0) throw new PackageFormatError(problems.join("; "));
    return parsed.data;
  }

  async finalize(meta: FinalizeMeta): Promise<Manifest> {
    this.assertOpen();
    // Validate everything that can be validated before touching the disk.
    this.draft(meta);
    this.phase = "closed";
    try {
      if (this.licenses !== undefined) {
        const notices = this.licenses.endsWith("\n")
          ? this.licenses
          : `${this.licenses}\n`;
        await this.record(
          PACKAGE_COMPONENT_ID,
          LICENSES_FILE,
          () =>
            Promise.resolve(toChunks(`# Third-party notices\n\n${notices}`)),
          { mediaType: "text/markdown" },
        );
      }
      const manifest = this.draft(meta);
      await mkdir(join(this.root, "recovery"), { recursive: true });
      await this.assertContained(join(this.root, "recovery"));
      await writeGeneratedFiles(this.root, manifest);
      // manifest.json is written last so a partial package never has one.
      await writeFileAtomic(
        join(this.root, MANIFEST_FILE),
        serializeJson(manifest),
      );
      return manifest;
    } catch (error) {
      await rm(join(this.root, MANIFEST_FILE), { force: true });
      throw error;
    }
  }
}

async function writeHashed(
  abs: string,
  source: AsyncIterable<Uint8Array>,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  await pipeline(
    source,
    async function* (chunks: AsyncIterable<Uint8Array>) {
      for await (const chunk of chunks) {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        hash.update(buf);
        size += buf.length;
        yield buf;
      }
    },
    createWriteStream(abs, { flags: "wx", mode: 0o644 }),
  );
  return { sha256: hash.digest("hex"), size };
}

export async function createPackageBuilder(options: {
  stagingDir: string;
}): Promise<PackageBuilder> {
  const root = resolve(options.stagingDir);
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory())
      throw new PackageFormatError(`staging path ${root} is not a directory`);
    if ((await readdir(root)).length > 0)
      throw new PackageFormatError(`staging directory ${root} is not empty`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(root, { recursive: true });
  }
  return new Builder(await realpath(root));
}
