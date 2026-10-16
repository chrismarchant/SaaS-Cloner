import type { routingSchema } from "@rea-web/contracts/browser";
import type { z } from "zod";
import { useTargetRouting } from "../api/hooks";
import { ErrorNotice } from "./ErrorNotice";
import { Badge, YesNo } from "./Badge";

export type Routing = z.output<typeof routingSchema>;

/** A routing decision exactly as the API computed it. */
export function RoutingTable({ routing }: { routing: Routing }) {
  return (
    <div className="routing" data-testid="routing">
      <dl className="facts">
        <div className="fact">
          <dt>Target class</dt>
          <dd>{routing.class}</dd>
        </div>
        <div className="fact">
          <dt>First tool</dt>
          <dd>
            {routing.first_tool === null ? (
              <span>none selected</span>
            ) : (
              <code data-testid="first-tool">{routing.first_tool}</code>
            )}
          </dd>
        </div>
        <div className="fact">
          <dt>Rationale</dt>
          <dd>{routing.rationale}</dd>
        </div>
        <div className="fact">
          <dt>Needs an open binary session</dt>
          <dd>
            <YesNo value={routing.requires_open_binary} />
          </dd>
        </div>
        <div className="fact">
          <dt>Required tools</dt>
          <dd>{routing.required_tools.join(", ") || "none"}</dd>
        </div>
        <div className="fact">
          <dt>Required providers (any of)</dt>
          <dd>{routing.required_providers_any_of.join(", ") || "none"}</dd>
        </div>
        <div className="fact">
          <dt>Required operating systems</dt>
          <dd>{routing.required_os.join(", ") || "any"}</dd>
        </div>
      </dl>
      <h4>Candidate runners</h4>
      {routing.candidate_runners.length === 0 ? (
        <p className="notice notice-warn">
          No runner exists that could be considered for this target.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Runner</th>
                <th scope="col">Satisfies routing</th>
                <th scope="col">Unmet requirements</th>
              </tr>
            </thead>
            <tbody>
              {routing.candidate_runners.map((candidate) => (
                <tr key={candidate.runner_id}>
                  <th scope="row">{candidate.runner_name}</th>
                  <td>
                    <Badge
                      value={
                        candidate.satisfied ? "satisfied" : "not satisfied"
                      }
                      tone={candidate.satisfied ? "ok" : "bad"}
                    />
                  </td>
                  <td>
                    {candidate.unmet.length === 0 ? (
                      <span className="muted">none</span>
                    ) : (
                      <ul className="plain">
                        {candidate.unmet.map((unmet) => (
                          <li key={`${unmet.kind}:${unmet.value}`}>
                            <code>
                              {unmet.kind} {unmet.value}
                            </code>
                            <br />
                            <span className="label">reason</span> {unmet.reason}
                            <br />
                            <span className="label">remediation</span>{" "}
                            {unmet.remediation}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function RoutingView({
  projectId,
  targetId,
}: {
  projectId: string;
  targetId: string;
}) {
  const routing = useTargetRouting(projectId, targetId);
  if (routing.isPending) return <p role="status">Loading routing…</p>;
  if (routing.isError) return <ErrorNotice error={routing.error} />;
  return <RoutingTable routing={routing.data} />;
}
