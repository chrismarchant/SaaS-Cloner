import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { targetSchema } from "@rea-web/contracts/browser";
import type { z } from "zod";
import { useCreateUrlTarget, flatten, keys, useTargets } from "../api/hooks";
import { useProject } from "../api/project";
import {
  targetNameProblem,
  uploadTarget,
  type UploadProgress,
} from "../api/upload";
import { ErrorNotice } from "../components/ErrorNotice";
import { JsonExplorer } from "../components/JsonTree";
import { RoutingView } from "../components/RoutingView";
import { formatBytes, formatTimestamp } from "../lib/format";

type Target = z.output<typeof targetSchema>;

function TargetSummary({
  target,
  heading,
}: {
  target: Target;
  heading: string;
}) {
  return (
    <section className="card" aria-label={heading} data-testid="target-result">
      <h3>{heading}</h3>
      <dl className="facts">
        <div className="fact">
          <dt>Name</dt>
          <dd>{target.name}</dd>
        </div>
        <div className="fact">
          <dt>Target id</dt>
          <dd>
            <code>{target.id}</code>
          </dd>
        </div>
        <div className="fact">
          <dt>Class</dt>
          <dd>{target.class}</dd>
        </div>
        <div className="fact">
          <dt>SHA-256</dt>
          <dd>
            <code data-testid="target-sha256">
              {target.sha256 ?? "not recorded"}
            </code>
          </dd>
        </div>
        <div className="fact">
          <dt>Size</dt>
          <dd data-testid="target-size">
            {target.size === null
              ? "unknown"
              : `${formatBytes(target.size)} (${target.size} bytes)`}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function UploadForm({ projectId }: { projectId: string }) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<Target | null>(null);
  const nameProblem = file === null ? null : targetNameProblem(name);

  const submit = async (): Promise<void> => {
    if (file === null) return;
    setBusy(true);
    setError(null);
    setDone(null);
    setProgress({ loaded: 0, total: file.size });
    try {
      const target = await uploadTarget({
        projectId,
        body: file,
        name,
        onProgress: setProgress,
      });
      setDone(target);
      setFile(null);
      if (input.current) input.current.value = "";
      await client.invalidateQueries({ queryKey: keys.targets(projectId) });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2>Upload a target</h2>
      <label>
        Target file
        <input
          ref={input}
          type="file"
          onChange={(event) => {
            const chosen = event.target.files?.[0] ?? null;
            setFile(chosen);
            setName(chosen?.name ?? "");
            setDone(null);
          }}
        />
      </label>
      <label>
        Target name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={file === null}
        />
      </label>
      {nameProblem !== null && <p className="field-error">{nameProblem}</p>}
      <button
        type="submit"
        disabled={file === null || busy || nameProblem !== null}
      >
        Upload
      </button>
      {progress !== null && busy && (
        <p role="status">
          <progress
            max={progress.total ?? undefined}
            value={progress.loaded}
            aria-label="Upload progress"
          />{" "}
          {formatBytes(progress.loaded)}
          {progress.total !== null && ` of ${formatBytes(progress.total)}`} sent
        </p>
      )}
      <ErrorNotice error={error} />
      {done !== null && <TargetSummary target={done} heading="Upload stored" />}
    </form>
  );
}

function UrlForm({ projectId }: { projectId: string }) {
  const create = useCreateUrlTarget(projectId);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate({ url, ...(name.trim() ? { name: name.trim() } : {}) });
      }}
    >
      <h2>Register a URL target</h2>
      <label>
        URL
        <input
          type="text"
          inputMode="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
        />
      </label>
      <label>
        Name (optional)
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <button type="submit" disabled={create.isPending}>
        Add URL target
      </button>
      <ErrorNotice error={create.error} />
      {create.data !== undefined && (
        <TargetSummary target={create.data} heading="URL target registered" />
      )}
    </form>
  );
}

export function TargetsPage() {
  const { project, canWrite } = useProject();
  const targets = useTargets(project.id);
  const [open, setOpen] = useState<string | null>(null);
  const items = flatten(targets.data);
  return (
    <>
      <h1>Targets</h1>
      {canWrite ? (
        <div className="grid-2">
          <UploadForm projectId={project.id} />
          <UrlForm projectId={project.id} />
        </div>
      ) : (
        <p className="muted">Adding targets needs the member role.</p>
      )}
      <section aria-labelledby="target-list">
        <h2 id="target-list">Targets in {project.name}</h2>
        <ErrorNotice error={targets.error} />
        {targets.isPending && <p role="status">Loading targets…</p>}
        {targets.data !== undefined && items.length === 0 && (
          <p>No target has been added yet.</p>
        )}
        {items.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Class</th>
                  <th scope="col">SHA-256</th>
                  <th scope="col">Size</th>
                  <th scope="col">URL</th>
                  <th scope="col">Added</th>
                  <th scope="col">Routing</th>
                </tr>
              </thead>
              <tbody>
                {items.map((target) => (
                  <TargetRow
                    key={target.id}
                    target={target}
                    projectId={project.id}
                    open={open === target.id}
                    onToggle={() =>
                      setOpen(open === target.id ? null : target.id)
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {targets.hasNextPage && (
          <button
            type="button"
            disabled={targets.isFetchingNextPage}
            onClick={() => void targets.fetchNextPage()}
          >
            Load more targets
          </button>
        )}
      </section>
    </>
  );
}

function TargetRow({
  target,
  projectId,
  open,
  onToggle,
}: {
  target: Target;
  projectId: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr data-testid="target-row">
        <th scope="row">{target.name}</th>
        <td>{target.kind}</td>
        <td>{target.class}</td>
        <td>
          {target.sha256 === null ? (
            <span className="muted">not recorded</span>
          ) : (
            <code className="break">{target.sha256}</code>
          )}
        </td>
        <td>{target.size === null ? "unknown" : formatBytes(target.size)}</td>
        <td className="break">
          {target.url ?? <span className="muted">none</span>}
        </td>
        <td>{formatTimestamp(target.created_at)}</td>
        <td>
          <button type="button" aria-expanded={open} onClick={onToggle}>
            {open ? "Hide routing" : "Show routing"}
            <span className="sr-only"> for {target.name}</span>
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8}>
            <RoutingView projectId={projectId} targetId={target.id} />
            {Object.keys(target.metadata).length > 0 && (
              <details>
                <summary>Target metadata</summary>
                <JsonExplorer value={target.metadata} />
              </details>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
