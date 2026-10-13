import { existsSync } from "node:fs";
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
  /** rea-recover bundle embedded into captured packages, when present. */
  readonly verifierBundlePath: string | null;
  /** Recovery keys (`<key id>.key`, base64) for encrypted exports; never uploaded. */
  readonly recoveryKeysDir: string | null;
  /** Restore-only admin URL of a disposable PostgreSQL server (never a capture credential). */
  readonly verifyDatabaseAdminUrl: string | null;
  /** Network classes restore steps may use during verification. */
  readonly verifyAllowNetwork: readonly ("registry" | "unknown")[];
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

/**
 * REA_WEB_API_URL wins. On platforms whose variable references cannot be
 * templated (Railway IaC), the runner composes the private-network URL from
 * REA_WEB_API_PRIVATE_HOST and REA_WEB_API_PORT instead.
 */
const resolveApiUrl = (
  env: Readonly<Record<string, string | undefined>>,
): string => {
  const explicit = env["REA_WEB_API_URL"];
  if (explicit) return explicit.replace(/\/+$/u, "");
  const host = env["REA_WEB_API_PRIVATE_HOST"];
  if (host) {
    if (!/^[A-Za-z0-9.-]+$/u.test(host))
      throw new Error("REA_WEB_API_PRIVATE_HOST is not a hostname");
    const port = Number(env["REA_WEB_API_PORT"] ?? 8080);
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error("REA_WEB_API_PORT is not a valid port");
    return `http://${host}:${port}`;
  }
  throw new Error("REA_WEB_API_URL or REA_WEB_API_PRIVATE_HOST is required");
};

/**
 * The self-contained verifier embedded in every captured package. Explicit
 * REA_WEB_RECOVER_BUNDLE wins; otherwise the built bundle next to the runner
 * in this checkout is used when it exists.
 */
const resolveVerifierBundle = (
  env: Readonly<Record<string, string | undefined>>,
): string | null => {
  const explicit = env["REA_WEB_RECOVER_BUNDLE"];
  if (explicit) return resolve(explicit);
  const sibling = resolve(
    import.meta.dirname,
    "../../recover-cli/dist/rea-recover.mjs",
  );
  return existsSync(sibling) ? sibling : null;
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
    apiUrl: resolveApiUrl(env),
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
    verifierBundlePath: resolveVerifierBundle(env),
    verifyDatabaseAdminUrl: env["REA_WEB_VERIFY_DATABASE_ADMIN_URL"] ?? null,
    verifyAllowNetwork: list(env["REA_WEB_VERIFY_ALLOW_NETWORK"], ",").map(
      (value) => {
        if (value !== "registry" && value !== "unknown")
          throw new Error(
            "REA_WEB_VERIFY_ALLOW_NETWORK accepts only registry and unknown",
          );
        return value;
      },
    ),
    recoveryKeysDir: env["REA_WEB_RECOVERY_KEYS_DIR"]
      ? resolve(env["REA_WEB_RECOVERY_KEYS_DIR"])
      : null,
    sessionIdleMs: Number.isFinite(idle) && idle >= 0 ? idle : 15 * 60_000,
    logLevel: (LOG_LEVELS as readonly string[]).includes(level)
      ? level
      : "info",
  };
};
