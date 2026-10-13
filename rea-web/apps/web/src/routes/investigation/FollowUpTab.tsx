import { SelectField } from "../../components/SelectField";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Job } from "@rea-web/contracts/browser";
import { useFollowUp, useProjectTools } from "../../api/hooks";
import { useProject } from "../../api/project";
import { Badge } from "../../components/Badge";
import { ToolAvailability } from "../../components/ToolAvailability";
import { ErrorNotice } from "../../components/ErrorNotice";
import {
  EvidencePicker,
  retainedEvidenceJson,
  type EvidenceOption,
} from "../../components/EvidencePicker";
import { JobPanel } from "../../components/JobPanel";
import { SchemaForm } from "../../components/SchemaForm";
import {
  argumentsToDraft,
  buildFormModel,
  describeError,
  draftToArguments,
  initialDraft,
  type Draft,
  type FieldError,
} from "../../lib/schemaForm";
import type { ProjectTool } from "../../components/ToolAvailability";
import { OperationList } from "./OperationList";
import { str, strings, useInvestigationJobs } from "./shared";

type Mode = "form" | "raw";

interface ToolFormProps {
  readonly tool: ProjectTool;
  readonly evidence: readonly EvidenceOption[];
  readonly busy: boolean;
  readonly onSubmit: (args: Record<string, unknown>) => void;
}

