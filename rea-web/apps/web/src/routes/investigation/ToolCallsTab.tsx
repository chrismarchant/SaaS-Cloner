import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { useRawResult } from "../../api/hooks";
import { Badge } from "../../components/Badge";
import { ErrorNotice } from "../../components/ErrorNotice";
import { JsonExplorer } from "../../components/JsonTree";
import { formatBytes, formatDuration, formatTimestamp } from "../../lib/format";
import {
  RAW_FORCE_LIMIT_BYTES,
  RAW_VIEW_LIMIT_BYTES,
  normalizedResultOf,
  prettyJson,
} from "../../lib/json";
import type { ToolCall } from "./shared";

const isPrimitive = (
  value: unknown,
): value is string | number | boolean | null =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

function Value({ value }: { value: unknown }): ReactNode {
  if (isPrimitive(value))
    return value === null ? (
      <span className="muted">null</span>
    ) : (
      <span>{String(value)}</span>
    );
  if (Array.isArray(value) && value.every(isPrimitive))
    return value.length === 0 ? (
      <span className="muted">none</span>
    ) : (
      <ul className="plain">
        {value.map((entry, index) => (
          <li key={`${index}:${String(entry)}`}>{String(entry)}</li>
        ))}
      </ul>
    );
  return <JsonExplorer value={value} />;
}

const DERIVED_LABELS: readonly (readonly [string, string])[] = [
  ["is_error", "Error result"],
  ["evidence_id", "Evidence id"],
  ["operation", "Operation"],
  ["kind", "Kind"],
  ["confidence", "Confidence"],
  ["authority", "Authority"],
  ["predicate_type", "Predicate type"],
  ["normalized_result_keys", "Normalized result keys"],
  ["limitations", "Limitations"],
  ["coverage", "Coverage"],
  ["residual_unknowns_count", "Residual unknowns"],
  ["error", "Error"],
  ["raw_result_present", "Raw result present"],
  ["analysis_profile_present", "Analysis profile present"],
  ["structured_present", "Structured content present"],
  ["text_chars", "Text characters"],
  ["top_level_keys", "Top-level keys"],
];

