import {
  COMPONENT_KINDS,
  type ComponentKind,
} from "@rea-web/contracts/browser";
import { useState } from "react";
import {
  componentLabel,
  newComponent,
  newInvariant,
  type AssetSourceDraft,
  type ComponentDraft,
  type DraftProblem,
  type ExpectKind,
  type InvariantDraft,
} from "../lib/buildDraft";
import { TextAreaField, TextField } from "./Fields";
import { RunnerPathField } from "./RunnerPathField";
import { SelectField } from "./SelectField";

const ENV_NAME_HELP =
  "An environment variable NAME that the runner reads (uppercase letters, digits and underscores, starting with a letter). Enter a name, never a value: the runner holds the credential and it never reaches this page.";

const KIND_HELP: Readonly<Record<ComponentKind, string>> = {
  source: "The repository declared as the build source above.",
  dependencies: "Lockfiles and container images the build depends on.",
  data: "A PostgreSQL or Supabase database captured with the runner's own credential.",
  assets:
    "Uploaded files or objects: an S3 bucket, a runner path or Supabase Storage.",
  infrastructure:
    "Declared services, commands, health checks, env var names, domains and schedules as a JSON descriptor.",
  integrations:
    "Third-party providers, webhooks and manual steps as a JSON descriptor.",
  product: "Product documentation generated from a source component.",
  artifacts: "Evidence from earlier investigations in this project.",
};

function Invariants({
  invariants,
  onChange,
}: {
  invariants: readonly InvariantDraft[];
  onChange: (next: readonly InvariantDraft[]) => void;
}) {
  const patch = (uid: string, change: Partial<InvariantDraft>): void =>
    onChange(
      invariants.map((entry) =>
        entry.uid === uid ? { ...entry, ...change } : entry,
      ),
    );
  return (
    <fieldset className="nested">
      <legend>Invariants</legend>
      <p className="help-text">
        A query that must hold after a restore, for example a row count. The
        query runs against the restored copy only.
      </p>
      {invariants.map((invariant, position) => (
        <div key={invariant.uid} className="array-item">
          <TextField
            label={`Invariant ${position + 1} id`}
            value={invariant.id}
            onValue={(id) => patch(invariant.uid, { id })}
          />
          <TextAreaField
            label={`Invariant ${position + 1} SQL`}
            mono
            rows={2}
            maxLength={4000}
            value={invariant.sql}
            onValue={(sql) => patch(invariant.uid, { sql })}
          />
          <SelectField
            label={`Invariant ${position + 1} expected value`}
            value={invariant.expectKind}
            onChange={(event) =>
              patch(invariant.uid, {
                expectKind: event.target.value as ExpectKind,
                expect: event.target.value === "boolean" ? "true" : "",
              })
            }
          >
            <option value="none">No expected value</option>
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="boolean">Boolean</option>
            <option value="null">Null</option>
          </SelectField>
          {(invariant.expectKind === "text" ||
            invariant.expectKind === "number") && (
            <TextField
              label={`Invariant ${position + 1} expected`}
              value={invariant.expect}
              onValue={(expect) => patch(invariant.uid, { expect })}
            />
          )}
          {invariant.expectKind === "boolean" && (
            <SelectField
              label={`Invariant ${position + 1} expected boolean`}
              value={invariant.expect}
              onChange={(event) =>
                patch(invariant.uid, { expect: event.target.value })
              }
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </SelectField>
          )}
          <button
            type="button"
            onClick={() =>
              onChange(
                invariants.filter((entry) => entry.uid !== invariant.uid),
              )
            }
          >
            Remove invariant {position + 1}
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...invariants, newInvariant()])}
      >
        Add invariant
      </button>
    </fieldset>
  );
}

