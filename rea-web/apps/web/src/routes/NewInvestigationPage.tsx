import { SelectField } from "../components/SelectField";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  flatten,
  useCreateInvestigation,
  useRunners,
  useTargets,
} from "../api/hooks";
import { useProject } from "../api/project";
import { ErrorNotice } from "../components/ErrorNotice";
import { PolicyFields } from "../components/PolicyFields";
import { RoutingView } from "../components/RoutingView";
import {
  defaultPolicyDraft,
  policyFromDraft,
  type PolicyDraft,
} from "../lib/policy";

export function NewInvestigationPage() {
  const { project, canWrite } = useProject();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const targets = useTargets(project.id);
  const runners = useRunners(project.id);
  const create = useCreateInvestigation(project.id);
  const [targetId, setTargetId] = useState(search.get("target") ?? "");
  const [question, setQuestion] = useState("");
  const [runnerId, setRunnerId] = useState("");
  const [policy, setPolicy] = useState<PolicyDraft>(defaultPolicyDraft);
  const [policyErrors, setPolicyErrors] = useState<Record<string, string>>({});
  const items = flatten(targets.data);
  const selected = targetId || items[0]?.id || "";

  const submit = (): void => {
    const result = policyFromDraft(policy);
    if (!result.ok) {
      setPolicyErrors(result.errors);
      return;
    }
    setPolicyErrors({});
    create.mutate(
      {
        target_id: selected,
        question,
        policy: result.policy as never,
        ...(runnerId ? { runner_id: runnerId } : {}),
      },
      {
        onSuccess: (investigation) =>
          navigate(`/investigations/${investigation.id}`),
      },
    );
  };

  if (!canWrite) return <p>Creating investigations needs the member role.</p>;
  return (
    <>
      <p>
        <Link to="/investigations">Investigations</Link> / New
      </p>
      <h1>New investigation</h1>
      {targets.isSuccess && items.length === 0 ? (
        <p>
          There is no target yet. <Link to="/targets">Add a target</Link> first.
        </p>
      ) : (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <SelectField
            label="Target"
            value={selected}
            onChange={(event) => setTargetId(event.target.value)}
          >
            {items.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name} ({target.class})
              </option>
            ))}
          </SelectField>
          {selected !== "" && (
            <details open>
              <summary>Routing for the selected target</summary>
              <RoutingView projectId={project.id} targetId={selected} />
            </details>
          )}
          <label>
            Question
            <textarea
              rows={4}
              maxLength={4000}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              required
            />
          </label>
          <SelectField
            label="Runner (optional)"
            value={runnerId}
            onChange={(event) => setRunnerId(event.target.value)}
          >
            <option value="">Any runner that satisfies the routing</option>
            {runners.data?.items
              .filter((runner) => runner.status !== "revoked")
              .map((runner) => (
                <option key={runner.id} value={runner.id}>
                  {runner.name} ({runner.status})
                </option>
              ))}
          </SelectField>
          <PolicyFields
            draft={policy}
            onChange={setPolicy}
            errors={policyErrors}
          />
          <button type="submit" disabled={create.isPending || selected === ""}>
            Create investigation
          </button>
          <ErrorNotice error={create.error} />
        </form>
      )}
    </>
  );
}
