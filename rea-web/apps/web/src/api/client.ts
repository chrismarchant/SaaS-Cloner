/**
 * Typed client over the route contracts. Every JSON response is parsed with
 * the route's own response schema; every failure becomes an `ApiClientError`
 * carrying the API's code, message and details unchanged.
 */
import {
  API_ROUTES,
  apiErrorSchema,
  type ApiErrorCode,
} from "@rea-web/contracts/browser";
import type { z } from "zod";

export const API_PREFIX = "/api/v1";

type Routes = typeof API_ROUTES;
export type RouteId = keyof Routes;

type InputOf<S> = S extends z.ZodTypeAny ? z.input<S> : never;
type OutputOf<S> = S extends z.ZodTypeAny ? z.output<S> : never;

export interface CallArgs<K extends RouteId> {
  readonly params?: InputOf<NonNullable<Routes[K]["params"]>>;
  readonly query?: InputOf<NonNullable<Routes[K]["query"]>>;
  readonly body?: InputOf<NonNullable<Routes[K]["body"]>>;
}

export type BodyOf<K extends RouteId> = InputOf<NonNullable<Routes[K]["body"]>>;

export interface CallOptions {
  readonly signal?: AbortSignal;
  /** Reuse a key to retry the same logical request. */
  readonly idempotencyKey?: string;
}

export type ClientErrorCode =
  | ApiErrorCode
  | "network_error"
  | "invalid_response"
  | "unexpected_status";

export class ApiClientError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly details: unknown;
  readonly requestId: string | null;
  constructor(
    code: ClientErrorCode,
    message: string,
    options: {
      status?: number;
      details?: unknown;
      requestId?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = options.status ?? 0;
    this.details = options.details;
    this.requestId = options.requestId ?? null;
  }
}

export const isApiClientError = (error: unknown): error is ApiClientError =>
  error instanceof ApiClientError;

/** Substitutes `:name` segments; values are percent-encoded. */
export const buildPath = (
  template: string,
  params: Record<string, unknown>,
): string =>
  template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/gu, (_match, name: string) => {
    const value = params[name];
    if (typeof value !== "string" && typeof value !== "number")
      throw new ApiClientError(
        "validation_failed",
        `Missing path parameter ${name}`,
        { details: { source: "client" } },
      );
    return encodeURIComponent(String(value));
  });

export const buildQuery = (query: Record<string, unknown>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
};

const looksLikeJson = (text: string): boolean => /^\s*[{[]/u.test(text);

/** Turns a failed response into a typed error, keeping the envelope intact. */
export const errorFromResponse = (
  status: number,
  text: string,
): ApiClientError => {
  let body: unknown = null;
  if (looksLikeJson(text)) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  const envelope = apiErrorSchema.safeParse(body);
  if (envelope.success) {
    const { code, message, details, request_id } = envelope.data.error;
    return new ApiClientError(code, message, {
      status,
      details,
      requestId: request_id,
    });
  }
  return new ApiClientError(
    "unexpected_status",
    `The server answered HTTP ${status} without an error envelope`,
    { status, details: text.slice(0, 500) },
  );
};

export interface ApiClient {
  call<K extends RouteId>(
    id: K,
    args?: CallArgs<K>,
    options?: CallOptions,
  ): Promise<OutputOf<Routes[K]["response"]>>;
  /** Streaming routes (raw results, artifacts): the checked response. */
  stream<K extends RouteId>(
    id: K,
    args?: CallArgs<K>,
    options?: CallOptions,
  ): Promise<Response>;
  /** Same-origin relative URL for a route; throws on invalid parameters. */
  url<K extends RouteId>(id: K, args?: CallArgs<K>): string;
}

export interface ClientDeps {
  readonly fetch: typeof fetch;
  readonly newKey: () => string;
}

interface Prepared {
  readonly url: string;
  readonly init: RequestInit;
}

const issues = (error: z.ZodError): unknown =>
  error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));

export const createApiClient = (deps?: Partial<ClientDeps>): ApiClient => {
  const doFetch: typeof fetch =
    deps?.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const newKey = deps?.newKey ?? (() => crypto.randomUUID());

  const parseInput = (
    schema: z.ZodTypeAny | undefined,
    value: unknown,
    what: string,
  ): unknown => {
    if (schema === undefined) return value;
    const parsed = schema.safeParse(value ?? {});
    if (!parsed.success)
      throw new ApiClientError("validation_failed", `Invalid ${what}`, {
        details: { source: "client", issues: issues(parsed.error) },
      });
    return parsed.data;
  };

  const locate = (id: RouteId, args: CallArgs<RouteId>): string => {
    const route = API_ROUTES[id];
    const params = parseInput(route.params, args.params, "path parameters");
    const query = route.query
      ? parseInput(route.query, args.query, "query")
      : undefined;
    return (
      API_PREFIX +
      buildPath(route.path, (params ?? {}) as Record<string, unknown>) +
      (query ? buildQuery(query as Record<string, unknown>) : "")
    );
  };

  const prepare = (
    id: RouteId,
    args: CallArgs<RouteId>,
    options: CallOptions,
  ): Prepared => {
    const route = API_ROUTES[id];
    const headers: Record<string, string> = { accept: "application/json" };
    const init: RequestInit = {
      method: route.method.toUpperCase(),
      credentials: "same-origin",
      headers,
    };
    if (options.signal) init.signal = options.signal;
    if (route.body) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(parseInput(route.body, args.body, "body"));
    }
    if (route.idempotent === true)
      headers["idempotency-key"] = options.idempotencyKey ?? newKey();
    return { url: locate(id, args), init };
  };

  const send = async (prepared: Prepared): Promise<Response> => {
    let response: Response;
    try {
      response = await doFetch(prepared.url, prepared.init);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        throw error;
      throw new ApiClientError(
        "network_error",
        error instanceof Error ? error.message : "Network request failed",
      );
    }
    if (!response.ok)
      throw errorFromResponse(response.status, await response.text());
    return response;
  };

  return {
    async call(id, args = {}, options = {}) {
      const route = API_ROUTES[id];
      const response = await send(prepare(id, args, options));
      const text = await response.text();
      let json: unknown;
      try {
        json = text === "" ? null : JSON.parse(text);
      } catch {
        throw new ApiClientError(
          "invalid_response",
          `${route.id}: the response is not JSON`,
          { status: response.status },
        );
      }
      const parsed = route.response.safeParse(json);
      if (!parsed.success)
        throw new ApiClientError(
          "invalid_response",
          `${route.id}: the response does not match its contract`,
          { status: response.status, details: issues(parsed.error) },
        );
      return parsed.data as never;
    },
    stream(id, args = {}, options = {}) {
      return send(prepare(id, args, options));
    },
    url(id, args = {}) {
      return locate(id, args);
    },
  };
};

export const api: ApiClient = createApiClient();
