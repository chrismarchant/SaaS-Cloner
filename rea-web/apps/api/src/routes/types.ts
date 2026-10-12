import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { API_ROUTES, RouteContract } from "@rea-web/contracts";
import type { ProjectAccess } from "../auth/authorize.js";
import type { RunnerPrincipal, UserPrincipal } from "../auth/principal.js";
import type { AppContext } from "../context.js";

/** Returned by handlers that wrote the response themselves (SSE, downloads). */
export const STREAMED: unique symbol = Symbol("streamed");
export type Streamed = typeof STREAMED;

/** Parsed output of an optional contract schema; `undefined` when absent. */
type Parsed<S> =
  unknown extends z.output<NonNullable<S>>
    ? undefined
    : z.output<NonNullable<S>>;

export interface RouteContext<P, Q, B> {
  readonly ctx: AppContext;
  readonly req: FastifyRequest;
  readonly reply: FastifyReply;
  readonly params: P;
  readonly query: Q;
  readonly body: B;
  /** Set for contracts that declare a `role`. */
  readonly project: ProjectAccess | null;
  /** Throws `unauthorized` unless the request authenticated as a user. */
  readonly user: UserPrincipal;
  /** Throws `unauthorized` unless the request authenticated as a runner. */
  readonly runner: RunnerPrincipal;
}

export type Handler<C extends RouteContract> = (
  rc: RouteContext<Parsed<C["params"]>, Parsed<C["query"]>, Parsed<C["body"]>>,
) => Promise<z.input<C["response"]> | Streamed>;

export type ApiRoutes = typeof API_ROUTES;
export type ApiRouteId = keyof ApiRoutes;

/** One handler per contract id; a missing or extra id is a compile error. */
export type Handlers = { [K in ApiRouteId]: Handler<ApiRoutes[K]> };

export type HandlersFor<K extends ApiRouteId> = Pick<Handlers, K>;
