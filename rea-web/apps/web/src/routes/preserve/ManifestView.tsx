import { useState } from "react";
import type {
  ManifestComponent,
  RecoveryManifest,
} from "@rea-web/contracts/browser";
import { Badge } from "../../components/Badge";
import { JsonExplorer } from "../../components/JsonTree";
import { VirtualTable } from "../../components/VirtualTable";
import { formatBytes, plural } from "../../lib/format";
import {
  filterFiles,
  imageLabel,
  manifestTotals,
  stepNetworks,
  windowLabel,
} from "../../lib/manifestView";
import {
  componentStatusWording,
  consistencyWording,
  humanise,
} from "../../lib/recoveryWording";

function ListOrNone({ items }: { items: readonly string[] }) {
  if (items.length === 0) return <span className="muted">none</span>;
  return (
    <ul className="plain">
      {items.map((item, index) => (
        <li key={`${index}:${item}`}>{item}</li>
      ))}
    </ul>
  );
}

function ComponentCard({ component }: { component: ManifestComponent }) {
  const wording = componentStatusWording(component.status);
  const networks = stepNetworks(component);
  return (
    <article className="card" data-testid="manifest-component">
      <header className="row between">
        <h4>
          <code>{component.id}</code>{" "}
          <span className="muted">{component.title}</span>
        </h4>
        <Badge value={component.status} tone={wording.tone} />
      </header>
      <p className="help-text">{wording.meaning}</p>
      <dl className="facts">
        <div className="fact">
          <dt>Kind</dt>
          <dd>{component.kind}</dd>
        </div>
        <div className="fact">
          <dt>Method</dt>
          <dd>{component.method === "" ? "not recorded" : component.method}</dd>
        </div>
        <div className="fact">
          <dt>Captured window</dt>
          <dd>{windowLabel(component.captured_at)}</dd>
        </div>
        <div className="fact">
          <dt>Entries</dt>
          <dd>{component.entries}</dd>
        </div>
        <div className="fact">
          <dt>Bytes</dt>
          <dd>
            {formatBytes(component.bytes)} ({component.bytes} bytes)
          </dd>
        </div>
        <div className="fact">
          <dt>Restore steps</dt>
          <dd>
            {plural(component.restore.steps.length, "step")}
            {networks.length > 0 && `; network: ${networks.join(", ")}`}
          </dd>
        </div>
      </dl>
      <h5>Limitations</h5>
      <ListOrNone items={component.limitations} />
      <h5>Omissions</h5>
      {component.omissions.length === 0 ? (
        <span className="muted">none recorded</span>
      ) : (
        <ul className="plain">
          {component.omissions.map((omission, index) => (
            <li key={`${index}:${omission.what}`}>
              <strong>{omission.what}</strong>
              <br />
              <span className="label">reason</span> {omission.reason}
              <br />
              <span className="label">remediation</span> {omission.remediation}
            </li>
          ))}
        </ul>
      )}
      {Object.keys(component.details).length > 0 && (
        <details>
          <summary>Collector details</summary>
          <JsonExplorer value={component.details} label="details" />
        </details>
      )}
    </article>
  );
}

