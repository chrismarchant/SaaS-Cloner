import { Link } from "react-router-dom";
import { flatten, useInvestigations, useTargets } from "../api/hooks";
import { useProject } from "../api/project";
import { Badge } from "../components/Badge";
import { ErrorNotice } from "../components/ErrorNotice";
import { formatTimestamp } from "../lib/format";

export function InvestigationsPage() {
  const { project, canWrite } = useProject();
  const investigations = useInvestigations(project.id);
  const targets = useTargets(project.id);
  const items = flatten(investigations.data);
  const targetName = (id: string): string =>
    flatten(targets.data).find((target) => target.id === id)?.name ?? id;
  return (
    <>
      <div className="row between">
        <h1>Investigations</h1>
        {canWrite && (
          <Link to="/investigations/new" className="button">
            New investigation
          </Link>
        )}
      </div>
      <ErrorNotice error={investigations.error} />
      {investigations.isPending && <p role="status">Loading investigations…</p>}
      {investigations.data !== undefined && items.length === 0 && (
        <p>No investigation has been created in this project.</p>
      )}
      {items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Question</th>
                <th scope="col">Target</th>
                <th scope="col">Status</th>
                <th scope="col">Job state</th>
                <th scope="col">Tool calls</th>
                <th scope="col">Findings</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((investigation) => (
                <tr key={investigation.id} data-testid="investigation-row">
                  <th scope="row">
                    <Link to={`/investigations/${investigation.id}`}>
                      {investigation.question.length > 120
                        ? `${investigation.question.slice(0, 120)}…`
                        : investigation.question}
                    </Link>
                  </th>
                  <td>{targetName(investigation.target_id)}</td>
                  <td>
                    <Badge value={investigation.status} />
                  </td>
                  <td>
                    {investigation.job_state === null ? (
                      <span className="muted">no job</span>
                    ) : (
                      <Badge value={investigation.job_state} />
                    )}
                  </td>
                  <td>{investigation.tool_call_count}</td>
                  <td>
                    {Object.entries(investigation.finding_counts)
                      .map(([kind, count]) => `${kind} ${count}`)
                      .join(", ") || "none"}
                  </td>
                  <td>{formatTimestamp(investigation.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {investigations.hasNextPage && (
        <button
          type="button"
          disabled={investigations.isFetchingNextPage}
          onClick={() => void investigations.fetchNextPage()}
        >
          Load more investigations
        </button>
      )}
    </>
  );
}
