import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  VERIFICATION_SCOPES,
  type VerificationScope,
  type verificationSchema,
} from "@rea-web/contracts/browser";
import type { z } from "zod";
import { useRunners } from "../../api/hooks";
import {
  downloadReportUrl,
  useCreateVerification,
  useRestoreReport,
  useVerification,
} from "../../api/preserveHooks";
import { useProject } from "../../api/project";
import { Badge } from "../../components/Badge";
import { ErrorNotice } from "../../components/ErrorNotice";
import { CheckField } from "../../components/Fields";
import { JobPanel } from "../../components/JobPanel";
import { SelectField } from "../../components/SelectField";
import { formatTimestamp, safeFileName } from "../../lib/format";
import { stepSummaries } from "../../lib/reportView";
import {
  SCOPE_HELP,
  humanise,
  networkWording,
  verificationStatusWording,
} from "../../lib/recoveryWording";
import { Crumbs } from "./shared";

type Verification = z.output<typeof verificationSchema>;

export function VerifyNewPage() {
  const { b = "", c = "" } = useParams();
  const { project, canWrite } = useProject();
  const navigate = useNavigate();
  const runners = useRunners(project.id);
  const create = useCreateVerification(project.id, b, c);
  const [scopes, setScopes] =
    useState<readonly VerificationScope[]>(VERIFICATION_SCOPES);
  const [runnerId, setRunnerId] = useState("");
  const base = `/preserve/builds/${b}/captures/${c}`;
  if (!canWrite) return <p>Starting a verification needs the member role.</p>;
  return (
    <>
      <Crumbs
        items={[
          { to: "/preserve", label: "Preserve" },
          { to: `/preserve/builds/${b}`, label: "Build" },
          { to: base, label: "Capture" },
          { label: "Verify" },
        ]}
      />
      <h1>Verify a capture</h1>
      <p>
        A verification restores the stored package on a runner, in a disposable
        directory and database with production endpoints blocked, and records a
        result for each scope you choose.
      </p>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            {
              scope: VERIFICATION_SCOPES.filter((scope) =>
                scopes.includes(scope),
              ),
              ...(runnerId === "" ? {} : { runner_id: runnerId }),
            },
            {
              onSuccess: (verification) =>
                navigate(`${base}/verifications/${verification.id}`),
            },
          );
        }}
      >
        <fieldset>
          <legend>Scopes</legend>
          {VERIFICATION_SCOPES.map((scope) => (
            <CheckField
              key={scope}
              label={humanise(scope)}
              checked={scopes.includes(scope)}
              onValue={(checked) =>
                setScopes(
                  checked
                    ? [...scopes, scope]
                    : scopes.filter((entry) => entry !== scope),
                )
              }
              help={SCOPE_HELP[scope]}
            />
          ))}
        </fieldset>
        <div className="notice" role="note">
          <p>
            <strong>
              A scope that cannot run is reported blocked, which is a result and
              not an error.
            </strong>{" "}
            In particular, <code>data_restore</code> needs the runner to have a
            restore-only database server configured. Without it that scope is
            blocked, and so is any scope whose steps need a network the runner
            does not allow.
          </p>
        </div>
        <SelectField
          label="Runner (optional)"
          value={runnerId}
          onChange={(event) => setRunnerId(event.target.value)}
        >
          <option value="">The build's preferred runner, or any</option>
          {runners.data?.items
            .filter((runner) => runner.status !== "revoked")
            .map((runner) => (
              <option key={runner.id} value={runner.id}>
                {runner.name} ({runner.status})
              </option>
            ))}
        </SelectField>
        <button
          type="submit"
          disabled={create.isPending || scopes.length === 0}
        >
          Start verification
        </button>
        {scopes.length === 0 && (
          <p className="help-text">Choose at least one scope.</p>
        )}
        <ErrorNotice error={create.error} />
      </form>
    </>
  );
}

function ScopeRow({
  scope,
  result,
}: {
  scope: string;
  result: Verification["results"][number] | undefined;
}) {
  if (result === undefined)
    return (
      <tr data-testid={`scope-${scope}`}>
        <th scope="row">{humanise(scope)}</th>
        <td>
          <Badge value="no result yet" tone="neutral" />
        </td>
        <td colSpan={3} className="muted">
          No result has been reported for this scope.
        </td>
      </tr>
    );
  const wording = verificationStatusWording(result.status);
  return (
    <tr data-testid={`scope-${scope}`}>
      <th scope="row">{humanise(scope)}</th>
      <td data-testid={`scope-status-${scope}`}>
        <Badge value={result.status} tone={wording.tone} />
      </td>
      <td className="prewrap">
        {result.detail === "" ? (
          <span className="muted">no detail</span>
        ) : (
          result.detail
        )}
        <br />
        <span className="help-text">{wording.meaning}</span>
      </td>
      <td>{formatTimestamp(result.performed_at)}</td>
      <td>
        {result.evidence_object_key === null ? (
          <span className="muted">none stored</span>
        ) : (
          <span className="muted">
            stored (<code className="break">{result.evidence_object_key}</code>)
          </span>
        )}
      </td>
    </tr>
  );
}

