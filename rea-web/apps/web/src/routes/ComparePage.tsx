import { SelectField } from "../components/SelectField";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { comparisonRequestSchema, type Job } from "@rea-web/contracts/browser";
import {
  flatten,
  useCreateComparison,
  useEvidence,
  useInvestigations,
  useJobsOfKind,
  useProjectTools,
  useRunners,
  useToolCalls,
} from "../api/hooks";
import { useProject } from "../api/project";
import { Badge } from "../components/Badge";
import { ErrorNotice } from "../components/ErrorNotice";
import { JobPanel } from "../components/JobPanel";
import { ToolAvailability } from "../components/ToolAvailability";
import { formatTimestamp, shortId } from "../lib/format";
import { isUuid } from "../lib/json";
import { OperationList } from "./investigation/OperationList";
import { str, strings } from "./investigation/shared";

const TOOLS = comparisonRequestSchema.shape.tool.options;
type ToolName = (typeof TOOLS)[number];

type Side =
  | { kind: "retained"; investigationId: string; evidenceId: string }
  | { kind: "artifact"; investigationId: string; artifactId: string };

const emptySide = (): Side => ({
  kind: "retained",
  investigationId: "",
  evidenceId: "",
});

const sideRef = (side: Side) =>
  side.kind === "retained"
    ? {
        kind: "retained-evidence" as const,
        evidence_id: side.evidenceId,
        investigation_id: side.investigationId,
      }
    : { kind: "artifact" as const, artifact_id: side.artifactId };

const sideComplete = (side: Side): boolean =>
  side.investigationId !== "" &&
  (side.kind === "retained" ? side.evidenceId !== "" : side.artifactId !== "");

function RetainedChoices({
  projectId,
  side,
  onChange,
}: {
  projectId: string;
  side: Extract<Side, { kind: "retained" }>;
  onChange: (next: Side) => void;
}) {
  const calls = useToolCalls(projectId, side.investigationId, false);
  const options = flatten(calls.data).filter(
    (call) => call.evidence_id !== null,
  );
  return (
    <SelectField
      label="Evidence id"
      value={side.evidenceId}
      onChange={(event) =>
        onChange({ ...side, evidenceId: event.target.value })
      }
    >
      <option value="">Select evidence</option>
      {options.map((call) => (
        <option key={call.id} value={call.evidence_id ?? ""}>
          #{call.seq} {call.tool_name} · {(call.evidence_id ?? "").slice(0, 14)}
          …
        </option>
      ))}
    </SelectField>
  );
}

function ArtifactChoices({
  projectId,
  side,
  onChange,
}: {
  projectId: string;
  side: Extract<Side, { kind: "artifact" }>;
  onChange: (next: Side) => void;
}) {
  const artifacts = useEvidence(projectId, side.investigationId, false);
  const bundles = (artifacts.data?.items ?? []).filter(
    (item) => item.kind === "bundle",
  );
  return (
    <SelectField
      label="Evidence bundle"
      value={side.artifactId}
      onChange={(event) =>
        onChange({ ...side, artifactId: event.target.value })
      }
    >
      <option value="">Select a bundle</option>
      {bundles.map((bundle) => (
        <option key={bundle.id} value={bundle.id}>
          {bundle.name} ({shortId(bundle.sha256)}…)
        </option>
      ))}
    </SelectField>
  );
}

function SidePicker({
  label,
  projectId,
  side,
  onChange,
}: {
  label: string;
  projectId: string;
  side: Side;
  onChange: (next: Side) => void;
}) {
  const investigations = flatten(useInvestigations(projectId).data);
  return (
    <fieldset>
      <legend>{label}</legend>
      <div
        className="row"
        role="radiogroup"
        aria-label={`${label} reference kind`}
      >
        <label className="inline">
          <input
            type="radio"
            name={`${label}-kind`}
            checked={side.kind === "retained"}
            onChange={() =>
              onChange({
                kind: "retained",
                investigationId: side.investigationId,
                evidenceId: "",
              })
            }
          />{" "}
          Retained evidence
        </label>
        <label className="inline">
          <input
            type="radio"
            name={`${label}-kind`}
            checked={side.kind === "artifact"}
            onChange={() =>
              onChange({
                kind: "artifact",
                investigationId: side.investigationId,
                artifactId: "",
              })
            }
          />{" "}
          Evidence bundle artifact
        </label>
      </div>
      <SelectField
        label="Investigation"
        value={side.investigationId}
        onChange={(event) =>
          onChange(
            side.kind === "retained"
              ? {
                  kind: "retained",
                  investigationId: event.target.value,
                  evidenceId: "",
                }
              : {
                  kind: "artifact",
                  investigationId: event.target.value,
                  artifactId: "",
                },
          )
        }
      >
        <option value="">Select an investigation</option>
        {investigations.map((investigation) => (
          <option key={investigation.id} value={investigation.id}>
            {investigation.question.slice(0, 60)} ({shortId(investigation.id)})
          </option>
        ))}
      </SelectField>
      {side.investigationId !== "" &&
        (side.kind === "retained" ? (
          <RetainedChoices
            key={side.investigationId}
            projectId={projectId}
            side={side}
            onChange={onChange}
          />
        ) : (
          <ArtifactChoices
            key={side.investigationId}
            projectId={projectId}
            side={side}
            onChange={onChange}
          />
        ))}
    </fieldset>
  );
}

