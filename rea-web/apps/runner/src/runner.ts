import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_SECRET_ENV_NAMES,
  redactorFromEnvironment,
  type ClaimResponse,
  type CleanupReport,
  type JobFailure,
  type Redactor,
} from "@rea-web/contracts";
import { SessionManager, type ReaSessionOptions } from "@rea-web/rea-adapter";
import type { ModelProvider } from "@rea-web/model-connector";
import type { RunnerConfig } from "./config.js";
import { ControlPlaneClient, ControlPlaneError } from "./controlPlane.js";
import { buildCapabilityReport } from "./capabilities.js";
import { UsageTracker } from "./budget.js";
import { JobContext, type Logger } from "./jobContext.js";
import { LeaseKeeper, abortReasonOf, type ActiveLease } from "./leases.js";
import {
  InvestigationRun,
  parseInvestigationInput,
} from "./investigation/execute.js";
import { runFollowUp, SessionClosedError } from "./investigation/followUp.js";
import { runComparison } from "./investigation/compare.js";
import { runExport } from "./investigation/exportInvestigation.js";
import {
  runPreservationCapture,
  runPreservationPlan,
  SourceRefusedError,
  type PreservationDeps,
} from "./preservation/execute.js";
import { resolveLocalPaths } from "./preservation/localPaths.js";

export interface RunnerDeps {
  readonly config: RunnerConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly provider: ModelProvider;
  readonly log: Logger;
  readonly fetchImpl?: typeof fetch;
}

/** Version recorded as the package producer (rea-web runner). */
export const RUNNER_VERSION = "0.1.0";

/** Job kinds this runner executes; others are failed with capability_unavailable. */
export const SUPPORTED_JOB_KINDS = new Set([
  "investigation.run",
  "investigation.follow_up",
  "investigation.compare",
  "investigation.export",
  "preservation.plan",
  "preservation.capture",
]);

export class Runner {
  readonly client: ControlPlaneClient;
  readonly sessions = new SessionManager();
  private keeper: LeaseKeeper | null = null;
  private readonly active = new Map<string, Promise<void>>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private stopping = false;
  private readonly claimAbort = new AbortController();
  private readonly redactor: Redactor;
  private reaSourceSha: string | null = null;
  private reaIdentity: PreservationDeps["upstreamRea"] = null;

  constructor(private readonly deps: RunnerDeps) {
    this.client = new ControlPlaneClient(
      deps.config.apiUrl,
      deps.config.runnerToken,
      deps.fetchImpl,
    );
    this.redactor = redactorFromEnvironment(deps.env, [
      ...DEFAULT_SECRET_ENV_NAMES,
      ...deps.config.passthroughNames,
    ]);
  }

  private sessionOptions(workspace: string): ReaSessionOptions {
    return {
      reaRoot: this.deps.config.reaRoot,
      sourceSha: this.reaSourceSha,
      workspace,
      ambientEnv: this.deps.env,
      passthroughNames: this.deps.config.passthroughNames,
      logLevel: "warn",
    };
  }

  async register(): Promise<void> {
    await mkdir(this.deps.config.workspaceRoot, {
      recursive: true,
      mode: 0o700,
    });
    const { report, reaInfo } = await buildCapabilityReport(
      this.deps.config,
      this.deps.env,
    );
    this.reaSourceSha = reaInfo?.source_sha ?? null;
    this.reaIdentity = report.rea
      ? {
          package_version: report.rea.package_version,
          source_sha: report.rea.source_sha,
          catalog_digest: report.rea.catalog.digests["mcp_tools"] ?? null,
        }
      : null;
    const registered = await this.client.register(report);
    this.deps.log("info", "runner registered", {
      runner_id: registered.runner_id,
      tools: report.tools_list.length,
      rea_unavailable_reason: report.rea_unavailable_reason,
    });
    this.keeper = new LeaseKeeper(
      this.client,
      registered.heartbeat_interval_ms,
      (m, f) => this.deps.log("warn", m, f),
    );
    this.keeper.start();
  }

