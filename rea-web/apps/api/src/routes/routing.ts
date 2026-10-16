import {
  type RouteEntry,
  type TargetClass,
  routeFor,
  targetClassSchema,
  unmetRequirements,
  type routingSchema,
} from "@rea-web/contracts";
import type { z } from "zod";
import type { RunnerRecord, TargetRecord } from "@rea-web/db";
import type { AppContext } from "../context.js";
import { runnerFacts } from "./mappers.js";

export type Routing = z.input<typeof routingSchema>;

export const targetClassOf = (target: TargetRecord): TargetClass =>
  targetClassSchema.catch("unknown").parse(target.class);

/** Unmet requirements of one runner for one route entry (empty = satisfied). */
export const unmetForRoute = (runner: RunnerRecord, route: RouteEntry) => {
  const { digest } = runnerFacts(runner);
  if (digest === null)
    return [
      {
        kind: "runner",
        value: runner.name,
        reason: "never_connected",
        remediation:
          "Start the runner so it registers its capability report with the control plane.",
      },
    ];
  const unmet: Array<{
    kind: string;
    value: string;
    reason: string;
    remediation: string;
  }> = unmetRequirements(digest, {
    tools: route.required_tools,
    providers: [],
    os: route.required_os,
    labels: [],
  }).map((entry) => ({ ...entry }));
  const anyOf = route.required_providers_any_of;
  if (
    anyOf.length > 0 &&
    !anyOf.some((p) => digest.providers_available.includes(p))
  )
    unmet.push({
      kind: "provider",
      value: anyOf.join("|"),
      reason: "provider_unavailable",
      remediation: `Configure one of ${anyOf.join(", ")} on the runner; see its candidate diagnostics.`,
    });
  return unmet;
};

export const computeRouting = async (
  ctx: Pick<AppContext, "repos">,
  projectId: string,
  target: TargetRecord,
): Promise<Routing> => {
  const klass = targetClassOf(target);
  const route = routeFor(klass);
  const runners = (await ctx.repos.runners.list(projectId)).filter(
    (runner) =>
      runner.revoked_at === null &&
      (target.runner_id === null || target.runner_id === runner.id),
  );
  return {
    target_id: target.id,
    class: klass,
    first_tool: route.first_tool,
    rationale: route.rationale,
    requires_open_binary: route.requires_open_binary,
    required_tools: [...route.required_tools],
    required_providers_any_of: [...route.required_providers_any_of],
    required_os: [...route.required_os],
    candidate_runners: runners.map((runner) => {
      const unmet = unmetForRoute(runner, route);
      return {
        runner_id: runner.id,
        runner_name: runner.name,
        satisfied: unmet.length === 0,
        unmet,
      };
    }),
  };
};
