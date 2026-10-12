import { createHash } from "node:crypto";
import { access, mkdtemp, rm, statfs } from "node:fs/promises";
import { arch, cpus, hostname, platform, release, totalmem } from "node:os";
import { delimiter, join } from "node:path";
import {
  RUNNER_PROTOCOL_VERSION,
  type CapabilityReport,
  type HostFacts,
} from "@rea-web/contracts";
import {
  ReaSession,
  describeReaRoot,
  setCapabilityNames,
  toAdvertisedTools,
} from "@rea-web/rea-adapter";
import type { RunnerConfig } from "./config.js";

const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

const onPath = async (
  command: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> => {
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      await access(join(dir, command));
      return true;
    } catch {
      /* next */
    }
  }
  return false;
};

/** Host facts the runner can prove; anything unproven is reported false/0. */
export const collectHostFacts = async (
  env: Readonly<Record<string, string | undefined>>,
): Promise<HostFacts> => {
  const os = platform();
  let docker = false;
  try {
    await access("/var/run/docker.sock");
    docker = true;
  } catch {
    docker = false;
  }
  return {
    os: os === "darwin" || os === "win32" ? os : "linux",
    arch: arch(),
    release: release(),
    hostname_hash: sha256(hostname()),
    node_version: process.versions.node,
    docker_available: docker,
    gui: os !== "linux" || Boolean(env["DISPLAY"] ?? env["WAYLAND_DISPLAY"]),
    adb_devices: 0,
    cpus: Math.max(1, cpus().length),
    memory_bytes: totalmem(),
  };
};

/** Collectors this host can run, proven by locating their executables. */
export const detectCollectors = async (
  env: Readonly<Record<string, string | undefined>>,
): Promise<string[]> => {
  const collectors: string[] = [];
  if (await onPath("git", env)) collectors.push("git");
  if ((await onPath("pg_dump", env)) && (await onPath("pg_restore", env)))
    collectors.push("postgresql");
  if (await onPath("python3", env)) collectors.push("code-to-prd");
  collectors.push(
    "filesystem-assets",
    "dependencies",
    "infrastructure-descriptor",
  );
  return collectors;
};

/**
 * Build the capability report by starting a throwaway REA session and
 * recording its live discovery verbatim. If REA cannot start, the report says
 * so with the reason and advertises no tools.
 */
export const buildCapabilityReport = async (
  config: RunnerConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{
  report: CapabilityReport;
  reaInfo: Awaited<ReturnType<typeof describeReaRoot>> | null;
}> => {
  const host = await collectHostFacts(env);
  const collectors = await detectCollectors(env);
  let freeBytes = 0;
  try {
    const fs = await statfs(config.workspaceRoot);
    freeBytes = Number(fs.bavail) * Number(fs.bsize);
  } catch {
    freeBytes = 0;
  }
  const base = {
    protocol_version: RUNNER_PROTOCOL_VERSION,
    runner_name: config.runnerName,
    host,
    env_capability_names: setCapabilityNames(env, config.passthroughNames),
    labels: [...config.labels],
    max_concurrent_jobs: config.maxJobs,
    workspace_root_free_bytes: freeBytes,
    collectors,
    reported_at: new Date().toISOString(),
  };
  let reaInfo: Awaited<ReturnType<typeof describeReaRoot>> | null = null;
  const scratch = await mkdtemp(join(config.workspaceRoot, "discovery-"));
  try {
    reaInfo = await describeReaRoot(config.reaRoot);
    if (!reaInfo.built)
      throw new Error("upstream REA is not built (dist/mcp/main.js missing)");
    const session = new ReaSession({
      reaRoot: config.reaRoot,
      sourceSha: reaInfo.source_sha,
      workspace: scratch,
      ambientEnv: env,
      passthroughNames: config.passthroughNames,
      logLevel: "warn",
    });
    try {
      const discovery = await session.start();
      return {
        reaInfo,
        report: {
          ...base,
          rea: discovery.identity,
          rea_unavailable_reason: discovery.binary_session_error,
          tools_list: toAdvertisedTools(discovery.tools),
          prompts_list: discovery.prompts.map((p) => p.name),
          tool_availability: discovery.tool_availability,
          analysis_provider_candidates: discovery.analysis_provider_candidates,
          provider_capabilities: discovery.provider_capabilities,
        },
      };
    } finally {
      await session.close();
    }
  } catch (error) {
    return {
      reaInfo,
      report: {
        ...base,
        rea: null,
        rea_unavailable_reason:
          error instanceof Error ? error.message : String(error),
        tools_list: [],
        prompts_list: [],
        tool_availability: { groups: [] },
        analysis_provider_candidates: [],
        provider_capabilities: [],
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};
