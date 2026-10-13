import { useId, useState } from "react";

export interface EvidenceOption {
  readonly evidenceId: string;
  readonly label: string;
}

/** The reference object upstream tools accept for retained Evidence. */
export const retainedEvidenceJson = (evidenceId: string): string =>
  JSON.stringify({ kind: "retained-evidence", evidence_id: evidenceId });

/** Chooses one of this investigation's evidence ids. */
export function EvidencePicker({
  options,
  onPick,
  buttonLabel,
  selectLabel = "Retained evidence",
}: {
  options: readonly EvidenceOption[];
  onPick: (evidenceId: string) => void;
  buttonLabel: string;
  selectLabel?: string;
}) {
  const id = useId();
  const [choice, setChoice] = useState("");
  if (options.length === 0)
    return (
      <p className="muted">
        This investigation has no tool call with an evidence id yet.
      </p>
    );
  const selected = choice || options[0]?.evidenceId || "";
  return (
    <div className="picker">
      <label htmlFor={id} className="sr-only">
        {selectLabel}
      </label>
      <select
        id={id}
        value={selected}
        onChange={(event) => setChoice(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.evidenceId} value={option.evidenceId}>
            {option.label}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => onPick(selected)}>
        {buttonLabel}
      </button>
    </div>
  );
}