function ReportSummary({
  projectId,
  b,
  c,
  verification,
}: {
  projectId: string;
  b: string;
  c: string;
  verification: Verification;
}) {
  const report = useRestoreReport(projectId, b, c, verification.id, true);
  const steps =
    report.data?.ok === true ? stepSummaries(report.data.report) : [];
  return (
    <section aria-labelledby="report-heading" data-testid="report-note">
      <h3 id="report-heading">Restore report</h3>
      <p>
        <a
          className="button"
          href={downloadReportUrl(projectId, b, c, verification.id)}
          download={safeFileName(
            `restore-report-${verification.id}.json`,
            "restore-report.json",
          )}
          data-testid="report-download"
        >
          Download the restore report
        </a>
      </p>
      <ErrorNotice error={report.error} />
      {report.isPending && <p role="status">Loading the report…</p>}
      {report.data?.ok === false && (
        <div className="notice notice-error" role="alert">
          <p>
            <strong>
              The stored report does not match the restore report format.
            </strong>{" "}
            No summary is shown; download it to read it as stored.
          </p>
          <ul>
            {report.data.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      {report.data?.ok === true &&
        (steps.length === 0 ? (
          <p className="muted" data-testid="report-steps-none">
            The report records no restore steps; only the integrity scope ran,
            or every scope was blocked before a step started.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table" data-testid="report-steps">
              <caption>Restore steps by scope</caption>
              <thead>
                <tr>
                  <th scope="col">Scope</th>
                  <th scope="col">Step</th>
                  <th scope="col">Status</th>
                  <th scope="col">Exit code</th>
                  <th scope="col">Network isolated</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((step) => (
                  <tr key={`${step.scope}:${step.stepId}`}>
                    <td>{humanise(step.scope)}</td>
                    <th scope="row">{step.stepId}</th>
                    <td>{step.status}</td>
                    <td>{step.exitCode === null ? "none" : step.exitCode}</td>
                    <td>{step.networkIsolated ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

function VerificationResult({
  verification,
  projectId,
  b,
  c,
}: {
  verification: Verification;
  projectId: string;
  b: string;
  c: string;
}) {
  const overall = verification.overall;
  const overallWording =
    overall === null ? null : verificationStatusWording(overall);
  const network = networkWording(
    verification.network_required?.verdict ?? null,
  );
  const hasEvidence = verification.results.some(
    (result) => result.evidence_object_key !== null,
  );
  return (
    <section aria-label="Verification result" data-testid="verification-result">
      <h2>Result</h2>
      <dl className="facts">
        <div className="fact">
          <dt>Status</dt>
          <dd data-testid="verification-status">
            <Badge value={verification.status} />
          </dd>
        </div>
        <div className="fact">
          <dt>Overall</dt>
          <dd data-testid="verification-overall">
            {overall === null || overallWording === null ? (
              <Badge
                value={
                  verification.status === "completed"
                    ? "not reported"
                    : "not reported yet"
                }
                tone="neutral"
              />
            ) : (
              <Badge value={overall} tone={overallWording.tone} />
            )}
            {overallWording !== null && (
              <>
                <br />
                <span className="help-text">{overallWording.meaning}</span>
              </>
            )}
          </dd>
        </div>
        <div className="fact">
          <dt>Network required</dt>
          <dd data-testid="verification-network">
            <Badge value={network.label} tone={network.tone} />
            <br />
            <span className="help-text">{network.meaning}</span>
            {verification.network_required !== null &&
              verification.network_required.reasons.length > 0 && (
                <ul className="plain">
                  {verification.network_required.reasons.map(
                    (reason, index) => (
                      <li key={`${index}:${reason}`}>{reason}</li>
                    ),
                  )}
                </ul>
              )}
          </dd>
        </div>
      </dl>
      <div className="table-wrap">
        <table className="table">
          <caption>Per scope</caption>
          <thead>
            <tr>
              <th scope="col">Scope</th>
              <th scope="col">Status</th>
              <th scope="col">Detail</th>
              <th scope="col">Performed</th>
              <th scope="col">Restore report</th>
            </tr>
          </thead>
          <tbody>
            {verification.scope.map((scope) => (
              <ScopeRow
                key={scope}
                scope={scope}
                result={verification.results.find(
                  (entry) => entry.scope === scope,
                )}
              />
            ))}
          </tbody>
        </table>
      </div>
      {hasEvidence ? (
        <ReportSummary
          projectId={projectId}
          b={b}
          c={c}
          verification={verification}
        />
      ) : (
        <p className="help-text" data-testid="report-note">
          {verification.status === "pending" ||
          verification.status === "running"
            ? "The restore report is stored when the verification job finishes."
            : "No restore report is stored for this verification."}
        </p>
      )}
    </section>
  );
}

export function VerificationPage() {
  const { b = "", c = "", v = "" } = useParams();
  const { project } = useProject();
  const verification = useVerification(project.id, b, c, v);
  return (
    <>
      <Crumbs
        items={[
          { to: "/preserve", label: "Preserve" },
          { to: `/preserve/builds/${b}`, label: "Build" },
          { to: `/preserve/builds/${b}/captures/${c}`, label: "Capture" },
          { label: "Verification" },
        ]}
      />
      <h1>Verification</h1>
      {verification.isPending && <p role="status">Loading verification…</p>}
      <ErrorNotice error={verification.error} />
      {verification.data !== undefined && (
        <>
          <VerificationResult
            verification={verification.data}
            projectId={project.id}
            b={b}
            c={c}
          />
          <JobPanel
            projectId={project.id}
            jobId={verification.data.job_id}
            title="Verification job"
          />
        </>
      )}
    </>
  );
}