export function FileList({ manifest }: { manifest: RecoveryManifest }) {
  const [query, setQuery] = useState("");
  const [componentId, setComponentId] = useState("");
  const files = filterFiles(manifest.files, query, componentId);
  const componentIds = [
    ...new Set(manifest.files.map((file) => file.component_id)),
  ];
  return (
    <section aria-labelledby="files-heading">
      <h3 id="files-heading">Files</h3>
      <p className="help-text">
        Every file in the package except the manifest, with the SHA-256 the
        integrity check compares. Only the rows in view are drawn.
      </p>
      <div className="row">
        <label className="inline">
          Filter by path{" "}
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="inline">
          Component{" "}
          <select
            value={componentId}
            onChange={(event) => setComponentId(event.target.value)}
          >
            <option value="">All components</option>
            {componentIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p role="status" data-testid="file-count">
        {plural(files.length, "file")}
        {files.length !== manifest.files.length &&
          ` of ${manifest.files.length}`}
        .
      </p>
      <VirtualTable
        label="Package files"
        testId="file-table"
        columns="minmax(14rem, 3fr) 7rem minmax(12rem, 4fr) 9rem"
        headers={["Path", "Size", "SHA-256", "Component"]}
        items={files}
        rowKey={(file, index) => `${index}:${file.path}`}
        cells={(file) => [
          <span key="p" title={file.path}>
            {file.path}
          </span>,
          <span key="s" title={`${file.size} bytes`}>
            {formatBytes(file.size)}
          </span>,
          <code key="h" title={file.sha256}>
            {file.sha256}
          </code>,
          <span key="c">{file.component_id}</span>,
        ]}
      />
    </section>
  );
}

/** The manifest, parsed facts only: nothing here re-reads the raw document. */
export function ManifestView({
  manifest,
  manifestSha256,
}: {
  manifest: RecoveryManifest;
  manifestSha256: string | null;
}) {
  const totals = manifestTotals(manifest);
  const consistency = consistencyWording(manifest.consistency.classification);
  return (
    <div data-testid="manifest">
      <dl className="facts">
        <div className="fact">
          <dt>Package</dt>
          <dd>
            <code>{manifest.package_id}</code>
          </dd>
        </div>
        <div className="fact">
          <dt>Manifest SHA-256 (recorded)</dt>
          <dd>
            <code className="break">{manifestSha256 ?? "not recorded"}</code>
          </dd>
        </div>
        <div className="fact">
          <dt>Created</dt>
          <dd>{manifest.created_at}</dd>
        </div>
        <div className="fact">
          <dt>Producer</dt>
          <dd>
            {manifest.producer.name} {manifest.producer.version}
          </dd>
        </div>
        <div className="fact">
          <dt>Files</dt>
          <dd>
            {totals.files} ({formatBytes(totals.fileBytes)})
          </dd>
        </div>
        <div className="fact">
          <dt>Components by status</dt>
          <dd>
            {Object.entries(totals.componentsByStatus)
              .map(([status, count]) => `${status} ${count}`)
              .join(", ")}
          </dd>
        </div>
      </dl>

      <h3>Consistency</h3>
      <dl className="facts">
        <div className="fact">
          <dt>Classification</dt>
          <dd>
            <Badge value={consistency.label} tone={consistency.tone} />
          </dd>
        </div>
        <div className="fact">
          <dt>Window</dt>
          <dd>{windowLabel(manifest.consistency.window)}</dd>
        </div>
        <div className="fact">
          <dt>Strategy</dt>
          <dd className="prewrap">{manifest.consistency.strategy}</dd>
        </div>
        <div className="fact">
          <dt>Gaps</dt>
          <dd>
            <ListOrNone items={manifest.consistency.gaps} />
          </dd>
        </div>
      </dl>

      <h3>Components</h3>
      {manifest.components.map((component) => (
        <ComponentCard key={component.id} component={component} />
      ))}

      <h3>Source revisions</h3>
      {manifest.source_revisions.length === 0 ? (
        <p className="muted">No source revision is recorded.</p>
      ) : (
        manifest.source_revisions.map((revision) => (
          <article
            className="card"
            key={revision.repository + revision.head_sha}
          >
            <dl className="facts">
              <div className="fact">
                <dt>Repository</dt>
                <dd>{revision.repository}</dd>
              </div>
              <div className="fact">
                <dt>Remote (credentials redacted)</dt>
                <dd>{revision.remote_url_redacted ?? "none"}</dd>
              </div>
              <div className="fact">
                <dt>Head</dt>
                <dd>
                  <code>{revision.head_sha}</code>
                </dd>
              </div>
              <div className="fact">
                <dt>Refs, submodules</dt>
                <dd>
                  {revision.refs.length} refs, {revision.submodules.length}{" "}
                  submodules
                </dd>
              </div>
              <div className="fact">
                <dt>LFS</dt>
                <dd>
                  {revision.lfs.count} objects,{" "}
                  {formatBytes(revision.lfs.bytes)},{" "}
                  {revision.lfs.included ? "included" : "not included"}
                </dd>
              </div>
              <div className="fact">
                <dt>Working tree</dt>
                <dd>
                  {revision.working_tree.included ? "included" : "not included"}
                  ; {revision.working_tree.dirty_files} modified,{" "}
                  {revision.working_tree.untracked_files} untracked
                </dd>
              </div>
            </dl>
          </article>
        ))
      )}

      <h3>Secrets</h3>
      <div className="card" data-testid="manifest-secrets">
        <p>
          Mode <strong>{humanise(manifest.secrets.mode)}</strong>.{" "}
          {manifest.secrets.mode === "names_only"
            ? "The package records the names of the secrets it needs and never their values."
            : "Values are held in a separately encrypted escrow file; they are not shown here."}
        </p>
        {manifest.secrets.names.length === 0 ? (
          <p className="muted">No secret name is recorded.</p>
        ) : (
          <ul className="plain">
            {manifest.secrets.names.map((name) => (
              <li key={name}>
                <code>{name}</code>
              </li>
            ))}
          </ul>
        )}
      </div>

      <h3>Dependencies</h3>
      <div className="grid-2">
        <section className="card" aria-label="Runtimes">
          <h4>Runtimes</h4>
          <ListOrNone
            items={manifest.dependencies.runtimes.map(
              (runtime) =>
                `${runtime.name} ${runtime.version} (${runtime.source})`,
            )}
          />
          <h4>Package managers</h4>
          <ListOrNone
            items={manifest.dependencies.package_managers.map(
              (manager) =>
                `${manager.name} ${manager.version ?? "version unknown"}${manager.lockfile === null ? "" : `, lockfile ${manager.lockfile}`}`,
            )}
          />
          <h4>System packages</h4>
          <ListOrNone items={manifest.dependencies.system_packages} />
        </section>
        <section className="card" aria-label="Images and registries">
          <h4>Container images</h4>
          <ListOrNone
            items={manifest.dependencies.container_images.map(imageLabel)}
          />
          <h4>Registries</h4>
          <ListOrNone
            items={manifest.dependencies.registries.map(
              (registry) =>
                `${registry.url}: needed for ${registry.required_for.join(", ") || "unspecified"}; credentials ${registry.credentials_required ? "required" : "not required"}`,
            )}
          />
        </section>
      </div>

      <h3>Manual prerequisites</h3>
      {manifest.manual_prerequisites.length === 0 ? (
        <p className="muted">None recorded.</p>
      ) : (
        manifest.manual_prerequisites.map((item) => (
          <article className="card" key={item.id}>
            <h4>{item.title}</h4>
            <p>
              <span className="label">reason</span> {item.reason}
            </p>
            <p className="prewrap">
              <span className="label">instructions</span> {item.instructions}
            </p>
            {item.component_id !== undefined && (
              <p className="muted">Component {item.component_id}</p>
            )}
          </article>
        ))
      )}

      <h3>Missing or blocked</h3>
      {manifest.missing_or_blocked.length === 0 ? (
        <p className="muted">
          The manifest lists nothing as missing or blocked.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table" data-testid="manifest-missing">
            <thead>
              <tr>
                <th scope="col">Component</th>
                <th scope="col">Status</th>
                <th scope="col">Reason</th>
                <th scope="col">Remediation</th>
              </tr>
            </thead>
            <tbody>
              {manifest.missing_or_blocked.map((item, index) => (
                <tr key={`${index}:${item.component_id}`}>
                  <th scope="row">{item.component_id}</th>
                  <td>
                    <Badge
                      value={item.status}
                      tone={item.status === "blocked" ? "bad" : "warn"}
                    />
                  </td>
                  <td>{item.reason}</td>
                  <td>{item.remediation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Restore guards</h3>
      <dl className="facts">
        <div className="fact">
          <dt>Default network</dt>
          <dd>{manifest.restore_guards.default_network}</dd>
        </div>
        <div className="fact">
          <dt>Blocked hosts</dt>
          <dd>
            <ListOrNone items={manifest.restore_guards.blocked_hosts} />
          </dd>
        </div>
        <div className="fact">
          <dt>Schedules left disabled</dt>
          <dd>
            <ListOrNone items={manifest.restore_guards.disabled_schedules} />
          </dd>
        </div>
        <div className="fact">
          <dt>Webhooks left disabled</dt>
          <dd>
            <ListOrNone items={manifest.restore_guards.disabled_webhooks} />
          </dd>
        </div>
      </dl>
    </div>
  );
}
