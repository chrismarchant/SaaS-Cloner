export interface DatabaseTarget {
  /** The connection URL with its password removed; safe for argv and reports. */
  readonly urlWithoutPassword: string;
  readonly password: string;
  /** Normalised hosts the connection may reach (empty: the default socket). */
  readonly hosts: readonly string[];
  /** True when every route to the server is a Unix socket. */
  readonly viaSocket: boolean;
}

const EMPTY_HOST = "rea-default-socket.invalid";

const isSocketPath = (host: string): boolean => host.startsWith("/");

/** Lower-case, drop IPv6 brackets and a trailing dot; socket paths are kept verbatim. */
export const normalizeHost = (host: string): string => {
  const trimmed = host.trim();
  if (isSocketPath(trimmed)) return trimmed;
  return trimmed
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "")
    .toLowerCase();
};

/** A `blocked_hosts` entry may carry a port (`host:5432`); only the host is compared. */
export const normalizeBlockedHost = (entry: string): string => {
  const trimmed = entry.trim();
  const withPort = /^([^:[\]]+):\d+$/u.exec(trimmed);
  const bracketed = /^(\[[^\]]+\]):\d+$/u.exec(trimmed);
  return normalizeHost(withPort?.[1] ?? bracketed?.[1] ?? trimmed);
};

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Parse a postgres URL. The reason never echoes any part of the value. */
export const parseDatabaseUrl = (
  raw: string,
): { ok: true; db: DatabaseTarget } | { ok: false; reason: string } => {
  // `postgres://user@/db?host=/dir` is valid for libpq but not for WHATWG URL.
  const emptyHost = /^(postgres(?:ql)?:\/\/[^/?#@]*@)(?=[/?#]|$)/u.test(raw);
  const parseable = emptyHost
    ? raw.replace(/^(postgres(?:ql)?:\/\/[^/?#@]*@)/u, `$1${EMPTY_HOST}`)
    : raw;
  let url: URL;
  try {
    url = new URL(parseable);
  } catch {
    return { ok: false, reason: "the database URL is not a valid URL" };
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    return {
      ok: false,
      reason:
        "the database URL must use the postgres:// or postgresql:// scheme",
    };
  const hostParam = url.searchParams.get("host");
  const hostText = hostParam ?? (emptyHost ? "" : decode(url.hostname));
  const hosts = hostText
    .split(",")
    .map(normalizeHost)
    .filter((h) => h !== "");
  const password =
    decode(url.password) || url.searchParams.get("password") || "";
  const stripped = new URL(parseable);
  stripped.password = "";
  stripped.searchParams.delete("password");
  return {
    ok: true,
    db: {
      urlWithoutPassword: stripped.toString().replace(EMPTY_HOST, ""),
      password,
      hosts,
      viaSocket: !url.searchParams.has("hostaddr") && hosts.every(isSocketPath), // no host at all: the default socket,
    },
  };
};

/** The first of the database's hosts that appears in `blocked`, or null. */
export const blockedDatabaseHost = (
  db: DatabaseTarget,
  blocked: readonly string[],
): string | null => {
  const set = new Set(blocked.map(normalizeBlockedHost));
  return db.hosts.find((h) => set.has(h)) ?? null;
};

/** SQL that counts relations outside the system schemas. */
export const NON_EMPTY_DATABASE_SQL =
  "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace " +
  "where n.nspname not in ('pg_catalog', 'information_schema') " +
  "and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%' " +
  "and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')";

const READ_ONLY_START = /^\s*(select|with|values|show|table)\b/iu;

/** Invariants must be one read-only statement; same rule as the capture side. */
export const readOnlySql = (
  sql: string,
): { ok: true; sql: string } | { ok: false; reason: string } => {
  const text = sql.trim().replace(/;+\s*$/u, "");
  if (!READ_ONLY_START.test(text) || text.includes(";"))
    return {
      ok: false,
      reason:
        "invariant must be a single SELECT/WITH/VALUES/SHOW/TABLE statement",
    };
  return { ok: true, sql: text };
};
