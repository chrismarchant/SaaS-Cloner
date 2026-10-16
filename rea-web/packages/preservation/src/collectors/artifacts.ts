import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validateRelativePath } from "@rea-web/contracts";
import {
  type CaptureRuntime,
  type CollectorOutcome,
  type Runtime,
  emptyOutcome,
} from "../runtime.js";
import {
  type ComponentDeclaration,
  type ComponentPlan,
  type Omission,
  componentId,
} from "../types.js";
import { jsonText, listTree, writeStaged } from "../util.js";

type ArtifactsDecl = Extract<ComponentDeclaration, { kind: "artifacts" }>;

const REMEDIATION =
  "Export evidence bundles from the investigation export screen and keep them with this package, or supply the exported directory to the runner as a local path.";

/** Key under which a runner may supply an exported evidence directory for an investigation. */
export const evidenceKey = (investigationId: string): string =>
  `investigation:${investigationId}`;

export async function plan(
  decl: ArtifactsDecl,
  rt: Runtime,
): Promise<ComponentPlan> {
  const supplied = decl.investigation_ids.filter((id) =>
    rt.ctx.localPaths.has(evidenceKey(id)),
  );
  return {
    id: componentId(decl),
    kind: "artifacts",
    collector: "artifacts",
    permissions: [
      {
        check: "evidence files supplied by runner",
        ok: true,
        detail: `${supplied.length} of ${decl.investigation_ids.length} investigations have local evidence`,
      },
    ],
    estimated_bytes: null,
    dependencies: [],
    method: "copy supplied evidence bundles; otherwise manual export",
    omissions: decl.investigation_ids
      .filter((id) => !supplied.includes(id))
      .map((id) => ({
        what: `Evidence for investigation ${id}`,
        reason: "No evidence export was supplied to the runner.",
        remediation: REMEDIATION,
      })),
    feasible: true,
  };
}

export async function capture(
  decl: ArtifactsDecl,
  rt: CaptureRuntime,
): Promise<CollectorOutcome> {
  const cid = componentId(decl);
  const root = `artifacts/${decl.id}/`;
  const base = {
    title: `Shipped-artifact evidence (${decl.id})`,
    method: "copy supplied evidence bundles; otherwise manual export",
    root,
  };
  const start = rt.now();
  const stage = await rt.stageDir(cid);
  const omissions: Omission[] = [];
  const captured: { investigation_id: string; files: number }[] = [];
  for (const id of decl.investigation_ids) {
    const dir = rt.ctx.localPaths.get(evidenceKey(id));
    const info = dir === undefined ? null : await stat(dir).catch(() => null);
    if (dir === undefined || info === null || !info.isDirectory()) {
      omissions.push({
        what: `Evidence for investigation ${id}`,
        reason:
          dir === undefined
            ? "No evidence export was supplied to the runner."
            : "The supplied evidence path is missing or not a directory.",
        remediation: REMEDIATION,
      });
      continue;
    }
    const listing = await listTree(dir, { skipDirs: null });
    let files = 0;
    for (const f of listing.files) {
      const v = validateRelativePath(f.rel);
      if (!v.ok || v.path !== f.rel) continue;
      const dest = join(stage, ...`${root}${id}/${f.rel}`.split("/"));
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(f.abs, dest);
      files += 1;
    }
    for (const s of listing.skipped)
      omissions.push({
        what: `Evidence file ${s.rel} of investigation ${id}`,
        reason: s.reason,
        remediation: REMEDIATION,
      });
    captured.push({ investigation_id: id, files });
  }
  const none = captured.length === 0;
  if (!none)
    await writeStaged(
      stage,
      `${root}index.json`,
      jsonText({ captured }, rt.ctx.redactor),
    );
  const status =
    decl.investigation_ids.length === 0
      ? "captured"
      : none
        ? "manual"
        : omissions.length > 0
          ? "partial"
          : "captured";
  return {
    ...emptyOutcome(base),
    status,
    omissions,
    limitations: [
      "Investigation evidence is produced by REA; this collector only packages evidence exports that were supplied to the runner.",
    ],
    capturedAt: { start: start.toISOString(), end: rt.now().toISOString() },
    stageDir: none ? null : stage,
    manual:
      none && decl.investigation_ids.length > 0
        ? [
            {
              id: `${cid}:evidence-export`,
              title: "Export investigation evidence bundles",
              reason:
                "Evidence is held by the control plane and was not supplied to the capture runner.",
              instructions: REMEDIATION,
              component_id: cid,
            },
          ]
        : [],
    details: { investigation_ids: decl.investigation_ids, captured },
  };
}
