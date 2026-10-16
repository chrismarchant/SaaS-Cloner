import * as artifacts from "./collectors/artifacts.js";
import * as assets from "./collectors/assets.js";
import * as data from "./collectors/data.js";
import * as dependencies from "./collectors/dependencies.js";
import * as infrastructure from "./collectors/infrastructure.js";
import * as integrations from "./collectors/integrations.js";
import * as product from "./collectors/product.js";
import * as source from "./collectors/source.js";
import {
  declarationProblems,
  orderedDeclarations,
  redactorForBuild,
} from "./declarations.js";
import { createRuntime, type Runtime } from "./runtime.js";
import {
  type BuildDefinition,
  type CollectorContext,
  type ComponentDeclaration,
  type ComponentPlan,
  type Omission,
  type PreservationPlanBody,
  DEFAULT_CONSISTENCY_WINDOW_MS,
  componentId,
  errorMessage,
} from "./types.js";

export const consistencyStrategyText = (
  windowMs: number = DEFAULT_CONSISTENCY_WINDOW_MS,
): string =>
  `Components are captured in this order: source, dependencies, data, assets, infrastructure, integrations, product, artifacts. ` +
  `Each database is captured first with pg_dump in a single REPEATABLE READ snapshot (all tables mutually consistent), and asset files are read immediately afterwards. ` +
  `A single recovery point is claimed only if every data and asset capture window falls inside one ${Math.round(windowMs / 1000)} s window (earliest start to latest end); ` +
  `if the window is exceeded the package is labelled inconsistent, and if any data or asset component could not be captured it is labelled unknown. ` +
  `Source, dependency and configuration components are not time-sensitive and do not affect the label.`;

const GLOBAL_OMISSIONS: Omission[] = [
  {
    what: "Secret and environment variable values",
    reason:
      "Exports are names-only by default; values are never read from the environment into the package.",
    remediation:
      "Keep values in your secret manager; supply them when restoring.",
  },
];

const planOne = (
  decl: ComponentDeclaration,
  rt: Runtime,
): Promise<ComponentPlan> => {
  switch (decl.kind) {
    case "source":
      return source.plan(decl, rt);
    case "dependencies":
      return dependencies.plan(decl, rt);
    case "data":
      return data.plan(decl, rt);
    case "assets":
      return assets.plan(decl, rt);
    case "infrastructure":
      return infrastructure.plan(decl, rt);
    case "integrations":
      return integrations.plan(decl, rt);
    case "product":
      return product.plan(decl, rt);
    case "artifacts":
      return artifacts.plan(decl, rt);
  }
};

/** Cheap checks only: ls-remote / rev-parse, select 1, directory readability, tool presence. */
export async function planPreservation(
  build: BuildDefinition,
  ctx: CollectorContext,
): Promise<PreservationPlanBody> {
  const redactor = redactorForBuild(build, ctx);
  const rt = createRuntime(build, { ...ctx, redactor });
  const problems = declarationProblems(build);
  const plans: ComponentPlan[] = [];
  for (const decl of orderedDeclarations(build)) {
    ctx.signal.throwIfAborted();
    try {
      const p = await planOne(decl, rt);
      if (
        problems.some(
          (x) =>
            x.includes(JSON.stringify(decl.id)) ||
            x.includes(componentId(decl)),
        )
      ) {
        p.permissions.push({
          check: "component declaration",
          ok: false,
          detail: problems.join("; "),
        });
        p.feasible = false;
      }
      plans.push(p);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      plans.push({
        id: componentId(decl),
        kind: decl.kind,
        collector: decl.kind,
        permissions: [
          {
            check: "planning",
            ok: false,
            detail: redactor.redactText(errorMessage(error)),
          },
        ],
        estimated_bytes: null,
        dependencies: [],
        method: "n/a",
        omissions: [],
        feasible: false,
      });
    }
  }
  // A component is only feasible if what it reads from is.
  const feasibleById = new Map(plans.map((p) => [p.id, p.feasible]));
  for (const p of plans)
    for (const dep of p.dependencies)
      if (
        p.kind !== "assets" &&
        feasibleById.get(dep) === false &&
        p.feasible
      ) {
        p.feasible = false;
        p.permissions.push({
          check: `depends on ${dep}`,
          ok: false,
          detail: `${dep} is not feasible`,
        });
      }
  const seen = new Set<string>();
  const known: Omission[] = [];
  for (const o of [...GLOBAL_OMISSIONS, ...plans.flatMap((p) => p.omissions)]) {
    const key = `${o.what}|${o.reason}`;
    if (!seen.has(key)) {
      seen.add(key);
      known.push(o);
    }
  }
  return {
    components: plans,
    consistency_strategy: consistencyStrategyText(),
    known_omissions: known,
  };
}
