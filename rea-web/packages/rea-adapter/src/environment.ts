/**
 * Child environment for an upstream REA process. Only an allowlist crosses
 * the boundary: the process gets a private HOME/TMPDIR inside the workspace,
 * PATH for tool discovery, and the REA_ or provider locator names the runner
 * operator explicitly passes through. Nothing else from the ambient
 * environment is inherited (AGENTS.md: do not persist the ambient environment
 * merely because a child inherits it).
 */
export const BASE_PASSTHROUGH: readonly string[] = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "PROGRAMFILES",
  "PROGRAMDATA",
  "LOCALAPPDATA",
  "APPDATA",
  "USERPROFILE",
  "JAVA_HOME",
  "JAVA_TOOL_OPTIONS",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "PLAYWRIGHT_BROWSERS_PATH",
];

export interface ChildEnvironmentOptions {
  readonly ambient: Readonly<Record<string, string | undefined>>;
  readonly privateHome: string;
  readonly privateTemp: string;
  /** REA_* or provider variable names the operator allows through. */
  readonly passthroughNames: readonly string[];
  readonly logLevel:
    | "trace"
    | "debug"
    | "info"
    | "warn"
    | "error"
    | "fatal"
    | "silent";
  readonly mcpInputSchemaProfile?: "full" | "compact";
}

export const buildChildEnvironment = (
  options: ChildEnvironmentOptions,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of [...BASE_PASSTHROUGH, ...options.passthroughNames]) {
    const value = options.ambient[name];
    if (typeof value === "string" && value.length > 0) env[name] = value;
  }
  env["HOME"] = options.privateHome;
  env["TMPDIR"] = options.privateTemp;
  env["TMP"] = options.privateTemp;
  env["TEMP"] = options.privateTemp;
  env["REA_LOG_LEVEL"] = options.logLevel;
  if (options.mcpInputSchemaProfile)
    env["REA_MCP_INPUT_SCHEMA_PROFILE"] = options.mcpInputSchemaProfile;
  return env;
};

/** Names from the ambient environment that are set and allowed; never values. */
export const setCapabilityNames = (
  ambient: Readonly<Record<string, string | undefined>>,
  passthroughNames: readonly string[],
): string[] =>
  passthroughNames
    .filter((n) => typeof ambient[n] === "string" && ambient[n] !== "")
    .sort();
