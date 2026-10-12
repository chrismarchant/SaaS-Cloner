import { resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * Runner configuration from environment variable names documented in
 * docs/API.md#environment. Values are never logged; errors name variables only.
 */
export interface RunnerConfig {
  readonly apiUrl: string;
  readonly runnerToken: string;
  readonly runnerName: string;
  readonly workspaceRoot: string;
  readonly maxJobs: number;
  readonly reaRoot: string;
  readonly passthroughNames: readonly string[];
  readonly localTargetAllowlist: readonly string[];
  readonly labels: readonly string[];
  /** Keep an investigation's REA session alive this long after its run for follow-ups. */
  readonly sessionIdleMs: number;
  readonly logLevel:
    | "trace"
    | "debug"
    | "info"
    | "warn"
    | "error"
    | "fatal"
    | "silent";
}

const required = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const list = (value: string | undefined, separator: string): string[] =>
  (value ?? "")
    .split(separator)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
] as const;

export const parseRunnerConfig = (
  env: Readonly<Record<string, string | undefined>>,
): RunnerConfig => {
  const maxJobs = Number(env["REA_WEB_RUNNER_MAX_JOBS"] ?? 2);
  const idle = Number(env["REA_WEB_RUNNER_SESSION_IDLE_MS"] ?? 15 * 60_000);
  const level = (env["REA_WEB_LOG_LEVEL"] ??
    "info") as RunnerConfig["logLevel"];
  const passthrough = list(env["REA_WEB_REA_PASSTHROUGH_ENV"], ",");
  for (const name of passthrough)
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || name.startsWith("REA_WEB_"))
      throw new Error(
        `REA_WEB_REA_PASSTHROUGH_ENV contains an invalid or control-plane variable name`,
      );
  return {
    apiUrl: required(env, "REA_WEB_API_URL").replace(/\/+$/u, ""),
    runnerToken: required(env, "REA_WEB_RUNNER_TOKEN"),
    runnerName: env["REA_WEB_RUNNER_NAME"] ?? "runner",
    workspaceRoot: resolve(
      env["REA_WEB_RUNNER_WORKSPACE_ROOT"] ?? `${tmpdir()}/rea-web-runner`,
    ),
    maxJobs:
      Number.isInteger(maxJobs) && maxJobs > 0 && maxJobs <= 64 ? maxJobs : 2,
    reaRoot: resolve(required(env, "REA_WEB_REA_ROOT")),
    passthroughNames: passthrough,
    localTargetAllowlist: list(
      env["REA_WEB_RUNNER_LOCAL_TARGET_ALLOWLIST"],
      ":",
    ).map((p) => resolve(p)),
    labels: list(env["REA_WEB_RUNNER_LABELS"], ","),
    sessionIdleMs: Number.isFinite(idle) && idle >= 0 ? idle : 15 * 60_000,
    logLevel: (LOG_LEVELS as readonly string[]).includes(level)
      ? level
      : "info",
  };
};
