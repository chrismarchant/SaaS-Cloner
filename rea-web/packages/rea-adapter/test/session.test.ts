import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildChildEnvironment,
  describeReaRoot,
  EvidenceOwnershipError,
  processAlive,
  ReaSession,
  runReaCli,
  SessionManager,
  ToolArgumentsRejectedError,
  UnknownToolError,
} from "../src/index.js";

const REA_ROOT = resolve(import.meta.dirname, "../../../..");
const FIXTURE = resolve(
  import.meta.dirname,
  "../../../fixtures/investigation/js-cli-app",
);
const built = existsSync(join(REA_ROOT, "dist", "mcp", "main.js"));
const describeIfBuilt = built ? describe : describe.skip;

const expectedToolCount = (): number | null => {
  const catalogPath = join(REA_ROOT, ".cache", "mcp-tool-catalog.json");
  if (!existsSync(catalogPath)) return null;
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
    catalog: Record<string, unknown>;
  };
  return Object.keys(catalog.catalog).length;
};

let workspaceRoot: string;
const sessionOptions = (name: string) => ({
  reaRoot: REA_ROOT,
  sourceSha: null,
  workspace: join(workspaceRoot, name),
  ambientEnv: process.env,
  passthroughNames: [],
  logLevel: "warn" as const,
});

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "rea-web-adapter-"));
});
afterAll(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("buildChildEnvironment", () => {
  it("passes only the allowlist and private directories", () => {
    const env = buildChildEnvironment({
      ambient: {
        PATH: "/usr/bin",
        HOME: "/root",
        SECRET_LEAK: "x",
        GHIDRA_INSTALL_DIR: "/opt/ghidra",
        REA_WEB_SESSION_SECRET: "s",
      },
      privateHome: "/w/home",
      privateTemp: "/w/tmp",
      passthroughNames: ["GHIDRA_INSTALL_DIR"],
      logLevel: "warn",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      GHIDRA_INSTALL_DIR: "/opt/ghidra",
      HOME: "/w/home",
      TMPDIR: "/w/tmp",
      TMP: "/w/tmp",
      TEMP: "/w/tmp",
      REA_LOG_LEVEL: "warn",
    });
  });
});

describeIfBuilt("ReaSession against the built upstream server", () => {
  it("describes the REA root", async () => {
    const info = await describeReaRoot(REA_ROOT);
    expect(info.package_name).toBe("rea-agents");
    expect(info.built).toBe(true);
    expect(info.source_sha).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("discovers the live catalog, identity and availability; validates and routes calls; exports and tears down", async () => {
    const session = new ReaSession(sessionOptions("primary"));
    const discovery = await session.start();
    try {
      const expected = expectedToolCount();
      if (expected !== null) expect(discovery.tools).toHaveLength(expected);
      expect(discovery.identity?.catalog.counts["mcp_tools"]).toBe(
        discovery.tools.length,
      );
      expect(discovery.identity?.catalog.digests["tools_sha256"]).toMatch(
        /^[0-9a-f]{64}$/u,
      );
      const groupNames = new Set(
        discovery.tool_availability.groups.flatMap((g) => g.names),
      );
      for (const tool of discovery.tools)
        expect(groupNames.has(tool.name)).toBe(true);
      expect(discovery.prompts.length).toBeGreaterThan(0);
      expect(session.pid).not.toBeNull();
      expect(processAlive(session.pid as number)).toBe(true);

      // Schema validation happens before dispatch.
      await expect(
        session.callTool("inspect_go_binary", {}),
      ).rejects.toBeInstanceOf(ToolArgumentsRejectedError);
      await expect(session.callTool("no_such_tool", {})).rejects.toBeInstanceOf(
        UnknownToolError,
      );

      // A real target-free analysis on the fixture, raw and derived retained.
      const analysis = await session.callTool(
        "analyze_javascript_application",
        { input_path: FIXTURE },
        { timeoutMs: 120_000 },
      );
      expect(analysis.derived.is_error).toBe(false);
      expect(analysis.derived.evidence_id).toMatch(/^ev_[0-9a-f]{64}$/u);
      expect(analysis.derived.normalized_result_keys.length).toBeGreaterThan(0);
      expect(analysis.raw["structuredContent"]).toBeDefined();
      expect(session.retainedEvidenceIds).toContain(
        analysis.derived.evidence_id,
      );

      // Same-session follow-up with the retained reference is routed.
      const view = await session.callTool("inspect_analysis_view", {
        source: {
          kind: "retained-evidence",
          evidence_id: analysis.derived.evidence_id,
        },
        view: { kind: "summary" },
      });
      expect(view.derived.is_error).toBe(false);

      // Export before teardown; the bundle survives the process.
      const exported = await session.exportEvidence();
      expect(exported).not.toBeNull();
      expect(exported?.outcome.derived.is_error).toBe(false);
      const bundleStat = await stat(exported?.path as string);
      expect(bundleStat.size).toBeGreaterThan(100);
      const bundle = JSON.parse(
        readFileSync(exported?.path as string, "utf8"),
      ) as {
        records?: unknown[];
      };
      expect(Array.isArray(bundle.records)).toBe(true);
    } finally {
      const pid = session.pid as number;
      const cleanup = await session.close();
      expect(cleanup.status).toBe("cleanup_complete");
      expect(processAlive(pid)).toBe(false);
    }
  }, 240_000);

  it("isolates evidence between concurrent sessions and routes follow-ups to the owner", async () => {
    const manager = new SessionManager();
    const a = await manager.open("inv-a", sessionOptions("iso-a"));
    const b = await manager.open("inv-b", sessionOptions("iso-b"));
    try {
      expect(a.pid).not.toBe(b.pid);
      const analysis = await a.callTool(
        "analyze_javascript_application",
        { input_path: FIXTURE, detail: "summary" },
        { timeoutMs: 120_000 },
      );
      const evidenceId = analysis.derived.evidence_id as string;
      expect(a.ownsEvidence(evidenceId)).toBe(true);
      expect(b.ownsEvidence(evidenceId)).toBe(false);
      // The adapter refuses before any upstream call is dispatched.
      await expect(
        b.callTool("inspect_analysis_view", {
          source: { kind: "retained-evidence", evidence_id: evidenceId },
          view: { kind: "summary" },
        }),
      ).rejects.toBeInstanceOf(EvidenceOwnershipError);
      expect(() => manager.routeEvidence(b.id, evidenceId)).toThrowError(
        new RegExp(`belongs to session ${a.id}`, "u"),
      );
      expect(manager.routeEvidence(a.id, evidenceId)).toBe(a);
      expect(manager.ownerOf(evidenceId)?.id).toBe(a.id);
    } finally {
      await manager.closeAll();
      expect(manager.size).toBe(0);
    }
  }, 240_000);

  it("honours cancellation signals", async () => {
    const session = new ReaSession(sessionOptions("cancel"));
    await session.start();
    try {
      const controller = new AbortController();
      const pending = session.callTool(
        "analyze_javascript_application",
        { input_path: FIXTURE },
        { signal: controller.signal, timeoutMs: 120_000 },
      );
      controller.abort(new Error("operator cancelled"));
      await expect(pending).rejects.toThrow();
      // The session stays usable after a cancelled call.
      const status = await session.callTool("binary_session", {});
      expect(status.derived.is_error).toBe(false);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("runs a one-shot upstream CLI command with an argument array", async () => {
    const result = await runReaCli(["capabilities", "--format", "json"], {
      reaRoot: REA_ROOT,
      cwd: workspaceRoot,
      ambientEnv: process.env,
      passthroughNames: [],
      privateHome: join(workspaceRoot, "cli-home"),
      privateTemp: join(workspaceRoot, "cli-tmp"),
      timeoutMs: 120_000,
    });
    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);
    expect(result.json).toBeTypeOf("object");
    expect((result.json as { open?: boolean }).open).toBe(false);
  }, 120_000);
});
