import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { CapabilityReport } from "@rea-web/contracts/browser";
import { useCapabilities } from "../api/hooks";
import { useProject } from "../api/project";
import { Badge, YesNo } from "../components/Badge";
import { ErrorNotice } from "../components/ErrorNotice";
import { JsonExplorer } from "../components/JsonTree";
import { formatBytes, formatTimestamp } from "../lib/format";

function Facts({
  rows,
}: {
  rows: readonly (readonly [string, React.ReactNode])[];
}) {
  return (
    <dl className="facts">
      {rows.map(([label, value]) => (
        <div key={label} className="fact">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ToolGroups({ report }: { report: CapabilityReport }) {
  const [onlyUnavailable, setOnlyUnavailable] = useState(false);
  const groups = report.tool_availability.groups.filter(
    (group) => !onlyUnavailable || !group.available,
  );
  return (
    <section aria-labelledby="availability">
      <h2 id="availability">Tool availability</h2>
      <label className="inline">
        <input
          type="checkbox"
          checked={onlyUnavailable}
          onChange={(event) => setOnlyUnavailable(event.target.checked)}
        />{" "}
        Show only groups that are not available
      </label>
      <div className="table-wrap">
        <table className="table" data-testid="availability-table">
          <thead>
            <tr>
              <th scope="col">Tools</th>
              <th scope="col">Available</th>
              <th scope="col">Reason</th>
              <th scope="col">Remediation</th>
              <th scope="col">Effects</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr key={`${group.surface ?? ""}:${group.names.join(",")}`}>
                <td>
                  <details>
                    <summary>
                      {group.names.length}{" "}
                      {group.names.length === 1 ? "tool" : "tools"}
                      {group.surface !== undefined && ` (${group.surface})`}
                      {group.names.length > 0 && `: ${group.names[0]}`}
                      {group.names.length > 1 && ", …"}
                    </summary>
                    <ul className="plain">
                      {group.names.map((name) => (
                        <li key={name}>
                          <code>{name}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                </td>
                <td>
                  <YesNo value={group.available} />
                </td>
                <td>
                  {group.reason ?? <span className="muted">none reported</span>}
                </td>
                <td>
                  {group.remediation ?? (
                    <span className="muted">none reported</span>
                  )}
                </td>
                <td>
                  {group.effects === undefined ? (
                    <span className="muted">not reported</span>
                  ) : (
                    group.effects.join(", ") || "none"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {groups.length === 0 && <p>No groups match.</p>}
    </section>
  );
}

function Providers({ report }: { report: CapabilityReport }) {
  return (
    <section aria-labelledby="providers">
      <h2 id="providers">Providers</h2>
      <h3>Analysis provider candidates</h3>
      {report.analysis_provider_candidates.length === 0 ? (
        <p className="muted">The runner reported no candidates.</p>
      ) : (
        report.analysis_provider_candidates.map((candidate, index) => (
          <JsonExplorer
            // The report has no stable id per candidate.
            key={String(candidate["provider_id"] ?? candidate["id"] ?? index)}
            value={candidate}
            label={String(
              candidate["provider_id"] ??
                candidate["id"] ??
                `candidate ${index + 1}`,
            )}
          />
        ))
      )}
      <h3>Provider capabilities</h3>
      {report.provider_capabilities.length === 0 ? (
        <p className="muted">The runner reported no provider capabilities.</p>
      ) : (
        report.provider_capabilities.map((capability, index) => {
          const provider = capability["provider"] as
            | { id?: unknown }
            | undefined;
          const name =
            typeof provider?.id === "string"
              ? provider.id
              : `capability ${index + 1}`;
          return (
            <JsonExplorer
              key={`${name}:${index}`}
              value={capability}
              label={name}
            />
          );
        })
      )}
    </section>
  );
}

export function CapabilitiesPage() {
  const { id } = useParams();
  const { project } = useProject();
  const result = useCapabilities(project.id, id ?? "");
  if (result.isPending) return <p role="status">Loading capabilities…</p>;
  if (result.isError) return <ErrorNotice error={result.error} />;
  const { runner, report } = result.data;
  return (
    <>
      <p>
        <Link to="/runners">Runners</Link> / {runner.name}
      </p>
      <h1>
        {runner.name} <Badge value={runner.status} />
      </h1>
      <p>Last heartbeat: {formatTimestamp(runner.last_seen_at)}</p>
      {report === null ? (
        <p className="notice">
          No capability report has been received from this runner. It reports
          when it first connects.
        </p>
      ) : (
        <>
          <p className="muted">
            Report from {formatTimestamp(report.reported_at)} (self-attested by
            the runner; protocol {report.protocol_version}).
          </p>
          <section aria-labelledby="host">
            <h2 id="host">Host</h2>
            <Facts
              rows={[
                ["Operating system", report.host.os],
                ["Architecture", report.host.arch],
                ["Release", report.host.release],
                [
                  "Hostname hash",
                  <code key="h">{report.host.hostname_hash}</code>,
                ],
                ["Node.js", report.host.node_version],
                [
                  "Docker available",
                  <YesNo key="d" value={report.host.docker_available} />,
                ],
                ["GUI", <YesNo key="g" value={report.host.gui} />],
                ["ADB devices", report.host.adb_devices],
                ["CPUs", report.host.cpus],
                ["Memory", formatBytes(report.host.memory_bytes)],
                [
                  "Workspace free",
                  formatBytes(report.workspace_root_free_bytes),
                ],
                ["Max concurrent jobs", report.max_concurrent_jobs],
                ["Labels", report.labels.join(", ") || "none"],
                ["Collectors", report.collectors.join(", ") || "none"],
              ]}
            />
          </section>
          <section aria-labelledby="rea">
            <h2 id="rea">REA</h2>
            {report.rea === null ? (
              <p className="notice notice-warn">
                REA is unavailable on this runner:{" "}
                {report.rea_unavailable_reason ?? "no reason reported"}
              </p>
            ) : (
              <Facts
                rows={[
                  ["Package version", report.rea.package_version],
                  ["Build commit", report.rea.build_commit ?? "not reported"],
                  ["Source SHA", report.rea.source_sha ?? "not reported"],
                  [
                    "Negotiated protocol",
                    report.rea.negotiated_protocol_version ?? "not reported",
                  ],
                  ["Advertised tools", report.tools_list.length],
                  ["Prompts", report.prompts_list.length],
                  [
                    "Catalog counts",
                    Object.entries(report.rea.catalog.counts)
                      .map(([key, count]) => `${key}: ${count}`)
                      .join(", ") || "none",
                  ],
                ]}
              />
            )}
            <p>
              Environment variable names that are set:{" "}
              {report.env_capability_names.length === 0
                ? "none"
                : report.env_capability_names.map((name) => (
                    <code key={name} className="chip">
                      {name}
                    </code>
                  ))}
            </p>
          </section>
          <ToolGroups report={report} />
          <Providers report={report} />
        </>
      )}
    </>
  );
}
