import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError, uuidv7, validateTargetUrl } from "@rea-web/contracts";
import type { TargetKind } from "@rea-web/db";
import type { AppContext } from "../context.js";
import { computeRouting } from "./routing.js";
import { targetView } from "./mappers.js";
import type { HandlersFor, RouteContext } from "./types.js";
import {
  declaredLength,
  newTargetId,
  parseTargetName,
  sniffClass,
  streamIntoStore,
  targetObjectKey,
  type UploadSource,
} from "./uploads.js";

const tooLarge = (ctx: AppContext, reply: FastifyReply) => () => {
  void reply.header("connection", "close");
  return new ApiError(
    "payload_too_large",
    `Upload exceeds the ${ctx.config.maxUploadBytes} byte limit`,
    { max_bytes: ctx.config.maxUploadBytes },
  );
};

const openSource = async (
  ctx: AppContext,
  req: FastifyRequest,
): Promise<{ source: UploadSource; contentType: string | null }> => {
  const contentType =
    typeof req.headers["content-type"] === "string"
      ? req.headers["content-type"]
      : null;
  if (req.isMultipart()) {
    const part = await req.file({
      limits: { fileSize: ctx.config.maxUploadBytes + 1, files: 1 },
    });
    if (part === undefined)
      throw new ApiError(
        "validation_failed",
        "Multipart body has no file part",
      );
    return {
      source: {
        stream: part.file,
        contentLength: undefined,
        truncated: () => part.file.truncated,
        filename: part.filename,
      },
      contentType: part.mimetype,
    };
  }
  return {
    source: {
      stream: req.raw,
      contentLength: declaredLength(req),
      truncated: () => false,
    },
    contentType,
  };
};

const ingest =
  (kind: Extract<TargetKind, "upload" | "runtime_capture">) =>
  async (rc: RouteContext<{ p: string }, unknown, unknown>) => {
    const { ctx, req, reply, params, user } = rc;
    const rawName = req.headers["x-target-name"];
    // Reject a bad name before reading any of the body.
    if (rawName !== undefined || !req.isMultipart()) parseTargetName(rawName);
    const { source, contentType } = await openSource(ctx, req);
    const name = parseTargetName(rawName ?? source.filename);
    const id = newTargetId();
    const key = targetObjectKey(params.p, id);
    const stored = await streamIntoStore(ctx.store, key, source, {
      maxBytes: ctx.config.maxUploadBytes,
      onTooLarge: tooLarge(ctx, reply),
    });
    try {
      const record = await ctx.repos.targets.create({
        id,
        project_id: params.p,
        kind,
        name,
        class: sniffClass(name, stored.head),
        sha256: stored.sha256,
        size: stored.size,
        object_key: key,
        metadata: contentType === null ? {} : { content_type: contentType },
        created_by: user.user.id,
      });
      return targetView(record);
    } catch (error) {
      await ctx.store.delete(key).catch(() => undefined);
      throw error;
    }
  };

export const targetHandlers = (): HandlersFor<
  | "uploadTarget"
  | "uploadRuntimeCapture"
  | "createUrlTarget"
  | "listTargets"
  | "getTarget"
  | "getTargetRouting"
  | "deleteTarget"
> => ({
  uploadTarget: ingest("upload"),
  uploadRuntimeCapture: ingest("runtime_capture"),

  async createUrlTarget({ ctx, params, body, user }) {
    const checked = validateTargetUrl(body.url);
    if (!checked.ok)
      throw new ApiError("unsafe_url", "URL target rejected", {
        rejection: checked.rejection,
      });
    const record = await ctx.repos.targets.create({
      id: uuidv7(),
      project_id: params.p,
      kind: "url",
      name:
        body.name ?? `${checked.url.host}${checked.url.pathname}`.slice(0, 255),
      class: "website_url",
      url: checked.url.href,
      metadata: { submitted_url: body.url },
      created_by: user.user.id,
    });
    return targetView(record);
  },

  async listTargets({ ctx, params, query }) {
    const page = await ctx.repos.targets.list(params.p, {
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map(targetView), next_cursor: page.next_cursor };
  },

  async getTarget({ ctx, params }) {
    const target = await ctx.repos.targets.findById(params.p, params.t);
    if (target === null) throw new ApiError("not_found", "Target not found");
    return targetView(target);
  },

  async getTargetRouting({ ctx, params }) {
    const target = await ctx.repos.targets.findById(params.p, params.t);
    if (target === null) throw new ApiError("not_found", "Target not found");
    return computeRouting(ctx, params.p, target);
  },

  async deleteTarget({ ctx, params }) {
    const target = await ctx.repos.targets.findById(params.p, params.t);
    if (target === null) throw new ApiError("not_found", "Target not found");
    const deleted = await ctx.repos.targets.delete(params.p, params.t);
    if (!deleted) throw new ApiError("not_found", "Target not found");
    if (target.object_key !== null)
      await ctx.store.delete(target.object_key).catch((error: unknown) => {
        ctx.logger.warn(
          { err: error, target_id: target.id },
          "object cleanup after target delete failed",
        );
      });
    return { ok: true as const };
  },
});
