import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { InvestigationIndex } from "@rea-web/contracts";
import type { JobContext } from "../jobContext.js";
import { ZipWriter } from "../zip.js";
import { downloadVerified, loadInvestigationIndex } from "./evidenceSources.js";

/**
 * investigation.export: a downloadable zip of everything the investigation
 * stored — record, findings (with obligations as proposals), tool-call
 * summaries, every raw upstream result and every evidence artifact — with an
 * index listing each member's SHA-256. Stored objects are digest-checked on
 * download. Raw results and bundles are copied verbatim unless the runner's
 * redactor finds a configured secret value in them; such members are marked
 * `redacted: true` and keep the stored digest alongside the exported one.
 */
export const EXPORT_FORMAT = "rea-web.investigation-export";
export const EXPORT_FORMAT_VERSION = 1;

interface Member {
  path: string;
  sha256: string;
  size: number;
  source:
    | { kind: "generated" }
    | { kind: "raw_result"; seq: number; tool: string; stored_sha256: string }
    | {
        kind: "evidence_artifact";
        artifact_id: string;
        artifact_kind: string;
        stored_sha256: string;
      };
  redacted: boolean;
}

const sha256 = (data: Buffer): string =>
  createHash("sha256").update(data).digest("hex");

const safeSegment = (value: string): string =>
  value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120) || "item";

const json = (value: unknown): Buffer =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

const readme = (index: InvestigationIndex, generatedAt: string): string =>
  `# Investigation export

Investigation: ${index.investigation.id}
Question: ${index.investigation.question}
Status at export: ${index.investigation.status}
Generated: ${generatedAt}

| Path | Contents |
| --- | --- |
| \`index.json\` | Every member with its SHA-256 and size, and where it came from |
| \`investigation.json\` | The investigation record, routing and upstream identity |
| \`findings.json\` | Facts, inferences, proposals and unknowns, each citing tool-call seqs and evidence ids |
| \`obligations.json\` | Proposals derived from reconstruction obligation ledgers |
| \`tool-calls.json\` | Every upstream tool call: arguments, derived summary, effects, raw digest |
| \`raw/\` | The complete raw upstream result of each tool call (\`<seq>-<tool>.json\`) |
| \`evidence/\` | Exported upstream evidence bundles and other evidence artifacts |

Finding classes follow upstream Evidence: observed and derived Evidence are
facts, inferred Evidence is an inference, obligations are proposals, and
errors, unavailable capabilities and policy refusals are unknowns. Summaries
never replace raw results; consult \`raw/\` and \`evidence/\` for the record.
Evidence bundles can be inspected or re-imported with upstream REA
(\`import_evidence_bundle\`).
`;

export const runExport = async (
  ctx: JobContext,
  rawInput: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const investigationId = String(rawInput["investigation_id"] ?? "");
  const index = await loadInvestigationIndex(ctx, investigationId);
  const generatedAt = new Date().toISOString();
  const zipPath = join(ctx.workspace, `export-${ctx.job.id}.zip`);
  await rm(zipPath, { force: true });
  const zip = await ZipWriter.create(zipPath, new Date(generatedAt));
  const members: Member[] = [];
  const add = async (
    path: string,
    data: Buffer,
    source: Member["source"],
    redacted = false,
  ) => {
    await zip.add(path, data);
    members.push({
      path,
      sha256: sha256(data),
      size: data.length,
      source,
      redacted,
    });
  };
  /** Copy stored bytes, redacting configured secret values if present. */
  const copyStored = async (
    path: string,
    stored: Buffer,
    source: Exclude<Member["source"], { kind: "generated" }>,
  ) => {
    const text = stored.toString("utf8");
    const redactedText = ctx.redactor.redactText(text);
    const changed = redactedText !== text;
    await add(
      path,
      changed ? Buffer.from(redactedText, "utf8") : stored,
      source,
      changed,
    );
  };

  try {
    const generated = { kind: "generated" } as const;
    const redact = <T>(v: T): T => ctx.redactor.redactValue(v) as T;
    await add(
      "README.md",
      Buffer.from(readme(index, generatedAt), "utf8"),
      generated,
    );
    await add(
      "investigation.json",
      json(redact(index.investigation)),
      generated,
    );
    await add("findings.json", json(redact(index.findings)), generated);
    await add(
      "obligations.json",
      json(redact(index.findings.filter((f) => f.class === "proposal"))),
      generated,
    );
    await add("tool-calls.json", json(redact(index.tool_calls)), generated);

    let bytes = 0;
    const missingRaw: number[] = [];
    for (const call of index.tool_calls) {
      if (!call.has_raw) {
        missingRaw.push(call.seq);
        continue;
      }
      const name = `raw-${investigationId}-${call.seq}`;
      const path = await downloadVerified(ctx, name, `${name}.json`, {
        sha256: call.raw_result_sha256,
        size: call.raw_result_bytes,
      });
      const data = await readFile(path);
      await rm(path, { force: true });
      bytes += data.length;
      await copyStored(
        `raw/${call.seq}-${safeSegment(call.tool_name)}.json`,
        data,
        {
          kind: "raw_result",
          seq: call.seq,
          tool: call.tool_name,
          stored_sha256: call.raw_result_sha256,
        },
      );
    }
    for (const artifact of index.artifacts) {
      if (artifact.kind === "export" || artifact.kind === "raw_result")
        continue;
      const path = await downloadVerified(
        ctx,
        `artifact-${artifact.id}`,
        `artifact-${artifact.id}`,
        artifact,
      );
      const data = await readFile(path);
      await rm(path, { force: true });
      bytes += data.length;
      await copyStored(
        `evidence/${artifact.id}-${safeSegment(artifact.name)}`,
        data,
        {
          kind: "evidence_artifact",
          artifact_id: artifact.id,
          artifact_kind: artifact.kind,
          stored_sha256: artifact.sha256,
        },
      );
    }
    await add(
      "index.json",
      json({
        format: EXPORT_FORMAT,
        format_version: EXPORT_FORMAT_VERSION,
        investigation_id: investigationId,
        generated_at: generatedAt,
        export_job_id: ctx.job.id,
        upstream_identity: index.investigation.upstream_identity,
        // index.json cannot list its own digest; every other member is here.
        members,
        omissions: missingRaw.map((seq) => ({
          what: `raw result of tool call ${seq}`,
          reason: "not present in object storage",
        })),
      }),
      generated,
    );
    const size = await zip.finish();
    ctx.usage.addArtifactBytes(size);
    const uploaded = await ctx.client.uploadArtifact(
      ctx.job.id,
      ctx.fencingToken,
      {
        kind: "export",
        name: `investigation-${investigationId}-export.zip`,
        investigationId,
      },
      { path: zipPath },
    );
    return {
      investigation_id: investigationId,
      export_artifact_id: uploaded.artifact_id,
      object_key: uploaded.object_key,
      sha256: uploaded.sha256,
      size: uploaded.size,
      members: members.length + 1,
      source_bytes: bytes,
      redacted_members: members.filter((m) => m.redacted).map((m) => m.path),
      omissions: missingRaw.length,
    };
  } catch (error) {
    await zip.abort();
    throw error;
  } finally {
    await rm(zipPath, { force: true });
  }
};
