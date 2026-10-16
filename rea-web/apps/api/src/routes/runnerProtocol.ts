import {
  ApiError,
  type JobEventKind,
  type JobFailure,
  buildJobInputSchema,
  planJobInputSchema,
  recoveryManifestSchema,
  validateRelativePath,
  type JobRequirements,
  RUNNER_PROTOCOL_VERSION,
  digestCapabilities,
  targetClassSchema,
  unmetRequirements,
  uuidv7,
} from "@rea-web/contracts";
import type { JobRecord, JsonObject } from "@rea-web/db";
import type { AppContext } from "../context.js";
import {
  activeLeaseCount,
  evidenceArtifactOwner,
  findRunnerLocalTargetId,
} from "../db/extra.js";
import type { PresentedLease } from "../orchestrator/fencing.js";
import {
  parseArtifactHeaders,
  parseFencingHeader,
  capturePrefix,
  planArtifact,
  requireInput,
  storeArtifact,
} from "./artifacts.js";
import {
  digestSummary,
  evidenceView,
  findingView,
  jobView,
  runnerFacts,
  targetView,
  toolCallView,
} from "./mappers.js";
import { viewsFor } from "./investigations.js";
import { applyJobResult, assertJobResult } from "./runnerResults.js";
import { sendObject } from "./streaming.js";
import { STREAMED, type HandlersFor, type RouteContext } from "./types.js";
import { declaredLength } from "./uploads.js";
import type { RunnerPrincipal } from "../auth/principal.js";

/** Events a runner may append; lifecycle kinds are written only by the API. */
const RUNNER_EVENT_KINDS: ReadonlySet<JobEventKind> = new Set<JobEventKind>([
  "job.progress",
  "job.log",
  "job.tool_call",
  "job.budget",
  "job.cleanup",
]);

type Rc = RouteContext<unknown, unknown, unknown>;

const heartbeatIntervalMs = (leaseTtlMs: number): number =>
  Math.max(1, Math.floor(leaseTtlMs / 3));

/**
 * Loads a job for a runner call. A job in another project does not exist for
 * this runner; a job currently leased to a different runner is `forbidden`.
 * Whether the presented token is current is decided by the fenced write.
 */
const loadRunnerJob = async (
  ctx: AppContext,
  principal: RunnerPrincipal,
  jobId: string,
): Promise<JobRecord> => {
  const job = await ctx.repos.jobs.findById(jobId);
  if (job === null || job.project_id !== principal.runner.project_id)
    throw new ApiError("not_found", "Job not found");
  if (job.lease !== null && job.lease.runner_id !== principal.runner.id)
    throw new ApiError("forbidden", "Job is leased to another runner");
  return job;
};

const presented = (
  principal: RunnerPrincipal,
  jobId: string,
  fencingToken: number,
): PresentedLease => ({
  job_id: jobId,
  runner_id: principal.runner.id,
  fencing_token: fencingToken,
});

const requireSelf = (principal: RunnerPrincipal, runnerId: string): void => {
  if (principal.runner.id !== runnerId)
    throw new ApiError("forbidden", "Runner token does not match runner id");
};

const investigationOf = async (
  ctx: AppContext,
  job: JobRecord,
): Promise<string> => {
  const id = requireInput(job, "investigation_id");
  const investigation = await ctx.repos.investigations.findById(
    job.project_id,
    id,
  );
  if (investigation === null)
    throw new ApiError("not_found", "Investigation not found");
  return investigation.id;
};

const matcher =
  (digest: ReturnType<typeof digestCapabilities>) =>
  (requirements: JobRequirements): boolean =>
    unmetRequirements(digest, requirements).length === 0;

/** Resolves after `ms`, on any bus event, or when the request goes away. */
const waitForWork = (ctx: AppContext, rc: Rc, ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const unsubscribe = ctx.bus.subscribeAll(done);
    rc.req.raw.once("close", done);
    function done(): void {
      clearTimeout(timer);
      unsubscribe();
      rc.req.raw.off("close", done);
      resolve();
    }
  });

