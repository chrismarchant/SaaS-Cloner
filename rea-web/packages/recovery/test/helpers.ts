import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecoveryManifest } from "@rea-web/contracts";
import { type PackageBuilder, createPackageBuilder } from "../src/index.js";

export const PACKAGE_ID = "6f1d0b52-3c1e-4a5e-9a37-0d4a3b8c2f10";
export const CREATED_AT = "2026-03-01T12:00:00.000Z";

const tempDirs: string[] = [];

/** Fresh temp directory; removed by `cleanupTempDirs`. */
export const makeTempDir = async (label = "t"): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `rea-recovery-${label}-`));
  tempDirs.push(dir);
  return dir;
};

export const cleanupTempDirs = async (): Promise<void> => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
};

/** Deterministic pseudo-random bytes (incompressible, no RNG dependence). */
export const pseudoRandomBytes = (length: number, seed = "seed"): Buffer => {
  const parts: Buffer[] = [];
  for (let i = 0; i * 32 < length; i += 1)
    parts.push(createHash("sha256").update(`${seed}:${i}`).digest());
  return Buffer.concat(parts).subarray(0, length);
};

export const sha256 = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");

export const flipByte = async (path: string, offset: number): Promise<void> => {
  const data = await readFile(path);
  data[offset] = (data[offset] ?? 0) ^ 0xff;
  await writeFile(path, data);
};

export const BUILD = {
  id: "build-1",
  name: "Fixture Build",
  project_slug: "fixture-build",
  description: "A fixture build",
};

export const PRODUCER: RecoveryManifest["producer"] = {
  name: "rea-web",
  version: "0.1.0",
  upstream_rea: null,
  tools: [{ name: "git", version: "2.43.0" }],
};

export const SOURCE_STEP = {
  id: "clone",
  title: "Clone the repository bundle",
  run: ["git", "clone", "source/main/repo.bin", "{{target}}"],
  env_names: [],
  requires: ["git>=2.30"],
  network: "none" as const,
  scope: "clean_build" as const,
};

export const DATA_STEP = {
  id: "restore-db",
  title: "Restore the database",
  run: ["pg_restore", "--dbname", "{{database_url}}", "data/main/state.json"],
  env_names: [],
  requires: ["pg_restore"],
  network: "none" as const,
  scope: "data_restore" as const,
};

const WINDOW = {
  start: "2026-03-01T11:00:00.000Z",
  end: "2026-03-01T11:30:00.000Z",
};

export const SOURCE_BYTES = pseudoRandomBytes(2 * 1024 * 1024, "source");

export interface Fixture {
  readonly builder: PackageBuilder;
  readonly root: string;
  readonly workDir: string;
}

/** Create a builder with the two fixture components declared and files added. */
export async function stageFixture(
  options: { signature?: { keyId: string }; license?: string } = {},
): Promise<Fixture> {
  const workDir = await makeTempDir("pkg");
  const builder = await createPackageBuilder({
    stagingDir: join(workDir, "fixture-package"),
  });
  builder.addComponent({
    id: "source:main",
    kind: "source",
    title: "Source repository",
    status: "captured",
    captured_at: WINDOW,
    method: "git bundle --all",
    root: "source/main/",
    restore: { steps: [SOURCE_STEP] },
    limitations: ["Submodule payloads are not included"],
    omissions: [],
    details: {},
  });
  builder.addComponent({
    id: "data:main",
    kind: "data",
    title: "Database dump",
    status: "captured",
    captured_at: WINDOW,
    method: "pg_dump -Fc",
    root: "data/main/",
    restore: { steps: [DATA_STEP] },
    limitations: [],
    omissions: [],
    details: {},
  });
  await builder.addFile("source:main", "source/main/repo.bin", SOURCE_BYTES, {
    mediaType: "application/octet-stream",
  });
  await builder.addFile("source:main", "source/main/NOTES.txt", "hello\n");
  await builder.addFile("data:main", "data/main/state.json", '{"rows":3}\n', {
    mediaType: "application/json",
  });
  builder.setSecrets({
    mode: "names_only",
    names: ["DATABASE_URL", "STRIPE_KEY"],
  });
  builder.setRestoreGuards({
    blocked_hosts: ["db.prod.example.com"],
    disabled_schedules: ["nightly-sync"],
    disabled_webhooks: ["https://hooks.example.com/stripe"],
    default_network: "deny",
  });
  builder.setDependencies({
    runtimes: [{ name: "node", version: "22.0.0", source: ".nvmrc" }],
    package_managers: [
      { name: "npm", version: "10.0.0", lockfile: "package-lock.json" },
    ],
    container_images: [],
    registries: [
      {
        url: "https://registry.example.com",
        required_for: ["@acme/*"],
        credentials_required: true,
      },
    ],
    system_packages: [],
  });
  builder.setConsistency({
    strategy: "pg_dump snapshot",
    window: WINDOW,
    classification: "single_point",
    gaps: [],
  });
  builder.addRelationship({
    from: "data:main",
    to: "source:main",
    kind: "backs",
  });
  if (options.signature !== undefined)
    builder.setSignature({
      algorithm: "ed25519",
      public_key_id: options.signature.keyId,
      detached_path: "manifest.json.sig",
    });
  if (options.license !== undefined) builder.setLicenses(options.license);
  return { builder, root: builder.root, workDir };
}

export const finalizeFixture = (builder: PackageBuilder) =>
  builder.finalize({
    packageId: PACKAGE_ID,
    build: BUILD,
    producer: PRODUCER,
    createdAt: CREATED_AT,
  });

export async function buildFixture(
  options: Parameters<typeof stageFixture>[0] = {},
): Promise<Fixture & { manifest: RecoveryManifest }> {
  const fixture = await stageFixture(options);
  const manifest = await finalizeFixture(fixture.builder);
  return { ...fixture, manifest };
}

/** Minimal ustar writer for hand-crafted (hostile) archives. */
export interface RawEntry {
  name: string;
  type?: "0" | "1" | "2" | "5" | "3";
  linkname?: string;
  body?: Buffer;
  size?: number;
}

export const rawTar = (entries: readonly RawEntry[]): Buffer => {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = e.body ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(e.name, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(
      `${(e.size ?? body.length).toString(8).padStart(11, "0")}\0`,
      124,
    );
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(e.type ?? "0", 156);
    if (e.linkname !== undefined) header.write(e.linkname, 157, 100, "utf8");
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header);
    if (body.length > 0) {
      blocks.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad > 0) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
};
