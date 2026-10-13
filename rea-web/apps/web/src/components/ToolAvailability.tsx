import type { projectToolSchema } from "@rea-web/contracts/browser";
import type { z } from "zod";
import { YesNo } from "./Badge";

export type ProjectTool = z.output<typeof projectToolSchema>;

export function ToolAvailability({ tool }: { tool: ProjectTool }) {
  if (tool.per_runner.length === 0)
    return (
      <p className="muted">No runner of this project advertises this tool.</p>
    );
  return (
    <div className="table-wrap">
      <table className="table">
        <caption>Availability per runner</caption>
        <thead>
          <tr>
            <th scope="col">Runner</th>
            <th scope="col">Available</th>
            <th scope="col">Needs a target</th>
            <th scope="col">Reason</th>
            <th scope="col">Remediation</th>
          </tr>
        </thead>
        <tbody>
          {tool.per_runner.map((entry) => (
            <tr key={entry.runner_id}>
              <th scope="row">{entry.runner_name}</th>
              <td>
                <YesNo value={entry.available} />
              </td>
              <td>
                <YesNo value={entry.target_required} />
              </td>
              <td>
                {entry.reason ?? <span className="muted">none reported</span>}
              </td>
              <td>
                {entry.remediation ?? (
                  <span className="muted">none reported</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