const objectKeyUnder = (prefix: string, key: string | null): void => {
  if (key !== null && !key.startsWith(prefix))
    throw new ApiError(
      "forbidden",
      "Object key is outside the investigation's storage",
      {
        prefix,
      },
    );
};

export const runnerProtocolHandlers = (): HandlersFor<
  | "runnerRegister"
  | "runnerClaim"
  | "runnerHeartbeat"
  | "runnerLocalTargets"
  | "runnerPostEvents"
  | "runnerToolCall"
  | "runnerUploadArtifact"
  | "runnerGetInput"
  | "runnerTransition"
  | "runnerComplete"
  | "runnerFindings"
> => ({
  async runnerRegister({ ctx, runner, body }) {
    const digest = digestCapabilities(body);
    const updated = await ctx.repos.runners.updateCapabilities(
      runner.runner.id,
      {
        capability_report: body as unknown as JsonObject,
        capability_digest: digestSummary(digest),
      },
    );
    if (updated === null)
      throw new ApiError("unauthorized", "Runner is revoked");
    return {
      runner_id: runner.runner.id,
      project_id: runner.runner.project_id,
      server_time: ctx.now().toISOString(),
      protocol_version: RUNNER_PROTOCOL_VERSION,
      lease_ttl_ms: ctx.config.leaseTtlMs,
      heartbeat_interval_ms: heartbeatIntervalMs(ctx.config.leaseTtlMs),
    };
  },

  async runnerClaim(rc) {
    const { ctx, runner, params, body, reply } = rc;
    requireSelf(runner, params.r);
    const { report, digest } = runnerFacts(runner.runner);
    if (report === null || digest === null)
      throw new ApiError(
        "capability_unavailable",
        "Register a capability report before claiming jobs",
        { reason: "not_registered" },
      );
    await ctx.repos.runners.touch(runner.runner.id);
    const waitMs = Math.min(body.wait_ms, 25_000);
    const deadline = Date.now() + waitMs;
    const matches = matcher(digest);
    let closed = false;
    rc.req.raw.once("close", () => {
      closed = true;
    });
    for (;;) {
      if (
        (await activeLeaseCount(ctx.db, runner.runner.id)) <
        report.max_concurrent_jobs
      ) {
        const claimed = await ctx.repos.jobs.claim({
          runner_id: runner.runner.id,
          lease_ttl_ms: ctx.config.leaseTtlMs,
          matches,
        });
        if (claimed !== null)
          return {
            job: jobView(claimed.job),
            fencing_token: claimed.fencing_token,
            lease_expires_at: claimed.lease_expires_at,
          };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || closed) break;
      await waitForWork(ctx, rc, Math.min(ctx.config.claimPollMs, remaining));
      if (closed) break;
    }
    void reply.code(204).send();
    return STREAMED;
  },

  async runnerHeartbeat({ ctx, runner, params, body }) {
    requireSelf(runner, params.r);
    await ctx.repos.runners.touch(runner.runner.id);
    if (body.capability_report !== undefined) {
      await ctx.repos.runners.updateCapabilities(runner.runner.id, {
        capability_report: body.capability_report as unknown as JsonObject,
        capability_digest: digestSummary(
          digestCapabilities(body.capability_report),
        ),
      });
    }
    const leases = [];
    for (const lease of body.leases) {
      const job = await ctx.repos.jobs.findById(lease.job_id);
      if (job === null || job.project_id !== runner.runner.project_id) {
        leases.push({
          job_id: lease.job_id,
          fencing_token: lease.fencing_token,
          accepted: false,
          reason: "not_leased",
          cancel_requested: false,
          approvals: [],
        });
        continue;
      }
      const result = await ctx.repos.jobs.heartbeat({
        job_id: lease.job_id,
        runner_id: runner.runner.id,
        fencing_token: lease.fencing_token,
        lease_ttl_ms: ctx.config.leaseTtlMs,
        usage: lease.usage,
      });
      const decisions = result.accepted
        ? await ctx.repos.approvals.undeliveredDecisions(lease.job_id)
        : [];
      await ctx.repos.approvals.markDelivered(
        decisions.map((d) => d.approval_id),
      );
      leases.push({
        job_id: lease.job_id,
        fencing_token: lease.fencing_token,
        accepted: result.accepted,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.lease_expires_at === undefined
          ? {}
          : { lease_expires_at: result.lease_expires_at }),
        cancel_requested: result.cancel_requested,
        approvals: decisions.flatMap((d) =>
          d.decision === null || d.decided_by === null || d.decided_at === null
            ? []
            : [
                {
                  approval_id: d.approval_id,
                  decision: d.decision,
                  decided_by: d.decided_by,
                  decided_at: d.decided_at,
                },
              ],
        ),
      });
    }
    return { leases };
  },

  async runnerLocalTargets({ ctx, runner, params, body }) {
    requireSelf(runner, params.r);
    const items = [];
    for (const entry of body.targets) {
      if (entry.project_id !== runner.runner.project_id)
        throw new ApiError("forbidden", "Target belongs to another project");
      const existingId = await findRunnerLocalTargetId(
        ctx.db,
        runner.runner.project_id,
        runner.runner.id,
        entry.path_hash,
      );
      const existing =
        existingId === null
          ? null
          : await ctx.repos.targets.findById(
              runner.runner.project_id,
              existingId,
            );
      const record =
        existing ??
        (await ctx.repos.targets.create({
          id: uuidv7(),
          project_id: runner.runner.project_id,
          kind: "runner_local",
          name: entry.name,
          class: targetClassSchema.catch("unknown").parse(entry.kind),
          sha256: entry.sha256,
          size: entry.size,
          runner_id: runner.runner.id,
          runner_path_hash: entry.path_hash,
          metadata: { path_hash: entry.path_hash, reported_kind: entry.kind },
          created_by: null,
        }));
      items.push(targetView(record));
    }
    return { items };
  },

  async runnerPostEvents({ ctx, runner, params, body }) {
    const job = await loadRunnerJob(ctx, runner, params.j);
    const rejected = body.events.filter((e) => !RUNNER_EVENT_KINDS.has(e.kind));
    if (rejected.length > 0)
      throw new ApiError(
        "validation_failed",
        "Event kind may not be posted by a runner",
        {
          kinds: [...new Set(rejected.map((e) => e.kind))],
          allowed: [...RUNNER_EVENT_KINDS],
        },
      );
    const seqs = await ctx.fencing.appendEvents(
      presented(runner, job.id, body.fencing_token),
      body.events,
    );
    return { seqs };
  },

  async runnerToolCall({ ctx, runner, params, body }) {
    const job = await loadRunnerJob(ctx, runner, params.j);
    const investigationId = await investigationOf(ctx, job);
    if (body.investigation_id !== investigationId)
      throw new ApiError(
        "forbidden",
        "Tool call belongs to a different investigation",
      );
    const prefix = `projects/${job.project_id}/investigations/${investigationId}/`;
    objectKeyUnder(prefix, body.raw_result_object_key);
    objectKeyUnder(prefix, body.arguments_object_key);
    const record = await ctx.fencing.withLease(
      presented(runner, job.id, body.fencing_token),
      "tool_call",
      () =>
        ctx.repos.toolCalls.create({
          investigation_id: investigationId,
          job_id: job.id,
          upstream_seq: body.upstream_seq,
          tool_name: body.tool_name,
          upstream_session_id: body.upstream_session_id,
          arguments_object_key: body.arguments_object_key,
          raw_result_object_key: body.raw_result_object_key,
          raw_result_sha256: body.raw_result_sha256,
          raw_result_bytes: body.raw_result_bytes,
          derived: body.derived as JsonObject,
          evidence_id: body.evidence_id,
          effects: body.effects,
          is_error: body.is_error,
          duration_ms: body.duration_ms,
          started_at: body.started_at,
        }),
    );
    return toolCallView(record);
  },

  async runnerUploadArtifact(rc) {
    const { ctx, runner, params, req } = rc;
    const token = parseFencingHeader(req);
    const headers = parseArtifactHeaders(req);
    const job = await loadRunnerJob(ctx, runner, params.j);
    const lease = presented(runner, job.id, token);
    // Fail fast before any bytes are read; re-checked when the row is written.
    await ctx.fencing.assertCurrent(lease, "artifact_upload");
    const plan = planArtifact(ctx, job, headers);
    const result = await storeArtifact(ctx, lease, plan, {
      stream: req.raw,
      contentLength: declaredLength(req),
      truncated: () => false,
    });
    return result;
  },

  async runnerGetInput(rc) {
    const { ctx, runner, params, req, reply } = rc;
    const job = await loadRunnerJob(ctx, runner, params.j);
    await ctx.fencing.assertCurrent(
      presented(runner, job.id, parseFencingHeader(req)),
      "input",
    );
    return serveInput(ctx, reply, job, params.name);
  },

  async runnerTransition({ ctx, runner, params, body }) {
    const job = await loadRunnerJob(ctx, runner, params.j);
    if (body.to === "awaiting_approval") {
      if (body.approval === undefined)
        throw new ApiError(
          "validation_failed",
          "approval is required for awaiting_approval",
        );
      if ((await ctx.repos.approvals.find(body.approval.approval_id)) !== null)
        throw new ApiError("conflict", "approval_id already exists");
    }
    if (
      body.to === "running" &&
      job.state === "awaiting_approval" &&
      (await ctx.repos.approvals.pendingForJob(job.id)).length > 0
    )
      throw new ApiError("conflict", "An approval is still pending");
    const updated = await ctx.repos.jobs.transition({
      job_id: job.id,
      fencing_token: body.fencing_token,
      to: body.to,
      actor: "runner",
      event_payload:
        body.approval === undefined
          ? {}
          : { approval_id: body.approval.approval_id },
    });
    if (body.approval !== undefined) {
      await ctx.repos.approvals.create({
        approval_id: body.approval.approval_id,
        job_id: job.id,
        tool: body.approval.tool,
        arguments: body.approval.arguments as JsonObject,
        effects: body.approval.effects,
        reason: body.approval.reason,
      });
      await ctx.repos.jobEvents.append(
        undefined,
        job.id,
        "job.approval_requested",
        {
          approval_id: body.approval.approval_id,
          tool: body.approval.tool,
          effects: body.approval.effects,
          reason: body.approval.reason,
        },
      );
    }
    if (body.to === "running" && job.kind === "preservation.capture") {
      const capture = await ctx.repos.captures.findByJobId(job.id);
      if (capture !== null && capture.started_at === null)
        await ctx.repos.captures.update(capture.id, {
          status: "running",
          started_at: ctx.now(),
        });
    }
    return jobView(updated);
  },

  async runnerComplete({ ctx, runner, params, body }) {
    const job = await loadRunnerJob(ctx, runner, params.j);
    assertJobResult(job.kind, body.outcome, body.result);
    const lease = presented(runner, job.id, body.fencing_token);
    await ctx.fencing.appendEvents(lease, [
      { kind: "job.cleanup", payload: { ...body.cleanup } },
    ]);
    const failure: JobFailure | null =
      body.failure ??
      (body.outcome === "failed"
        ? {
            code: "runner_reported_failure",
            message: "The runner reported failure without details",
            retryable: false,
          }
        : null);
    const completed = await ctx.repos.jobs.complete({
      job_id: job.id,
      runner_id: runner.runner.id,
      fencing_token: body.fencing_token,
      outcome: body.outcome,
      result: body.result as JsonObject | null,
      failure,
      usage: body.usage,
    });
    try {
      await applyJobResult(ctx, completed, runner.runner.id);
    } catch (error) {
      ctx.logger.error(
        { err: error, job_id: job.id },
        "applying job result failed",
      );
      await ctx.repos.jobEvents
        .append(undefined, job.id, "job.log", {
          level: "error",
          message: "result_apply_failed",
        })
        .catch(() => undefined);
    }
    return jobView(completed);
  },

  async runnerFindings({ ctx, runner, params, body }) {
    const job = await loadRunnerJob(ctx, runner, params.j);
    const investigationId = await investigationOf(ctx, job);
    if (body.investigation_id !== investigationId)
      throw new ApiError(
        "forbidden",
        "Findings belong to a different investigation",
      );
    const created = await ctx.fencing.withLease(
      presented(runner, job.id, body.fencing_token),
      "findings",
      () =>
        ctx.repos.findings.createMany(
          body.findings.map((finding) => ({
            investigation_id: investigationId,
            class: finding.class,
            title: finding.title,
            body: finding.body,
            evidence_ids: finding.evidence_ids,
            tool_call_seqs: finding.tool_call_seqs,
            limitations: finding.limitations,
            source: finding.source,
          })),
        ),
    );
    return { count: created.length };
  },
});

