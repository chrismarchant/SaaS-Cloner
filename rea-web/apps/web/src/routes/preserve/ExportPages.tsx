import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { exportSchema } from "@rea-web/contracts/browser";
import type { z } from "zod";
import {
  downloadExportUrl,
  useCreateRecoveryExport,
  useManifest,
  useRecoveryExport,
} from "../../api/preserveHooks";
import { useProject } from "../../api/project";
import { Badge } from "../../components/Badge";
import { CopyButton } from "../../components/CopyButton";
import { ErrorNotice } from "../../components/ErrorNotice";
import { TextAreaField } from "../../components/Fields";
import { JobPanel } from "../../components/JobPanel";
import { JsonExplorer } from "../../components/JsonTree";
import {
  parseRecipients,
  readEncryption,
  type EncryptionView,
} from "../../lib/exportView";
import { formatBytes, formatTimestamp, safeFileName } from "../../lib/format";
import { restoreCommands } from "../../lib/restoreCommands";
import { Crumbs } from "./shared";

type Export = z.output<typeof exportSchema>;

export function ExportNewPage() {
  const { b = "", c = "" } = useParams();
  const { project, canWrite } = useProject();
  const navigate = useNavigate();
  const create = useCreateRecoveryExport(project.id, b, c);
  const [encrypted, setEncrypted] = useState(false);
  const [recipients, setRecipients] = useState("");
  const base = `/preserve/builds/${b}/captures/${c}`;
  const ids = parseRecipients(recipients);
  if (!canWrite) return <p>Exporting needs the member role.</p>;
  return (
    <>
      <Crumbs
        items={[
          { to: "/preserve", label: "Preserve" },
          { to: `/preserve/builds/${b}`, label: "Build" },
          { to: base, label: "Capture" },
          { label: "Export" },
        ]}
      />
      <h1>Export a capture</h1>
      <p>
        An export is a tar of the recovery package that the restore tool opens
        without this service. It runs on the build's preferred runner.
      </p>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(encrypted ? { encrypt_to_recipients: ids } : {}, {
            onSuccess: (created) =>
              navigate(`/preserve/builds/${b}/exports/${created.id}`),
          });
        }}
      >
        <fieldset>
          <legend>Protection</legend>
          <label className="inline">
            <input
              type="radio"
              name="protection"
              checked={!encrypted}
              onChange={() => setEncrypted(false)}
            />{" "}
            Plain tar
          </label>
          <label className="inline">
            <input
              type="radio"
              name="protection"
              checked={encrypted}
              onChange={() => setEncrypted(true)}
            />{" "}
            Encrypted to recipient keys
          </label>
        </fieldset>
        {encrypted && (
          <>
            <TextAreaField
              label="Recipient key ids"
              mono
              rows={2}
              value={recipients}
              spellCheck={false}
              onValue={setRecipients}
              help="One key id per line, or separated by commas. Enter key ids only, never key material."
            />
            <div className="notice notice-warn" role="note">
              <p>
                The key must already be on the runner, in its recovery keys
                directory (REA_WEB_RECOVERY_KEYS_DIR, one file per key id). If
                the runner does not have a key you name, the export job fails
                with a reason; it does not fall back to a plain export. The key
                stays outside the archive and is not stored by this service.
              </p>
            </div>
          </>
        )}
        <button
          type="submit"
          disabled={create.isPending || (encrypted && ids.length === 0)}
        >
          Start export
        </button>
        <ErrorNotice error={create.error} />
      </form>
    </>
  );
}

function EncryptionFacts({ encryption }: { encryption: EncryptionView }) {
  if (encryption.state === "plain")
    return (
      <p data-testid="export-encryption">
        Not encrypted: this is a plain tar, so anyone who has the file can read
        the package.
      </p>
    );
  if (encryption.state === "unrecognised")
    return (
      <div data-testid="export-encryption">
        <p className="notice notice-warn">
          The encryption record does not match the recovery format; it is shown
          as stored.
        </p>
        <JsonExplorer value={encryption.raw} label="encryption" />
      </div>
    );
  return (
    <dl className="facts" data-testid="export-encryption">
      <div className="fact">
        <dt>Scheme</dt>
        <dd>{encryption.scheme}</dd>
      </div>
      <div className="fact">
        <dt>Recipients (key ids)</dt>
        <dd>{encryption.recipients.join(", ")}</dd>
      </div>
      <div className="fact">
        <dt>Key location</dt>
        <dd>{encryption.keyLocation}</dd>
      </div>
    </dl>
  );
}

