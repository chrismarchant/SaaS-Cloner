import { isApiClientError } from "../api/client";
import { prettyJson } from "../lib/json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** Failure from the API or the client, with the upstream words kept verbatim. */
export function ErrorNotice({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  if (!isApiClientError(error))
    return (
      <div className="notice notice-error" role="alert">
        <strong>Error</strong>
        <p>{error instanceof Error ? error.message : String(error)}</p>
      </div>
    );
  const details = error.details;
  const reason = isRecord(details) ? text(details["reason"]) : null;
  const remediation = isRecord(details) ? text(details["remediation"]) : null;
  const hasDetails = details !== undefined && details !== null;
  return (
    <div className="notice notice-error" role="alert">
      <p>
        <strong>{error.code}</strong>
        {error.status > 0 ? ` (HTTP ${error.status})` : ""}: {error.message}
      </p>
      {reason !== null && (
        <p>
          <span className="label">reason</span> {reason}
        </p>
      )}
      {remediation !== null && (
        <p>
          <span className="label">remediation</span> {remediation}
        </p>
      )}
      {hasDetails && (
        <details>
          <summary>Details</summary>
          <pre className="code">{prettyJson(details, 20_000).text}</pre>
        </details>
      )}
      {error.requestId !== null && (
        <p className="muted">
          request id <code>{error.requestId}</code>
        </p>
      )}
    </div>
  );
}
