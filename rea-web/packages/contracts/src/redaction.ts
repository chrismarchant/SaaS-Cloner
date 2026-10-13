/**
 * Redaction for logs, exports and model inputs. Secret *names* are configured;
 * values are never inferred from text patterns except for well-known
 * transport credentials (bearer tokens, cookies, basic auth, URL userinfo).
 */
export interface RedactionConfig {
  /** Environment variable names whose values are secret (e.g. REA_WEB_S3_SECRET_ACCESS_KEY). */
  readonly secretNames: readonly string[];
  /** Literal secret values known at runtime (looked up from env by name). */
  readonly secretValues: readonly string[];
}

export const REDACTED = "[REDACTED]";

const TRANSPORT_PATTERNS: readonly RegExp[] = [
  /(authorization\s*[:=]\s*)(bearer|basic)\s+[^\s,;"']+/giu,
  /(bearer\s+)[a-z0-9._~+/=-]{16,}/giu,
  /((?:^|[;\s])(?:set-)?cookie\s*[:=]\s*)[^\n]+/giu,
  /(x-api-key\s*[:=]\s*)[^\s,;"']+/giu,
  /(\/\/)[^\s/@:]+:[^\s/@]+@/gu, // url userinfo
  /(sk-ant-[a-z0-9-]{3})[a-z0-9_-]{10,}/giu,
];

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export const createRedactor = (config: RedactionConfig) => {
  const valuePatterns = config.secretValues
    .filter((v) => v.length >= 6)
    .map((v) => new RegExp(escapeRegExp(v), "gu"));
  const namePattern =
    config.secretNames.length > 0
      ? new RegExp(
          `\\b(${config.secretNames.map(escapeRegExp).join("|")})\\s*[=:]\\s*("[^"]*"|'[^']*'|[^\\s,;]+)`,
          "gu",
        )
      : null;
  const redactText = (text: string): string => {
    let out = text;
    for (const pattern of valuePatterns) out = out.replace(pattern, REDACTED);
    if (namePattern)
      out = out.replace(
        namePattern,
        (_m, name: string) => `${name}=${REDACTED}`,
      );
    out = out.replace(
      TRANSPORT_PATTERNS[0] as RegExp,
      (_m, prefix: string, scheme: string) => `${prefix}${scheme} ${REDACTED}`,
    );
    out = out.replace(
      TRANSPORT_PATTERNS[1] as RegExp,
      (_m, prefix: string) => `${prefix}${REDACTED}`,
    );
    out = out.replace(
      TRANSPORT_PATTERNS[2] as RegExp,
      (_m, prefix: string) => `${prefix}${REDACTED}`,
    );
    out = out.replace(
      TRANSPORT_PATTERNS[3] as RegExp,
      (_m, prefix: string) => `${prefix}${REDACTED}`,
    );
    out = out.replace(
      TRANSPORT_PATTERNS[4] as RegExp,
      (_m, prefix: string) => `${prefix}${REDACTED}@`,
    );
    out = out.replace(
      TRANSPORT_PATTERNS[5] as RegExp,
      (_m, prefix: string) => `${prefix}${REDACTED}`,
    );
    return out;
  };
  const secretNameSet = new Set(config.secretNames.map((n) => n.toLowerCase()));
  const redactValue = (value: unknown, keyHint?: string): unknown => {
    if (typeof value === "string") {
      if (keyHint && secretNameSet.has(keyHint.toLowerCase())) return REDACTED;
      if (
        keyHint &&
        /(password|secret|token|api[_-]?key|private[_-]?key|authorization|cookie)/iu.test(
          keyHint,
        )
      )
        return REDACTED;
      return redactText(value);
    }
    if (Array.isArray(value)) return value.map((v) => redactValue(v));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        out[k] = redactValue(v, k);
      return out;
    }
    return value;
  };
  return { redactText, redactValue };
};

export type Redactor = ReturnType<typeof createRedactor>;

/** Build a redactor from a process environment using configured secret names. */
export const redactorFromEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
  secretNames: readonly string[],
): Redactor =>
  createRedactor({
    secretNames,
    secretValues: secretNames
      .map((n) => env[n])
      .filter((v): v is string => typeof v === "string" && v.length > 0),
  });

export const DEFAULT_SECRET_ENV_NAMES: readonly string[] = [
  "REA_WEB_SESSION_SECRET",
  "REA_WEB_S3_SECRET_ACCESS_KEY",
  "REA_WEB_S3_ACCESS_KEY_ID",
  "REA_WEB_ANTHROPIC_API_KEY",
  "REA_WEB_RUNNER_TOKEN",
  "REA_WEB_DATABASE_URL",
  "REA_WEB_CAPTURE_DATABASE_URL",
  "REA_WEB_VERIFY_DATABASE_ADMIN_URL",
  "DATABASE_URL",
  "PGPASSWORD",
  "AWS_SECRET_ACCESS_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "SUPABASE_SERVICE_ROLE_KEY",
  "RAILWAY_TOKEN",
];
