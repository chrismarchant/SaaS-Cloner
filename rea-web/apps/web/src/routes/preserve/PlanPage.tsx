import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { preservationPlanSchema } from "@rea-web/contracts/browser";
import type { z } from "zod";
import {
  planNotReady,
  useCreateCapture,
  usePlan,
} from "../../api/preserveHooks";
import { useProject } from "../../api/project";
import { Badge, YesNo } from "../../components/Badge";
import { ErrorNotice } from "../../components/ErrorNotice";
import { JobPanel } from "../../components/JobPanel";
import { formatBytes } from "../../lib/format";
import { Crumbs } from "./shared";

type Plan = z.output<typeof preservationPlanSchema>;
type PlanComponent = Plan["components"][number];

function Omissions({
  items,
}: {
  items: readonly { what: string; reason: string; remediation: string }[];
}) {
  if (items.length === 0) return <span className="muted">none recorded</span>;
  return (
    <ul className="plain">
      {items.map((omission, index) => (
        <li key={`${index}:${omission.what}`}>
          <strong>{omission.what}</strong>
          <br />
          <span className="label">reason</span> {omission.reason}
          <br />
          <span className="label">remediation</span> {omission.remediation}
        </li>
      ))}
    </ul>
  );
}

function PlanComponentCard({ component }: { component: PlanComponent }) {
  return (
    <article className="card" data-testid="plan-component">
      <header className="row between">
        <h3>
          <code>{component.id}</code>{" "}
          <span className="muted">{component.kind}</span>
        </h3>
        <span data-testid="plan-feasible">
          Feasible: <YesNo value={component.feasible} />
        </span>
      </header>
      <dl className="facts">
        <div className="fact">
          <dt>Method</dt>
          <dd>{component.method}</dd>
        </div>
        <div className="fact">
          <dt>Collector</dt>
          <dd>{component.collector}</dd>
        </div>
        <div className="fact">
          <dt>Estimated size</dt>
          <dd>
            {component.estimated_bytes === null
              ? "unknown"
              : `${formatBytes(component.estimated_bytes)} (${component.estimated_bytes} bytes)`}
          </dd>
        </div>
        <div className="fact">
          <dt>Depends on</dt>
          <dd>
            {component.dependencies.length === 0
              ? "nothing"
              : component.dependencies.join(", ")}
          </dd>
        </div>
      </dl>
      <h4>Permission checks</h4>
      {component.permissions.length === 0 ? (
        <p className="muted">No permission check was recorded.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Check</th>
                <th scope="col">Result</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {component.permissions.map((check, index) => (
                <tr key={`${index}:${check.check}`}>
                  <th scope="row">{check.check}</th>
                  <td>
                    <Badge
                      value={check.ok ? "ok" : "not ok"}
                      tone={check.ok ? "ok" : "bad"}
                    />
                  </td>
                  <td>{check.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h4>Omissions</h4>
      <Omissions items={component.omissions} />
    </article>
  );
}

function PlanView({ plan, projectId }: { plan: Plan; projectId: string }) {
  const { canWrite } = useProject();
  const navigate = useNavigate();
  const capture = useCreateCapture(projectId, plan.build_id);
  const feasible = plan.components.filter((component) => component.feasible);
  return (
    <>
      <h2>Plan</h2>
      <p className="muted">
        Plan <code>{plan.id}</code>
      </p>
      {plan.components.map((component) => (
        <PlanComponentCard key={component.id} component={component} />
      ))}
      <section aria-labelledby="strategy-heading" className="card">
        <h3 id="strategy-heading">Consistency strategy</h3>
        <p className="prewrap" data-testid="plan-strategy">
          {plan.consistency_strategy === ""
            ? "The plan states no consistency strategy."
            : plan.consistency_strategy}
        </p>
      </section>
      <section aria-labelledby="known-heading" className="card">
        <h3 id="known-heading">Known omissions</h3>
        <Omissions items={plan.known_omissions} />
      </section>
      <div className="row">
        <button
          type="button"
          disabled={!canWrite || capture.isPending}
          onClick={() =>
            capture.mutate(plan.id, {
              onSuccess: (created) =>
                navigate(
                  `/preserve/builds/${plan.build_id}/captures/${created.id}`,
                ),
            })
          }
        >
          Capture from this plan
        </button>
      </div>
      {feasible.length === 0 && (
        <p className="notice notice-warn">
          No component in this plan is feasible, so a capture would preserve
          nothing. Read the permission checks and omissions above first.
        </p>
      )}
      {feasible.length > 0 && feasible.length < plan.components.length && (
        <p className="notice notice-warn">
          Components that are not feasible are not captured; they will appear as
          blocked or missing in the capture.
        </p>
      )}
      {!canWrite && <p className="muted">Capturing needs the member role.</p>}
      <ErrorNotice error={capture.error} />
    </>
  );
}

export function PlanPage() {
  const { b = "", pl = "" } = useParams();
  const { project } = useProject();
  const plan = usePlan(project.id, b, pl);
  const waiting = planNotReady(plan.error);
  // The job id createPlan answered with, until the plan itself names it.
  const created: unknown = useLocation().state;
  const createdJobId =
    typeof created === "object" &&
    created !== null &&
    "jobId" in created &&
    typeof created.jobId === "string"
      ? created.jobId
      : null;
  const jobId = plan.data?.job_id ?? waiting?.jobId ?? createdJobId;
  return (
    <>
      <Crumbs
        items={[
          { to: "/preserve", label: "Preserve" },
          { to: `/preserve/builds/${b}`, label: "Build" },
          { label: "Plan" },
        ]}
      />
      <h1>Preservation plan</h1>
      {plan.isPending && <p role="status">Loading plan…</p>}
      {plan.isError && waiting === null && <ErrorNotice error={plan.error} />}
      {waiting !== null && (
        <p role="status" data-testid="plan-waiting">
          The plan has not been produced yet
          {waiting.jobState === null ? "" : ` (job ${waiting.jobState})`}. This
          page refreshes while the job runs.
          {(waiting.jobState === "failed" ||
            waiting.jobState === "cancelled") &&
            " The job ended without producing a plan; see its failure below."}
        </p>
      )}
      {plan.data !== undefined && (
        <PlanView plan={plan.data} projectId={project.id} />
      )}
      {jobId !== null && (
        <JobPanel projectId={project.id} jobId={jobId} title="Plan job" />
      )}
    </>
  );
}