const serveInput = async (
  ctx: AppContext,
  reply: RouteContext<unknown, unknown, unknown>["reply"],
  job: JobRecord,
  name: string,
) => {
  const projectId = job.project_id;
  const json = (value: unknown) => {
    void reply.header("cache-control", "private, no-store");
    void reply.type("application/json; charset=utf-8");
    void reply.send(value);
    return STREAMED;
  };
  if (name === "target") {
    const target = await ctx.repos.targets.findById(
      projectId,
      requireInput(job, "target_id"),
    );
    if (target === null) throw new ApiError("not_found", "Target not found");
    if (target.object_key === null)
      return json({
        kind: target.kind,
        url: target.url,
        name: target.name,
        class: target.class,
      });
    return sendObject(ctx, reply, target.object_key, {
      contentType: "application/octet-stream",
      filename: target.name,
      sha256: target.sha256,
      size: target.size,
    });
  }
  if (name === "build") {
    const build = await ctx.repos.builds.findById(
      projectId,
      requireInput(job, "build_id"),
    );
    if (build === null) throw new ApiError("not_found", "Build not found");
    const project = await ctx.repos.projects.findById(projectId);
    return json(
      buildJobInputSchema.parse({
        id: build.id,
        name: build.name,
        description: build.description,
        source: build.source,
        components: build.components,
        project_slug: project?.slug ?? projectId,
      }),
    );
  }
  if (name === "plan") {
    const plan = await ctx.repos.plans.findById(
      projectId,
      requireInput(job, "plan_id"),
    );
    if (plan === null || plan.plan === null)
      throw new ApiError("not_found", "Plan not found");
    return json(
      planJobInputSchema.parse({
        ...plan.plan,
        id: plan.id,
        build_id: plan.build_id,
      }),
    );
  }
  if (name === "manifest") {
    const capture = await ctx.repos.captures.findById(
      projectId,
      requireInput(job, "capture_id"),
    );
    if (capture === null || capture.manifest_object_key === null)
      throw new ApiError("not_found", "Manifest not found");
    return sendObject(ctx, reply, capture.manifest_object_key, {
      contentType: "application/json; charset=utf-8",
      sha256: capture.manifest_sha256,
    });
  }
  const captureFile = /^capture-file-(\d{1,6})$/u.exec(name);
  if (captureFile?.[1] !== undefined) {
    // Package files are addressed by their index in the stored manifest, which
    // owns file identity; the runner checks each digest against it.
    const capture = await ctx.repos.captures.findById(
      projectId,
      requireInput(job, "capture_id"),
    );
    if (capture === null || capture.manifest_object_key === null)
      throw new ApiError("not_found", "Manifest not found");
    const manifest = recoveryManifestSchema.parse(
      await readJsonObject(
        ctx,
        capture.manifest_object_key,
        MANIFEST_READ_LIMIT,
      ),
    );
    const file = manifest.files[Number(captureFile[1])];
    if (file === undefined)
      throw new ApiError("not_found", "No such package file", { name });
    const checked = validateRelativePath(file.path);
    if (!checked.ok)
      throw new ApiError("unsafe_path", "Manifest file path is not safe", {
        rejection: checked.rejection,
      });
    return sendObject(
      ctx,
      reply,
      `${capturePrefix(projectId, capture.build_id, capture.id)}/${checked.path}`,
      {
        contentType: "application/octet-stream",
        sha256: file.sha256,
        size: file.size,
      },
    );
  }
  const artifact = /^artifact-([0-9a-f-]{36})$/u.exec(name);
  if (artifact?.[1] !== undefined) {
    const found = await evidenceFor(ctx, job, artifact[1]);
    return sendObject(ctx, reply, found.object_key, {
      contentType: "application/octet-stream",
      filename: found.name,
      sha256: found.sha256,
      size: found.size,
    });
  }
  const investigation = /^investigation-([0-9a-f-]{36})$/u.exec(name);
  if (investigation?.[1] !== undefined)
    return json(await investigationInput(ctx, projectId, investigation[1]));
  const raw = /^raw-([0-9a-f-]{36})-(\d{1,9})$/u.exec(name);
  if (raw?.[1] !== undefined && raw[2] !== undefined) {
    const record = await ctx.repos.investigations.findById(projectId, raw[1]);
    if (record === null)
      throw new ApiError("not_found", "Investigation not found");
    const call = await ctx.repos.toolCalls.findBySeq(record.id, Number(raw[2]));
    if (call === null) throw new ApiError("not_found", "Tool call not found");
    return sendObject(ctx, reply, call.raw_result_object_key, {
      contentType: "application/json; charset=utf-8",
      sha256: call.raw_result_sha256,
      size: call.raw_result_bytes,
    });
  }
  throw new ApiError("not_found", "Unknown job input", { name });
};

