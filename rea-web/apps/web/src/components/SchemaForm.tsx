import { useId, useRef, type ReactNode } from "react";
import {
  EXTRAS_KEY,
  emptyDraft,
  initialDraft,
  joinPath,
  type Draft,
  type FieldError,
  type FormNode,
  type RawNode,
} from "../lib/schemaForm";
import {
  EvidencePicker,
  retainedEvidenceJson,
  type EvidenceOption,
} from "./EvidencePicker";

interface FieldProps<N extends FormNode = FormNode> {
  readonly node: N;
  readonly value: Draft;
  readonly path: string;
  readonly errors: readonly FieldError[];
  readonly evidence: readonly EvidenceOption[];
  readonly onChange: (next: Draft) => void;
}

const asRecord = (draft: Draft): { [key: string]: Draft } =>
  typeof draft === "object" && !Array.isArray(draft) ? draft : {};

const asText = (draft: Draft | undefined): string =>
  typeof draft === "string" ? draft : "";

function Label({ node, htmlFor }: { node: FormNode; htmlFor?: string }) {
  const text = node.title === "" ? node.name : node.title;
  const content = (
    <>
      {text}
      {node.required && (
        <>
          <span aria-hidden="true"> *</span>
          <span className="sr-only"> (required)</span>
        </>
      )}
    </>
  );
  return htmlFor === undefined ? (
    <span className="field-label">{content}</span>
  ) : (
    <label htmlFor={htmlFor}>{content}</label>
  );
}

function Help({
  id,
  node,
  extra,
}: {
  id: string;
  node: FormNode;
  extra?: ReactNode;
}) {
  return (
    <>
      {node.description !== null && (
        <small id={id} className="muted help">
          {node.description}
        </small>
      )}
      {extra}
    </>
  );
}

function FieldErrors({
  path,
  errors,
}: {
  path: string;
  errors: readonly FieldError[];
}) {
  const own = errors.filter((entry) => entry.path === path);
  return (
    <>
      {own.map((entry) => (
        <small key={entry.message} className="field-error">
          {entry.message}
        </small>
      ))}
    </>
  );
}

function RawField({
  node,
  value,
  path,
  errors,
  evidence,
  onChange,
}: FieldProps<RawNode>) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const text = asText(value);
  const insert = (snippet: string): void => {
    const element = area.current;
    if (text.trim() === "" || element === null) {
      onChange(snippet);
      return;
    }
    const start = element.selectionStart;
    const end = element.selectionEnd;
    onChange(text.slice(0, start) + snippet + text.slice(end));
  };
  return (
    <div className="field">
      <Label node={node} htmlFor={id} />
      <Help
        id={`${id}-help`}
        node={node}
        extra={
          <small className="muted help">
            Edited as JSON ({node.reason}).
            {node.variants.length > 0 &&
              ` Accepted shapes: ${node.variants.join(" | ")}.`}
          </small>
        }
      />
      <textarea
        id={id}
        ref={area}
        rows={4}
        spellCheck={false}
        className="mono"
        value={text}
        aria-describedby={`${id}-help`}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldErrors path={path} errors={errors} />
      {evidence.length > 0 && (
        <EvidencePicker
          options={evidence}
          selectLabel={`Retained evidence for ${node.title || node.name}`}
          buttonLabel={`Insert evidence reference into ${node.title || node.name}`}
          onPick={(evidenceId) => insert(retainedEvidenceJson(evidenceId))}
        />
      )}
    </div>
  );
}

