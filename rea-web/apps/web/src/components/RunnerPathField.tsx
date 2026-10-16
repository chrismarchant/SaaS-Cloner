import { useEffect, useState } from "react";
import { flatten, useRunners, useTargets } from "../api/hooks";
import { useProject } from "../api/project";
import { ErrorNotice } from "./ErrorNotice";
import { TextField } from "./Fields";
import { SelectField } from "./SelectField";

const MANUAL = "__manual";

/**
 * Names a path on a runner without ever naming the path: pick one of the
 * runner's allowlisted paths (registered as runner_local targets), or enter a
 * runner and a path hash by hand when the path is not listed.
 */
export function RunnerPathField({
  label,
  runnerId,
  pathHash,
  onChange,
}: {
  label: string;
  runnerId: string;
  pathHash: string;
  onChange: (runnerId: string, pathHash: string) => void;
}) {
  const { project } = useProject();
  const targets = useTargets(project.id);
  const runners = useRunners(project.id);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = targets;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const local = flatten(targets.data).filter(
    (target) =>
      target.kind === "runner_local" &&
      target.runner_id !== null &&
      target.path_hash !== null,
  );
  const runnerName = (id: string | null): string =>
    runners.data?.items.find((runner) => runner.id === id)?.name ?? "a runner";
  const chosen = local.find(
    (target) => target.runner_id === runnerId && target.path_hash === pathHash,
  );
  // Until the user chooses, a value that matches no listed path is manual.
  const [override, setManual] = useState<boolean | null>(null);
  const manual =
    override ??
    (targets.isSuccess &&
      (runnerId !== "" || pathHash !== "") &&
      chosen === undefined);
  const selected = manual ? MANUAL : (chosen?.id ?? "");
  return (
    <fieldset className="nested">
      <legend>{label}</legend>
      <ErrorNotice error={targets.error} />
      <SelectField
        label={`${label}: allowlisted path`}
        value={selected}
        onChange={(event) => {
          const value = event.target.value;
          if (value === MANUAL) {
            setManual(true);
            return;
          }
          setManual(false);
          const target = local.find((entry) => entry.id === value);
          onChange(target?.runner_id ?? "", target?.path_hash ?? "");
        }}
      >
        <option value="">Choose an allowlisted path</option>
        {local.map((target) => (
          <option key={target.id} value={target.id}>
            {target.name} on {runnerName(target.runner_id)} (
            {(target.path_hash ?? "").slice(0, 12)})
          </option>
        ))}
        <option value={MANUAL}>Enter a runner and path hash by hand</option>
      </SelectField>
      {targets.isSuccess && local.length === 0 && (
        <p className="help-text">
          No runner has registered an allowlisted path. Start a runner with
          REA_WEB_RUNNER_LOCAL_TARGET_ALLOWLIST, or enter a path hash by hand.
        </p>
      )}
      {manual && (
        <>
          <SelectField
            label={`${label}: runner`}
            value={runnerId}
            onChange={(event) => onChange(event.target.value, pathHash)}
          >
            <option value="">Choose a runner</option>
            {runners.data?.items
              .filter((runner) => runner.status !== "revoked")
              .map((runner) => (
                <option key={runner.id} value={runner.id}>
                  {runner.name} ({runner.status})
                </option>
              ))}
          </SelectField>
          <TextField
            label={`${label}: path hash`}
            mono
            value={pathHash}
            maxLength={64}
            spellCheck={false}
            autoComplete="off"
            onValue={(value) => onChange(runnerId, value)}
            help="The 64-character hash of an allowlisted path. It is shown by the runner operator; the path itself is never sent to this page or to the control plane."
          />
        </>
      )}
      {!manual && chosen !== undefined && (
        <p className="help-text">
          Path hash <code className="break">{chosen.path_hash}</code>
        </p>
      )}
    </fieldset>
  );
}
