import type { Job } from "@rea-web/contracts/browser";
import { JobPanel } from "../../components/JobPanel";
import { JsonExplorer } from "../../components/JsonTree";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function RunResult({ job }: { job: Job }) {
  const result = job.result ?? {};
  const unavailable = Array.isArray(result["unavailable"])
    ? result["unavailable"]
    : [];
  const model = result["model"];
  return (
    <section aria-label="Run result">
      <h3>Run result</h3>
      <dl className="facts">
        <div className="fact">
          <dt>Tool calls recorded</dt>
          <dd>
            {typeof result["tool_calls"] === "number"
              ? result["tool_calls"]
              : "not reported"}
          </dd>
        </div>
        <div className="fact">
          <dt>Finding counts</dt>
          <dd>
            {isRecord(result["findings"])
              ? Object.entries(result["findings"])
                  .map(([kind, count]) => `${kind} ${String(count)}`)
                  .join(", ")
              : "not reported"}
          </dd>
        </div>
        <div className="fact">
          <dt>Model follow-up</dt>
          <dd>
            {isRecord(model) ? (
              <JsonExplorer value={model} />
            ) : (
              <span>none recorded (not run, or no provider was available)</span>
            )}
          </dd>
        </div>
      </dl>
      {unavailable.length > 0 && (
        <>
          <p className="label">Tools that could not run</p>
          <ul>
            {unavailable.map((entry, index) =>
              isRecord(entry) ? (
                <li key={`${index}:${String(entry["tool"])}`}>
                  <code>{String(entry["tool"])}</code>:{" "}
                  {String(entry["reason"])}
                </li>
              ) : null,
            )}
          </ul>
        </>
      )}
    </section>
  );
}

export function RunTab({
  projectId,
  jobId,
}: {
  projectId: string;
  jobId: string | null;
}) {
  if (jobId === null)
    return <p className="notice">This investigation has no job yet.</p>;
  return (
    <JobPanel
      projectId={projectId}
      jobId={jobId}
      title="Investigation run"
      renderResult={(job) => <RunResult job={job} />}
    />
  );
}
