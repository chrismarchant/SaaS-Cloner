import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "@rea-web/contracts";
import type { AppContext } from "../context.js";
import { authHandlers } from "./auth.js";
import { bindRoute } from "./bind.js";
import { buildHandlers } from "./builds.js";
import { investigationHandlers } from "./investigations.js";
import { jobHandlers } from "./jobs.js";
import { projectHandlers } from "./projects.js";
import { runnerAdminHandlers } from "./runners.js";
import { runnerProtocolHandlers } from "./runnerProtocol.js";
import { targetHandlers } from "./targets.js";
import type { ApiRouteId, Handlers } from "./types.js";

const MIB = 1024 * 1024;

/** Larger JSON bodies than the 1 MiB default: capability reports are ~1 MiB. */
export const BODY_LIMITS: Partial<Record<ApiRouteId, number>> = {
  runnerRegister: 16 * MIB,
  runnerHeartbeat: 16 * MIB,
  runnerPostEvents: 4 * MIB,
  runnerToolCall: 4 * MIB,
  runnerComplete: 8 * MIB,
  runnerFindings: 8 * MIB,
};

/** Routes whose request body is a raw byte stream rather than JSON. */
const RAW_BODY_ROUTES: ReadonlySet<ApiRouteId> = new Set<ApiRouteId>([
  "uploadTarget",
  "uploadRuntimeCapture",
  "runnerUploadArtifact",
]);

/** Exhaustive by type: adding a contract without a handler fails to compile. */
export const createHandlers = (): Handlers => ({
  ...authHandlers(),
  ...projectHandlers(),
  ...runnerAdminHandlers(),
  ...targetHandlers(),
  ...investigationHandlers(),
  ...jobHandlers(),
  ...buildHandlers(),
  ...runnerProtocolHandlers(),
});

const bindAll = (
  app: FastifyInstance,
  ctx: AppContext,
  handlers: Handlers,
  raw: boolean,
): void => {
  for (const id of Object.keys(API_ROUTES) as ApiRouteId[]) {
    if (RAW_BODY_ROUTES.has(id) !== raw) continue;
    const limit = BODY_LIMITS[id];
    bindRoute(
      app,
      ctx,
      API_ROUTES[id],
      handlers[id] as never,
      limit === undefined ? {} : { bodyLimit: limit },
    );
  }
};

/** Registers every contract on `app`; call inside the `/api/v1` prefix scope. */
export const registerRoutes = async (
  app: FastifyInstance,
  ctx: AppContext,
  handlers: Handlers = createHandlers(),
): Promise<void> => {
  bindAll(app, ctx, handlers, false);
  // Raw upload routes read the request stream themselves, so JSON parsing and
  // the default body limit are replaced by a pass-through parser in this scope.
  await app.register(async (rawScope) => {
    rawScope.removeAllContentTypeParsers();
    rawScope.addContentTypeParser("*", (_req, _payload, done) => {
      done(null, undefined);
    });
    await rawScope.register(multipart, {
      limits: {
        fileSize: ctx.config.maxUploadBytes + 1,
        files: 1,
        fields: 8,
        parts: 10,
      },
    });
    bindAll(rawScope, ctx, handlers, true);
  });
};
