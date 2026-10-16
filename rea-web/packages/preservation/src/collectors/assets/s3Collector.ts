import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type CaptureRuntime,
  type CollectorOutcome,
  blockedOutcome,
  emptyOutcome,
} from "../../runtime.js";
import {
  type ComponentDeclaration,
  type Omission,
  componentId,
} from "../../types.js";
import { isLoopbackHost, redactUrl } from "../../util.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_OBJECTS,
  DEFAULT_PAGE_SIZE,
  connectS3,
  s3OptionsOf,
  ssrfOmission,
} from "./s3Connection.js";
import {
  type EngineState,
  ListingWriter,
  type TargetOutcome,
  captureTargets,
} from "./s3Engine.js";
import { type S3Failure, blockedOmission } from "./s3Errors.js";
import {
  LIMITATIONS,
  manualItems,
  restoreStep,
  skippedOmissions,
  stopOmission,
  targetLabel,
} from "./s3Report.js";
import { type ObjectSource, resolveS3Source } from "./s3Source.js";

type AssetsDecl = Extract<ComponentDeclaration, { kind: "assets" }>;

const METHOD = "s3 list+get";

export async function captureObjectSource(
  decl: AssetsDecl,
  src: ObjectSource,
  rt: CaptureRuntime,
): Promise<CollectorOutcome> {
  const cid = componentId(decl);
  const root = `assets/${decl.id}/`;
  const base = { title: `Assets (${decl.id})`, method: METHOD, root };
  const options = s3OptionsOf(rt.ctx);
  const redact = rt.ctx.redactor.redactText;

  const resolved = resolveS3Source(src, rt.ctx.env);
  if (!resolved.ok)
    return blockedOutcome(base, resolved.omission, {
      secretNames: resolved.secretNames,
    });
  const { source } = resolved;
  const secretNames = source.secretNames;
  const connected = await connectS3(source.connection, options);
  if (!connected.ok)
    return blockedOutcome(base, ssrfOmission(redact(connected.reason)), {
      secretNames,
    });
  const { connection } = connected;

  const stage = await rt.stageDir(cid);
  const state: EngineState = {
    objects: 0,
    bytes: 0,
    examined: 0,
    deniedReads: 0,
    taken: new Set(),
  };
  const start = rt.now();
  const endpoint =
    source.connection.endpoint === undefined
      ? null
      : redactUrl(source.connection.endpoint);
  const writer = await ListingWriter.open(
    join(stage, ...`${root}objects.json`.split("/")),
    rt.ctx.redactor,
    {
      source: source.provider,
      endpoint,
      region: source.connection.region,
      buckets: source.targets.map((t) => ({
        bucket: t.bucket,
        prefix: t.declaredPrefix,
        list_prefix: t.listPrefix,
      })),
      point_in_time_snapshot: false,
      snapshot_note:
        "S3 offers no snapshot of a bucket: keys are listed page by page while objects are read, so objects written, replaced or deleted during the capture window may or may not be included.",
    },
  );
  const maxObjects = options.maxObjects ?? DEFAULT_MAX_OBJECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let outcomes: TargetOutcome[];
  try {
    outcomes = await captureTargets(
      {
        client: connection.client,
        stage,
        root,
        signal: rt.ctx.signal,
        maxObjects,
        maxBytes,
        pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
        writer,
        state,
      },
      source.targets,
    );
  } catch (error) {
    writer.abandon();
    throw error;
  } finally {
    connection.destroy();
  }
  const end = rt.now();
  const capturedAt = { start: start.toISOString(), end: end.toISOString() };
  const hardSkips = writer.skipped.filter((s) => !s.benign);
  const hardSkipCount = writer.skippedTotal - writer.benignTotal;
  await writer.finish({
    captured_at: capturedAt,
    targets: outcomes.map((o) => ({
      bucket: o.target.bucket,
      started: o.started,
      listed: o.listed,
      objects: o.objects,
      bytes: o.bytes,
      stopped:
        o.stop === null
          ? null
          : o.stop.kind === "failure"
            ? o.stop.failure.kind
            : o.stop.kind,
    })),
    totals: {
      objects: state.objects,
      bytes: state.bytes,
      examined: state.examined,
      skipped: writer.skippedTotal,
    },
    limits: { max_objects: maxObjects, max_bytes: maxBytes },
  });

  const stopOmissions = new Map<TargetOutcome, Omission>();
  for (const o of outcomes) {
    const omission = stopOmission(source, o, state, redact);
    if (omission !== null) stopOmissions.set(o, omission);
  }
  const omissions: Omission[] = [...source.rejected, ...stopOmissions.values()];
  const failedStops = outcomes.filter(
    (o) => o.started && o.stop?.kind === "failure",
  );
  const anyComplete = outcomes.some(
    (o) => o.started && o.listed && o.stop === null,
  );
  const blocked =
    state.objects === 0 &&
    (state.deniedReads > 0 || (failedStops.length > 0 && !anyComplete));
  if (blocked) {
    await rm(stage, { recursive: true, force: true });
    const first = failedStops[0];
    const subject = first?.target ?? source.targets[0];
    const stop = first?.stop;
    const failure: S3Failure =
      stop?.kind === "failure"
        ? stop.failure
        : {
            kind: "access_denied",
            message: "AccessDenied: reading objects was refused",
          };
    return blockedOutcome(
      base,
      blockedOmission(
        subject === undefined ? "Object storage" : targetLabel(source, subject),
        failure,
        redact,
        {
          bucket: subject?.bucket ?? "",
          credentialNames: source.credentialNames,
          endpointHint: source.endpointHint,
        },
      ),
      {
        secretNames,
        omissions: omissions.filter(
          (o) => first === undefined || o !== stopOmissions.get(first),
        ),
      },
    );
  }
  omissions.push(...skippedOmissions(hardSkips, hardSkipCount));

  const hosts = connection.hosts.filter((h) => !isLoopbackHost(h));
  rt.ctx.log("info", `${cid}: ${state.objects} objects, ${state.bytes} bytes`, {
    skipped: writer.skippedTotal,
    point_in_time_snapshot: false,
  });
  return {
    ...emptyOutcome(base),
    status: omissions.length > 0 ? "partial" : "captured",
    omissions,
    limitations: LIMITATIONS,
    manual: manualItems(cid, decl, source),
    restoreSteps: state.objects > 0 ? [restoreStep(decl, root)] : [],
    capturedAt,
    stageDir: stage,
    secretNames,
    guards: { blocked_hosts: hosts },
    details: {
      provider: source.provider,
      endpoint: endpoint ?? `aws:${source.connection.region}`,
      region: source.connection.region,
      point_in_time_snapshot: false,
      buckets: outcomes.map((o) => ({
        bucket: o.target.bucket,
        objects: o.objects,
        bytes: o.bytes,
        complete: o.stop === null,
      })),
      objects: state.objects,
      bytes: state.bytes,
      skipped: writer.skippedTotal,
    },
    relationships: [...rt.sources.values()]
      .slice(0, 1)
      .map((s) => ({ from: cid, to: s.componentId, kind: "backs" as const })),
  };
}
