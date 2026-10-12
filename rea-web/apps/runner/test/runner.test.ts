import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { routeFor } from "@rea-web/contracts";
import { processAlive } from "@rea-web/rea-adapter";
import {
  createDisabledProvider,
  createScriptedProvider,
} from "@rea-web/model-connector";
import { parseRunnerConfig } from "../src/config.js";
import { Runner } from "../src/runner.js";
import { evaluatePolicy } from "../src/investigation/policy.js";
import { FakeControlPlane, type FakeJob } from "./fakeControlPlane.js";

const REA_ROOT = resolve(import.meta.dirname, "../../../..");
const FIXTURE_DIR = resolve(
  import.meta.dirname,
  "../../../fixtures/investigation/js-cli-app",
);
const built = existsSync(join(REA_ROOT, "dist", "mcp", "main.js"));
const describeIfBuilt = built ? describe : describe.skip;

let scratch: string;
let fixtureZip: string;
let control: FakeControlPlane;
let runner: Runner | null = null;
let runLoop: Promise<void> | null = null;

const startRunner = async (
  provider = createDisabledProvider("not configured in tests"),
) => {
  const config = parseRunnerConfig({
    REA_WEB_API_URL: control.url,
    REA_WEB_RUNNER_TOKEN: control.token,
    REA_WEB_RUNNER_NAME: "test-runner",
    REA_WEB_RUNNER_WORKSPACE_ROOT: join(scratch, "ws"),
    REA_WEB_REA_ROOT: REA_ROOT,
    REA_WEB_RUNNER_MAX_JOBS: "2",
    REA_WEB_RUNNER_SESSION_IDLE_MS: "60000",
  });
  runner = new Runner({
    config,
    env: {
      PATH: process.env["PATH"],
      REA_WEB_SESSION_SECRET: "fixture-session-secret-value-123",
    },
    provider,
    log: () => undefined,
  });
  await runner.register();
  runLoop = runner.run();
  return runner;
};

const investigation = (
  cls: string,
  name: string,
  extra: Record<string, unknown> = {},
) => ({
  investigation_id: `inv-${Math.random().toString(16).slice(2)}`,
  target: {
    kind: "upload",
    class: cls,
    name,
    sha256: null,
    size: null,
    url: null,
  },
  question: "What does this application do and where does it store data?",
  policy: { model_follow_up: false, ...extra },
  route: routeFor(cls as never),
});

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "rea-web-runner-"));
  fixtureZip = join(scratch, "notes-cli.zip");
  execFileSync("python3", [
    "-I",
    "-m",
    "zipfile",
    "-c",
    fixtureZip,
    FIXTURE_DIR,
  ]);
});