function RestorePanel({
  projectId,
  b,
  record,
  encryption,
}: {
  projectId: string;
  b: string;
  record: Export;
  encryption: EncryptionView;
}) {
  const manifest = useManifest(projectId, b, record.capture_id, true);
  if (manifest.isPending) return <p role="status">Loading the manifest…</p>;
  if (manifest.isError) return <ErrorNotice error={manifest.error} />;
  if (!manifest.data.ok)
    return (
      <p className="notice notice-warn">
        The manifest does not match the recovery format, so no restore commands
        are suggested.
      </p>
    );
  const commands = restoreCommands(
    manifest.data.manifest,
    encryption.state === "encrypted" ? encryption : null,
  );
  return (
    <section
      aria-labelledby="restore-heading"
      className="card"
      data-testid="restore-panel"
    >
      <h3 id="restore-heading">Restore this package</h3>
      <p>
        Run these with the <code>rea-recover</code> tool on a machine of your
        own. Angle brackets are arguments you supply; nothing here is a URL or a
        secret.
      </p>
      <h4>1. Unpack</h4>
      <code className="code-line" data-testid="cmd-unpack">
        {commands.unpack}
      </code>
      <CopyButton value={commands.unpack} label="Copy unpack command" />
      <h4>2. Restore into disposable targets</h4>
      <code className="code-line" data-testid="cmd-restore">
        {commands.restore}
      </code>
      <CopyButton value={commands.restore} label="Copy restore command" />
      <ul>
        {commands.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </section>
  );
}

export function ExportPage() {
  const { b = "", e = "" } = useParams();
  const { project } = useProject();
  const record = useRecoveryExport(project.id, b, e);
  if (record.isPending) return <p role="status">Loading export…</p>;
  if (record.isError) return <ErrorNotice error={record.error} />;
  const data = record.data;
  const encryption = readEncryption(data.encryption);
  const done = data.status === "completed";
  return (
    <>
      <Crumbs
        items={[
          { to: "/preserve", label: "Preserve" },
          { to: `/preserve/builds/${b}`, label: "Build" },
          {
            to: `/preserve/builds/${b}/captures/${data.capture_id}`,
            label: "Capture",
          },
          { label: "Export" },
        ]}
      />
      <h1>Export</h1>
      <dl className="facts">
        <div className="fact">
          <dt>Status</dt>
          <dd data-testid="export-status">
            <Badge value={data.status} />
          </dd>
        </div>
        <div className="fact">
          <dt>Created</dt>
          <dd>{formatTimestamp(data.created_at)}</dd>
        </div>
        <div className="fact">
          <dt>Capture</dt>
          <dd>
            <Link to={`/preserve/builds/${b}/captures/${data.capture_id}`}>
              <code>{data.capture_id}</code>
            </Link>
          </dd>
        </div>
      </dl>
      {data.status === "failed" && (
        <p className="notice notice-error" role="alert">
          The export failed. The reason is in the job below.
        </p>
      )}
      {done && (
        <section aria-labelledby="result-heading" data-testid="export-result">
          <h2 id="result-heading">Archive</h2>
          <dl className="facts">
            <div className="fact">
              <dt>SHA-256 (recorded)</dt>
              <dd>
                <code className="break" data-testid="export-sha256">
                  {data.sha256 ?? "not recorded"}
                </code>
              </dd>
            </div>
            <div className="fact">
              <dt>Size</dt>
              <dd data-testid="export-size">
                {data.size === null
                  ? "not recorded"
                  : `${formatBytes(data.size)} (${data.size} bytes)`}
              </dd>
            </div>
            <div className="fact">
              <dt>Signature</dt>
              <dd>
                {data.signature === null ? (
                  "not signed"
                ) : (
                  <JsonExplorer value={data.signature} label="signature" />
                )}
              </dd>
            </div>
          </dl>
          <h3>Encryption</h3>
          <EncryptionFacts encryption={encryption} />
          <p>
            <a
              className="button"
              href={downloadExportUrl(project.id, b, data.id)}
              download={safeFileName(
                `recovery-${data.id}${encryption.state === "encrypted" ? ".tar.enc" : ".tar"}`,
                "recovery-export.tar",
              )}
              data-testid="export-download"
            >
              Download the archive
            </a>
          </p>
          <RestorePanel
            projectId={project.id}
            b={b}
            record={data}
            encryption={encryption}
          />
        </section>
      )}
      <JobPanel projectId={project.id} jobId={data.job_id} title="Export job" />
    </>
  );
}
