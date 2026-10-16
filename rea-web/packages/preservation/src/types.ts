import type {
  ComponentDeclaration,
  ComponentKind,
  RecoveryManifest,
  Redactor,
  buildSourceSchema,
} from "@rea-web/contracts";
import type { z } from "zod";

export type BuildSource = z.infer<typeof buildSourceSchema>;
export type { ComponentDeclaration, ComponentKind };

export interface CommandResult {
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface CollectorContext {
  /** Private scratch directory for this job. */
  readonly workspace: string;
  /** Capture credentials are looked up here BY NAME from declarations. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly log: (
    level: "info" | "warn",
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  /** Applied to every stdout/stderr/log/detail that is stored or returned. */
  readonly redactor: Redactor;
  /** path_hash -> absolute path, resolved by the runner. */
  readonly localPaths: ReadonlyMap<string, string>;
  readonly now?: () => Date;
}

export interface Omission {
  what: string;
  reason: string;
  remediation: string;
}

export interface PermissionCheck {
  check: string;
  ok: boolean;
  detail: string;
}

export interface ComponentPlan {
  id: string;
  kind: ComponentKind;
  collector: string;
  permissions: PermissionCheck[];
  estimated_bytes: number | null;
  dependencies: string[];
  method: string;
  omissions: Omission[];
  feasible: boolean;
}

export interface PreservationPlanBody {
  components: ComponentPlan[];
  consistency_strategy: string;
  known_omissions: Omission[];
}

export interface BuildDefinition {
  id: string;
  name: string;
  description: string;
  project_slug: string;
  source: BuildSource;
  components: ComponentDeclaration[];
}

export type ComponentCaptureStatus =
  | "captured"
  | "partial"
  | "blocked"
  | "manual";

export interface CaptureResult {
  manifest: RecoveryManifest;
  root: string;
  componentStatuses: Record<string, ComponentCaptureStatus>;
  consistency: "single_point" | "inconsistent" | "unknown";
}

export interface CaptureOptions {
  stagingDir: string;
  producerVersion: string;
  upstreamRea?: {
    package_version: string;
    source_sha: string | null;
    catalog_digest: string | null;
  } | null;
  /** Maximum span between the data and asset windows for `single_point`. Default 60 000 ms. */
  consistencyWindowMs?: number;
  /**
   * Built `rea-recover.mjs` bundle to embed as `recovery/rea-recover.mjs`
   * (component `package`), so the package carries its own verifier and the
   * manifest records its hash.
   */
  verifierBundlePath?: string;
}

export const DEFAULT_CONSISTENCY_WINDOW_MS = 60_000;

/** Manifest component id for a declaration (`kind:id`, as in RECOVERY-FORMAT.md). */
export const componentId = (decl: {
  kind: ComponentKind;
  id: string;
}): string => `${decl.kind}:${decl.id}`;

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