/** The stored `derived` object, field by field, as the producer recorded it. */
function DerivedView({ call }: { call: ToolCall }) {
  const known = new Set(DERIVED_LABELS.map(([key]) => key));
  const extra = Object.entries(call.derived).filter(([key]) => !known.has(key));
  return (
    <div data-testid="derived-summary">
      <p className="muted">
        A derived summary is a shallow extraction kept beside the raw result; it
        never replaces it.
      </p>
      <dl className="facts">
        {DERIVED_LABELS.filter(([key]) => key in call.derived).map(
          ([key, label]) => (
            <div key={key} className="fact">
              <dt>{label}</dt>
              <dd>
                <Value value={call.derived[key]} />
              </dd>
            </div>
          ),
        )}
        {extra.map(([key, value]) => (
          <div key={key} className="fact">
            <dt>
              <code>{key}</code>
            </dt>
            <dd>
              <Value value={value} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function useRawControls(
  call: ToolCall,
  projectId: string,
  investigationId: string,
) {
  const [force, setForce] = useState(false);
  const tooBig = call.raw_result_bytes > RAW_VIEW_LIMIT_BYTES;
  const raw = useRawResult(
    projectId,
    investigationId,
    call.id,
    !tooBig || force,
  );
  const downloadHref = (): string | null => {
    try {
      return api.url("getToolCallRaw", {
        params: { p: projectId, i: investigationId, c: call.id },
      });
    } catch {
      return null;
    }
  };
  return { force, setForce, tooBig, raw, href: downloadHref() };
}

function RawGate({
  call,
  controls,
  children,
}: {
  call: ToolCall;
  controls: ReturnType<typeof useRawControls>;
  children: (value: unknown) => ReactNode;
}) {
  const { tooBig, force, setForce, raw, href } = controls;
  const download =
    href === null ? null : (
      <a href={href} download={`tool-call-${call.seq}.json`}>
        Download the raw result ({formatBytes(call.raw_result_bytes)})
      </a>
    );
  if (tooBig && !force)
    return (
      <div className="notice notice-warn">
        <p>
          The raw result is {formatBytes(call.raw_result_bytes)}, above the{" "}
          {formatBytes(RAW_VIEW_LIMIT_BYTES)} the page shows by default.
        </p>
        <p>{download}</p>
        {call.raw_result_bytes <= RAW_FORCE_LIMIT_BYTES && (
          <button type="button" onClick={() => setForce(true)}>
            Load it in the browser anyway
          </button>
        )}
      </div>
    );
  if (raw.isPending) return <p role="status">Loading the raw result…</p>;
  if (raw.isError) return <ErrorNotice error={raw.error} />;
  return (
    <>
      {children(raw.data)}
      <p>{download}</p>
    </>
  );
}

function RawView({
  call,
  controls,
}: {
  call: ToolCall;
  controls: ReturnType<typeof useRawControls>;
}) {
  return (
    <RawGate call={call} controls={controls}>
      {(value) => {
        const pretty = prettyJson(value, RAW_VIEW_LIMIT_BYTES);
        return (
          <>
            <p className="muted">
              sha256 <code>{call.raw_result_sha256}</code>
            </p>
            {pretty.truncated && (
              <p className="notice notice-warn">
                Showing the first {formatBytes(RAW_VIEW_LIMIT_BYTES)} of{" "}
                {pretty.totalChars} characters. Download the file for the
                complete result.
              </p>
            )}
            <pre className="code raw" data-testid="raw-result" tabIndex={0}>
              {pretty.text}
            </pre>
          </>
        );
      }}
    </RawGate>
  );
}

function ExplorerView({
  call,
  controls,
}: {
  call: ToolCall;
  controls: ReturnType<typeof useRawControls>;
}) {
  return (
    <RawGate call={call} controls={controls}>
      {(value) => {
        const normalized = normalizedResultOf(value);
        return normalized === undefined ? (
          <p className="notice">
            This raw result has no{" "}
            <code>structuredContent.normalized_result</code>, so there is
            nothing to explore.
          </p>
        ) : (
          <div data-testid="evidence-explorer">
            <p className="muted">
              <code>structuredContent.normalized_result</code> exactly as the
              producer returned it. Nodes load when opened.
            </p>
            <JsonExplorer value={normalized} label="normalized_result" />
          </div>
        );
      }}
    </RawGate>
  );
}

type View = "derived" | "raw" | "explorer";

function CallDetail({
  call,
  projectId,
  investigationId,
}: {
  call: ToolCall;
  projectId: string;
  investigationId: string;
}) {
  const [view, setView] = useState<View>("derived");
  const controls = useRawControls(call, projectId, investigationId);
  const offersExplorer =
    call.tool_name === "analyze_javascript_application" ||
    (Array.isArray(call.derived["normalized_result_keys"]) &&
      call.derived["normalized_result_keys"].length > 0);
  return (
    <section
      className="card"
      aria-label={`Tool call ${call.seq}`}
      data-testid="call-detail"
    >
      <h3>
        Tool call #{call.seq}: <code>{call.tool_name}</code>
      </h3>
      <dl className="facts">
        <div className="fact">
          <dt>Started</dt>
          <dd>{formatTimestamp(call.started_at)}</dd>
        </div>
        <div className="fact">
          <dt>Upstream session</dt>
          <dd>
            <code>{call.upstream_session_id}</code> call {call.upstream_seq}
          </dd>
        </div>
        <div className="fact">
          <dt>Raw result</dt>
          <dd>{formatBytes(call.raw_result_bytes)}</dd>
        </div>
      </dl>
      <div className="row" role="group" aria-label="Tool call view">
        <button
          type="button"
          aria-pressed={view === "derived"}
          onClick={() => setView("derived")}
        >
          Derived summary
        </button>
        <button
          type="button"
          aria-pressed={view === "raw"}
          onClick={() => setView("raw")}
        >
          Raw result
        </button>
        {offersExplorer && (
          <button
            type="button"
            aria-pressed={view === "explorer"}
            onClick={() => setView("explorer")}
          >
            Evidence explorer
          </button>
        )}
      </div>
      {view === "derived" && <DerivedView call={call} />}
      {view === "raw" && <RawView call={call} controls={controls} />}
      {view === "explorer" && <ExplorerView call={call} controls={controls} />}
    </section>
  );
}

export function ToolCallsTab({
  projectId,
  investigationId,
  calls,
  hasMore,
  loadMore,
  loadingMore,
}: {
  projectId: string;
  investigationId: string;
  calls: readonly ToolCall[];
  hasMore: boolean;
  loadMore: () => void;
  loadingMore: boolean;
}) {
  const [search, setSearch] = useSearchParams();
  const selectedSeq = Number(search.get("call"));
  const selected = calls.find((call) => call.seq === selectedSeq) ?? null;
  const select = (seq: number): void => {
    const next = new URLSearchParams(search);
    next.set("tab", "calls");
    next.set("call", String(seq));
    setSearch(next);
  };
  if (calls.length === 0) return <p>No tool call has been recorded yet.</p>;
  return (
    <>
      <div className="table-wrap">
        <table className="table" data-testid="calls-table">
          <thead>
            <tr>
              <th scope="col">Seq</th>
              <th scope="col">Tool</th>
              <th scope="col">Effects</th>
              <th scope="col">Duration</th>
              <th scope="col">Error</th>
              <th scope="col">Evidence id</th>
              <th scope="col">Open</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call) => (
              <tr
                key={call.id}
                id={`call-${call.seq}`}
                data-testid="call-row"
                aria-current={selected?.id === call.id ? "true" : undefined}
                className={selected?.id === call.id ? "selected" : undefined}
              >
                <th scope="row">{call.seq}</th>
                <td>
                  <code>{call.tool_name}</code>
                </td>
                <td>{call.effects.join(", ") || "none"}</td>
                <td>{formatDuration(call.duration_ms)}</td>
                <td>
                  <Badge
                    value={call.is_error ? "error" : "ok"}
                    tone={call.is_error ? "bad" : "ok"}
                  />
                </td>
                <td>
                  {call.evidence_id === null ? (
                    <span className="muted">none</span>
                  ) : (
                    <code className="break">{call.evidence_id}</code>
                  )}
                </td>
                <td>
                  <button type="button" onClick={() => select(call.seq)}>
                    Inspect
                    <span className="sr-only">
                      {" "}
                      call {call.seq} {call.tool_name}
                    </span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <button type="button" disabled={loadingMore} onClick={loadMore}>
          Load more tool calls
        </button>
      )}
      {selected !== null ? (
        <CallDetail
          key={selected.id}
          call={selected}
          projectId={projectId}
          investigationId={investigationId}
        />
      ) : (
        search.get("call") !== null && (
          <p className="notice notice-warn">
            Tool call #{search.get("call")} is not in the loaded list.
          </p>
        )
      )}
    </>
  );
}