function AssetSource({
  source,
  onChange,
}: {
  source: AssetSourceDraft;
  onChange: (next: AssetSourceDraft) => void;
}) {
  return (
    <>
      <SelectField
        label="Asset source"
        value={source.kind}
        onChange={(event) => {
          const kind = event.target.value as AssetSourceDraft["kind"];
          onChange(
            kind === "s3"
              ? {
                  kind,
                  bucket: "",
                  prefix: "",
                  endpointEnvName: "",
                  credentialsEnvPrefix: "",
                }
              : kind === "runner_local"
                ? { kind, runnerId: "", pathHash: "" }
                : {
                    kind,
                    projectRef: "",
                    buckets: "",
                    credentialsEnvPrefix: "",
                  },
          );
        }}
      >
        <option value="s3">S3 bucket</option>
        <option value="runner_local">Directory on a runner</option>
        <option value="supabase_storage">Supabase Storage</option>
      </SelectField>
      {source.kind === "runner_local" && (
        <RunnerPathField
          label="Assets path"
          runnerId={source.runnerId}
          pathHash={source.pathHash}
          onChange={(runnerId, pathHash) =>
            onChange({ ...source, runnerId, pathHash })
          }
        />
      )}
      {source.kind === "s3" && (
        <>
          <TextField
            label="Bucket"
            value={source.bucket}
            onValue={(bucket) => onChange({ ...source, bucket })}
          />
          <TextField
            label="Prefix"
            value={source.prefix}
            onValue={(prefix) => onChange({ ...source, prefix })}
          />
          <TextField
            label="Endpoint variable name (optional)"
            mono
            value={source.endpointEnvName}
            onValue={(endpointEnvName) =>
              onChange({ ...source, endpointEnvName })
            }
            help="Name of the variable holding a custom endpoint URL, for S3-compatible stores. Leave empty for AWS."
          />
          <TextField
            label="Credentials variable prefix"
            mono
            value={source.credentialsEnvPrefix}
            onValue={(credentialsEnvPrefix) =>
              onChange({ ...source, credentialsEnvPrefix })
            }
            help={ENV_NAME_HELP}
          />
        </>
      )}
      {source.kind === "supabase_storage" && (
        <>
          <TextField
            label="Supabase project ref"
            value={source.projectRef}
            onValue={(projectRef) => onChange({ ...source, projectRef })}
          />
          <TextAreaField
            label="Buckets"
            rows={2}
            value={source.buckets}
            onValue={(buckets) => onChange({ ...source, buckets })}
            help="One bucket per line, or comma-separated."
          />
          <TextField
            label="Credentials variable prefix"
            mono
            value={source.credentialsEnvPrefix}
            onValue={(credentialsEnvPrefix) =>
              onChange({ ...source, credentialsEnvPrefix })
            }
            help={ENV_NAME_HELP}
          />
        </>
      )}
    </>
  );
}

