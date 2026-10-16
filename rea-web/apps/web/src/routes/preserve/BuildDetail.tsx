import { Link, useNavigate, useParams } from "react-router-dom";
import { useBuild, useBuildJobs, useCreatePlan } from "../../api/preserveHooks";
import { useProject } from "../../api/project";
import { ErrorNotice } from "../../components/ErrorNotice";
import { describeComponent, describeSource } from "../../lib/buildView";
import { producedId } from "../../lib/buildJobs";
import { formatTimestamp } from "../../lib/format";
import { Crumbs, Facts, JobLinks } from "./shared";

export function BuildDetail() {
  const { b = "" } = useParams();
  const { project, canWrite } = useProject();
  const navigate = useNavigate();
  const build = useBuild(project.id, b);
  const createPlan = useCreatePlan(project.id, b);
  const plans = useBuildJobs(
    project.id,
    "preservation.plan",
    "build_id",
    b,
    true,
  );
  const captures = useBuildJobs(
    project.id,
    "preservation.capture",
    "build_id",
    b,
    true,
  );
  const exports_ = useBuildJobs(
    project.id,
    "recovery.export",
    "build_id",
    b,
    true,
  );
  if (build.isPending) return <p role="status">Loading build…</p>;
  if (build.isError) return <ErrorNotice error={build.error} />;
  const data = build.data;
  const link =
    (kind: string, field: string) =>
    (job: Parameters<typeof producedId>[0]) => {
      const id = producedId(job, field);
      return id === null ? null : `/preserve/builds/${b}/${kind}/${id}`;
    };
  return (
    <>
      <Crumbs
        items={[{ to: "/preserve", label: "Preserve" }, { label: data.name }]}
      />
      <h1 data-testid="build-name">{data.name}</h1>
      {data.description !== "" && <p className="prewrap">{data.description}</p>}
      <p className="muted">
        Created {formatTimestamp(data.created_at)} · build{" "}
        <code>{data.id}</code>
        {data.runner_id !== undefined && (
          <>
            {" "}
            · preferred runner <code>{data.runner_id}</code>
          </>
        )}
      </p>
      <div className="row">
        <button
          type="button"
          disabled={!canWrite || createPlan.isPending}
          onClick={() =>
            createPlan.mutate(undefined, {
              onSuccess: (job) =>
                navigate(`/preserve/builds/${b}/plans/${job.id}`),
            })
          }
        >
          Create plan
        </button>
        {canWrite && (
          <Link
            to={`/preserve/new?from=${encodeURIComponent(b)}`}
            className="button"
          >
            Copy as new build
          </Link>
        )}
      </div>
      {!canWrite && <p className="muted">Planning needs the member role.</p>}
      <ErrorNotice error={createPlan.error} />
      <p className="help-text">
        A plan only looks: it checks permissions and estimates sizes on the
        runner. Nothing is captured until you capture from a plan.
      </p>

      <section aria-labelledby="definition-heading">
        <h2 id="definition-heading">Definition</h2>
        <div className="card">
          <h3>Source</h3>
          <Facts rows={describeSource(data.source)} />
        </div>
        {data.components.map((component) => (
          <article
            key={`${component.kind}:${component.id}`}
            className="card"
            data-testid="definition-component"
          >
            <h3>
              {component.kind}:{component.id}
            </h3>
            <Facts rows={describeComponent(component)} />
          </article>
        ))}
      </section>

      <h2>Work on this build</h2>
      <ErrorNotice error={plans.error ?? captures.error ?? exports_.error} />
      <div className="grid-2">
        <JobLinks
          title="Plans"
          jobs={plans.jobs}
          href={link("plans", "plan_id")}
          empty="No plan has been created."
        />
        <JobLinks
          title="Captures"
          jobs={captures.jobs}
          href={link("captures", "capture_id")}
          empty="No capture has been started. Capture from a produced plan."
        />
        <JobLinks
          title="Exports"
          jobs={exports_.jobs}
          href={link("exports", "export_id")}
          empty="No export has been made. Export from a completed capture."
        />
      </div>
      <p className="help-text">
        These lists are the jobs of this build; the API has no list routes for
        plans, captures or exports, so only up to 200 jobs of each kind in the
        project are searched.
      </p>
    </>
  );
}
