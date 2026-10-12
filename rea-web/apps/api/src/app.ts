import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { uuidv7 } from "@rea-web/contracts";
import type { AppContext, AppDeps } from "./context.js";
import { registerErrorHandling, sendError } from "./http/errors.js";
import { createIdempotencyService } from "./http/idempotency.js";
import { buildApiDocument } from "./openapi.js";
import { createJobEventBus } from "./orchestrator/eventBus.js";
import { createFencing } from "./orchestrator/fencing.js";
import { registerRoutes } from "./routes/index.js";
import { ApiError } from "@rea-web/contracts";

const MIB = 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/u;

const incomingRequestId = (value: string | string[] | undefined): string => {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate !== undefined && REQUEST_ID.test(candidate)
    ? candidate
    : uuidv7();
};

export const createContext = (
  deps: AppDeps,
): AppContext & { ownsBus: boolean } => {
  const bus =
    deps.bus ??
    createJobEventBus(deps.db, {
      onError: (error) =>
        deps.logger.warn({ err: error }, "job event listener problem"),
    });
  const partial = {
    repos: deps.repos,
    db: deps.db,
    store: deps.store,
    config: deps.config,
    logger: deps.logger,
    now: deps.now ?? (() => new Date()),
    bus,
  };
  return {
    ...partial,
    fencing: createFencing(deps.db, deps.repos),
    idempotency: createIdempotencyService(partial),
    ownsBus: deps.bus === undefined,
  };
};

/**
 * Builds the Fastify instance with every contract bound. It does not listen
 * and does not start background loops (`startReaper` etc.); callers own those.
 */
export async function createApp(deps: AppDeps): Promise<FastifyInstance> {
  const { ownsBus, ...ctx } = createContext(deps);
  const app = Fastify({
    loggerInstance: deps.logger,
    genReqId: (req) => incomingRequestId(req.headers["x-request-id"]),
    bodyLimit: MIB,
    forceCloseConnections: true,
    // Behind a reverse proxy the deployment sets this through the platform.
    trustProxy: false,
  });

  app.decorateRequest("principal", null);

  app.addHook("onRequest", async (request, reply) => {
    void reply.header("x-request-id", request.id);
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("referrer-policy", "no-referrer");
  });
  app.addHook("onSend", async (request, reply) => {
    if (!reply.hasHeader("cache-control") && request.url.startsWith("/api/"))
      void reply.header("cache-control", "no-store");
  });

  // An empty body with a JSON content type is "no body", not a syntax error.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      const text = typeof body === "string" ? body : body.toString("utf8");
      if (text.trim() === "") {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch {
        done(
          Object.assign(new Error("Request body is not valid JSON"), {
            statusCode: 400,
          }),
          undefined,
        );
      }
    },
  );

  await app.register(cookie, { secret: ctx.config.sessionSecret });
  await app.register(cors, {
    origin:
      ctx.config.corsOrigins.length > 0 ? [...ctx.config.corsOrigins] : false,
    credentials: true,
  });
  registerErrorHandling(app);

  const openApi = buildApiDocument(ctx.config.version);
  app.get("/openapi.json", async () => openApi);

  await app.register(
    async (api) => {
      // Deployment liveness probe (see .railway/railway.ts). Not a contract:
      // it carries no project data and never echoes connection details.
      api.get("/health", async (request, reply) => {
        try {
          await ctx.db.query("SELECT 1");
          return { status: "ok" };
        } catch (error) {
          request.log.warn(
            { err: error },
            "health check: database unavailable",
          );
          return reply.code(503).send({ status: "unavailable" });
        }
      });
      await registerRoutes(api, ctx);
    },
    { prefix: "/api/v1" },
  );

  if (ctx.config.staticDir !== null) {
    await app.register(fastifyStatic, {
      root: ctx.config.staticDir,
      wildcard: false,
      index: ["index.html"],
    });
    // SPA fallback for non-API GETs; everything else keeps the JSON 404.
    app.setNotFoundHandler(async (request, reply) => {
      const apiPath =
        request.url.startsWith("/api/") ||
        request.url.startsWith("/openapi.json");
      if ((request.method === "GET" || request.method === "HEAD") && !apiPath)
        return reply.sendFile("index.html");
      return sendError(
        reply,
        new ApiError("not_found", "Route not found"),
        request.id,
      );
    });
  }

  app.addHook("onReady", async () => {
    await ctx.bus.start();
  });
  app.addHook("onClose", async () => {
    if (ownsBus) await ctx.bus.close();
  });
  return app;
}
