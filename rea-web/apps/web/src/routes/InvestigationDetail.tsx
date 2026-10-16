import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  flatten,
  isTerminal,
  useEvidence,
  useFindings,
  useInvestigation,
  useTargets,
  useToolCalls,
} from "../api/hooks";
import { useProject } from "../api/project";
import { Badge } from "../components/Badge";
import { ErrorNotice } from "../components/ErrorNotice";
import { JsonExplorer } from "../components/JsonTree";
import { RoutingTable } from "../components/RoutingView";
import { formatTimestamp } from "../lib/format";
import { EvidenceTab } from "./investigation/EvidenceTab";
import { ExportTab } from "./investigation/ExportTab";
import { FindingsTab } from "./investigation/FindingsTab";
import { FollowUpTab } from "./investigation/FollowUpTab";
import { RunTab } from "./investigation/RunTab";
import { evidenceOptions } from "./investigation/shared";
import { ToolCallsTab } from "./investigation/ToolCallsTab";

const TABS = [
  ["run", "Run"],
  ["calls", "Tool calls"],
  ["findings", "Findings"],
  ["evidence", "Evidence"],
  ["follow-up", "Follow-up"],
  ["export", "Export"],
] as const;

type TabId = (typeof TABS)[number][0];

const asTab = (value: string | null): TabId =>
  TABS.find(([id]) => id === value)?.[0] ?? "run";

export function InvestigationDetail() {
  const { id = "" } = useParams();
  const { project } = useProject();
  const [search] = useSearchParams();
  const tab = asTab(search.get("tab"));
  const investigation = useInvestigation(project.id, id);
  const status = investigation.data?.status;
  const live = status === "pending" || status === "running";
  const calls = useToolCalls(project.id, id, live);
  const findings = useFindings(project.id, id, live);
  const evidence = useEvidence(project.id, id, live);
  const targets = useTargets(project.id);

  if (investigation.isPending)
    return <p role="status">Loading investigation…</p>;
  if (investigation.isError) return <ErrorNotice error={investigation.error} />;
  const data = investigation.data;
  const callList = flatten(calls.data);
  const targetName =
    flatten(targets.data).find((target) => target.id === data.target_id)
      ?.name ?? data.target_id;

  return (
    <>
      <p>
        <Link to="/investigations">Investigations</Link> /{" "}
        <code>{data.id}</code>
      </p>
      <h1 className="prewrap" data-testid="investigation-question">
        {data.question}
      </h1>
      <div className="row">
        <span data-testid="investigation-status">
          <Badge value={data.status} />
        </span>
        {data.job_state !== null && <Badge value={data.job_state} />}
        <span className="muted">
          target {targetName} · created {formatTimestamp(data.created_at)} ·{" "}
          {data.tool_call_count} tool calls ·{" "}
          {Object.entries(data.finding_counts)
            .map(([kind, count]) => `${kind} ${count}`)
            .join(", ") || "no findings"}
        </span>
      </div>
      <details>
        <summary>Execution policy and routing</summary>
        <JsonExplorer value={data.policy} label="policy" />
        {data.routing === null ? (
          <p className="muted">No routing was recorded.</p>
        ) : (
          <RoutingTable routing={data.routing} />
        )}
        {data.upstream_identity !== null && (
          <JsonExplorer
            value={data.upstream_identity}
            label="upstream identity"
          />
        )}
      </details>
      <nav aria-label="Investigation sections">
        <ul className="tabs">
          {TABS.map(([tabId, label]) => (
            <li key={tabId}>
              <Link
                to={`/investigations/${id}?tab=${tabId}`}
                aria-current={tab === tabId ? "page" : undefined}
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="tab-panel">
        {tab === "run" && <RunTab projectId={project.id} jobId={data.job_id} />}
        {tab === "calls" && (
          <>
            <ErrorNotice error={calls.error} />
            <ToolCallsTab
              projectId={project.id}
              investigationId={id}
              calls={callList}
              hasMore={calls.hasNextPage}
              loadMore={() => void calls.fetchNextPage()}
              loadingMore={calls.isFetchingNextPage}
            />
          </>
        )}
        {tab === "findings" && (
          <>
            <ErrorNotice error={findings.error} />
            <FindingsTab
              investigationId={id}
              findings={findings.data?.items ?? []}
              calls={callList}
            />
          </>
        )}
        {tab === "evidence" && (
          <>
            <ErrorNotice error={evidence.error} />
            <EvidenceTab
              projectId={project.id}
              investigationId={id}
              artifacts={evidence.data?.items ?? []}
            />
          </>
        )}
        {tab === "follow-up" && (
          <FollowUpTab
            investigationId={id}
            evidence={evidenceOptions(callList)}
            live={!isTerminal(data.job_state)}
          />
        )}
        {tab === "export" && (
          <ExportTab investigationId={id} live={!isTerminal(data.job_state)} />
        )}
      </div>
    </>
  );
}
