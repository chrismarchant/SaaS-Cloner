import type {
  ManifestComponent,
  RecoveryManifest,
  RestoreStep,
} from "@rea-web/contracts";
import type { PackageBuilder } from "@rea-web/recovery";
import { type RunCommandOptions, runCommand } from "./exec.js";
import type {
  BuildDefinition,
  CollectorContext,
  CommandResult,
  ComponentCaptureStatus,
  Omission,
} from "./types.js";

/** What every collector (plan and capture) can rely on. */
export interface Runtime {
  readonly build: BuildDefinition;
  readonly ctx: CollectorContext;
  readonly now: () => Date;
  /** Run a program with the job's abort signal; never throws. */
  run(argv: string[], opts?: RunCommandOptions): Promise<CommandResult>;
  /** Redacted, single-line description of a failed command. */
  failure(result: CommandResult): string;
}

export interface SourceInfo {
  declId: string;
  componentId: string;
  headSha: string;
  /** Subset of restore steps that rebuilds the checkout (no LFS payload). */
  checkoutSteps: RestoreStep[];
}

export type CheckoutResult =
  | {
      ok: true;
      dir: string;
      headSha: string;
      sourceComponentId: string;
      sourceDeclId: string;
    }
  | { ok: false; reason: string; remediation: string };

export interface CaptureRuntime extends Runtime {
  readonly builder: PackageBuilder;
  /** Fresh, empty scratch directory mirroring the package layout for one component. */
  stageDir(label: string): Promise<string>;
  /** Captured source components, by declaration id, in declaration order. */
  readonly sources: ReadonlyMap<string, SourceInfo>;
  /** Make a captured source available to `checkout`. */
  registerSource(info: SourceInfo): void;
  /**
   * Materialise a scan checkout by executing the captured source's own
   * restore steps (clone bundle, checkout, submodules, patch) in the
   * workspace. `declId` null selects the first captured source.
   */
  checkout(declId: string | null): Promise<CheckoutResult>;
}

export interface ManifestFacts {
  sourceRevision?: RecoveryManifest["source_revisions"][number];
  dependencies?: Partial<RecoveryManifest["dependencies"]>;
  manual?: RecoveryManifest["manual_prerequisites"];
  secretNames?: string[];
  guards?: {
    blocked_hosts?: string[];
    disabled_schedules?: string[];
    disabled_webhooks?: string[];
  };
  relationships?: RecoveryManifest["relationships"];
  tools?: string[];
  /** Registries / network reasons for the network_required verdict. */
  networkReasons?: string[];
  /** Explicit "not captured" entries beyond omissions (e.g. manual items). */
  gaps?: string[];
  licenses?: { path: string; content: string; notice: string };
  sourceInfo?: SourceInfo;
}

export interface CollectorOutcome extends ManifestFacts {
  status: ComponentCaptureStatus;
  title: string;
  method: string;
  root: string;
  restoreSteps: RestoreStep[];
  limitations: string[];
  omissions: Omission[];
  details: Record<string, unknown>;
  capturedAt: { start: string; end: string } | null;
  /** Directory whose files (package-relative layout) belong to this component. */
  stageDir: string | null;
}

export type ComponentInputOf = Omit<ManifestComponent, "entries" | "bytes">;

export const createRuntime = (
  build: BuildDefinition,
  ctx: CollectorContext,
): Runtime => {
  const now = ctx.now ?? (() => new Date());
  return {
    build,
    ctx,
    now,
    run: (argv, opts = {}) =>
      runCommand(argv, {
        ...opts,
        signal: opts.signal ?? ctx.signal,
      }),
    failure: (r) => {
      const detail = (r.stderr.trim() || r.stdout.trim())
        .split("\n")
        .slice(-3)
        .join(" | ");
      const how = r.timedOut
        ? "timed out"
        : r.signal !== null
          ? `killed by ${r.signal}`
          : r.exitCode === null
            ? "could not start"
            : `exit ${r.exitCode}`;
      return ctx.redactor.redactText(
        `${r.argv[0] ?? "command"} ${r.argv[1] ?? ""}: ${how}${detail === "" ? "" : `: ${detail}`}`.trim(),
      );
    },
  };
};

export const emptyOutcome = (
  base: Pick<CollectorOutcome, "title" | "method" | "root">,
): CollectorOutcome => ({
  status: "captured",
  restoreSteps: [],
  limitations: [],
  omissions: [],
  details: {},
  capturedAt: null,
  stageDir: null,
  ...base,
});

export const blockedOutcome = (
  base: Pick<CollectorOutcome, "title" | "method" | "root">,
  omission: Omission,
  extra: Partial<CollectorOutcome> = {},
): CollectorOutcome => ({
  ...emptyOutcome(base),
  ...extra,
  status: "blocked",
  omissions: [omission, ...(extra.omissions ?? [])],
});
