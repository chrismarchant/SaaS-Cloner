import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  buildJobInputSchema,
  jobResultSchemas,
  planJobInputSchema,
  redactorFromEnvironment,
  resolvePinnedAddress,
  validateTargetUrl,
  DEFAULT_SECRET_ENV_NAMES,
  type BuildJobInput,
  type ComponentDeclaration,
  type JobResult,
} from "@rea-web/contracts";
import {
  capturePackage,
  planPreservation,
  type BuildDefinition,
  type CollectorContext,
} from "@rea-web/preservation";
import type { JobContext } from "../jobContext.js";

/**
 * preservation.plan / preservation.capture executors. Capture credentials
 * are read from this runner's environment by the names the build declares,
 * and only those names reach the collectors; every value is added to the
 * redactor. The package is staged in the job workspace, uploaded file by
 * file with `manifest.json` last, and removed.
 */
export interface PreservationDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly localPaths: () => Promise<ReadonlyMap<string, string>>;
  readonly producerVersion: string;
  readonly upstreamRea: {
    package_version: string;
    source_sha: string | null;
    catalog_digest: string | null;
  } | null;
  /** Self-contained verifier to embed as recovery/rea-recover.mjs, if built. */
  readonly verifierBundlePath: string | null;
}

/** Environment names a build's declarations read, split by sensitivity. */
export const declaredEnvironment = (
  components: readonly ComponentDeclaration[],
): { secret: string[]; plain: string[] } => {
  const secret = new Set<string>();
  const plain = new Set<string>(["REA_WEB_CODE_TO_PRD_DIR"]);
  for (const c of components) {
    if (c.kind === "data") secret.add(c.connection_env_name);
    if (c.kind === "assets" && c.source.kind !== "runner_local") {
      const prefix = c.source.credentials_env_prefix;
      for (const suffix of [
        "ACCESS_KEY_ID",
        "SECRET_ACCESS_KEY",
        "SESSION_TOKEN",
        "SERVICE_ROLE_KEY",
        "KEY",
      ])
        secret.add(`${prefix}_${suffix}`);
      plain.add(`${prefix}_REGION`);
      if (c.source.kind === "s3" && c.source.endpoint_env_name)
        plain.add(c.source.endpoint_env_name);
      if (c.source.kind === "supabase_storage") plain.add(`${prefix}_ENDPOINT`);
    }
  }
  return { secret: [...secret], plain: [...plain] };
};

const collectorContext = async (
  ctx: JobContext,
  deps: PreservationDeps,
  build: BuildJobInput,
): Promise<CollectorContext> => {
  const names = declaredEnvironment(build.components);
  const env: Record<string, string | undefined> = {};
  for (const name of [...names.secret, ...names.plain])
    if (deps.env[name] !== undefined) env[name] = deps.env[name];
  const redactor = redactorFromEnvironment(deps.env, [
    ...DEFAULT_SECRET_ENV_NAMES,
    ...names.secret,
  ]);
  const workspace = join(ctx.workspace, "preservation");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  return {
    workspace,
    env,
    signal: ctx.signal,
    redactor,
    localPaths: await deps.localPaths(),
    log: (level, message, fields) => {
      void ctx.emit("job.log", {
        level,
        message: redactor.redactText(message),
        ...(fields ? { fields: redactor.redactValue(fields) } : {}),
      });
    },
  };
};

export class SourceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceRefusedError";
  }
}

/** `git@host:path` (scp-like) as an ssh URL, so one parser checks both. */
const asUrl = (raw: string): string => {
  const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(?!\/\/)(.+)$/u.exec(raw);
  return scp ? `ssh://${scp[1]}@${scp[2]}/${scp[3]}` : raw;
};

/**
 * Host paths are reachable only through this runner's allowlist
 * (`runner_local` + `path_hash`). A `git` source must therefore be a remote
 * https or ssh URL without embedded credentials (they would be persisted in
 * the build definition; declare them by environment name instead) whose host
 * does not resolve to a private, loopback or link-local address.
 */
