import { rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type RestoreStep,
  validateRestoreStepArguments,
} from "@rea-web/contracts";
import { type ComponentInput, PACKAGE_COMPONENT_ID } from "@rea-web/recovery";
import * as artifacts from "./collectors/artifacts.js";
import * as assets from "./collectors/assets.js";
import * as data from "./collectors/data.js";
import * as dependencies from "./collectors/dependencies.js";
import * as infrastructure from "./collectors/infrastructure.js";
import * as integrations from "./collectors/integrations.js";
import * as product from "./collectors/product.js";
import * as source from "./collectors/source.js";
import { createCaptureRuntime } from "./captureRuntime.js";
import {
  declarationProblems,
  orderedDeclarations,
  redactorForBuild,
} from "./declarations.js";
import {
  type ComponentResult,
  applyManifestFacts,
  toolVersions,
} from "./manifestFacts.js";
import {
  type CaptureRuntime,
  type CollectorOutcome,
  blockedOutcome,
  createRuntime,
} from "./runtime.js";
import {
  type BuildDefinition,
  type CaptureOptions,
  type CaptureResult,
  type CollectorContext,
  type ComponentCaptureStatus,
  type ComponentDeclaration,
  type Omission,
  type PreservationPlanBody,
  DEFAULT_CONSISTENCY_WINDOW_MS,
  componentId,
  errorMessage,
} from "./types.js";
import { componentRoot, guessContentType, unique } from "./util.js";

const captureOne = (
  decl: ComponentDeclaration,
  rt: CaptureRuntime,
): Promise<CollectorOutcome> => {
  switch (decl.kind) {
    case "source":
      return source.capture(decl, rt);
    case "dependencies":
      return dependencies.capture(decl, rt);
    case "data":
      return data.capture(decl, rt);
    case "assets":
      return assets.capture(decl, rt);
    case "infrastructure":
      return infrastructure.capture(decl, rt);
    case "integrations":
      return integrations.capture(decl, rt);
    case "product":
      return product.capture(decl, rt);
    case "artifacts":
      return artifacts.capture(decl, rt);
  }
};

/** Drop restore steps the manifest would reject; report each as an omission. */
const vetSteps = (outcome: CollectorOutcome): CollectorOutcome => {
  const kept: RestoreStep[] = [];
  const omissions: Omission[] = [...outcome.omissions];
  for (const step of outcome.restoreSteps) {
    const verdict = validateRestoreStepArguments(step);
    if (verdict.ok) kept.push(step);
    else
      omissions.push({
        what: `Restore step ${step.id}`,
        reason: verdict.reason,
        remediation:
          "Declare the command as an argument array that runs a program directly (no shell interpreter, only the documented placeholders).",
      });
  }
  if (kept.length === outcome.restoreSteps.length) return outcome;
  return {
    ...outcome,
    restoreSteps: kept,
    omissions,
    status: outcome.status === "captured" ? "partial" : outcome.status,
  };
};

async function walkStage(
  dir: string,
  prefix = "",
): Promise<{ rel: string; abs: string }[]> {
  const out: { rel: string; abs: string }[] = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walkStage(join(dir, e.name), rel)));
    else if (e.isFile()) out.push({ rel, abs: join(dir, e.name) });
  }
  return out;
}

/** Package-relative path of the embedded standalone verifier/restorer. */
export const EMBEDDED_VERIFIER_PATH = "recovery/rea-recover.mjs";