function ScalarField({
  node,
  value,
  path,
  errors,
  evidence,
  onChange,
}: FieldProps) {
  const id = useId();
  if (node.kind === "object" || node.kind === "array" || node.kind === "raw")
    return null;
  const text = asText(value);
  const wantsEvidence =
    node.kind === "string" &&
    node.pattern?.includes("ev_") === true &&
    evidence.length > 0;
  let control: ReactNode;
  if (node.kind === "boolean")
    control = (
      <select id={id} value={text} onChange={(e) => onChange(e.target.value)}>
        <option value="">(not set)</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  else if (node.kind === "enum")
    control = (
      <select id={id} value={text} onChange={(e) => onChange(e.target.value)}>
        {!(node.fixed && node.required) && <option value="">(not set)</option>}
        {node.options.map((option, index) => (
          <option key={JSON.stringify(option)} value={String(index)}>
            {typeof option === "string" ? option : JSON.stringify(option)}
          </option>
        ))}
      </select>
    );
  else
    control = (
      <input
        id={id}
        type="text"
        value={text}
        inputMode={node.kind === "string" ? "text" : "decimal"}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={`${id}-help`}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  const limits: string[] = [];
  if (node.kind === "integer" || node.kind === "number") {
    limits.push(node.kind);
    if (node.minimum !== null) limits.push(`min ${node.minimum}`);
    if (node.maximum !== null) limits.push(`max ${node.maximum}`);
  }
  if (node.kind === "string" && node.pattern !== null)
    limits.push(`pattern ${node.pattern}`);
  return (
    <div className="field">
      <Label node={node} htmlFor={id} />
      <Help
        id={`${id}-help`}
        node={node}
        extra={
          limits.length > 0 ? (
            <small className="muted help">{limits.join(", ")}</small>
          ) : null
        }
      />
      {control}
      <FieldErrors path={path} errors={errors} />
      {wantsEvidence && (
        <EvidencePicker
          options={evidence}
          selectLabel={`Evidence id for ${node.title || node.name}`}
          buttonLabel={`Use evidence id for ${node.title || node.name}`}
          onPick={(evidenceId) => onChange(evidenceId)}
        />
      )}
    </div>
  );
}

function ObjectField({
  node,
  value,
  path,
  errors,
  evidence,
  onChange,
}: FieldProps) {
  if (node.kind !== "object") return null;
  const record = asRecord(value);
  const body = (
    <>
      {node.fields.map((field) => (
        <Field
          key={field.id}
          node={field}
          value={record[field.name] ?? emptyDraft(field)}
          path={joinPath(path, field.name)}
          errors={errors}
          evidence={evidence}
          onChange={(next) => onChange({ ...record, [field.name]: next })}
        />
      ))}
      {node.extras !== null && (
        <Field
          node={node.extras}
          value={record[EXTRAS_KEY] ?? ""}
          path={joinPath(path, "additional properties")}
          errors={errors}
          evidence={evidence}
          onChange={(next) => onChange({ ...record, [EXTRAS_KEY]: next })}
        />
      )}
    </>
  );
  if (path === "") return <div className="fields">{body}</div>;
  return (
    <fieldset className="nested">
      <legend>
        <Label node={node} />
      </legend>
      {node.description !== null && (
        <small className="muted help">{node.description}</small>
      )}
      {body}
    </fieldset>
  );
}

function ArrayField({
  node,
  value,
  path,
  errors,
  evidence,
  onChange,
}: FieldProps) {
  if (node.kind !== "array") return null;
  const items = Array.isArray(value) ? value : [];
  return (
    <fieldset className="nested">
      <legend>
        <Label node={node} />
      </legend>
      {node.description !== null && (
        <small className="muted help">{node.description}</small>
      )}
      <FieldErrors path={path} errors={errors} />
      {items.length === 0 && <p className="muted">No items.</p>}
      {items.map((item, index) => (
        // Items have no identity of their own; position is the identity.
        <div key={index} className="array-item">
          <Field
            node={{
              ...node.item,
              title: `${node.title || node.name} ${index + 1}`,
            }}
            value={item}
            path={`${path}[${index}]`}
            errors={errors}
            evidence={evidence}
            onChange={(next) =>
              onChange(items.map((old, at) => (at === index ? next : old)))
            }
          />
          <button
            type="button"
            onClick={() => onChange(items.filter((_old, at) => at !== index))}
          >
            Remove {node.title || node.name} {index + 1}
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...items, initialDraft(node.item)])}
      >
        Add {node.title || node.name} item
      </button>
    </fieldset>
  );
}

function Field(props: FieldProps) {
  switch (props.node.kind) {
    case "raw":
      return <RawField {...(props as FieldProps<RawNode>)} />;
    case "object":
      return <ObjectField {...props} />;
    case "array":
      return <ArrayField {...props} />;
    default:
      return <ScalarField {...props} />;
  }
}

/** Renders a form model; the caller owns the draft and the error list. */
export function SchemaForm(props: Omit<FieldProps, "path">) {
  return <Field {...props} path="" />;
}
