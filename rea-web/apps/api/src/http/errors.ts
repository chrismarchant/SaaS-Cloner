import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import {
  ApiError,
  HTTP_STATUS_BY_CODE,
  type ApiErrorBody,
  type ApiErrorCode,
} from "@rea-web/contracts";

export const zodIssues = (error: ZodError) =>
  error.issues.map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));

interface Normalised {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

const fastifyStatusCode = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
};

const codeForStatus = (status: number): ApiErrorCode => {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 413:
      return "payload_too_large";
    case 429:
      return "rate_limited";
    default:
      return "validation_failed";
  }
};

/**
 * Map any thrown value to the wire taxonomy. Unknown failures become a generic
 * `internal` error: their message and stack are for the log only.
 */
export const normaliseError = (error: unknown): Normalised => {
  if (error instanceof ApiError)
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  if (error instanceof ZodError)
    return {
      code: "validation_failed",
      message: "Request validation failed",
      details: { issues: zodIssues(error) },
    };
  const status = fastifyStatusCode(error);
  if (status !== undefined && status >= 400 && status < 500) {
    const code = codeForStatus(status);
    const message =
      error instanceof Error && code === "validation_failed"
        ? error.message
        : (HTTP_REASONS[code] ?? "Request rejected");
    return { code, message };
  }
  return { code: "internal", message: "Internal server error" };
};

const HTTP_REASONS: Partial<Record<ApiErrorCode, string>> = {
  unauthorized: "Authentication required",
  forbidden: "Forbidden",
  not_found: "Not found",
  payload_too_large: "Payload too large",
  rate_limited: "Too many requests",
};

export const errorBody = (
  normalised: Normalised,
  requestId: string,
): ApiErrorBody => ({
  error: {
    code: normalised.code,
    message: normalised.message,
    ...(normalised.details === undefined
      ? {}
      : { details: normalised.details }),
    request_id: requestId,
  },
});

export const sendError = (
  reply: FastifyReply,
  error: unknown,
  requestId: string,
): FastifyReply => {
  const normalised = normaliseError(error);
  const status = HTTP_STATUS_BY_CODE[normalised.code];
  if (reply.raw.headersSent || reply.sent) return reply;
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .type("application/json; charset=utf-8")
    .send(errorBody(normalised, requestId));
};

export const registerErrorHandling = (app: FastifyInstance): void => {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    const normalised = normaliseError(error);
    if (normalised.code === "internal") {
      request.log.error({ err: error }, "unhandled error");
    } else if (reply.statusCode >= 500) {
      request.log.warn({ code: normalised.code }, "request failed");
    }
    sendError(reply, error, request.id);
  });
  app.setNotFoundHandler((request, reply) => {
    sendError(reply, new ApiError("not_found", "Route not found"), request.id);
  });
};
