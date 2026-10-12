import { z } from "zod";

/** Closed set of API error codes. Adding a code is a contract change. */
export const API_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "validation_failed",
  "idempotency_conflict",
  "stale_lease",
  "lease_expired",
  "invalid_transition",
  "budget_exceeded",
  "capability_unavailable",
  "payload_too_large",
  "unsafe_url",
  "unsafe_archive",
  "unsafe_path",
  "rate_limited",
  "registration_disabled",
  "internal",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
    request_id: z.string(),
  }),
});

export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

export const HTTP_STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 400,
  idempotency_conflict: 422,
  stale_lease: 409,
  lease_expired: 409,
  invalid_transition: 409,
  budget_exceeded: 422,
  capability_unavailable: 409,
  payload_too_large: 413,
  unsafe_url: 400,
  unsafe_archive: 400,
  unsafe_path: 400,
  rate_limited: 429,
  registration_disabled: 403,
  internal: 500,
};

/**
 * Typed failure carried through application code. Handlers convert it to the
 * wire shape above; nothing else formats errors.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details: unknown;
  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
  get status(): number {
    return HTTP_STATUS_BY_CODE[this.code];
  }
}

export type Result<T, E = ApiError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
