import { useState, type ReactNode } from "react";
import type { Job } from "@rea-web/contracts/browser";
import {
  isTerminal,
  useApprovals,
  useJob,
  useJobAction,
  useRunners,
} from "../api/hooks";
import { useJobStream } from "../api/jobStream";
import { useProject } from "../api/project";
import { summariseEvent } from "../lib/events";
import { formatBytes, formatDuration, formatTimestamp } from "../lib/format";
import { prettyJson } from "../lib/json";
import { BUDGET_KEYS } from "../lib/policy";
import { Badge } from "./Badge";
import { ErrorNotice } from "./ErrorNotice";

const BYTE_KEYS = new Set(["memory_bytes", "disk_bytes", "artifact_bytes"]);

const amount = (key: string, value: number | undefined): string => {
  if (value === undefined) return "no limit";
  if (BYTE_KEYS.has(key)) return `${formatBytes(value)} (${value})`;
  if (key.endsWith("_ms")) return `${formatDuration(value)} (${value})`;
  return String(value);
};

function BudgetTable({ job }: { job: Job }) {
  return (
    <table className="table">
      <caption>Budget usage</caption>
      <thead>
        <tr>
          <th scope="col">Dimension</th>
          <th scope="col">Used</th>
          <th scope="col">Budget</th>
        </tr>
      </thead>
      <tbody>
        {BUDGET_KEYS.map((key) => {
          const used =
            key === "memory_bytes"
              ? job.usage.memory_bytes_peak
              : job.usage[key];
          const limit = job.budget[key];
          return (
            <tr key={key}>
              <th scope="row">
                <code>{key}</code>
                {key === "memory_bytes" && (
                  <span className="muted"> (peak)</span>
                )}
              </th>
              <td>{amount(key, used)}</td>
              <td>
                {amount(key, limit)}
                {limit !== undefined && used > limit && (
                  <>
                    {" "}
                    <Badge value="over budget" tone="bad" />
                  </>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Approvals({ projectId, job }: { projectId: string; job: Job }) {
  const { canWrite } = useProject();
  const approvals = useApprovals(
    projectId,
    job.id,
    job.state === "awaiting_approval",
  );
  const actions = useJobAction(projectId, job.id);
  if (job.state !== "awaiting_approval") return null;
  return (
    <section aria-labelledby={`appr-${job.id}`}>
      <h3 id={`appr-${job.id}`}>Approval required</h3>
      <ErrorNotice error={approvals.error} />
      <ErrorNotice error={actions.approve.error ?? actions.reject.error} />
      {approvals.data?.items.length === 0 && (
        <p className="muted">No pending approval request is listed.</p>
      )}
      {approvals.data?.items.map((request) => (
        <article key={request.approval_id} className="card">
          <dl className="facts">
            <dt>Tool</dt>
            <dd>
              <code>{request.tool}</code>
            </dd>
            <dt>Effects</dt>
            <dd>{request.effects.join(", ") || "none declared"}</dd>
            <dt>Reason</dt>
            <dd>{request.reason}</dd>
            <dt>Requested</dt>
            <dd>{formatTimestamp(request.requested_at)}</dd>
          </dl>
          <p className="label">Arguments</p>
          <pre className="code">
            {prettyJson(request.arguments, 20_000).text}
          </pre>
          <div className="row">
            <button
              type="button"
              disabled={!canWrite || actions.approve.isPending}
              onClick={() => actions.approve.mutate(request.approval_id)}
            >
              Approve
            </button>
            <button
              type="button"
              className="danger"
              disabled={!canWrite || actions.reject.isPending}
              onClick={() => actions.reject.mutate(request.approval_id)}
            >
              Reject
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

const TIMELINE_LIMIT = 500;

function Timeline({ projectId, jobId }: { projectId: string; jobId: string }) {
  const stream = useJobStream(projectId, jobId);
  const [all, setAll] = useState(false);
  const hidden = all ? 0 : Math.max(0, stream.events.length - TIMELINE_LIMIT);
  const visible = hidden > 0 ? stream.events.slice(hidden) : stream.events;
  return (
    <section aria-labelledby={`tl-${jobId}`}>
      <h3 id={`tl-${jobId}`}>Timeline</h3>
      <p role="status" className="muted" data-testid="stream-status">
        Event stream: {stream.status}
        {stream.end !== null &&
          ` (job ${stream.end.state}, last event #${stream.end.lastSeq})`}
        {stream.status === "failed" &&
          ". The stream could not be kept open; the job state above is refreshed by polling."}
      </p>
      {hidden > 0 && (
        <button type="button" onClick={() => setAll(true)}>
          Show {hidden} earlier events
        </button>
      )}
      <ol className="timeline">
        {visible.map((event) => (
          <li key={event.seq}>
            <span className="seq">#{event.seq}</span> <code>{event.kind}</code>{" "}
            <span>{summariseEvent(event)}</span>{" "}
            <time className="muted" dateTime={event.created_at}>
              {formatTimestamp(event.created_at)}
            </time>
            {Object.keys(event.payload).length > 0 && (
              <details>
                <summary>Payload</summary>
                <pre className="code">
                  {prettyJson(event.payload, 10_000).text}
                </pre>
              </details>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Failure({ job }: { job: Job }) {
  if (job.failure === null) return null;
  const { code, message, retryable, details } = job.failure;
  return (
    <div className="notice notice-error" role="alert">
      <p>
        <strong>Failure {code}</strong>: {message}
      </p>
      <p className="muted">
        {retryable
          ? "The runner marked this failure retryable."
          : "Not retryable."}
        {code === "budget_exceeded" &&
          " A measured budget was exceeded, so the job was aborted (this differs from a partial result, where a counted budget stopped planned work)."}
      </p>
      {details !== undefined && details !== null && (
        <details open>
          <summary>Failure details</summary>
          <pre className="code">{prettyJson(details, 20_000).text}</pre>
        </details>
      )}
    </div>
  );
}

/**
 * One job: live state, budget, approvals, cancel, timeline and (through
 * `renderResult`) the job-specific result once it has one.
 */
export function JobPanel({
  projectId,
  jobId,
  title,
  renderResult,
}: {
  projectId: string;
  jobId: string;
  title: string;
  renderResult?: (job: Job) => ReactNode;
}) {
  const job = useJob(projectId, jobId);
  const runners = useRunners(projectId);
  const actions = useJobAction(projectId, jobId);
  const { canWrite } = useProject();
  if (job.isPending) return <p role="status">Loading job…</p>;
  if (job.isError) return <ErrorNotice error={job.error} />;
  const data = job.data;
  const live = !isTerminal(data.state);
  const runnerName = (id: string): string =>
    runners.data?.items.find((runner) => runner.id === id)?.name ?? id;
  const partial = data.result?.["partial"] === true;
  return (
    <section className="job-panel" aria-label={title}>
      <header className="row between">
        <h2>{title}</h2>
        <div className="row">
          <Badge value={data.state} />
          {partial && <Badge value="partial" />}
          {live && (
            <button
              type="button"
              className="danger"
              disabled={
                !canWrite ||
                actions.cancel.isPending ||
                data.cancel_requested_at !== null
              }
              onClick={() => actions.cancel.mutate()}
            >
              Cancel job
            </button>
          )}
        </div>
      </header>
      <ErrorNotice error={actions.cancel.error} />
      <dl className="facts" aria-live="polite">
        <dt>Job</dt>
        <dd>
          <code>{data.id}</code> ({data.kind})
        </dd>
        <dt>Attempt</dt>
        <dd>{data.attempt}</dd>
        <dt>Lease</dt>
        <dd>
          {data.lease === null
            ? "no active lease"
            : `runner ${runnerName(data.lease.runner_id)}, expires ${formatTimestamp(data.lease.expires_at)}`}
        </dd>
        {data.cancel_requested_at !== null && (
          <>
            <dt>Cancel requested</dt>
            <dd>{formatTimestamp(data.cancel_requested_at)}</dd>
          </>
        )}
        <dt>Updated</dt>
        <dd>{formatTimestamp(data.updated_at)}</dd>
      </dl>
      {partial && (
        <p className="notice notice-warn">
          Partial result: a counted budget (tool calls or model tokens) stopped
          planned work before every step ran. Skipped steps are recorded as
          budget_exhausted findings.
        </p>
      )}
      <Failure job={data} />
      <Approvals projectId={projectId} job={data} />
      {renderResult !== undefined && data.result !== null && renderResult(data)}
      <BudgetTable job={data} />
      <Timeline projectId={projectId} jobId={jobId} />
    </section>
  );
}
