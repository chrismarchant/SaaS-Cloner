import { z } from "zod";

const GIB = 1024 * 1024 * 1024;

/** Environment names are documented in docs/API.md. */
export interface AppConfig {
  readonly databaseUrl: string;
  readonly sessionSecret: string;
  readonly publicUrl: string;
  readonly allowRegistration: boolean;
  readonly maxUploadBytes: number;
  readonly leaseTtlMs: number;
  readonly idempotencyTtlMs: number;
  readonly logLevel: string;
  readonly validateResponses: boolean;
  /** Origins allowed for credentialed cross-origin requests; empty = same-origin only. */
  readonly corsOrigins: readonly string[];
  readonly staticDir: string | null;
  readonly host: string;
  readonly port: number;
  readonly version: string;
  /** Cadence of SSE keep-alive comments. */
  readonly ssePingMs: number;
  /** Default long-poll wait ceiling for claims, bounded by the protocol maximum. */
  readonly claimPollMs: number;
  readonly sessionTtlMs: number;
}

export const DEFAULT_CONFIG = {
  publicUrl: "http://localhost:8080",
  allowRegistration: true,
  maxUploadBytes: 2 * GIB,
  leaseTtlMs: 60_000,
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
  logLevel: "info",
  validateResponses: false,
  corsOrigins: [] as readonly string[],
  staticDir: null,
  host: "0.0.0.0",
  port: 8080,
  version: "0.1.0",
  ssePingMs: 15_000,
  claimPollMs: 500,
  sessionTtlMs: 14 * 24 * 60 * 60 * 1000,
} as const;

export const DEFAULT_STORAGE_FS_ROOT = "./.rea-web-data/objects";

const boolish = z
  .string()
  .transform((value, ctx) => {
    const lower = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(lower)) return true;
    if (["0", "false", "no", "off"].includes(lower)) return false;
    ctx.addIssue({ code: "custom", message: "must be true or false" });
    return z.NEVER;
  })
  .optional();

const positiveInt = z.coerce.number().int().positive().optional();

const envSchema = z.object({
  REA_WEB_DATABASE_URL: z.string().min(1),
  REA_WEB_SESSION_SECRET: z.string().min(16),
  REA_WEB_PUBLIC_URL: z.string().url().optional(),
  REA_WEB_ALLOW_REGISTRATION: boolish,
  REA_WEB_MAX_UPLOAD_BYTES: positiveInt,
  REA_WEB_LEASE_TTL_MS: positiveInt,
  REA_WEB_IDEMPOTENCY_TTL_MS: positiveInt,
  REA_WEB_LOG_LEVEL: z.string().optional(),
  REA_WEB_VALIDATE_RESPONSES: boolish,
  REA_WEB_CORS_ORIGINS: z.string().optional(),
  REA_WEB_STATIC_DIR: z.string().optional(),
  REA_WEB_HOST: z.string().optional(),
  REA_WEB_PORT: positiveInt,
  PORT: positiveInt,
});

export type ConfigEnv = Readonly<Record<string, string | undefined>>;

/**
 * Parse the process environment. Failure messages name variables and rules,
 * never values (the session secret and database URL are credentials).
 */
export const loadConfig = (env: ConfigEnv): AppConfig => {
  const cleaned: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env))
    cleaned[name] = value === "" ? undefined : value;
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration (${problems})`);
  }
  const e = parsed.data;
  const origins = (e.REA_WEB_CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return {
    databaseUrl: e.REA_WEB_DATABASE_URL,
    sessionSecret: e.REA_WEB_SESSION_SECRET,
    publicUrl: e.REA_WEB_PUBLIC_URL ?? DEFAULT_CONFIG.publicUrl,
    allowRegistration:
      e.REA_WEB_ALLOW_REGISTRATION ?? DEFAULT_CONFIG.allowRegistration,
    maxUploadBytes: e.REA_WEB_MAX_UPLOAD_BYTES ?? DEFAULT_CONFIG.maxUploadBytes,
    leaseTtlMs: e.REA_WEB_LEASE_TTL_MS ?? DEFAULT_CONFIG.leaseTtlMs,
    idempotencyTtlMs:
      e.REA_WEB_IDEMPOTENCY_TTL_MS ?? DEFAULT_CONFIG.idempotencyTtlMs,
    logLevel: e.REA_WEB_LOG_LEVEL ?? DEFAULT_CONFIG.logLevel,
    validateResponses:
      e.REA_WEB_VALIDATE_RESPONSES ?? DEFAULT_CONFIG.validateResponses,
    corsOrigins: origins,
    staticDir: e.REA_WEB_STATIC_DIR ?? null,
    host: e.REA_WEB_HOST ?? DEFAULT_CONFIG.host,
    port: e.REA_WEB_PORT ?? e.PORT ?? DEFAULT_CONFIG.port,
    version: DEFAULT_CONFIG.version,
    ssePingMs: DEFAULT_CONFIG.ssePingMs,
    claimPollMs: DEFAULT_CONFIG.claimPollMs,
    sessionTtlMs: DEFAULT_CONFIG.sessionTtlMs,
  };
};

/** Test and embedding helper: defaults plus explicit overrides. */
export const makeConfig = (
  overrides: Partial<AppConfig> &
    Pick<AppConfig, "databaseUrl" | "sessionSecret">,
): AppConfig => ({ ...DEFAULT_CONFIG, ...overrides });