export async function capturePackage(
  build: BuildDefinition,
  plan: PreservationPlanBody,
  ctx: CollectorContext,
  options: CaptureOptions,
): Promise<CaptureResult> {
  const problems = declarationProblems(build);
  if (problems.length > 0)
    throw new Error(`invalid build declaration: ${problems.join("; ")}`);
  const redactor = redactorForBuild(build, ctx);
  const base = createRuntime(build, { ...ctx, redactor });
  const log = (
    level: "info" | "warn",
    message: string,
    fields?: Record<string, unknown>,
  ): void =>
    ctx.log(
      level,
      redactor.redactText(message),
      fields === undefined
        ? undefined
        : (redactor.redactValue(fields) as Record<string, unknown>),
    );
  const rt = await createCaptureRuntime(base, options.stagingDir);
  const { builder } = rt;

  const results: ComponentResult[] = [];
  const statuses: Record<string, ComponentCaptureStatus> = {};
  const licenseFiles = new Map<string, string>();
  const licenseNotices: string[] = [];

  for (const decl of orderedDeclarations(build)) {
    ctx.signal.throwIfAborted();
    const cid = componentId(decl);
    const outcome = vetSteps(await runCollector(decl, rt, log));
    const files = await commitComponent(rt, decl, outcome);
    if (outcome.sourceInfo !== undefined && outcome.status !== "blocked")
      rt.registerSource(outcome.sourceInfo);
    if (outcome.licenses !== undefined) {
      licenseFiles.set(outcome.licenses.path, outcome.licenses.content);
      licenseNotices.push(outcome.licenses.notice);
    }
    statuses[cid] = outcome.status;
    results.push({ decl, cid, kind: decl.kind, outcome });
    log("info", `component ${cid} ${outcome.status}`, {
      files,
      omissions: outcome.omissions.length,
    });
  }

  ctx.signal.throwIfAborted();
  for (const [path, content] of licenseFiles)
    await builder.addFile(PACKAGE_COMPONENT_ID, path, content, {
      mediaType: "text/plain",
    });
  if (licenseNotices.length > 0)
    builder.setLicenses(unique(licenseNotices).join("\n\n"));

  if (options.verifierBundlePath !== undefined)
    await builder.copyFile(
      PACKAGE_COMPONENT_ID,
      EMBEDDED_VERIFIER_PATH,
      options.verifierBundlePath,
      { mediaType: "text/javascript" },
    );

  const now = (ctx.now ?? (() => new Date()))().toISOString();
  const consistency = applyManifestFacts(builder, results, {
    ctx: { ...ctx, redactor },
    plan,
    windowMs: options.consistencyWindowMs ?? DEFAULT_CONSISTENCY_WINDOW_MS,
    now,
  });
  const manifest = await builder.finalize({
    build: {
      id: build.id,
      name: build.name,
      project_slug: build.project_slug,
      description: build.description,
    },
    producer: {
      name: "rea-web",
      version: options.producerVersion,
      upstream_rea: options.upstreamRea ?? null,
      tools: await toolVersions(
        base,
        results.map((r) => r.outcome),
      ),
    },
    createdAt: now,
  });
  log("info", "package finalized", {
    components: manifest.components.length,
    files: manifest.files.length,
    consistency: consistency.classification,
  });
  return {
    manifest,
    root: builder.root,
    componentStatuses: statuses,
    consistency: consistency.classification,
  };
}

/** Run one collector; a failure becomes a blocked component, an abort propagates. */
async function runCollector(
  decl: ComponentDeclaration,
  rt: CaptureRuntime,
  log: (
    level: "info" | "warn",
    message: string,
    fields?: Record<string, unknown>,
  ) => void,
): Promise<CollectorOutcome> {
  try {
    return await captureOne(decl, rt);
  } catch (error) {
    if (rt.ctx.signal.aborted) throw error;
    const reason = rt.ctx.redactor.redactText(errorMessage(error));
    log("warn", `collector ${componentId(decl)} failed`, { reason });
    return blockedOutcome(
      {
        title: `${decl.kind} (${decl.id})`,
        method: "n/a",
        root: componentRoot(rt.build, decl),
      },
      {
        what: `${decl.kind} capture`,
        reason: `collector failed: ${reason}`,
        remediation:
          "Fix the reported problem (see runner logs) and capture again.",
      },
    );
  }
}

/** Register the component, then hash-copy its staged files into the package. */
async function commitComponent(
  rt: CaptureRuntime,
  decl: ComponentDeclaration,
  outcome: CollectorOutcome,
): Promise<number> {
  const { redactor } = rt.ctx;
  const cid = componentId(decl);
  const clean = (o: Omission): Omission => ({
    what: redactor.redactText(o.what),
    reason: redactor.redactText(o.reason),
    remediation: redactor.redactText(o.remediation),
  });
  const component: ComponentInput = {
    id: cid,
    kind: decl.kind,
    title: outcome.title,
    status: outcome.status,
    captured_at: outcome.capturedAt,
    method: outcome.method,
    root: outcome.root,
    restore: { steps: outcome.restoreSteps },
    limitations: outcome.limitations.map((l) => redactor.redactText(l)),
    omissions: outcome.omissions.map(clean),
    details: redactor.redactValue(outcome.details) as Record<string, unknown>,
  };
  const files =
    outcome.stageDir === null ? [] : await walkStage(outcome.stageDir);
  rt.builder.addComponent(component);
  for (const f of files)
    await rt.builder.copyFile(cid, f.rel, f.abs, {
      mediaType: guessContentType(f.rel),
    });
  if (outcome.stageDir !== null)
    await rm(outcome.stageDir, { recursive: true, force: true });
  return files.length;
}
