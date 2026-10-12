import type { FastifyReply } from "fastify";
import { ApiError } from "@rea-web/contracts";
import { ObjectNotFoundError } from "@rea-web/storage";
import type { AppContext } from "../context.js";
import { STREAMED, type Streamed } from "./types.js";

const safeFilename = (name: string): string =>
  name.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 120) || "download";

export interface ObjectResponse {
  readonly contentType: string;
  readonly filename?: string;
  readonly sha256?: string | null;
  readonly size?: number | null;
}

/** Streams a stored object to the client; a missing object is `not_found`. */
export const sendObject = async (
  ctx: Pick<AppContext, "store">,
  reply: FastifyReply,
  key: string,
  response: ObjectResponse,
): Promise<Streamed> => {
  let body;
  try {
    body = await ctx.store.get(key);
  } catch (error) {
    if (error instanceof ObjectNotFoundError)
      throw new ApiError("not_found", "Stored object not found");
    throw error;
  }
  void reply.header("cache-control", "private, no-store");
  void reply.header("x-content-type-options", "nosniff");
  void reply.type(response.contentType);
  if (response.filename !== undefined)
    void reply.header(
      "content-disposition",
      `attachment; filename="${safeFilename(response.filename)}"`,
    );
  if (response.sha256 !== undefined && response.sha256 !== null)
    void reply.header("x-content-sha256", response.sha256);
  if (response.size !== undefined && response.size !== null)
    void reply.header("content-length", String(response.size));
  void reply.send(body);
  return STREAMED;
};
