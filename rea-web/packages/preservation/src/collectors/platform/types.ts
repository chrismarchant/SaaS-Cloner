import type { CommandFact } from "./command.js";
import type { Audit } from "./reader.js";

export type PlatformName =
  | "railway"
  | "fly"
  | "vercel"
  | "netlify"
  | "procfile"
  | "supabase";

/** `declared`: read from a file the platform itself consumes. `inferred`: only the file's presence is known. */
export type Confidence = "declared" | "inferred";

export interface UrlFact {
  /** Userinfo, query and fragment removed. */
  url: string;
  scheme: string | null;
  /** Lower-case host, null when the value is not an absolute URL. */
  host: string | null;
  /** The host contains a wildcard, so it cannot be a guard entry. */
  wildcard: boolean;
}

export interface VolumeFact {
  name: string;
  mount_path: string | null;
  size_gb: number | null;
  initial_size: string | null;
}

export interface HealthFact {
  kind: "http" | "tcp" | null;
  path: string | null;
  method: string | null;
  protocol: string | null;
  interval: string | null;
  /** Timeout as written (`"5s"`). */
  timeout: string | null;
  /** Timeout in seconds when the platform states a number (Railway). */
  timeout_seconds: number | null;
  grace_period: string | null;
}

export const emptyHealth = (): HealthFact => ({
  kind: null,
  path: null,
  method: null,
  protocol: null,
  interval: null,
  timeout: null,
  timeout_seconds: null,
  grace_period: null,
});

/** A service as one platform file declares it. */
export interface ServiceFact {
  name: string;
  kind: string;
  build_command: CommandFact | null;
  start_command: CommandFact | null;
  /** Directory (relative to the repository root) that holds the config file. */
  dir: string;
  health_check: HealthFact | null;
  region: string | null;
  regions: string[];
  volumes: VolumeFact[];
  depends_on: string[];
  /** Platform-specific settings worth keeping (replicas, restart policy, ports, ...). */
  settings: Record<string, unknown>;
}

export interface ScheduleFact {
  name: string;
  cron: string;
  command: CommandFact | null;
  /** HTTP path the platform requests (Vercel crons). */
  http_path: string | null;
}

export interface EnvNameFact {
  name: string;
  /** Where in the file the name appears, for example `env` or `auth.external.google.secret`. */
  key: string;
}

export type SecretRef =
  | { kind: "env"; name: string }
  | { kind: "literal" }
  | { kind: "absent" };

export interface SupabaseProviderFact {
  name: string;
  enabled: boolean;
  client_id: SecretRef;
  secret: SecretRef;
  redirect_uri: UrlFact | null;
  url: UrlFact | null;
  skip_nonce_check: boolean | null;
}

export interface SupabaseFunctionFact {
  name: string;
  /** `directory`: found under supabase/functions. `config`: only a [functions.<name>] table. */
  origin: "directory" | "config" | "both";
  verify_jwt: boolean | null;
  enabled: boolean | null;
  entrypoint: string | null;
}

export interface SupabaseFacts {
  path: string;
  project_id: string | null;
  api: { port: number | null; schemas: string[] } | null;
  db: { major_version: number | null; port: number | null } | null;
  auth: {
    enabled: boolean | null;
    site_url: UrlFact | null;
    additional_redirect_urls: UrlFact[];
    providers: SupabaseProviderFact[];
    hooks: { name: string; enabled: boolean | null; uri: UrlFact | null }[];
  } | null;
  storage: {
    file_size_limit: string | null;
    buckets: {
      name: string;
      public: boolean | null;
      file_size_limit: string | null;
      allowed_mime_types: string[];
    }[];
  } | null;
  edge_runtime: {
    enabled: boolean | null;
    policy: string | null;
    deno_version: number | null;
  } | null;
  functions: SupabaseFunctionFact[];
  analytics: {
    enabled: boolean | null;
    backend: string | null;
    port: number | null;
  } | null;
}

/** What one parser produces for one file. */
export interface Extraction {
  parsed: Record<string, unknown>;
  unknown_keys: string[];
  limitations: string[];
  services: ServiceFact[];
  schedules: ScheduleFact[];
  hosts: UrlFact[];
  env_names: EnvNameFact[];
  supabase: SupabaseFacts | null;
}

export interface PlatformFile {
  platform: PlatformName;
  /** Path inside the captured checkout. */
  path: string;
  sha256: string;
  confidence: Confidence;
  status: "parsed" | "unparsed" | "present";
  parsed: Record<string, unknown> | null;
  unknown_keys: string[];
  limitations: string[];
  /** Redacted parse failure; set when `status` is `unparsed`. */
  parse_error: string | null;
  extraction: Extraction | null;
}

export interface PlatformScan {
  files: PlatformFile[];
  /** Platform-looking files that were not read (symbolic links, oversized). */
  unread: { path: string; reason: string }[];
}

export const emptyExtraction = (): Extraction => ({
  parsed: {},
  unknown_keys: [],
  limitations: [],
  services: [],
  schedules: [],
  hosts: [],
  env_names: [],
  supabase: null,
});

/** Input to a per-format extractor. */
export interface ExtractInput {
  /** Path of the file inside the captured checkout. */
  path: string;
  /** Directory that holds it (empty at the repository root). */
  dir: string;
  /** Parsed JSON or TOML document. */
  doc: unknown;
  audit: Audit;
  /** Every path in the checkout; only the Supabase extractor needs it. */
  allPaths: readonly string[];
}

/** `railway` at the root, `railway:apps/api` below it. */
export const serviceName = (platform: PlatformName, dir: string): string =>
  dir === "" ? platform : `${platform}:${dir}`;
