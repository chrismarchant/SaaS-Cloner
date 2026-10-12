import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import {
  ApiError,
  type HttpMethod,
  type RouteContract,
} from "@rea-web/contracts";
import { authenticate } from "../auth/credentials.js";
import { authorizeProject, type ProjectAccess } from "../auth/authorize.js";
import type { Principal } from "../auth/principal.js";
import type { AppContext } from "../context.js";
import { zodIssues } from "../http/errors.js";
import { parseIdempotencyKey } from "../http/idempotency.js";
import { STREAMED, type Handler, type RouteContext } from "./types.js";

export interface BindOptions {
  readonly bodyLimit?: number;
}

const parseWith = <T>(
  schema: { parse(input: unknown): T } | undefined,
  input: unknown,
  what: string,
): T | undefined => {
  if (schema === undefined) return undefined;
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError)
      throw new ApiError("validation_failed", `Invalid ${what}`, {
        issues: zodIssues(error),
      });
    throw error;
  }
};

const METHODS: Record<HttpMethod, "GET" | "POST" | "PUT" | "PATCH" | "DELETE"> =
  {
    get: "GET",
    post: "POST",
    put: "PUT",
    patch: "PATCH",
    delete: "DELETE",
  };

interface Outcome {
  readonly status: number;
  readonly payload: unknown;
}

/**
 * Binds one handler to one contract. The order is fixed so a request is never
 * interpreted before it is trusted: authenticate, validate path parameters,
 * authorise against the project, validate query and body, apply idempotency,
 * run the handler, check the response against the contract.
 */
export function bindRoute<C extends RouteContract>(
  app: FastifyInstance,
  ctx: AppContext,
  contract: C,
  handler: Handler<C>,
  options: BindOptions = {},
): void {
  // A contract without a handler must fail at start-up, not as a 500 later.
  if (typeof handler !== "function")
    throw new Error(`No handler is bound to contract "${contract.id}"`);
  const successStatus = contract.responseStatus ?? 200;

  const run = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const principal: Principal | null = await authenticate(
      ctx,
      req,
      contract.auth,
    );
    req.principal = principal;
    const params = parseWith(contract.params, req.params, "path parameters");
    let project: ProjectAccess | null = null;
    if (contract.role !== undefined) {
      const projectId = (params as { p?: string } | undefined)?.p;
      if (principal?.kind !== "user" || projectId === undefined)
        throw new ApiError("internal", "role contract without user and :p");
      project = await authorizeProject(
        ctx,
        principal.user.id,
        projectId,
        contract.role,
      );
    }
    const query = parseWith(contract.query, req.query, "query");
    const body = parseWith(contract.body, req.body ?? undefined, "body");

    const routeContext: RouteContext<unknown, unknown, unknown> = {
      ctx,
      req,
      reply,
      params,
      query,
      body,
      project,
      get user() {
        if (principal?.kind !== "user")
          throw new ApiError("unauthorized", "Authentication required");
        return principal;
      },
      get runner() {
        if (principal?.kind !== "runner")
          throw new ApiError("unauthorized", "Authentication required");
        return principal;
      },
    };

    const execute = async (): Promise<Outcome | typeof STREAMED> => {
      const result = await (
        handler as unknown as (
          rc: RouteContext<unknown, unknown, unknown>,
        ) => Promise<unknown>
      )(routeContext);
      if (result === STREAMED) return STREAMED;
      if (ctx.config.validateResponses && contract.streaming === undefined) {
        try {
          contract.response.parse(result);
        } catch (error) {
          if (error instanceof ZodError) {
            req.log.error(
              { route: contract.id, issues: zodIssues(error) },
              "response violates contract",
            );
            throw new ApiError("internal", "Response violated its contract", {
              route: contract.id,
              issues: zodIssues(error),
            });
          }
          throw error;
        }
      }
      return { status: successStatus, payload: result };
    };

    const send = (outcome: Outcome | typeof STREAMED): void => {
      if (outcome === STREAMED) return;
      void reply.code(outcome.status).send(outcome.payload);
    };

    const key =
      contract.idempotent === true && principal?.kind === "user"
        ? parseIdempotencyKey(req.headers["idempotency-key"])
        : null;
    if (key === null || principal?.kind !== "user") {
      send(await execute());
      return;
    }

    const principalId = principal.user.id;
    const requestHash = ctx.idempotency.hashRequest(
      req.method,
      req.url,
      req.body ?? null,
    );
    const outcome = await ctx.idempotency.mutex.run(
      `${principalId}:${key}`,
      async (): Promise<Outcome | typeof STREAMED> => {
        const replay = await ctx.idempotency.lookup(
          principalId,
          key,
          requestHash,
        );
        if (replay !== null) {
          void reply.header("idempotent-replay", "true");
          return { status: replay.status, payload: replay.body };
        }
        const fresh = await execute();
        if (fresh !== STREAMED)
          await ctx.idempotency.remember({
            principalId,
            projectId: project?.project_id ?? null,
            key,
            requestHash,
            status: fresh.status,
            body: fresh.payload,
          });
        return fresh;
      },
    );
    send(outcome);
  };

  app.route({
    method: METHODS[contract.method],
    url: contract.path,
    ...(options.bodyLimit === undefined
      ? {}
      : { bodyLimit: options.bodyLimit }),
    handler: async (req, reply) => {
      await run(req, reply);
      return reply;
    },
  });
}
