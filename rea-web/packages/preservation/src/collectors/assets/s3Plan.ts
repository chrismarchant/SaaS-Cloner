import type { Runtime } from "../../runtime.js";
import type { ComponentPlan } from "../../types.js";
import { redactUrl } from "../../util.js";
import {
  DEFAULT_ESTIMATE_PAGE_LIMIT,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_OBJECTS,
  DEFAULT_PAGE_SIZE,
  type S3Connection,
  type S3CaptureOptions,
  connectS3,
  s3OptionsOf,
  ssrfOmission,
} from "./s3Connection.js";
import { listPage } from "./s3Engine.js";
import { classifyS3Error } from "./s3Errors.js";
import { notCaptured, targetLabel } from "./s3Report.js";
import {
  type ObjectSource,
  type S3Source,
  resolveS3Source,
} from "./s3Source.js";

interface Estimate {
  objects: number;
  bytes: number;
  /** False when a listing failed or ran past the page limit. */
  complete: boolean;
}

/** Page through one target's keys, up to `pageLimit` pages. */
async function estimateTarget(
  connection: S3Connection,
  source: S3Source,
  target: S3Source["targets"][number],
  options: S3CaptureOptions,
  rt: Runtime,
  out: ComponentPlan,
): Promise<Estimate> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const pageLimit = options.estimatePageLimit ?? DEFAULT_ESTIMATE_PAGE_LIMIT;
  const estimate: Estimate = { objects: 0, bytes: 0, complete: true };
  let token: string | undefined;
  let pages = 0;
  try {
    do {
      if (pages >= pageLimit) {
        estimate.complete = false;
        break;
      }
      const page = await listPage(
        connection.client,
        target.bucket,
        target.listPrefix,
        pageSize,
        token,
        rt.ctx.signal,
      );
      pages += 1;
      for (const o of page.objects) {
        estimate.objects += 1;
        estimate.bytes += o.size;
      }
      token = page.next;
    } while (token !== undefined);
  } catch (error) {
    if (rt.ctx.signal.aborted) throw error;
    estimate.complete = false;
    out.permissions.push({
      check: `size estimate for ${targetLabel(source, target)}`,
      ok: true,
      detail: rt.ctx.redactor.redactText(
        `unknown: listing failed (${classifyS3Error(error).message})`,
      ),
    });
  }
  return estimate;
}

/** ListObjectsV2 with MaxKeys=1: proves the credentials may list the target. */
async function checkList(
  connection: S3Connection,
  source: S3Source,
  target: S3Source["targets"][number],
  rt: Runtime,
  out: ComponentPlan,
): Promise<boolean> {
  const check = `list ${targetLabel(source, target)}`;
  try {
    await listPage(
      connection.client,
      target.bucket,
      target.listPrefix,
      1,
      undefined,
      rt.ctx.signal,
    );
    out.permissions.push({
      check,
      ok: true,
      detail: "ListObjectsV2 succeeded",
    });
    return true;
  } catch (error) {
    if (rt.ctx.signal.aborted) throw error;
    const failure = classifyS3Error(error);
    out.permissions.push({
      check,
      ok: false,
      detail: rt.ctx.redactor.redactText(`${failure.kind}: ${failure.message}`),
    });
    return false;
  }
}

/** Record the byte estimate, or why there is none; never a guess. */
function reportEstimate(
  total: Estimate,
  options: S3CaptureOptions,
  out: ComponentPlan,
): void {
  if (!total.complete) {
    out.permissions.push({
      check: "size estimate",
      ok: true,
      detail: `unknown: the listing did not finish within ${options.estimatePageLimit ?? DEFAULT_ESTIMATE_PAGE_LIMIT} pages of ${options.pageSize ?? DEFAULT_PAGE_SIZE} keys (or failed), so no byte count is reported`,
    });
    return;
  }
  out.estimated_bytes = total.bytes;
  out.permissions.push({
    check: "size estimate",
    ok: true,
    detail: `${total.objects} keys, ${total.bytes} bytes listed now; objects can change before capture`,
  });
  const maxObjects = options.maxObjects ?? DEFAULT_MAX_OBJECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (total.objects > maxObjects || total.bytes > maxBytes)
    out.omissions.push({
      what: "Objects beyond the capture limit",
      reason: `The listing (${total.objects} keys, ${total.bytes} bytes) exceeds the capture limit of ${maxObjects} objects / ${maxBytes} bytes.`,
      remediation:
        "Split the bucket into several assets sources by prefix or raise the limits.",
    });
}

export async function planObjectSource(
  src: ObjectSource,
  rt: Runtime,
  out: ComponentPlan,
): Promise<ComponentPlan> {
  const options = s3OptionsOf(rt.ctx);
  const redact = rt.ctx.redactor.redactText;
  const resolved = resolveS3Source(src, rt.ctx.env);
  const names = `${src.credentials_env_prefix}_ACCESS_KEY_ID / ${src.credentials_env_prefix}_SECRET_ACCESS_KEY`;
  if (!resolved.ok) {
    out.permissions.push({
      check: `credentials and settings ${names}`,
      ok: false,
      detail: redact(resolved.omission.reason),
    });
    out.omissions.push(resolved.omission);
    return out;
  }
  const { source } = resolved;
  out.permissions.push({
    check: `credentials ${names}`,
    ok: true,
    detail: "present by name; values are not logged",
  });
  for (const rejected of source.rejected) {
    out.permissions.push({
      check: rejected.what,
      ok: false,
      detail: rejected.reason,
    });
    out.omissions.push(rejected);
  }
  const connected = await connectS3(source.connection, options);
  const guardCheck = "endpoint passes the network safety guard";
  if (!connected.ok) {
    out.permissions.push({
      check: guardCheck,
      ok: false,
      detail: redact(connected.reason),
    });
    out.omissions.push(ssrfOmission(redact(connected.reason)));
    return out;
  }
  const { connection } = connected;
  try {
    out.permissions.push({
      check: guardCheck,
      ok: true,
      detail:
        source.connection.endpoint === undefined
          ? `AWS default endpoint in ${source.connection.region}`
          : redactUrl(source.connection.endpoint),
    });
    const total: Estimate = { objects: 0, bytes: 0, complete: true };
    let reachable = true;
    for (const target of source.targets) {
      if (!(await checkList(connection, source, target, rt, out))) {
        reachable = false;
        continue;
      }
      const part = await estimateTarget(
        connection,
        source,
        target,
        options,
        rt,
        out,
      );
      total.objects += part.objects;
      total.bytes += part.bytes;
      total.complete &&= part.complete;
    }
    if (reachable) reportEstimate(total, options, out);
    out.omissions.push(...notCaptured(source));
    out.feasible = out.permissions.every((p) => p.ok);
    return out;
  } finally {
    connection.destroy();
  }
}