function KindFields({
  component,
  siblings,
  onChange,
}: {
  component: ComponentDraft;
  siblings: readonly ComponentDraft[];
  onChange: (next: ComponentDraft) => void;
}) {
  switch (component.kind) {
    case "source":
      return null;
    case "dependencies":
      return (
        <>
          <TextAreaField
            label="Lockfiles"
            mono
            rows={2}
            value={component.lockfiles}
            onValue={(lockfiles) => onChange({ ...component, lockfiles })}
            help="One repository-relative path per line. Leave empty to detect the usual lockfiles."
          />
          <TextAreaField
            label="Container images"
            mono
            rows={2}
            value={component.containerImages}
            onValue={(containerImages) =>
              onChange({ ...component, containerImages })
            }
            help="One image reference per line. Images are recorded with their digest when known, otherwise as not pinned."
          />
        </>
      );
    case "data":
      return (
        <>
          <SelectField
            label="Database engine"
            value={component.engine}
            onChange={(event) =>
              onChange({
                ...component,
                engine: event.target.value as "postgresql" | "supabase",
              })
            }
          >
            <option value="postgresql">PostgreSQL</option>
            <option value="supabase">Supabase</option>
          </SelectField>
          <TextField
            label="Connection variable NAME"
            mono
            value={component.connectionEnvName}
            spellCheck={false}
            autoComplete="off"
            onValue={(connectionEnvName) =>
              onChange({ ...component, connectionEnvName })
            }
            help={ENV_NAME_HELP}
          />
          <Invariants
            invariants={component.invariants}
            onChange={(invariants) => onChange({ ...component, invariants })}
          />
        </>
      );
    case "assets":
      return (
        <AssetSource
          source={component.source}
          onChange={(source) => onChange({ ...component, source })}
        />
      );
    case "infrastructure":
    case "integrations":
      return (
        <TextAreaField
          label="Descriptor (JSON object)"
          mono
          rows={8}
          spellCheck={false}
          value={component.descriptor}
          onValue={(descriptor) => onChange({ ...component, descriptor })}
          help="Checked as JSON here and by the contract on submit. Secrets are names only: describe which variable holds a value, never the value."
        />
      );
    case "product":
      return (
        <>
          <TextField
            label="Source component id"
            value={component.sourceComponentId}
            list="source-component-ids"
            onValue={(sourceComponentId) =>
              onChange({ ...component, sourceComponentId })
            }
            help="The id of the source component to document."
          />
          <datalist id="source-component-ids">
            {siblings
              .filter((entry) => entry.kind === "source")
              .map((entry) => (
                <option key={entry.uid} value={entry.id} />
              ))}
          </datalist>
          <TextField
            label="Product name"
            value={component.name}
            maxLength={120}
            onValue={(name) => onChange({ ...component, name })}
          />
          <TextAreaField
            label="REA target ids"
            mono
            rows={2}
            value={component.reaTargetIds}
            onValue={(reaTargetIds) => onChange({ ...component, reaTargetIds })}
            help="Optional. One target id (UUID) per line."
          />
        </>
      );
    case "artifacts":
      return (
        <TextAreaField
          label="Investigation ids"
          mono
          rows={2}
          value={component.investigationIds}
          onValue={(investigationIds) =>
            onChange({ ...component, investigationIds })
          }
          help="Optional. One investigation id (UUID) per line."
        />
      );
  }
}

/** Edits the build's component declarations, one card per component. */
export function ComponentsEditor({
  components,
  problems,
  onChange,
}: {
  components: readonly ComponentDraft[];
  problems: readonly DraftProblem[];
  onChange: (next: readonly ComponentDraft[]) => void;
}) {
  const [kind, setKind] = useState<ComponentKind>("data");
  return (
    <section aria-labelledby="components-heading">
      <h2 id="components-heading">Components</h2>
      <p className="help-text">
        Each component is one thing to preserve. A component id is unique per
        kind and appears as kind:id, for example source:main.
      </p>
      {components.map((component, index) => {
        const own = problems.filter((entry) => entry.component === index);
        return (
          <fieldset key={component.uid} className="component-editor">
            <legend>
              Component {index + 1}: {component.kind}
            </legend>
            <p className="help-text">{KIND_HELP[component.kind]}</p>
            <TextField
              label={`Component ${index + 1} id`}
              value={component.id}
              onValue={(id) =>
                onChange(
                  components.map((entry) =>
                    entry.uid === component.uid ? { ...entry, id } : entry,
                  ),
                )
              }
              help={
                component.id.trim() === ""
                  ? "Required."
                  : `Shown as ${componentLabel(component)}.`
              }
            />
            <KindFields
              component={component}
              siblings={components}
              onChange={(next) =>
                onChange(
                  components.map((entry) =>
                    entry.uid === component.uid ? next : entry,
                  ),
                )
              }
            />
            {own.length > 0 && (
              <ul className="field-error" role="alert">
                {own.map((entry) => (
                  <li key={`${entry.path}:${entry.message}`}>
                    <code>{entry.path.replace(/^components\.\d+\./u, "")}</code>
                    : {entry.message}
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="danger"
              onClick={() =>
                onChange(
                  components.filter((entry) => entry.uid !== component.uid),
                )
              }
            >
              Remove component {index + 1}
            </button>
          </fieldset>
        );
      })}
      <div className="row">
        <SelectField
          label="Component kind to add"
          value={kind}
          onChange={(event) => setKind(event.target.value as ComponentKind)}
        >
          {COMPONENT_KINDS.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </SelectField>
        <button
          type="button"
          onClick={() => onChange([...components, newComponent(kind)])}
        >
          Add component
        </button>
      </div>
    </section>
  );
}
