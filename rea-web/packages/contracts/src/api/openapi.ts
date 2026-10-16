import { z } from "zod";
import { apiErrorSchema } from "../errors.js";
import type { Role } from "./resources.js";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface RouteContract<
  Params extends z.ZodTypeAny = z.ZodTypeAny,
  Query extends z.ZodTypeAny = z.ZodTypeAny,
  Body extends z.ZodTypeAny = z.ZodTypeAny,
  Response extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly auth: "none" | "user" | "runner";
  readonly role?: Role;
  readonly idempotent?: boolean;
  readonly params?: Params;
  readonly query?: Query;
  readonly body?: Body;
  readonly response: Response;
  readonly responseStatus?: number;
  readonly streaming?: "sse" | "octet-stream";
}

export const defineRoute = <
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  Body extends z.ZodTypeAny,
  Response extends z.ZodTypeAny,
>(
  contract: RouteContract<Params, Query, Body, Response>,
): RouteContract<Params, Query, Body, Response> => contract;

const toSchema = (schema: z.ZodTypeAny): Record<string, unknown> =>
  z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "any",
    io: "input",
  }) as Record<string, unknown>;

const toOutputSchema = (schema: z.ZodTypeAny): Record<string, unknown> =>
  z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "any",
    io: "output",
  }) as Record<string, unknown>;

const expressToOpenApiPath = (path: string): string =>
  path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/gu, "{$1}");

/** Build an OpenAPI 3.1 document from route contracts. */
export const buildOpenApiDocument = (
  routes: readonly RouteContract[],
  info: { title: string; version: string; serverUrl: string },
): Record<string, unknown> => {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const path = expressToOpenApiPath(route.path);
    const operation: Record<string, unknown> = {
      operationId: route.id,
      summary: route.summary,
      tags: route.tags,
      security:
        route.auth === "none"
          ? []
          : route.auth === "runner"
            ? [{ runnerToken: [] }]
            : [{ cookieSession: [] }, { bearerToken: [] }],
      "x-required-role": route.role ?? null,
      "x-idempotency-key": route.idempotent === true,
    };
    const parameters: Record<string, unknown>[] = [];
    if (route.params) {
      const schema = toSchema(route.params) as {
        properties?: Record<string, unknown>;
      };
      for (const [name, prop] of Object.entries(schema.properties ?? {}))
        parameters.push({ name, in: "path", required: true, schema: prop });
    }
    if (route.query) {
      const schema = toSchema(route.query) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      for (const [name, prop] of Object.entries(schema.properties ?? {}))
        parameters.push({
          name,
          in: "query",
          required: schema.required?.includes(name) ?? false,
          schema: prop,
        });
    }
    if (route.idempotent)
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 128 },
      });
    if (parameters.length > 0) operation["parameters"] = parameters;
    if (route.body)
      operation["requestBody"] = {
        required: true,
        content: { "application/json": { schema: toSchema(route.body) } },
      };
    const status = String(route.responseStatus ?? 200);
    const responses: Record<string, unknown> = {
      [status]: route.streaming
        ? {
            description:
              route.streaming === "sse"
                ? "Server-sent events"
                : "Binary stream",
            content: {
              [route.streaming === "sse"
                ? "text/event-stream"
                : "application/octet-stream"]: {},
            },
          }
        : {
            description: "Success",
            content: {
              "application/json": { schema: toOutputSchema(route.response) },
            },
          },
      default: {
        description: "Error",
        content: {
          "application/json": { schema: toOutputSchema(apiErrorSchema) },
        },
      },
    };
    operation["responses"] = responses;
    paths[path] ??= {};
    (paths[path] as Record<string, unknown>)[route.method] = operation;
  }
  return {
    openapi: "3.1.0",
    info: { title: info.title, version: info.version },
    servers: [{ url: info.serverUrl }],
    components: {
      securitySchemes: {
        cookieSession: {
          type: "apiKey",
          in: "cookie",
          name: "rea_web_session",
        },
        bearerToken: { type: "http", scheme: "bearer" },
        runnerToken: {
          type: "http",
          scheme: "bearer",
          description: "Runner token",
        },
      },
    },
    paths,
  };
};
