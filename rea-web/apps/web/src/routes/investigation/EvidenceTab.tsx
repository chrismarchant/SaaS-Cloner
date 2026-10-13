import type { evidenceArtifactSchema } from "@rea-web/contracts/browser";
import type { z } from "zod";
import { api } from "../../api/client";
import { formatBytes, formatTimestamp, safeFileName } from "../../lib/format";

type Artifact = z.output<typeof evidenceArtifactSchema>;

/** Same-origin download path for an artifact; null if an id is malformed. */
export const artifactHref = (
  projectId: string,
  investigationId: string,
  artifactId: string,
): string | null => {
  try {
    return api.url("getEvidence", {
      params: { p: projectId, i: investigationId, a: artifactId },
    });
  } catch {
    return null;
  }
};

export function EvidenceTab({
  projectId,
  investigationId,
  artifacts,
}: {
  projectId: string;
  investigationId: string;
  artifacts: readonly Artifact[];
}) {
  if (artifacts.length === 0)
    return <p>No evidence artifact has been stored yet.</p>;
  return (
    <div className="table-wrap">
      <table className="table" data-testid="evidence-table">
        <thead>
          <tr>
            <th scope="col">Kind</th>
            <th scope="col">Name</th>
            <th scope="col">Size</th>
            <th scope="col">SHA-256</th>
            <th scope="col">Created</th>
            <th scope="col">Download</th>
          </tr>
        </thead>
        <tbody>
          {artifacts.map((artifact) => {
            const href = artifactHref(projectId, investigationId, artifact.id);
            return (
              <tr key={artifact.id}>
                <td>{artifact.kind}</td>
                <th scope="row" className="break">
                  {artifact.name}
                </th>
                <td>{formatBytes(artifact.size)}</td>
                <td>
                  <code className="break">{artifact.sha256}</code>
                </td>
                <td>{formatTimestamp(artifact.created_at)}</td>
                <td>
                  {href === null ? (
                    <span className="muted">unavailable</span>
                  ) : (
                    <a
                      href={href}
                      download={safeFileName(
                        artifact.name,
                        `artifact-${artifact.id}`,
                      )}
                    >
                      Download<span className="sr-only"> {artifact.name}</span>
                    </a>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
