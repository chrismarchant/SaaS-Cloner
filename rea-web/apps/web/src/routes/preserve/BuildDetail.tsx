import { Link, useNavigate, useParams } from "react-router-dom";
import {
  useBuild,
  useCaptures,
  useCreatePlan,
  usePlans,
  useRecoveryExports,
} from "../../api/preserveHooks";
import { useProject } from "../../api/project";
import { ErrorNotice } from "../../components/ErrorNotice";
import { describeComponent, describeSource } from "../../lib/buildView";
import { formatTimestamp } from "../../lib/format";
import { Crumbs, Facts, RunList, runLabel } from "./shared";

export function BuildDetail() {
  const { b = "" } = useParams();
  const { project, canWrite } = useProject();
  const navigate = useNavigate();
  const build = useBuild(project.id, b);
  const createPlan = useCreatePlan(project.id, b);
  const plans = usePlans(project.id, b);
  const captures = useCaptures(project.id, b);
  const exports_ = useRecoveryExports(project.id, b, null);
  if (build.isPending) return <p role="status">Loading build…</p>;
  if (build.isError) return <ErrorNotice error={build.error} />;
  const data = build.data;
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
              onSuccess: (created) =>
                navigate(`/preserve/builds/${b}/plans/${created.plan_id}`, {
                  state: { jobId: created.job_id },
                }),
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
      <div className="grid-2">
        <RunList
          title="Plans"
          query={plans}
          row={(plan) => ({
            id: plan.id,
            to: `/preserve/builds/${b}/plans/${plan.id}`,
            label: runLabel(plan.created_at, plan.id),
            status: plan.status,
          })}
          empty="No plan has been created."
        />
        <RunList
          title="Captures"
          query={captures}
          row={(capture) => ({
            id: capture.id,
            to: `/preserve/builds/${b}/captures/${capture.id}`,
            label: runLabel(capture.started_at, capture.id),
            status: capture.status,
          })}
          empty="No capture has been started. Capture from a produced plan."
        />
        <RunList
          title="Exports"
          query={exports_}
          row={(record) => ({
            id: record.id,
            to: `/preserve/builds/${b}/exports/${record.id}`,
            label: runLabel(record.created_at, record.id),
            status: record.status,
          })}
          empty="No export has been made. Export from a completed capture."
        />
      </div>
    </>
  );
}