const ARGUMENTS_READ_LIMIT = 4 * 1024 * 1024;

/** Reads a small stored JSON object; absent or unparseable objects are `null`. */
/** Manifests list every package file; allow far more than tool arguments. */
const MANIFEST_READ_LIMIT = 64 * 1024 * 1024;

const readJsonObject = async (
  ctx: AppContext,
  key: string | null,
  limit = ARGUMENTS_READ_LIMIT,
): Promise<unknown> => {
  if (key === null) return null;
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of await ctx.store.get(key)) {
      const buffer = Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > limit) return null;
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    ctx.logger.warn({ err: error, key }, "stored tool arguments unreadable");
    return null;
  }
};

/**
 * Everything an export or comparison needs to know about one investigation of
 * the job's own project. Raw results stay out of line (`raw-<id>-<seq>`).
 */
const investigationInput = async (
  ctx: AppContext,
  projectId: string,
  investigationId: string,
) => {
  const record = await ctx.repos.investigations.findById(
    projectId,
    investigationId,
  );
  if (record === null)
    throw new ApiError("not_found", "Investigation not found");
  const [view] = await viewsFor(ctx, [record]);
  const toolCalls = [];
  for (let afterSeq = 0; ;) {
    const page = await ctx.repos.toolCalls.listByInvestigation(record.id, {
      afterSeq,
      limit: 1000,
    });
    toolCalls.push(...page);
    const last = page[page.length - 1];
    if (page.length < 1000 || last === undefined) break;
    afterSeq = last.seq;
  }
  const [findings, artifacts] = await Promise.all([
    ctx.repos.findings.listByInvestigation(record.id),
    ctx.repos.evidenceArtifacts.listByInvestigation(record.id),
  ]);
  return {
    investigation: view,
    findings: findings.map(findingView),
    tool_calls: await Promise.all(
      toolCalls.map(async (call) => ({
        ...toolCallView(call),
        arguments: await readJsonObject(ctx, call.arguments_object_key),
        has_raw: (await ctx.store.head(call.raw_result_object_key)) !== null,
      })),
    ),
    artifacts: artifacts.map(evidenceView),
  };
};

/** Evidence artifacts a job may read: any in its project (compare/export inputs). */
const evidenceFor = async (
  ctx: AppContext,
  job: JobRecord,
  artifactId: string,
) => {
  const owner = await evidenceArtifactOwner(ctx.db, artifactId);
  if (owner === null || owner.project_id !== job.project_id)
    throw new ApiError("not_found", "Artifact not found");
  const artifact = await ctx.repos.evidenceArtifacts.findById(
    owner.investigation_id,
    artifactId,
  );
  if (artifact === null) throw new ApiError("not_found", "Artifact not found");
  return artifact;
};