afterEach(async () => {
  if (runner) await runner.stop({ abortJobs: true });
  await runLoop;
  runner = null;
  runLoop = null;
  await control?.stop();
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("evaluatePolicy", () => {
  const policy = {
    mode: "static_only" as const,
    allowed_effects: [
      "launchesProcess",
      "writesFilesystem",
      "mutatesSession",
      "idempotent",
    ] as never,
    approval_required_effects: [
      "executesForeignCode",
      "mutatesDevice",
      "mayDiscardData",
      "accessesNetwork",
    ] as never,
  };
  it("allows read-only analysis and requires approval for network effects", () => {
    expect(
      evaluatePolicy(policy, ["mutatesSession", "idempotent"], "deterministic")
        .kind,
    ).toBe("allow");
    expect(
      evaluatePolicy(policy, ["accessesNetwork", "mutatesSession"], "model")
        .kind,
    ).toBe("approval");
    expect(evaluatePolicy(policy, ["accessesNetwork"], "operator").kind).toBe(
      "allow",
    );
  });
  it("forbids foreign-code execution in static_only even for operators", () => {
    expect(
      evaluatePolicy(policy, ["executesForeignCode"], "operator").kind,
    ).toBe("reject");
    expect(
      evaluatePolicy(
        { ...policy, mode: "static_plus_runtime" },
        ["executesForeignCode"],
        "model",
      ).kind,
    ).toBe("approval");
  });
  it("rejects effects outside both lists", () => {
    expect(
      evaluatePolicy(policy, ["mutatesTarget"], "deterministic").kind,
    ).toBe("reject");
  });
});

describeIfBuilt("Runner against the real upstream REA server", () => {
  beforeAll(() => undefined);

  it("registers with the live catalog, analyzes a zipped JS app end to end, exports evidence and keeps the session for follow-ups", async () => {
    control = new FakeControlPlane();
    await control.start();
    await startRunner();
    expect(control.report?.tools_list.length).toBeGreaterThan(100);
    expect(control.report?.rea?.catalog.counts["mcp_tools"]).toBe(
      control.report?.tools_list.length,
    );
    expect(control.report?.env_capability_names).toEqual([]);
    const job = control.enqueue(
      "investigation.run",
      investigation("zip_archive", "notes-cli.zip"),
      { targetPath: fixtureZip },
    );
    await control.waitFor(() => job.completion !== null);
    expect(job.completion?.["outcome"]).toBe("succeeded");
    expect(job.transitions[0]).toBe("running");
    const tools = job.toolCalls.map((c) => c["tool_name"]);
    expect(tools).toEqual(
      expect.arrayContaining([
        "binary_session",
        "open_binary",
        "inspect_artifact",
        "extract_artifact",
        "analyze_javascript_application",
        "export_evidence_bundle",
        "build_reconstruction_obligation_ledger",
      ]),
    );
    // every tool call has a raw upload with matching size
    for (const call of job.toolCalls) {
      const art = job.artifacts.find(
        (a) => a.key === call["raw_result_object_key"],
      );
      expect(art?.bytes.length).toBe(call["raw_result_bytes"]);
    }
    expect(
      job.artifacts.some((a) => a.kind === "bundle" && a.bytes.length > 100),
    ).toBe(true);
    expect(job.artifacts.some((a) => a.kind === "findings")).toBe(true);
    const classes = new Set(job.findings.map((f) => f["class"]));
    expect(classes.has("fact")).toBe(true);
    expect(classes.has("proposal")).toBe(true); // reconstruction obligation ledger
    const analysisFinding = job.findings.find((f) =>
      String(f["title"]).startsWith("analyze_javascript_application"),
    );
    expect((analysisFinding?.["evidence_ids"] as string[]).length).toBe(1);
    // nothing in what left the runner contains the fixture secret value
    const leaving = JSON.stringify([
      job.events,
      job.toolCalls,
      job.findings,
      job.completion,
    ]);
    expect(leaving).not.toContain("fixture-session-secret-value-123");

    // follow-up runs in the same session against retained evidence
    const evidenceId = (analysisFinding?.["evidence_ids"] as string[])[0];
    const follow = control.enqueue("investigation.follow_up", {
      investigation_id: job.job.input["investigation_id"],
      tool: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: evidenceId },
        view: { kind: "summary" },
      },
    });
    await control.waitFor(() => follow.completion !== null);
    expect(follow.completion?.["outcome"]).toBe("succeeded");
    expect(
      (follow.completion?.["result"] as Record<string, unknown>)["outcome"],
    ).toBe("ran");
    expect(
      (follow.completion?.["result"] as Record<string, unknown>)["session_id"],
    ).toBe(
      (job.completion?.["result"] as Record<string, unknown>)["session_id"],
    );

    // a follow-up for an investigation without a live session fails explicitly
    const orphan = control.enqueue("investigation.follow_up", {
      investigation_id: "inv-none",
      tool: "binary_session",
      arguments: {},
    });
    await control.waitFor(() => orphan.completion !== null);
    expect(orphan.completion?.["outcome"]).toBe("failed");
    expect(
      (orphan.completion?.["failure"] as Record<string, unknown>)["code"],
    ).toBe("capability_unavailable");
  }, 300_000);

  it("isolates concurrent investigations: another investigation's evidence is refused", async () => {
    control = new FakeControlPlane();
    await control.start();
    await startRunner();
    const a = control.enqueue(
      "investigation.run",
      investigation("zip_archive", "a.zip"),
      { targetPath: fixtureZip },
    );
    const b = control.enqueue(
      "investigation.run",
      investigation("zip_archive", "b.zip"),
      { targetPath: fixtureZip },
    );
    await control.waitFor(() => a.completion !== null && b.completion !== null);
    expect(a.completion?.["outcome"]).toBe("succeeded");
    expect(b.completion?.["outcome"]).toBe("succeeded");
    const aEvidence = a.toolCalls.find(
      (c) => c["tool_name"] === "analyze_javascript_application",
    )?.["evidence_id"] as string;
    const cross = control.enqueue("investigation.follow_up", {
      investigation_id: b.job.input["investigation_id"],
      tool: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: aEvidence },
        view: { kind: "summary" },
      },
    });
    await control.waitFor(() => cross.completion !== null);
    expect(
      (cross.completion?.["result"] as Record<string, unknown>)["outcome"],
    ).toBe("invalid_arguments");
    expect(JSON.stringify(cross.findings)).toContain("belongs to session");
  }, 300_000);

  it("reports unavailable capabilities with upstream remediation instead of switching providers", async () => {
    control = new FakeControlPlane();
    await control.start();
    await startRunner();
    const wasm = join(scratch, "m.wasm");
    await writeFile(wasm, Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    const job = control.enqueue(
      "investigation.run",
      investigation("wasm", "m.wasm"),
      { targetPath: wasm },
    );
    await control.waitFor(() => job.completion !== null);
    expect(job.completion?.["outcome"]).toBe("succeeded");
    const unavailable = job.findings.find((f) =>
      String(f["title"]).startsWith("inspect_wasm_artifact unavailable"),
    );
    expect(String(unavailable?.["body"])).toContain("REA_WABT_BIN_DIRECTORY");
    expect(job.toolCalls.map((c) => c["tool_name"])).not.toContain(
      "inspect_wasm_artifact",
    );
  }, 180_000);

  it("cancels on request, terminates the owned REA process group and reports cleanup", async () => {
    control = new FakeControlPlane();
    await control.start();
    const r = await startRunner();
    const job = control.enqueue(
      "investigation.run",
      investigation("zip_archive", "c.zip"),
      { targetPath: fixtureZip },
    );
    await control.waitFor(() => job.toolCalls.length >= 1);
    const session = r.sessions.forInvestigation(
      String(job.job.input["investigation_id"]),
    );
    const pid = session?.pid as number;
    expect(processAlive(pid)).toBe(true);
    job.cancelRequested = true;
    await control.waitFor(() => job.completion !== null);
    expect(job.completion?.["outcome"]).toBe("cancelled");
    expect(
      (job.completion?.["cleanup"] as Record<string, unknown>)["status"],
    ).toBe("cleanup_complete");
    expect(processAlive(pid)).toBe(false);
    expect(job.events.some((e) => e.kind === "job.cleanup")).toBe(true);
  }, 180_000);

  it("abandons a job whose lease is lost without completing it, and kills its process", async () => {
    control = new FakeControlPlane();
    await control.start();
    const r = await startRunner();
    const job: FakeJob = control.enqueue(
      "investigation.run",
      investigation("zip_archive", "d.zip"),
      { targetPath: fixtureZip },
    );
    await control.waitFor(() => job.toolCalls.length >= 1);
    const pid = r.sessions.forInvestigation(
      String(job.job.input["investigation_id"]),
    )?.pid as number;
    job.rejectLease = true;
    await control.waitFor(() => !processAlive(pid), 60_000);
    await new Promise((res) => setTimeout(res, 500));
    expect(job.completion).toBeNull();
  }, 180_000);

  it("stops at the tool-call budget with a partial result, and fails hard on a measured budget (wall time)", async () => {
    control = new FakeControlPlane();
    await control.start();
    await startRunner();
    const counted = control.enqueue(
      "investigation.run",
      investigation("zip_archive", "e.zip"),
      {
        targetPath: fixtureZip,
        budget: { tool_calls: 2 },
      },
    );
    await control.waitFor(() => counted.completion !== null);
    expect(counted.completion?.["outcome"]).toBe("succeeded");
    expect(
      (counted.completion?.["result"] as Record<string, unknown>)["partial"],
    ).toBe(true);
    expect(
      counted.toolCalls.filter(
        (c) => c["tool_name"] !== "export_evidence_bundle",
      ).length,
    ).toBeLessThanOrEqual(2);
    expect(JSON.stringify(counted.findings)).toContain(
      "tool-call budget exhausted",
    );
    const timed = control.enqueue(
      "investigation.run",
      investigation("zip_archive", "t.zip"),
      {
        targetPath: fixtureZip,
        budget: { wall_ms: 1_500 },
      },
    );
    await control.waitFor(() => timed.completion !== null);
    expect(timed.completion?.["outcome"]).toBe("failed");
    expect(
      (timed.completion?.["failure"] as Record<string, unknown>)["code"],
    ).toBe("budget_exceeded");
    expect(JSON.stringify(timed.completion?.["failure"])).toContain("wall_ms");
  }, 180_000);

  it("pauses for approval and resumes on approval; records a policy finding on rejection", async () => {
    control = new FakeControlPlane();
    await control.start();
    await startRunner();
    control.autoApproval = "approved";
    const approved = control.enqueue(
      "investigation.run",
      investigation("zip_archive", "f.zip", {
        approval_required_effects: ["launchesProcess"],
        allowed_effects: ["writesFilesystem", "mutatesSession", "idempotent"],
      }),
      { targetPath: fixtureZip },
    );
    await control.waitFor(() => approved.completion !== null);
    expect(approved.transitions).toContain("awaiting_approval");
    expect(
      approved.pendingApprovals.some((a) => a["tool"] === "open_binary"),
    ).toBe(true);
    expect(approved.toolCalls.map((c) => c["tool_name"])).toContain(
      "open_binary",
    );
    control.autoApproval = "rejected";
    const rejected = control.enqueue(
      "investigation.run",
      investigation("zip_archive", "g.zip", {
        approval_required_effects: ["launchesProcess"],
        allowed_effects: ["writesFilesystem", "mutatesSession", "idempotent"],
      }),
      { targetPath: fixtureZip },
    );
    await control.waitFor(() => rejected.completion !== null);
    expect(rejected.toolCalls.map((c) => c["tool_name"])).not.toContain(
      "open_binary",
    );
    expect(JSON.stringify(rejected.findings)).toContain(
      "operator rejected approval",
    );
  }, 300_000);

  it("runs a bounded model follow-up through validated, policy-checked tool calls (scripted provider: contract check only)", async () => {
    control = new FakeControlPlane();
    await control.start();
    const provider = createScriptedProvider([
      {
        content: [
          { type: "tool_use", id: "t1", name: "list_unknowns", input: {} },
        ],
      },
      {
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "inspect_analysis_view",
            input: { bogus: true },
          },
        ],
      },
      {
        content: [
          {
            type: "text",
            text: "Facts: notes are stored in notes.json (see evidence). Unknowns: sync endpoint behaviour.",
          },
        ],
        stop_reason: "end_turn",
      },
    ]);
    await startRunner(provider);
    const job = control.enqueue(
      "investigation.run",
      investigation("zip_archive", "h.zip", {
        model_follow_up: true,
        max_follow_up_rounds: 5,
      }),
      { targetPath: fixtureZip },
    );
    await control.waitFor(() => job.completion !== null);
    expect(job.completion?.["outcome"]).toBe("succeeded");
    expect(provider.calls.length).toBe(3);
    const secondRound = JSON.stringify(provider.calls[2]?.messages);
    expect(secondRound).toContain("rejected by the advertised input schema");
    expect(
      job.findings.some(
        (f) => f["source"] === "model" && f["class"] === "inference",
      ),
    ).toBe(true);
    expect(JSON.stringify(provider.calls)).not.toContain(
      "fixture-session-secret-value-123",
    );
  }, 300_000);
});