  /** Claim loop. Resolves when stop() is called and in-flight jobs settle. */
  async run(): Promise<void> {
    if (!this.keeper) await this.register();
    while (!this.stopping) {
      if (this.active.size >= this.deps.config.maxJobs) {
        await Promise.race(this.active.values());
        continue;
      }
      let claimed: ClaimResponse | null = null;
      try {
        claimed = await this.client.claim(20_000, this.claimAbort.signal);
      } catch (error) {
        if (this.stopping) break;
        this.deps.log("warn", "claim failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }
      if (!claimed) continue;
      const jobId = claimed.job.id;
      const task = this.execute(claimed).finally(() =>
        this.active.delete(jobId),
      );
      this.active.set(jobId, task);
    }
    await Promise.allSettled(this.active.values());
  }

  /** Stop claiming; abort running jobs without completing them (leases expire → interrupted → requeued). */
  async stop(
    options: { abortJobs: boolean } = { abortJobs: true },
  ): Promise<void> {
    this.stopping = true;
    this.claimAbort.abort();
    if (options.abortJobs)
      for (const lease of this.leases())
        lease.abort.abort({ kind: "shutdown" });
    await Promise.allSettled(this.active.values());
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    await this.sessions.closeAll();
    this.keeper?.stop();
  }

  private readonly leaseRegistry = new Map<string, ActiveLease>();
  private leases(): ActiveLease[] {
    return [...this.leaseRegistry.values()];
  }

  private scheduleIdleClose(investigationId: string): void {
    const existing = this.idleTimers.get(investigationId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.idleTimers.delete(investigationId);
      const session = this.sessions.forInvestigation(investigationId);
      if (session) void this.sessions.close(session.id);
    }, this.deps.config.sessionIdleMs);
    timer.unref();
    this.idleTimers.set(investigationId, timer);
  }

  async execute(claim: ClaimResponse): Promise<void> {
    const { job, fencing_token } = claim;
    const abort = new AbortController();
    let usageTracker: UsageTracker | null = null;
    const lease: ActiveLease = {
      jobId: job.id,
      fencingToken: fencing_token,
      abort,
      usage: () => usageTracker?.snapshot() ?? job.usage,
      approvals: new Map(),
      lost: false,
      cancelRequested: false,
    };
    const ctx = new JobContext(
      job,
      fencing_token,
      this.client,
      lease,
      (usageTracker = new UsageTracker(
        job.budget,
        join(this.deps.config.workspaceRoot, "jobs", job.id),
        (dimension) => abort.abort({ kind: "budget_exceeded", dimension }),
      )),
      this.deps.config.workspaceRoot,
      this.deps.log,
      this.redactor,
    );
    this.leaseRegistry.set(job.id, lease);
    this.keeper?.add(lease);
    usageTracker.start();
    let investigationId: string | null = null;
    let keepSession = false;
    try {
      await ctx.prepareWorkspace();
      if (!SUPPORTED_JOB_KINDS.has(job.kind)) {
        await this.finish(
          ctx,
          "failed",
          null,
          {
            code: "capability_unavailable",
            message: `this runner does not execute ${job.kind} jobs`,
            retryable: false,
          },
          { status: "cleanup_complete", remaining_resource_kinds: [] },
        );
        return;
      }
      await this.client.transition(job.id, fencing_token, "running");
      if (job.kind === "investigation.run") {
        const input = parseInvestigationInput(job.input);
        investigationId = input.investigation_id;
        let targetPath: string | null = null;
        if (input.target.kind !== "url") {
          await mkdir(join(ctx.workspace, "target"), { recursive: true });
          const safeName =
            input.target.name.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 200) ||
            "target";
          targetPath = join(ctx.workspace, "target", safeName);
          const bytes = await this.client.downloadInput(
            job.id,
            fencing_token,
            "target",
            targetPath,
            abort.signal,
          );
          await ctx.progress("target downloaded", { bytes });
        }
        const run = new InvestigationRun(ctx, input, {
          sessions: this.sessions,
          provider: this.deps.provider,
          sessionOptions: (workspace) => this.sessionOptions(workspace),
        });
        const result = await run.run(targetPath);
        keepSession = true;
        this.scheduleIdleClose(input.investigation_id);
        await this.finish(ctx, "succeeded", { ...result }, null, {
          status: "cleanup_complete",
          remaining_resource_kinds: [],
          detail: `REA session ${result.session_id} retained for follow-ups for ${this.deps.config.sessionIdleMs} ms; evidence bundle exported`,
        });
      } else if (job.kind === "investigation.compare") {
        // Runs in its own short-lived session, closed by runComparison.
        const result = await runComparison(
          ctx,
          {
            sessions: this.sessions,
            sessionOptions: (workspace) => this.sessionOptions(workspace),
          },
          job.input,
        );
        await this.finish(ctx, "succeeded", result, null, {
          status: "cleanup_complete",
          remaining_resource_kinds: [],
          detail: "comparison session closed",
        });
      } else if (
        job.kind === "preservation.plan" ||
        job.kind === "preservation.capture"
      ) {
        const deps = this.preservationDeps();
        const result =
          job.kind === "preservation.plan"
            ? await runPreservationPlan(ctx, deps)
            : await runPreservationCapture(ctx, deps);
        await this.finish(ctx, "succeeded", result, null, {
          status: "cleanup_complete",
          remaining_resource_kinds: [],
          detail: "staging package and collector workspace removed",
        });
      } else if (job.kind === "investigation.export") {
        const result = await runExport(ctx, job.input);
        await this.finish(ctx, "succeeded", result, null, {
          status: "cleanup_complete",
          remaining_resource_kinds: [],
        });
      } else {
        investigationId = String(job.input["investigation_id"] ?? "");
        keepSession = true;
        const result = await runFollowUp(ctx, this.sessions, job.input);
        this.scheduleIdleClose(investigationId);
        await this.finish(ctx, "succeeded", result, null, {
          status: "cleanup_complete",
          remaining_resource_kinds: [],
        });
      }
    } catch (error) {
      keepSession = false;
      await this.handleFailure(ctx, error, investigationId);
    } finally {
      usageTracker.stop();
      this.keeper?.remove(job.id);
      this.leaseRegistry.delete(job.id);
      if (!keepSession && investigationId && job.kind === "investigation.run") {
        const session = this.sessions.forInvestigation(investigationId);
        if (session) await this.sessions.close(session.id);
      }
      await rm(join(ctx.workspace, "target"), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  }

  private preservationDeps(): PreservationDeps {
    return {
      env: this.deps.env,
      localPaths: () =>
        resolveLocalPaths(this.deps.config.localTargetAllowlist),
      producerVersion: RUNNER_VERSION,
      upstreamRea: this.reaIdentity,
      verifierBundlePath: this.deps.config.verifierBundlePath,
    };
  }

  private async handleFailure(
    ctx: JobContext,
    error: unknown,
    investigationId: string | null,
  ): Promise<void> {
    const reason = abortReasonOf(ctx.signal);
    let cleanup: CleanupReport = {
      status: "not_attempted",
      remaining_resource_kinds: [],
    };
    if (investigationId && ctx.job.kind === "investigation.run") {
      const session = this.sessions.forInvestigation(investigationId);
      if (session) {
        const closed = await session.close();
        await this.sessions.close(session.id);
        cleanup = {
          status: closed.status,
          remaining_resource_kinds: closed.remaining_resource_kinds,
          ...(closed.detail ? { detail: closed.detail } : {}),
        };
      } else
        cleanup = { status: "cleanup_complete", remaining_resource_kinds: [] };
    }
    await ctx.emit("job.cleanup", { ...cleanup });
    if (
      reason?.kind === "lease_lost" ||
      reason?.kind === "shutdown" ||
      ctx.lease.lost
    ) {
      // Not ours to complete: the lease is gone or will expire and be reassigned.
      this.deps.log("warn", "job abandoned", { job_id: ctx.job.id, reason });
      return;
    }
    if (reason?.kind === "cancelled") {
      await this.finish(ctx, "cancelled", null, null, cleanup);
      return;
    }
    const failure: JobFailure =
      reason?.kind === "budget_exceeded"
        ? {
            code: "budget_exceeded",
            message: `budget dimension exceeded: ${reason.dimension}`,
            details: { dimension: reason.dimension },
            retryable: false,
          }
        : error instanceof SourceRefusedError
          ? {
              code: "unsafe_url",
              message: error.message,
              retryable: false,
            }
          : error instanceof SessionClosedError
            ? {
                code: "capability_unavailable",
                message: error.message,
                details: { reason: "session_closed" },
                retryable: false,
              }
            : {
                code: "runner_error",
                message: this.redactor
                  .redactText(
                    error instanceof Error ? error.message : String(error),
                  )
                  .slice(0, 2000),
                retryable: false,
              };
    await this.finish(ctx, "failed", null, failure, cleanup);
  }

  private async finish(
    ctx: JobContext,
    outcome: "succeeded" | "failed" | "cancelled",
    result: Record<string, unknown> | null,
    failure: JobFailure | null,
    cleanup: CleanupReport,
  ): Promise<void> {
    try {
      await ctx.usage.sample();
      await this.client.complete(ctx.job.id, {
        fencing_token: ctx.fencingToken,
        outcome,
        result: result
          ? (this.redactor.redactValue(result) as Record<string, unknown>)
          : null,
        failure,
        usage: ctx.usage.snapshot(),
        cleanup,
      });
    } catch (error) {
      this.deps.log(
        error instanceof ControlPlaneError && error.isStale ? "warn" : "error",
        "complete rejected",
        {
          job_id: ctx.job.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
}
