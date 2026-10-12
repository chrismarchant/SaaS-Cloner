import { ApiError } from "@rea-web/contracts";
import { activeLeaseCounts } from "../db/extra.js";
import { newRunnerToken } from "../auth/credentials.js";
import { interruptRunnerLeases } from "../orchestrator/revocation.js";
import { runnerFacts, runnerSummaryView } from "./mappers.js";
import type { HandlersFor } from "./types.js";

export const runnerAdminHandlers = (): HandlersFor<
  | "createRunner"
  | "listRunners"
  | "getRunnerCapabilities"
  | "revokeRunner"
  | "projectTools"
> => ({
  async createRunner({ ctx, user, params, body }) {
    const { token, hash } = newRunnerToken();
    const runner = await ctx.repos.runners.create({
      project_id: params.p,
      name: body.name,
      token_hash: hash,
      labels: body.labels,
      created_by: user.user.id,
    });
    return { id: runner.id, name: runner.name, token };
  },

  async listRunners({ ctx, params }) {
    const [runners, leases] = await Promise.all([
      ctx.repos.runners.list(params.p),
      activeLeaseCounts(ctx.db, params.p),
    ]);
    return {
      items: runners.map((runner) =>
        runnerSummaryView(runner, leases.get(runner.id) ?? 0),
      ),
    };
  },

  async getRunnerCapabilities({ ctx, params }) {
    const runner = await ctx.repos.runners.findById(params.p, params.r);
    if (runner === null) throw new ApiError("not_found", "Runner not found");
    const leases = await activeLeaseCounts(ctx.db, params.p);
    // The report is returned verbatim as stored; only its parsed form is validated.
    const { report } = runnerFacts(runner);
    return {
      runner: runnerSummaryView(runner, leases.get(runner.id) ?? 0),
      report,
    };
  },

  async revokeRunner({ ctx, params }) {
    const runner = await ctx.repos.runners.findById(params.p, params.r);
    if (runner === null) throw new ApiError("not_found", "Runner not found");
    await ctx.repos.runners.revoke(runner.id);
    await interruptRunnerLeases(ctx, runner.id);
    return { ok: true as const };
  },

  async projectTools({ ctx, params }) {
    const runners = await ctx.repos.runners.list(params.p);
    interface Entry {
      name: string;
      title: string | null;
      description: string | null;
      annotations: Record<string, unknown> | null;
      input_schema: Record<string, unknown>;
      input_schema_sha256: string;
      per_runner: Array<{
        runner_id: string;
        runner_name: string;
        available: boolean;
        target_required: boolean;
        reason: string | null;
        remediation: string | null;
      }>;
    }
    const tools = new Map<string, Entry>();
    for (const runner of runners) {
      if (runner.revoked_at !== null) continue;
      const { report, digest } = runnerFacts(runner);
      if (report === null || digest === null) continue;
      for (const tool of report.tools_list) {
        let entry = tools.get(tool.name);
        if (entry === undefined) {
          entry = {
            name: tool.name,
            title: tool.title ?? null,
            description: tool.description ?? null,
            annotations: tool.annotations ?? null,
            input_schema: tool.input_schema,
            input_schema_sha256: tool.input_schema_sha256,
            per_runner: [],
          };
          tools.set(tool.name, entry);
        }
        const available = digest.tools_available.includes(tool.name);
        const targetRequired = digest.tools_target_required.includes(tool.name);
        const unavailable = digest.tools_unavailable.get(tool.name);
        entry.per_runner.push({
          runner_id: runner.id,
          runner_name: runner.name,
          available,
          target_required: targetRequired,
          reason: available
            ? null
            : targetRequired
              ? "target_required"
              : (unavailable?.reason ?? "not_reported"),
          remediation: available ? null : (unavailable?.remediation ?? null),
        });
      }
    }
    return {
      items: [...tools.values()].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      ),
    };
  },
});