export const assertSourceAllowed = async (
  build: BuildJobInput,
  options: { allowLoopbackForTests?: boolean } = {},
): Promise<void> => {
  if (build.source.kind !== "git") return;
  const raw = asUrl(build.source.url);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SourceRefusedError(
      "git source must be a remote https or ssh URL; declare repositories on this host as runner_local sources from the runner allowlist",
    );
  }
  if (
    parsed.protocol === "ssh:" &&
    parsed.username !== "" &&
    parsed.password === ""
  )
    parsed = new URL(raw.replace(`${parsed.username}@`, ""));
  const checked = validateTargetUrl(parsed.toString(), {
    allowedSchemes: ["https:", "ssh:"],
    ...(options.allowLoopbackForTests ? { allowLoopbackForTests: true } : {}),
  });
  if (!checked.ok)
    throw new SourceRefusedError(
      `git source refused (${checked.rejection.kind}); use a remote https or ssh URL, credentials by environment name, or a runner_local source`,
    );
  const pinned = await resolvePinnedAddress(checked.url, options);
  if (!pinned.ok)
    throw new SourceRefusedError(
      `git source host refused (${pinned.rejection.kind})`,
    );
};

const toDefinition = (build: BuildJobInput): BuildDefinition => ({
  id: build.id,
  name: build.name,
  description: build.description,
  project_slug: build.project_slug,
  source: build.source,
  components: build.components,
});

const loadBuild = async (ctx: JobContext): Promise<BuildJobInput> => {
  const build = buildJobInputSchema.parse(
    await ctx.client.fetchInputJson(ctx.job.id, ctx.fencingToken, "build", {
      signal: ctx.signal,
    }),
  );
  await assertSourceAllowed(build);
  return build;
};

export const runPreservationPlan = async (
  ctx: JobContext,
  deps: PreservationDeps,
): Promise<JobResult<"preservation.plan">> => {
  const build = await loadBuild(ctx);
  const collectors = await collectorContext(ctx, deps, build);
  try {
    const plan = await planPreservation(toDefinition(build), collectors);
    // Validate here, where the result is produced, before completing.
    return jobResultSchemas["preservation.plan"].parse(
      collectors.redactor.redactValue({ plan }),
    );
  } finally {
    await rm(collectors.workspace, { recursive: true, force: true });
  }
};

export const runPreservationCapture = async (
  ctx: JobContext,
  deps: PreservationDeps,
): Promise<JobResult<"preservation.capture">> => {
  const build = await loadBuild(ctx);
  const plan = planJobInputSchema.parse(
    await ctx.client.fetchInputJson(ctx.job.id, ctx.fencingToken, "plan", {
      signal: ctx.signal,
    }),
  );
  const collectors = await collectorContext(ctx, deps, build);
  const stagingDir = join(ctx.workspace, "package");
  await rm(stagingDir, { recursive: true, force: true });
  try {
    const captured = await capturePackage(
      toDefinition(build),
      plan,
      collectors,
      {
        stagingDir,
        producerVersion: deps.producerVersion,
        upstreamRea: deps.upstreamRea,
        ...(deps.verifierBundlePath
          ? { verifierBundlePath: deps.verifierBundlePath }
          : {}),
      },
    );
    await ctx.progress("package staged", {
      files: captured.manifest.files.length,
      consistency: captured.consistency,
    });
    let bytes = 0;
    for (const file of captured.manifest.files) {
      const path = join(captured.root, file.path);
      const size = (await stat(path)).size;
      if (size !== file.size)
        throw new Error(`staged file ${file.path} changed size after hashing`);
      await ctx.client.uploadArtifact(
        ctx.job.id,
        ctx.fencingToken,
        { kind: "capture_file", name: file.path },
        { path },
      );
      bytes += size;
      ctx.usage.addArtifactBytes(size);
    }
    const manifestBytes = await readFile(join(captured.root, "manifest.json"));
    await ctx.client.uploadArtifact(
      ctx.job.id,
      ctx.fencingToken,
      { kind: "capture_manifest", name: "manifest.json" },
      { body: manifestBytes },
    );
    ctx.usage.addArtifactBytes(manifestBytes.length);
    return jobResultSchemas["preservation.capture"].parse({
      capture: {
        consistency: captured.consistency,
        component_statuses: captured.componentStatuses,
        manifest_sha256: createHash("sha256")
          .update(manifestBytes)
          .digest("hex"),
        package_id: captured.manifest.package_id,
        files: captured.manifest.files.length + 1,
        bytes: bytes + manifestBytes.length,
      },
    });
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    await rm(collectors.workspace, { recursive: true, force: true });
  }
};