/** Schema-generated form for one tool, with a raw JSON arguments mode. */
function ToolForm({ tool, evidence, busy, onSubmit }: ToolFormProps) {
  const model = useMemo(() => buildFormModel(tool.input_schema), [tool]);
  const [mode, setMode] = useState<Mode>("form");
  const [draft, setDraft] = useState<Draft>(() => initialDraft(model.root));
  const [rawText, setRawText] = useState("{}");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const toRaw = (): void => {
    const result = draftToArguments(model, draft);
    const invalid = result.errors.filter((entry) => entry.kind === "invalid");
    if (invalid.length > 0) {
      setErrors(invalid);
      setNotice(
        "Fix the invalid fields before switching; nothing is converted when it would drop input.",
      );
      return;
    }
    setRawText(JSON.stringify(result.value, null, 2));
    setErrors([]);
    setNotice(null);
    setMode("raw");
  };

  const toForm = (): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      setNotice(
        `The arguments are not valid JSON: ${error instanceof Error ? error.message : "parse error"}`,
      );
      return;
    }
    const loaded = argumentsToDraft(model, parsed);
    if (loaded.unrepresented.length > 0) {
      setNotice(
        `The form cannot hold: ${loaded.unrepresented.join(", ")}. Remove them or stay in raw JSON mode.`,
      );
      return;
    }
    setDraft(loaded.draft);
    setErrors([]);
    setNotice(null);
    setMode("form");
  };

  const submit = (): void => {
    if (mode === "form") {
      const result = draftToArguments(model, draft);
      setErrors([...result.errors]);
      setNotice(null);
      if (result.errors.length === 0) onSubmit(result.value);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        setNotice("Arguments must be a JSON object.");
        return;
      }
      setNotice(null);
      onSubmit(parsed as Record<string, unknown>);
    } catch (error) {
      setNotice(
        `The arguments are not valid JSON: ${error instanceof Error ? error.message : "parse error"}`,
      );
    }
  };

  const insertIntoRaw = (evidenceId: string): void => {
    const snippet = retainedEvidenceJson(evidenceId);
    setRawText((current) =>
      current.trim() === "" || current.trim() === "{}"
        ? snippet
        : `${current}\n${snippet}`,
    );
  };

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="row" role="group" aria-label="Argument entry mode">
        <button
          type="button"
          aria-pressed={mode === "form"}
          onClick={() => (mode === "form" ? undefined : toForm())}
        >
          Form
        </button>
        <button
          type="button"
          aria-pressed={mode === "raw"}
          onClick={() => (mode === "raw" ? undefined : toRaw())}
        >
          Raw JSON arguments
        </button>
      </div>
      {mode === "form" ? (
        <SchemaForm
          node={model.root}
          value={draft}
          errors={errors}
          evidence={evidence}
          onChange={setDraft}
        />
      ) : (
        <div className="field">
          <label htmlFor="raw-arguments">Arguments (JSON object)</label>
          <textarea
            id="raw-arguments"
            rows={10}
            className="mono"
            spellCheck={false}
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
          />
          {evidence.length > 0 && (
            <EvidencePicker
              options={evidence}
              buttonLabel="Append evidence reference"
              onPick={insertIntoRaw}
            />
          )}
          {model.examples.length > 0 && (
            <div className="row">
              {model.examples.map((example, index) => (
                <button
                  key={JSON.stringify(example)}
                  type="button"
                  onClick={() => setRawText(JSON.stringify(example, null, 2))}
                >
                  Load schema example {index + 1}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {notice !== null && (
        <p className="notice notice-warn" role="alert">
          {notice}
        </p>
      )}
      {errors.length > 0 && (
        <ul className="notice notice-error" role="alert">
          {errors.map((entry) => (
            <li key={`${entry.path}:${entry.message}`}>
              {describeError(entry)}
            </li>
          ))}
        </ul>
      )}
      <button type="submit" disabled={busy}>
        Run follow-up
      </button>
    </form>
  );
}

function FollowUpResult({
  job,
  investigationId,
}: {
  job: Job;
  investigationId: string;
}) {
  const result = job.result ?? {};
  const outcome = str(result["outcome"]);
  const reasons = strings(result["reasons"]);
  const seq = typeof result["seq"] === "number" ? result["seq"] : null;
  return (
    <section aria-label="Follow-up result" data-testid="follow-up-result">
      <h3>Result</h3>
      <dl className="facts">
        <div className="fact">
          <dt>Tool</dt>
          <dd>
            <code>{str(result["tool"]) ?? "not reported"}</code>
          </dd>
        </div>
        <div className="fact">
          <dt>Outcome</dt>
          <dd data-testid="follow-up-outcome">
            {outcome === null ? (
              "not reported"
            ) : (
              <Badge value={outcome} tone={outcome === "ran" ? "ok" : "warn"}>
                {outcome}
              </Badge>
            )}
          </dd>
        </div>
        {seq !== null && (
          <div className="fact">
            <dt>Recorded as</dt>
            <dd>
              <Link
                to={`/investigations/${investigationId}?tab=calls&call=${seq}`}
              >
                tool call #{seq}
              </Link>
            </dd>
          </div>
        )}
        {typeof result["evidence_id"] === "string" && (
          <div className="fact">
            <dt>Evidence id</dt>
            <dd>
              <code className="break">{result["evidence_id"]}</code>
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
        <ul className="notice notice-warn">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      {outcome !== null && outcome !== "ran" && reasons.length === 0 && (
        <p className="notice notice-warn">
          The tool did not run. The reason is recorded as a finding on this
          investigation.
        </p>
      )}
    </section>
  );
}

export function FollowUpTab({
  investigationId,
  evidence,
  live,
}: {
  investigationId: string;
  evidence: readonly EvidenceOption[];
  live: boolean;
}) {
  const { project, canWrite } = useProject();
  const tools = useProjectTools(project.id);
  const followUp = useFollowUp(project.id, investigationId);
  const history = useInvestigationJobs(
    project.id,
    investigationId,
    "investigation.follow_up",
    live,
  );
  const [filter, setFilter] = useState("");
  const [name, setName] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const items = tools.data?.items ?? [];
  const shown = items
    .filter((tool) =>
      tool.name.toLowerCase().includes(filter.trim().toLowerCase()),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const tool = items.find((entry) => entry.name === name) ?? null;

  if (tools.isPending) return <p role="status">Loading advertised tools…</p>;
  if (tools.isError) return <ErrorNotice error={tools.error} />;
  if (items.length === 0)
    return (
      <p className="notice">
        No runner of this project has advertised a tool yet; connect a runner
        first.
      </p>
    );
  return (
    <>
      <p className="muted">
        Every tool a runner of this project advertises, with its own input
        schema. A follow-up runs in this investigation&apos;s live REA session,
        so it is refused once that session has closed.
      </p>
      <div className="stack">
        <label>
          Filter tools
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <SelectField
          label="Tool"
          value={name}
          onChange={(event) => setName(event.target.value)}
        >
          <option value="">Select a tool ({shown.length})</option>
          {shown.map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.name}
            </option>
          ))}
        </SelectField>
      </div>
      {tool !== null && (
        <section aria-label={`Tool ${tool.name}`}>
          <h3>{tool.title ?? tool.name}</h3>
          {tool.description !== null && (
            <p className="prewrap">{tool.description}</p>
          )}
          <ToolAvailability tool={tool} />
          {canWrite ? (
            <ToolForm
              key={`${tool.name}:${tool.input_schema_sha256}`}
              tool={tool}
              evidence={evidence}
              busy={followUp.isPending}
              onSubmit={(args) =>
                followUp.mutate(
                  { tool: tool.name, arguments: args },
                  { onSuccess: (job) => setJobId(job.id) },
                )
              }
            />
          ) : (
            <p className="muted">Running follow-ups needs the member role.</p>
          )}
          <ErrorNotice error={followUp.error} />
        </section>
      )}
      <OperationList
        title="Earlier follow-ups"
        jobs={history.jobs}
        selected={jobId}
        onSelect={setJobId}
        describe={(job) => str(job.input["tool"]) ?? "follow-up"}
      />
      {jobId !== null && (
        <JobPanel
          key={jobId}
          projectId={project.id}
          jobId={jobId}
          title="Follow-up job"
          renderResult={(job) => (
            <FollowUpResult job={job} investigationId={investigationId} />
          )}
        />
      )}
    </>
  );
}
