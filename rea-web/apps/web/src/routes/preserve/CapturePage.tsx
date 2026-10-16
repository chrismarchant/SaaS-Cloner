import { Link, useParams } from "react-router-dom";
import {
  useBuildJobs,
  useCapture,
  useCoverage,
  useManifest,
} from "../../api/preserveHooks";
import { useProject } from "../../api/project";
import { Badge } from "../../components/Badge";
import { ErrorNotice } from "../../components/ErrorNotice";
import { JobPanel } from "../../components/JobPanel";
import { producedId } from "../../lib/buildJobs";
import { formatTimestamp } from "../../lib/format";
import {
  componentStatusWording,
  consistencyWording,
} from "../../lib/recoveryWording";
import { FileList, ManifestView } from "./ManifestView";
import { Crumbs, JobLinks } from "./shared";

const show = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

function Coverage({
  projectId,
  b,
  c,
}: {
  projectId: string;
  b: string;
  c: string;
}) {
  const coverage = useCoverage(projectId, b, c, true);
  return (
    <section aria-labelledby="coverage-heading">
      <h2 id="coverage-heading">Coverage</h2>
      <ErrorNotice error={coverage.error} />
      {coverage.isPending && <p role="status">Loading coverage…</p>}
      {coverage.data !== undefined && (
        <div data-testid="coverage">
          <p>
            Consistency reported with the coverage:{" "}
            <strong>
              {consistencyWording(coverage.data.consistency).label}
            </strong>
          </p>
          <h3>Missing or blocked</h3>
          {coverage.data.missing_or_blocked.length === 0 ? (
            <p className="muted">
              Every component is captured; nothing is listed as missing or
              blocked.
            </p>
          ) : (
            <ul className="plain">
              {coverage.data.missing_or_blocked.map((entry, index) => (
                <li key={index}>
                  {Object.entries(entry).map(([key, value]) => (
                    <span key={key}>
                      <span className="label">{key}</span> {show(value)}{" "}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export function CapturePage() {
  const { b = "", c = "" } = useParams();
  const { project, canWrite } = useProject();
  const capture = useCapture(project.id, b, c);
  const completed = capture.data?.status === "completed";
  const manifest = useManifest(
    project.id,
    b,
    c,
    capture.data?.manifest_object_key != null,
  );
  const verifications = useBuildJobs(
    project.id,
    "recovery.verify",
    "capture_id",
    c,
    true,
  );
  const exports_ = useBuildJobs(
    project.id,
    "recovery.export",
    "capture_id",
    c,
    true,
  );
  if (capture.isPending) return <p role="status">Loading capture…</p>;
  if (capture.isError) return <ErrorNotice error={capture.error} />;
  const data = capture.data;
  const consistency = consistencyWording(data.consistency);
  const statuses = Object.entries(data.component_statuses);
  const base = `/preserve/builds/${b}/captures/${c}`;
  const href =
    (kind: string, field: string, root: string) =>
    (job: Parameters<typeof producedId>[0]) => {
      const id = producedId(job, field);
      return id === null ? null : `${root}/${kind}/${id}`;
    };
  return (
    <>
      <Crumbs
        items={[
          { to: "/preserve", label: "Preserve" },
          { to: `/preserve/builds/${b}`, label: "Build" },
          { label: "Capture" },
        ]}
      />
      <h1>Capture</h1>
      <dl className="facts">
        <div className="fact">
          <dt>Status</dt>
          <dd data-testid="capture-status">
            <Badge value={data.status} />
          </dd>
        </div>
        <div className="fact">
          <dt>Consistency</dt>
          <dd data-testid="capture-consistency">
            <Badge value={consistency.label} tone={consistency.tone} />
            <br />
            <span className="help-text">{consistency.meaning}</span>
          </dd>
        </div>
        <div className="fact">
          <dt>Started</dt>
          <dd>{formatTimestamp(data.started_at)}</dd>
        </div>
        <div className="fact">
          <dt>Finished</dt>
          <dd>{formatTimestamp(data.finished_at)}</dd>
        </div>
        <div className="fact">
          <dt>Capture</dt>
          <dd>
            <code>{data.id}</code> from plan{" "}
            <Link to={`/preserve/builds/${b}/plans/${data.plan_id}`}>
              <code>{data.plan_id}</code>
            </Link>
          </dd>
        </div>
      </dl>
      <div className="row">
        {completed && canWrite ? (
          <>
            <Link to={`${base}/verify`} className="button">
              Verify this capture
            </Link>
            <Link to={`${base}/export`} className="button">
              Export this capture
            </Link>
          </>
        ) : (
          <p className="muted">
            Verifying and exporting become available when the capture job has
            succeeded{canWrite ? "" : " and need the member role"}.
          </p>
        )}
      </div>

      <section aria-labelledby="components-heading">
        <h2 id="components-heading">Component statuses</h2>
        {statuses.length === 0 ? (
          <p className="muted">No component status has been recorded yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table" data-testid="component-statuses">
              <thead>
                <tr>
                  <th scope="col">Component</th>
                  <th scope="col">Status</th>
                  <th scope="col">Meaning</th>
                </tr>
              </thead>
              <tbody>
                {statuses.map(([id, status]) => {
                  const wording = componentStatusWording(status);
                  return (
                    <tr key={id}>
                      <th scope="row">{id}</th>
                      <td>
                        <Badge value={status} tone={wording.tone} />
                      </td>
                      <td>{wording.meaning}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <JobPanel
        projectId={project.id}
        jobId={data.job_id}
        title="Capture job"
      />

      {data.manifest_object_key !== null && (
        <>
          <section aria-labelledby="manifest-heading">
            <h2 id="manifest-heading">Manifest</h2>
            <ErrorNotice error={manifest.error} />
            {manifest.isPending && <p role="status">Loading manifest…</p>}
            {manifest.data?.ok === false && (
              <div className="notice notice-error" role="alert">
                <p>
                  <strong>
                    The stored manifest does not match the recovery format.
                  </strong>{" "}
                  Nothing below is shown from it.
                </p>
                <ul>
                  {manifest.data.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}
            {manifest.data?.ok === true && (
              <ManifestView
                manifest={manifest.data.manifest}
                manifestSha256={data.manifest_sha256}
              />
            )}
          </section>
          <Coverage projectId={project.id} b={b} c={c} />
          {manifest.data?.ok === true && (
            <FileList manifest={manifest.data.manifest} />
          )}
        </>
      )}

      <h2>Verifications and exports</h2>
      <ErrorNotice error={verifications.error ?? exports_.error} />
      <div className="grid-2">
        <JobLinks
          title="Verifications"
          jobs={verifications.jobs}
          href={href("verifications", "verification_id", base)}
          empty="This capture has not been verified."
        />
        <JobLinks
          title="Exports"
          jobs={exports_.jobs}
          href={href("exports", "export_id", `/preserve/builds/${b}`)}
          empty="This capture has not been exported."
        />
      </div>
    </>
  );
}
