import { Link } from "react-router-dom";
import { FINDING_CLASSES, type Finding } from "@rea-web/contracts/browser";
import { Badge } from "../../components/Badge";
import type { ToolCall } from "./shared";

const CLASS_NOTES: Record<(typeof FINDING_CLASSES)[number], string> = {
  fact: "Recorded from upstream Evidence (normalized results).",
  inference:
    "Marked inferred upstream, or attributed to the model with a citation.",
  proposal: "Proposed work, such as reconstruction obligations.",
  unknown: "Questions the evidence could not settle, and unmet capabilities.",
};

function Citations({
  finding,
  investigationId,
  calls,
}: {
  finding: Finding;
  investigationId: string;
  calls: readonly ToolCall[];
}) {
  if (finding.tool_call_seqs.length === 0 && finding.evidence_ids.length === 0)
    return <p className="muted">No citations.</p>;
  return (
    <p className="citations">
      {finding.tool_call_seqs.length > 0 && (
        <>
          <span className="label">Tool calls</span>{" "}
          {finding.tool_call_seqs.map((seq) => (
            <Link
              key={seq}
              className="chip"
              to={`/investigations/${investigationId}?tab=calls&call=${seq}`}
            >
              #{seq}
            </Link>
          ))}{" "}
        </>
      )}
      {finding.evidence_ids.length > 0 && (
        <>
          <span className="label">Evidence</span>{" "}
          {finding.evidence_ids.map((evidenceId) => {
            const call = calls.find(
              (entry) => entry.evidence_id === evidenceId,
            );
            return call === undefined ? (
              <code key={evidenceId} className="chip break">
                {evidenceId}
              </code>
            ) : (
              <Link
                key={evidenceId}
                className="chip break"
                to={`/investigations/${investigationId}?tab=calls&call=${call.seq}`}
              >
                <code>{evidenceId}</code>
              </Link>
            );
          })}
        </>
      )}
    </p>
  );
}

export function FindingsTab({
  investigationId,
  findings,
  calls,
}: {
  investigationId: string;
  findings: readonly Finding[];
  calls: readonly ToolCall[];
}) {
  return (
    <>
      {FINDING_CLASSES.map((kind) => {
        const group = findings.filter((finding) => finding.class === kind);
        return (
          <section
            key={kind}
            aria-labelledby={`class-${kind}`}
            data-testid={`findings-${kind}`}
          >
            <h3 id={`class-${kind}`}>
              {kind} ({group.length})
            </h3>
            <p className="muted">{CLASS_NOTES[kind]}</p>
            {group.length === 0 && <p>None recorded.</p>}
            {group.map((finding) => (
              <article key={finding.id} className="card finding">
                <h4>
                  {finding.title} <Badge value={finding.source} tone="info" />
                </h4>
                <p className="prewrap">{finding.body}</p>
                {finding.limitations.length > 0 && (
                  <>
                    <p className="label">Limitations</p>
                    <ul>
                      {finding.limitations.map((limitation, index) => (
                        <li key={`${index}:${limitation}`}>{limitation}</li>
                      ))}
                    </ul>
                  </>
                )}
                <Citations
                  finding={finding}
                  investigationId={investigationId}
                  calls={calls}
                />
              </article>
            ))}
          </section>
        );
      })}
    </>
  );
}
