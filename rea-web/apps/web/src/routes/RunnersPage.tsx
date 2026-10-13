import { useState } from "react";
import { Link } from "react-router-dom";
import { useCreateRunner, useRevokeRunner, useRunners } from "../api/hooks";
import { useProject } from "../api/project";
import { Badge } from "../components/Badge";
import { CopyButton } from "../components/CopyButton";
import { ErrorNotice } from "../components/ErrorNotice";
import { formatTimestamp } from "../lib/format";

interface CreatedRunner {
  readonly id: string;
  readonly name: string;
  readonly token: string;
}

/** The only place a secret is shown: once, right after creation. */
function TokenReveal({
  runner,
  onDismiss,
}: {
  runner: CreatedRunner;
  onDismiss: () => void;
}) {
  return (
    <section className="card notice-warn" aria-labelledby="token-heading">
      <h2 id="token-heading">Runner token for {runner.name}</h2>
      <p role="alert">
        <strong>This token is shown only once.</strong> It cannot be retrieved
        later. Copy it now and store it where the runner reads its environment.
      </p>
      <label>
        Runner token
        <input
          readOnly
          className="mono"
          data-testid="runner-token"
          value={runner.token}
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
      <div className="row">
        <CopyButton value={runner.token} label="Copy token" />
      </div>
      <p>Start the runner with these environment variables:</p>
      <ul>
        <li>
          <code>REA_WEB_API_URL</code>: the address of this API as the runner
          reaches it (this page is served from{" "}
          <code>{window.location.origin}</code>)
        </li>
        <li>
          <code>REA_WEB_RUNNER_TOKEN</code>: the token above
        </li>
      </ul>
      <button type="button" onClick={onDismiss}>
        I have stored the token
      </button>
    </section>
  );
}

function CreateRunner({ projectId }: { projectId: string }) {
  const create = useCreateRunner(projectId);
  const [name, setName] = useState("");
  const [labels, setLabels] = useState("");
  const [created, setCreated] = useState<CreatedRunner | null>(null);
  return (
    <section aria-labelledby="create-runner">
      <h2 id="create-runner">Create a runner</h2>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            {
              name,
              labels: labels
                .split(",")
                .map((label) => label.trim())
                .filter((label) => label !== ""),
            },
            {
              onSuccess: (runner) => {
                setCreated({
                  id: runner.id,
                  name: runner.name,
                  token: runner.token,
                });
                setName("");
                setLabels("");
                create.reset();
              },
            },
          );
        }}
      >
        <label>
          Runner name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={120}
          />
        </label>
        <label>
          Labels (comma separated, optional)
          <input
            value={labels}
            onChange={(event) => setLabels(event.target.value)}
          />
        </label>
        <button type="submit" disabled={create.isPending}>
          Create runner
        </button>
        <ErrorNotice error={create.error} />
      </form>
      {created !== null && (
        <TokenReveal runner={created} onDismiss={() => setCreated(null)} />
      )}
    </section>
  );
}

export function RunnersPage() {
  const { project, canAdmin } = useProject();
  const runners = useRunners(project.id);
  const revoke = useRevokeRunner(project.id);
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <>
      <h1>Runners</h1>
      {canAdmin ? (
        <CreateRunner projectId={project.id} />
      ) : (
        <p className="muted">
          Creating or revoking runners needs the admin role.
        </p>
      )}
      <section aria-labelledby="runner-list">
        <h2 id="runner-list">Runners in {project.name}</h2>
        <ErrorNotice error={runners.error} />
        <ErrorNotice error={revoke.error} />
        {runners.isPending && <p role="status">Loading runners…</p>}
        {runners.data?.items.length === 0 && (
          <p>No runner has been created for this project.</p>
        )}
        {runners.data !== undefined && runners.data.items.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last heartbeat</th>
                  <th scope="col">Labels</th>
                  <th scope="col">
                    Tools available / need target / unavailable
                  </th>
                  <th scope="col">Providers available</th>
                  <th scope="col">Active leases</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {runners.data.items.map((runner) => (
                  <tr key={runner.id} data-testid="runner-row">
                    <th scope="row">{runner.name}</th>
                    <td>
                      <Badge value={runner.status} />
                    </td>
                    <td>{formatTimestamp(runner.last_seen_at)}</td>
                    <td>{runner.labels.join(", ") || "none"}</td>
                    <td>
                      {runner.tools_available_count} /{" "}
                      {runner.tools_target_required_count} /{" "}
                      {runner.tools_unavailable_count}
                    </td>
                    <td>{runner.providers_available.join(", ") || "none"}</td>
                    <td>{runner.active_leases}</td>
                    <td>
                      <div className="row">
                        <Link to={`/runners/${runner.id}`}>
                          Capabilities
                          <span className="sr-only"> of {runner.name}</span>
                        </Link>
                        {canAdmin &&
                          runner.status !== "revoked" &&
                          (confirming === runner.id ? (
                            <>
                              <button
                                type="button"
                                className="danger"
                                disabled={revoke.isPending}
                                onClick={() =>
                                  revoke.mutate(runner.id, {
                                    onSettled: () => setConfirming(null),
                                  })
                                }
                              >
                                Confirm revoke {runner.name}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirming(null)}
                              >
                                Keep
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirming(runner.id)}
                            >
                              Revoke
                              <span className="sr-only"> {runner.name}</span>
                            </button>
                          ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
