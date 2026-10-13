/**
 * Investigate workflow end to end through public interfaces only: the built
 * API and runner processes, real PostgreSQL, a filesystem object store and the
 * built upstream REA MCP server. No component is simulated. The model provider
 * is disabled (no approved budget), so the model follow-up loop is recorded as
 * unavailable rather than exercised.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findingSchema,
  investigationSchema,
  toolCallSummarySchema,
} from "@rea-web/contracts";
import { REA_WEB_ROOT, Stack, stackUnavailableReason } from "./stack.js";

const unavailable = stackUnavailableReason();
if (unavailable) console.warn(`e2e skipped: ${unavailable}`);
const describeStack = unavailable ? describe.skip : describe;

const FIXTURE = join(REA_WEB_ROOT, "fixtures/investigation/js-cli-app");

describeStack("investigate workflow through the built API and runner", () => {
  const stack = new Stack();
  let scratch = "";
  let zip: Buffer;
  let project = "";
  let target = "";
  let firstInvestigation = "";

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "rea-web-e2e-fixture-"));
    const zipPath = join(scratch, "notes-cli.zip");
    execFileSync("python3", ["-I", "-m", "zipfile", "-c", zipPath, FIXTURE]);
    zip = await readFile(zipPath);
    await stack.start();
  });

  afterAll(async () => {
    await stack.stop();
    await rm(scratch, { recursive: true, force: true });
  });

  it("registers the owner, connects a runner and analyses an uploaded target", async () => {
    const registered = await stack.request("POST", "/auth/register", {
      body: { email: "owner@example.test", password: "correct horse battery" },
    });
    expect(registered.status).toBe(201);
    project = registered.json.memberships[0].project_id;

    const runner = await stack.request("POST", `/projects/${project}/runners`, {
      body: { name: "e2e-linux", labels: ["e2e"] },
    });
    expect(runner.status).toBe(201);
    stack.startRunner(runner.json.token);
    await stack.waitFor(async () => {
      const list = await stack.request("GET", `/projects/${project}/runners`);
      return list.json.items?.[0]?.status === "online";
    }, 120_000);
    // The capability panel shows the runner's own live report.
    const capabilities = await stack.request(
      "GET",
      `/projects/${project}/runners/${runner.json.id}/capabilities`,
    );
    expect(capabilities.status).toBe(200);
    expect(JSON.stringify(capabilities.json)).toContain(
      "analyze_javascript_application",
    );

    const upload = await stack.request(
      "POST",
      `/projects/${project}/targets/uploads`,
      { raw: zip, headers: { "x-target-name": "notes-cli.zip" } },
    );
    expect(upload.status).toBe(201);
    expect(upload.json.sha256).toBe(
      createHash("sha256").update(zip).digest("hex"),
    );
    target = upload.json.id as string;
    const routing = await stack.request(
      "GET",
      `/projects/${project}/targets/${target}/routing`,
    );
    expect(routing.status).toBe(200);

    const created = await stack.request(
      "POST",
      `/projects/${project}/investigations`,
      {
        body: {
          target_id: target,
          question: "What does this CLI do and where does it store notes?",
          policy: { model_follow_up: true },
        },
        headers: { "idempotency-key": "e2e-investigation-1" },
      },
    );
    expect(created.status).toBe(201);
    const investigation = created.json.id as string;
    firstInvestigation = investigation;

    let view: any = null;
    await stack.waitFor(async () => {
      view = (
        await stack.request(
          "GET",
          `/projects/${project}/investigations/${investigation}`,
        )
      ).json;
      return ["completed", "failed", "cancelled"].includes(view?.status);
    }, 300_000);
    expect(investigationSchema.parse(view).status).toBe("completed");

    // Tool calls: real upstream results, contiguous server-allocated seqs,
    // raw results retrievable and matching their recorded digest.
    const calls = await stack.request(
      "GET",
      `/projects/${project}/investigations/${investigation}/tool-calls?limit=200`,
    );
    const items = calls.json.items.map((c: unknown) =>
      toolCallSummarySchema.parse(c),
    );
    expect(items.map((c: { seq: number }) => c.seq)).toEqual(
      items.map((_: unknown, i: number) => i + 1),
    );
    expect(items.map((c: { tool_name: string }) => c.tool_name)).toEqual(
      expect.arrayContaining([
        "binary_session",
        "open_binary",
        "extract_artifact",
        "analyze_javascript_application",
        "export_evidence_bundle",
      ]),
    );
    const analysis = items.find(
      (c: { tool_name: string }) =>
        c.tool_name === "analyze_javascript_application",
    );
    const raw = await stack.request(
      "GET",
      `/projects/${project}/investigations/${investigation}/tool-calls/${analysis.id}/raw`,
    );
    expect(raw.status).toBe(200);
    expect(createHash("sha256").update(raw.text).digest("hex")).toBe(
      analysis.raw_result_sha256,
    );
    expect(analysis.evidence_id).toMatch(/^ev_[0-9a-f]{64}$/u);

    // Findings cite tool calls that exist on the timeline.
    const findings = (
      await stack.request(
        "GET",
        `/projects/${project}/investigations/${investigation}/findings`,
      )
    ).json.items.map((f: unknown) => findingSchema.parse(f));
    const classes = new Set(findings.map((f: { class: string }) => f.class));
    expect(classes.has("fact")).toBe(true);
    const seqs = new Set(items.map((c: { seq: number }) => c.seq));
    for (const finding of findings)
      for (const seq of finding.tool_call_seqs)
        expect(seqs.has(seq)).toBe(true);
    // No model budget is configured: the follow-up loop says so explicitly.
    expect(JSON.stringify(findings)).toMatch(/model/iu);

    // The exported evidence bundle is stored and downloadable.
    const evidence = await stack.request(
      "GET",
      `/projects/${project}/investigations/${investigation}/evidence`,
    );
    const bundle = evidence.json.items.find(
      (a: { kind: string }) => a.kind === "bundle",
    );
    expect(bundle).toBeDefined();
    const bundleBody = await stack.request(
      "GET",
      `/projects/${project}/investigations/${investigation}/evidence/${bundle.id}`,
    );
    expect(createHash("sha256").update(bundleBody.text).digest("hex")).toBe(
      bundle.sha256,
    );
    expect(
      (bundleBody.json.records as { evidence_id: string }[]).map(
        (r) => r.evidence_id,
      ),
    ).toContain(analysis.evidence_id);

    // Job events are durable and replayable in order.
    const events = await stack.request(
      "GET",
      `/projects/${project}/jobs/${view.job_id}/events?after=0`,
    );
    const kinds = events.json.items.map((e: { kind: string }) => e.kind);
    expect(kinds[0]).toBe("job.created");
    expect(kinds).toContain("job.tool_call");
    expect(kinds.at(-1)).toMatch(/^job\.(succeeded|completed|cleanup)/u);

    // An operator follow-up runs in the investigation's own live session
    // against retained evidence, and lands on the same timeline.
    const follow = await stack.request(
      "POST",
      `/projects/${project}/investigations/${investigation}/follow-ups`,
      {
        body: {
          tool: "inspect_analysis_view",
          arguments: {
            source: {
              kind: "retained-evidence",
              evidence_id: analysis.evidence_id,
            },
            view: { kind: "summary" },
          },
        },
      },
    );
    expect(follow.status).toBe(202);
    let followJob: any = null;
    await stack.waitFor(async () => {
      followJob = (
        await stack.request(
          "GET",
          `/projects/${project}/jobs/${follow.json.id}`,
        )
      ).json;
      return ["succeeded", "failed", "cancelled"].includes(followJob?.state);
    }, 180_000);
    expect(followJob.state).toBe("succeeded");
    expect(followJob.result.outcome).toBe("ran");
    const after = await stack.request(
      "GET",
      `/projects/${project}/investigations/${investigation}/tool-calls?limit=200`,
    );
    const followCall = after.json.items.find(
      (c: { seq: number }) => c.seq === followJob.result.seq,
    );
    expect(followCall?.tool_name).toBe("inspect_analysis_view");
    expect(followCall.seq).toBeGreaterThan(items.length);

    // Secrets configured for either process never reach their logs.
    expect(stack.logs).not.toContain(stack.sessionSecret);
    expect(stack.logs).not.toContain(stack.runnerToken);
  });
  const waitForJob = async (jobId: string): Promise<any> => {
    let job: any = null;
    await stack.waitFor(async () => {
      job = (await stack.request("GET", `/projects/${project}/jobs/${jobId}`))
        .json;
      return ["succeeded", "failed", "cancelled"].includes(job?.state);
    }, 300_000);
    return job;
  };

  const runInvestigation = async (): Promise<string> => {
    const created = await stack.request(
      "POST",
      `/projects/${project}/investigations`,
      {
        body: {
          target_id: target,
          question: "Second look at the same build for comparison",
          policy: { model_follow_up: false },
        },
      },
    );
    expect(created.status).toBe(201);
    await stack.waitFor(async () => {
      const view = await stack.request(
        "GET",
        `/projects/${project}/investigations/${created.json.id}`,
      );
      return view.json.status === "completed";
    }, 300_000);
    return created.json.id as string;
  };

  const evidenceOf = async (investigation: string, tool: string) => {
    const calls = await stack.request(
      "GET",
      `/projects/${project}/investigations/${investigation}/tool-calls?limit=200`,
    );
    const call = calls.json.items.find(
      (c: { tool_name: string; evidence_id: string | null }) =>
        c.tool_name === tool && c.evidence_id,
    );
    expect(call, `${tool} evidence in ${investigation}`).toBeDefined();
    return call.evidence_id as string;
  };

  it("compares stored evidence across two investigations in a fresh session", async () => {
    expect(firstInvestigation).not.toBe("");
    const second = await runInvestigation();
    const left = await evidenceOf(firstInvestigation, "inspect_artifact");
    const right = await evidenceOf(second, "inspect_artifact");

    const compared = await stack.request(
      "POST",
      `/projects/${project}/comparisons`,
      {
        body: {
          tool: "compare_artifacts",
          left: {
            kind: "retained-evidence",
            evidence_id: left,
            investigation_id: firstInvestigation,
          },
          right: {
            kind: "retained-evidence",
            evidence_id: right,
            investigation_id: second,
          },
        },
      },
    );
    expect(compared.status).toBe(202);
    const job = await waitForJob(compared.json.id);
    expect(job.state, JSON.stringify(job.failure)).toBe("succeeded");
    expect(job.result).toMatchObject({
      tool: "compare_artifacts",
      outcome: "ran",
      anchor_investigation_id: firstInvestigation,
      left: { evidence_id: left, investigation_id: firstInvestigation },
      right: { evidence_id: right, investigation_id: second },
    });
    // The comparison is on the anchor's timeline with the next seq, and its
    // finding cites it.
    const calls = await stack.request(
      "GET",
      `/projects/${project}/investigations/${firstInvestigation}/tool-calls?limit=200`,
    );
    const call = calls.json.items.find(
      (c: { seq: number }) => c.seq === job.result.seq,
    );
    expect(call.tool_name).toBe("compare_artifacts");
    const findings = await stack.request(
      "GET",
      `/projects/${project}/investigations/${firstInvestigation}/findings`,
    );
    expect(
      findings.json.items.some((f: { tool_call_seqs: number[] }) =>
        f.tool_call_seqs.includes(job.result.seq),
      ),
    ).toBe(true);

    // Bundle-level comparison of the two investigations' stored bundles.
    const bundleOf = async (investigation: string) => {
      const evidence = await stack.request(
        "GET",
        `/projects/${project}/investigations/${investigation}/evidence`,
      );
      return evidence.json.items.find(
        (a: { kind: string; name: string }) =>
          a.kind === "bundle" && a.name.startsWith("evidence-bundle-"),
      ).id as string;
    };
    const bundles = await stack.request(
      "POST",
      `/projects/${project}/comparisons`,
      {
        body: {
          tool: "compare_bundles",
          left: {
            kind: "artifact",
            artifact_id: await bundleOf(firstInvestigation),
          },
          right: { kind: "artifact", artifact_id: await bundleOf(second) },
        },
      },
    );
    const bundleJob = await waitForJob(bundles.json.id);
    expect(bundleJob.state, JSON.stringify(bundleJob.failure)).toBe(
      "succeeded",
    );
    expect(bundleJob.result.outcome).toBe("ran");
    expect(bundleJob.result.is_error).toBe(false);

    // A record-level tool over multi-record bundles is refused before
    // dispatch with the reason, not guessed.
    const refused = await stack.request(
      "POST",
      `/projects/${project}/comparisons`,
      {
        body: {
          tool: "compare_artifacts",
          left: {
            kind: "artifact",
            artifact_id: await bundleOf(firstInvestigation),
          },
          right: { kind: "artifact", artifact_id: await bundleOf(second) },
        },
      },
    );
    const refusedJob = await waitForJob(refused.json.id);
    expect(refusedJob.result.outcome).toBe("invalid_arguments");
    expect(String(refusedJob.result.reasons)).toContain("compare_bundles");
  });

  it("exports the investigation as a zip whose index digests every member", async () => {
    const created = await stack.request(
      "POST",
      `/projects/${project}/investigations/${firstInvestigation}/exports`,
    );
    expect(created.status).toBe(202);
    const job = await waitForJob(created.json.id);
    expect(job.state, JSON.stringify(job.failure)).toBe("succeeded");
    const download = await fetch(
      `${stack.apiUrl}/api/v1/projects/${project}/investigations/${firstInvestigation}/evidence/${job.result.export_artifact_id}`,
      { headers: { cookie: stack.cookie } },
    );
    expect(download.status).toBe(200);
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      job.result.sha256,
    );
    const zipPath = join(scratch, "export.zip");
    await writeFile(zipPath, bytes);
    // Independent reader: Python's zipfile verifies every CRC and lists names.
    const listing = execFileSync(
      "python3",
      [
        "-I",
        "-c",
        [
          "import hashlib, json, sys, zipfile",
          "z = zipfile.ZipFile(sys.argv[1])",
          "assert z.testzip() is None",
          "index = json.loads(z.read('index.json'))",
          "out = {'names': z.namelist(), 'index': index,",
          "       'digests': {n: hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}}",
          "print(json.dumps(out))",
        ].join("\n"),
        zipPath,
      ],
      { encoding: "utf8" },
    );
    const { names, index, digests } = JSON.parse(listing);
    expect(index.format).toBe("rea-web.investigation-export");
    expect(index.investigation_id).toBe(firstInvestigation);
    for (const member of index.members)
      expect(digests[member.path], member.path).toBe(member.sha256);
    expect(new Set(names)).toEqual(
      new Set([
        ...index.members.map((m: { path: string }) => m.path),
        "index.json",
      ]),
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "README.md",
        "investigation.json",
        "findings.json",
        "obligations.json",
        "tool-calls.json",
      ]),
    );
    const calls = await stack.request(
      "GET",
      `/projects/${project}/investigations/${firstInvestigation}/tool-calls?limit=200`,
    );
    const raw = names.filter((n: string) => n.startsWith("raw/"));
    // Every tool call recorded before the export has its raw result inside.
    expect(raw.length).toBe(calls.json.items.length);
    for (const call of calls.json.items) {
      const member = index.members.find(
        (m: { source: { kind: string; seq?: number } }) =>
          m.source.kind === "raw_result" && m.source.seq === call.seq,
      );
      expect(member.source.stored_sha256).toBe(call.raw_result_sha256);
      if (!member.redacted) expect(member.sha256).toBe(call.raw_result_sha256);
    }
    expect(names.some((n: string) => n.startsWith("evidence/"))).toBe(true);
  });
});
