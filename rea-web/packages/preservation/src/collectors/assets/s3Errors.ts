import type { Omission } from "../../types.js";

export type S3FailureKind =
  /** Credentials accepted but the operation is not permitted. */
  | "access_denied"
  /** Credentials rejected, expired or the signature did not match. */
  | "bad_credentials"
  | "no_such_bucket"
  | "no_such_key"
  | "precondition"
  /** Connection, timeout, truncated body, throttling or a 5xx answer. */
  | "network"
  /** The package staging area could not take the file. */
  | "local_conflict"
  | "local_io"
  | "other";

export interface S3Failure {
  kind: S3FailureKind;
  /** Un-redacted `Name: message`; callers redact before storing. */
  message: string;
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_DESTROYED",
  "UND_ERR_SOCKET",
]);
const LOCAL_CONFLICT_CODES = new Set([
  "EEXIST",
  "ENOTDIR",
  "EISDIR",
  "ENAMETOOLONG",
]);
const LOCAL_IO_CODES = new Set([
  "ENOSPC",
  "EACCES",
  "EPERM",
  "EROFS",
  "EDQUOT",
  "EMFILE",
]);
const BAD_CREDENTIAL_NAMES = new Set([
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "ExpiredToken",
  "InvalidToken",
  "TokenRefreshRequired",
  "AuthorizationHeaderMalformed",
  "CredentialsProviderError",
  "InvalidClientTokenId",
]);

const httpStatus = (error: unknown): number | undefined =>
  (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause === undefined ? undefined : codeOf(cause);
};

export const classifyS3Error = (error: unknown): S3Failure => {
  const e = error instanceof Error ? error : new Error(String(error));
  const message = `${e.name}: ${e.message}`;
  const code = codeOf(e);
  const status = httpStatus(e);
  if (code !== undefined && LOCAL_CONFLICT_CODES.has(code))
    return { kind: "local_conflict", message };
  if (code !== undefined && LOCAL_IO_CODES.has(code))
    return { kind: "local_io", message };
  if (e.name === "NoSuchBucket") return { kind: "no_such_bucket", message };
  if (e.name === "NoSuchKey") return { kind: "no_such_key", message };
  if (BAD_CREDENTIAL_NAMES.has(e.name) || status === 401)
    return { kind: "bad_credentials", message };
  if (e.name === "AccessDenied" || status === 403)
    return { kind: "access_denied", message };
  if (e.name === "PreconditionFailed" || status === 412)
    return { kind: "precondition", message };
  if (status === 404) return { kind: "no_such_key", message };
  if (
    (code !== undefined && NETWORK_CODES.has(code)) ||
    e.name === "TimeoutError" ||
    e.name === "RequestTimeout" ||
    e.name === "SlowDown" ||
    e.name === "NetworkingError" ||
    (status !== undefined && (status >= 500 || status === 429))
  )
    return { kind: "network", message };
  return { kind: "other", message };
};

/** Blocking omission for a failure that stopped a bucket before anything was captured. */
export const blockedOmission = (
  what: string,
  failure: S3Failure,
  redact: (text: string) => string,
  context: { bucket: string; credentialNames: string; endpointHint: string },
): Omission => {
  const reason = redact(failure.message);
  switch (failure.kind) {
    case "access_denied":
      return {
        what,
        reason: `Access denied listing or reading bucket ${context.bucket}: ${reason}`,
        remediation: `Grant the capture credentials (${context.credentialNames}) s3:ListBucket on the bucket and s3:GetObject on its objects, then capture again.`,
      };
    case "bad_credentials":
      return {
        what,
        reason: `The storage service rejected the credentials for bucket ${context.bucket}: ${reason}`,
        remediation: `Check ${context.credentialNames} (key id, secret, session token expiry), the region and ${context.endpointHint}.`,
      };
    case "no_such_bucket":
      return {
        what,
        reason: `Bucket ${context.bucket} does not exist at the configured endpoint: ${reason}`,
        remediation: `Check the bucket name, the region and ${context.endpointHint}.`,
      };
    case "network":
      return {
        what,
        reason: `The storage endpoint could not be reached or answered with an error: ${reason}`,
        remediation: `Check network access from the runner to the storage endpoint (${context.endpointHint}) and capture again.`,
      };
    default:
      return {
        what,
        reason: `Bucket ${context.bucket} could not be read: ${reason}`,
        remediation: `Check the bucket, ${context.endpointHint} and the credentials, then capture again.`,
      };
  }
};
