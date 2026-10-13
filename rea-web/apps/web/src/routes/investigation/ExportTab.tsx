import { useState } from "react";
import type { Job } from "@rea-web/contracts/browser";
import { useCreateExport } from "../../api/hooks";
import { useProject } from "../../api/project";
import { ErrorNotice } from "../../components/ErrorNotice";
import { JobPanel } from "../../components/JobPanel";
import { formatBytes } from "../../lib/format";
import { safeFileName } from "../../lib/format";
import { artifactHref } from "./EvidenceTab";
import { OperationList } from "./OperationList";
import { strings, useInvestigationJobs } from "./shared";

/** What the export job reported, field by field. */
export function ExportResult({
  job,
  projectId,
  investigationId,
}: {
  job: Job;
  projectId: string;
  investigationId: string;
}) {
  const result = job.result ?? {};
  const artifactId = result["export_artifact_id"];
  const href =
    typeof artifactId === "string"
      ? artifactHref(projectId, investigationId, artifactId)
      : null;
  const redacted = strings(result["redacted_members"]);
  const sha = result["sha256"];
  const size = result["size"];
  return (
    <section aria-label="Export result" data-testid="export-result">
      <h3>Export result</h3>
      <dl className="facts">
        <div className="fact">
          <dt>Archive</dt>
          <dd>
            {href === null ? (
              <span className="muted">no export artifact reported</span>
            ) : (
              <a
                href={href}
                download={safeFileName(
                  `investigation-${investigationId}-export.zip`,
                  "export.zip",
                )}
                data-testid="export-download"
              >
                Download the export zip
              </a>
            )}
          </dd>
        </div>
        <div className="fact">
          <dt>SHA-256 (recorded)</dt>
          <dd>
            <code className="break" data-testid="export-sha256">
              {typeof sha === "string" ? sha : "not reported"}
            </code>
          </dd>
        </div>
        <div className="fact">
          <dt>Size</dt>
          <dd>
            {typeof size === "number"
              ? `${formatBytes(size)} (${size} bytes)`
              : "not reported"}
          </dd>
        </div>
        <div className="fact">
          <dt>Members</dt>
          <dd data-testid="export-members">
            {typeof result["members"] === "number"
              ? result["members"]
              : "not reported"}
          </dd>
        </div>
        <div className="fact">
          <dt>Redacted members</dt>
          <dd>
            {redacted.length === 0 ? (
              "none"
            ) : (
              <ul className="plain">
                {redacted.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div className="fact">
          <dt>Omissions</dt>
          <dd>
            {typeof result["omissions"] === "number"
              ? `${result["omissions"]} raw ${result["omissions"] === 1 ? "result" : "results"} missing from storage`
              : "not reported"}
          </dd>
        </div>
      </dl>
      <p className="muted">
        The index inside the archive lists a SHA-256 for every member.
      </p>
    </section>
  );
}

export function ExportTab({
  investigationId,
  live,
}: {
  investigationId: string;
  live: boolean;
}) {
  const { project, canWrite } = useProject();
  const create = useCreateExport(project.id, investigationId);
  const history = useInvestigationJobs(
    project.id,
    investigationId,
    "investigation.export",
    live,
  );
  const [jobId, setJobId] = useState<string | null>(null);
  return (
    <>
      <p>
        An export is a zip of the investigation: findings, tool calls, raw
        results and evidence artifacts, with an index of SHA-256 digests.
        Members that were redacted are listed with the result.
      </p>
      <button
        type="button"
        disabled={!canWrite || create.isPending}
        onClick={() =>
          create.mutate(undefined, { onSuccess: (job) => setJobId(job.id) })
        }
      >
        Export investigation
      </button>
      {!canWrite && <p className="muted">Exporting needs the member role.</p>}
      <ErrorNotice error={create.error} />
      <OperationList
        title="Earlier exports"
        jobs={history.jobs}
        selected={jobId}
        onSelect={setJobId}
        describe={() => "export"}
      />
      {jobId !== null && (
        <JobPanel
          key={jobId}
          projectId={project.id}
          jobId={jobId}
          title="Export job"
          renderResult={(job) => (
            <ExportResult
              job={job}
              projectId={project.id}
              investigationId={investigationId}
            />
          )}
        />
      )}
    </>
  );
}
