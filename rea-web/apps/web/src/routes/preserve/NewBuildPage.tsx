import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useRunners } from "../../api/hooks";
import { useBuild, useCreateBuild } from "../../api/preserveHooks";
import { useProject } from "../../api/project";
import { ComponentsEditor } from "../../components/ComponentsEditor";
import { ErrorNotice } from "../../components/ErrorNotice";
import { CheckField, TextAreaField, TextField } from "../../components/Fields";
import { RunnerPathField } from "../../components/RunnerPathField";
import { SelectField } from "../../components/SelectField";
import {
  bodyFromDraft,
  draftFromDefinition,
  emptyBuildDraft,
  emptySource,
  gitUrlConcern,
  type BuildDraft,
  type DraftProblem,
  type SourceDraft,
} from "../../lib/buildDraft";

function SourceFields({
  source,
  onChange,
}: {
  source: SourceDraft;
  onChange: (next: SourceDraft) => void;
}) {
  const concern = source.kind === "git" ? gitUrlConcern(source.url) : null;
  return (
    <fieldset>
      <legend>Source</legend>
      <SelectField
        label="Source kind"
        value={source.kind}
        onChange={(event) =>
          onChange(
            event.target.value === "git"
              ? { ...emptySource() }
              : {
                  kind: "runner_local",
                  runnerId: "",
                  pathHash: "",
                  includeWorkingTree: true,
                  includeLfs: source.includeLfs,
                  includeSubmodules: source.includeSubmodules,
                },
          )
        }
      >
        <option value="git">Git repository (remote URL)</option>
        <option value="runner_local">Directory on a runner</option>
      </SelectField>
      {source.kind === "git" ? (
        <>
          <TextField
            label="Repository URL"
            type="text"
            value={source.url}
            spellCheck={false}
            autoComplete="off"
            onValue={(url) => onChange({ ...source, url })}
            help="An https or ssh URL. The runner refuses paths on its own host and URLs that carry credentials; use a directory on a runner for local work."
          />
          {concern !== null && (
            <p className="notice notice-warn" role="status">
              {concern}
            </p>
          )}
          <TextField
            label="Ref (optional)"
            value={source.ref}
            onValue={(ref) => onChange({ ...source, ref })}
            help="A branch, tag or commit. Empty means HEAD."
          />
        </>
      ) : (
        <>
          <RunnerPathField
            label="Source path"
            runnerId={source.runnerId}
            pathHash={source.pathHash}
            onChange={(runnerId, pathHash) =>
              onChange({ ...source, runnerId, pathHash })
            }
          />
          <CheckField
            label="Include uncommitted work (working tree)"
            checked={source.includeWorkingTree}
            onValue={(includeWorkingTree) =>
              onChange({ ...source, includeWorkingTree })
            }
            help="Modified and untracked files are captured as a delta. Ignored files such as .env are not."
          />
        </>
      )}
      <CheckField
        label="Include Git LFS objects"
        checked={source.includeLfs}
        onValue={(includeLfs) => onChange({ ...source, includeLfs })}
      />
      <CheckField
        label="Include submodules"
        checked={source.includeSubmodules}
        onValue={(includeSubmodules) =>
          onChange({ ...source, includeSubmodules })
        }
      />
    </fieldset>
  );
}

function BuildForm({ initial }: { initial: BuildDraft }) {
  const { project } = useProject();
  const navigate = useNavigate();
  const runners = useRunners(project.id);
  const create = useCreateBuild(project.id);
  const [draft, setDraft] = useState<BuildDraft>(initial);
  const [problems, setProblems] = useState<readonly DraftProblem[]>([]);

  const submit = (): void => {
    const result = bodyFromDraft(draft);
    if (!result.ok) {
      setProblems(result.problems);
      return;
    }
    setProblems([]);
    create.mutate(result.body, {
      onSuccess: (build) => navigate(`/preserve/builds/${build.id}`),
    });
  };

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextField
        label="Name"
        value={draft.name}
        maxLength={120}
        onValue={(name) => setDraft({ ...draft, name })}
      />
      <TextAreaField
        label="Description"
        rows={2}
        maxLength={4000}
        value={draft.description}
        onValue={(description) => setDraft({ ...draft, description })}
      />
      <SourceFields
        source={draft.source}
        onChange={(source) => setDraft({ ...draft, source })}
      />
      <SelectField
        label="Preferred runner (optional)"
        value={draft.runnerId}
        onChange={(event) =>
          setDraft({ ...draft, runnerId: event.target.value })
        }
      >
        <option value="">Any runner that can do the job</option>
        {runners.data?.items
          .filter((runner) => runner.status !== "revoked")
          .map((runner) => (
            <option key={runner.id} value={runner.id}>
              {runner.name} ({runner.status})
            </option>
          ))}
      </SelectField>
      <ComponentsEditor
        components={draft.components}
        problems={problems}
        onChange={(components) => setDraft({ ...draft, components })}
      />
      {problems.length > 0 && (
        <div className="notice notice-error" role="alert">
          <p>
            <strong>
              The build was not sent: {problems.length}{" "}
              {problems.length === 1 ? "problem" : "problems"} to fix.
            </strong>
          </p>
          <ul>
            {problems.map((problem) => (
              <li key={`${problem.path}:${problem.message}`}>
                <code>{problem.path}</code>: {problem.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <button type="submit" disabled={create.isPending}>
        Create build
      </button>
      <ErrorNotice error={create.error} />
    </form>
  );
}

export function NewBuildPage() {
  const { project, canWrite } = useProject();
  const [search] = useSearchParams();
  const from = search.get("from");
  const source = useBuild(project.id, from);
  if (!canWrite) return <p>Declaring builds needs the member role.</p>;
  return (
    <>
      <p>
        <Link to="/preserve">Preserve</Link> / New build
      </p>
      <h1>New build</h1>
      <ErrorNotice error={source.error} />
      {from !== null && source.isPending ? (
        <p role="status">Loading the build to copy…</p>
      ) : (
        <>
          {from !== null && source.data !== undefined && (
            <p className="muted">
              Started from a copy of <strong>{source.data.name}</strong>. The
              original is not changed.
            </p>
          )}
          <BuildForm
            key={source.data?.id ?? "blank"}
            initial={
              source.data === undefined
                ? emptyBuildDraft()
                : draftFromDefinition({
                    ...source.data,
                    name: `${source.data.name} (copy)`,
                  })
            }
          />
        </>
      )}
    </>
  );
}
