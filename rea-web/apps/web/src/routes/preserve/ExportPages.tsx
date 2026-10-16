import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { exportSchema } from "@rea-web/contracts/browser";
import type { z } from "zod";
import {
  downloadExportSignatureUrl,
  downloadExportUrl,
  useCreateRecoveryExport,
  useManifest,
  useRecoveryExport,
} from "../../api/preserveHooks";
import { useProject } from "../../api/project";
import { Badge } from "../../components/Badge";
import { CopyButton } from "../../components/CopyButton";
import { ErrorNotice } from "../../components/ErrorNotice";
import { TextAreaField, TextField } from "../../components/Fields";
import { JobPanel } from "../../components/JobPanel";
import { JsonExplorer } from "../../components/JsonTree";
import {
  SIGNING_KEY_ID,
  VERIFY_ARCHIVE_COMMAND,
  parseRecipients,
  readEncryption,
  readSignature,
  type EncryptionView,
  type SignatureView,
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
  const [signKeyId, setSignKeyId] = useState("");
  const base = `/preserve/builds/${b}/captures/${c}`;
  const ids = parseRecipients(recipients);
  const signing = signKeyId.trim();
  const signingInvalid = signing !== "" && !SIGNING_KEY_ID.test(signing);
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
          create.mutate(
            {
              ...(encrypted ? { encrypt_to_recipients: ids } : {}),
              ...(signing === "" ? {} : { sign_with_key_id: signing }),
            },
            {
              onSuccess: (created) =>
                navigate(`/preserve/builds/${b}/exports/${created.id}`),
            },
          );
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
        <TextField
          label="Sign with key id (optional)"
          mono
          value={signKeyId}
          spellCheck={false}
          autoComplete="off"
          onValue={setSignKeyId}
          help="64 lowercase hex characters: the id of the signing key's public key. The private key must already be on the runner, in the directory named by REA_WEB_EXPORT_SIGNING_KEYS_DIR as <key id>.pem. If it is not there the export job fails; it does not fall back to an unsigned export. The key is never sent to or stored by this service."
        />
        {signingInvalid && (
          <p className="notice notice-warn" role="alert">
            A key id is 64 lowercase hex characters.
          </p>
        )}
        <button
          type="submit"
          disabled={
            create.isPending ||
            signingInvalid ||
            (encrypted && ids.length === 0)
          }
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

function SignatureFacts({
  signature,
  projectId,
  b,
  exportId,
}: {
  signature: SignatureView;
  projectId: string;
  b: string;
  exportId: string;
}) {
  if (signature.state === "unsigned")
    return <p data-testid="export-signature">Not signed.</p>;
  if (signature.state === "unrecognised")
    return (
      <div data-testid="export-signature">
        <p className="notice notice-warn">
          The signature record does not match the signature format; it is shown
          as stored.
        </p>
        <JsonExplorer value={signature.raw} label="signature" />
      </div>
    );
  const verify = VERIFY_ARCHIVE_COMMAND;
  return (
    <div data-testid="export-signature">
      <dl className="facts">
        <div className="fact">
          <dt>Algorithm</dt>
          <dd>{signature.algorithm}</dd>
        </div>
        <div className="fact">
          <dt>Public key id</dt>
          <dd>
            <code className="break" data-testid="signature-key-id">
              {signature.publicKeyId}
            </code>
          </dd>
        </div>
        <div className="fact">
          <dt>Signed archive SHA-256</dt>
          <dd>
            <code className="break" data-testid="signature-archive-sha256">
              {signature.archiveSha256}
            </code>
            <br />
            <span className="help-text">
              {signature.signsRecordedArchive === null
                ? "No archive digest is recorded to compare it with."
                : signature.signsRecordedArchive
                  ? "Matches the recorded archive digest."
                  : "Does not match the recorded archive digest."}
            </span>
          </dd>
        </div>
        <div className="fact">
          <dt>Signed at</dt>
          <dd data-testid="signature-signed-at">
            {formatTimestamp(signature.signedAt)}
          </dd>
        </div>
      </dl>
      <p>
        <a
          className="button"
          href={downloadExportSignatureUrl(projectId, b, exportId)}
          download={safeFileName(
            `recovery-${exportId}.sig.json`,
            "recovery-export.sig.json",
          )}
          data-testid="signature-download"
        >
          Download the signature
        </a>
      </p>
      <h4>Verify the download</h4>
      <p>
        The signature covers the archive file as distributed, encrypted or not.
        Check it with the signer&apos;s public key, which you hold; this service
        does not provide one.
      </p>
      <code className="code-line" data-testid="cmd-verify">
        {verify}
      </code>
      <CopyButton value={verify} label="Copy verify command" />
    </div>
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
  const signature = readSignature(data.signature, data.sha256);
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
          </dl>
          <h3>Signature</h3>
          <SignatureFacts
            signature={signature}
            projectId={project.id}
            b={b}
            exportId={data.id}
          />
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