function Descriptor({ title, value }: { title: string; value: unknown }) {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  if (record === null) return null;
  const investigation = str(record["investigation_id"]);
  return (
    <div className="card">
      <h4>{title}</h4>
      <dl className="facts">
        <div className="fact">
          <dt>Investigation</dt>
          <dd>
            {investigation !== null && isUuid(investigation) ? (
              <Link to={`/investigations/${investigation}`}>
                <code>{investigation}</code>
              </Link>
            ) : (
              <code>{investigation ?? "not reported"}</code>
            )}
          </dd>
        </div>
        <div className="fact">
          <dt>Evidence id</dt>
          <dd>
            <code className="break">
              {str(record["evidence_id"]) ?? "none (bundle-level)"}
            </code>
          </dd>
        </div>
        <div className="fact">
          <dt>Bundle artifact</dt>
          <dd>
            <code>{str(record["artifact_id"]) ?? "not reported"}</code>
          </dd>
        </div>
        <div className="fact">
          <dt>Bundle SHA-256</dt>
          <dd>
            <code className="break">
              {str(record["bundle_sha256"]) ?? "not reported"}
            </code>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function CompareResult({ job }: { job: Job }) {
  const result = job.result ?? {};
  const outcome = str(result["outcome"]);
  const reasons = strings(result["reasons"]);
  const anchor = str(result["anchor_investigation_id"]);
  const seq = typeof result["seq"] === "number" ? result["seq"] : null;
  return (
    <section aria-label="Comparison result" data-testid="compare-result">
      <h3>Comparison result</h3>
      <dl className="facts">
        <div className="fact">
          <dt>Tool</dt>
          <dd>
            <code>{str(result["tool"]) ?? "not reported"}</code>
          </dd>
        </div>
        <div className="fact">
          <dt>Outcome</dt>
          <dd data-testid="compare-outcome">
            {outcome === null ? (
              "not reported"
            ) : (
              <Badge value={outcome} tone={outcome === "ran" ? "ok" : "warn"}>
                {outcome}
              </Badge>
            )}
          </dd>
        </div>
        {anchor !== null && isUuid(anchor) && (
          <div className="fact">
            <dt>Anchor investigation</dt>
            <dd>
              <Link
                to={
                  seq === null
                    ? `/investigations/${anchor}`
                    : `/investigations/${anchor}?tab=calls&call=${seq}`
                }
              >
                {seq === null
                  ? "Open the anchor investigation"
                  : `Tool call #${seq} on the anchor investigation`}
              </Link>
            </dd>
          </div>
        )}
        {typeof result["is_error"] === "boolean" && (
          <div className="fact">
            <dt>Error result</dt>
            <dd>{result["is_error"] ? "yes" : "no"}</dd>
          </div>
        )}
      </dl>
      {reasons.length > 0 && (
        <div className="notice notice-warn">
          <p className="label">Reasons</p>
          <ul>
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid-2">
        <Descriptor title="Left" value={result["left"]} />
        <Descriptor title="Right" value={result["right"]} />
      </div>
    </section>
  );
}

export function ComparePage() {
  const { project, canWrite } = useProject();
  const [search, setSearch] = useSearchParams();
  const create = useCreateComparison(project.id);
  const tools = useProjectTools(project.id);
  const runners = useRunners(project.id);
  const history = useJobsOfKind(project.id, "investigation.compare", false);
  const [left, setLeft] = useState<Side>(emptySide);
  const [right, setRight] = useState<Side>(emptySide);
  const [tool, setTool] = useState<ToolName>("compare_artifacts");
  const [runnerId, setRunnerId] = useState("");
  const jobId = search.get("job");
  const advertised =
    tools.data?.items.find((entry) => entry.name === tool) ?? null;
  const ready = sideComplete(left) && sideComplete(right);

  const submit = (): void =>
    create.mutate(
      {
        tool,
        left: sideRef(left),
        right: sideRef(right),
        ...(runnerId ? { runner_id: runnerId } : {}),
      },
      { onSuccess: (job) => setSearch({ job: job.id }) },
    );

  return (
    <>
      <h1>Compare evidence</h1>
      <p className="muted">
        A comparison runs an upstream <code>compare_*</code> tool over two
        stored references and records the result on the left side&apos;s
        investigation.
      </p>
      {canWrite ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="grid-2">
            <SidePicker
              label="Left"
              projectId={project.id}
              side={left}
              onChange={setLeft}
            />
            <SidePicker
              label="Right"
              projectId={project.id}
              side={right}
              onChange={setRight}
            />
          </div>
          <SelectField
            label="Comparison tool"
            value={tool}
            onChange={(event) => setTool(event.target.value as ToolName)}
          >
            {TOOLS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </SelectField>
          {advertised === null ? (
            <p className="notice notice-warn">
              No runner of this project advertises <code>{tool}</code>.
            </p>
          ) : (
            <ToolAvailability tool={advertised} />
          )}
          <SelectField
            label="Runner (optional)"
            value={runnerId}
            onChange={(event) => setRunnerId(event.target.value)}
          >
            <option value="">Any eligible runner</option>
            {runners.data?.items
              .filter((runner) => runner.status !== "revoked")
              .map((runner) => (
                <option key={runner.id} value={runner.id}>
                  {runner.name} ({runner.status})
                </option>
              ))}
          </SelectField>
          <button type="submit" disabled={!ready || create.isPending}>
            Run comparison
          </button>
          <ErrorNotice error={create.error} />
        </form>
      ) : (
        <p className="muted">Running comparisons needs the member role.</p>
      )}
      <OperationList
        title="Earlier comparisons"
        jobs={history.data?.items ?? []}
        selected={jobId}
        onSelect={(id) => setSearch({ job: id })}
        describe={(job) =>
          `${str(job.input["tool"]) ?? "comparison"} on ${formatTimestamp(job.created_at)}`
        }
      />
      {jobId !== null && (
        <JobPanel
          key={jobId}
          projectId={project.id}
          jobId={jobId}
          title="Comparison job"
          renderResult={(job) => <CompareResult job={job} />}
        />
      )}
    </>
  );
}
