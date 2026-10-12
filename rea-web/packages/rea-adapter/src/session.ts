import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client, type RequestOptions } from "@modelcontextprotocol/client";
import { uuidv7, type CleanupReport } from "@rea-web/contracts";
import { buildChildEnvironment } from "./environment.js";
import {
  OwnedStdioTransport,
  processAlive,
  type KillReport,
} from "./ownedProcess.js";
import { discover, type Discovery, type LiveTool } from "./discovery.js";
import { ToolInputValidator, type ValidationFailure } from "./validation.js";
import { deriveToolResult, type DerivedToolResult } from "./derive.js";

export interface ReaSessionOptions {
  /** Upstream checkout or installed `rea-agents` package root containing scripts/rea.mjs. */
  readonly reaRoot: string;
  readonly sourceSha: string | null;
  /** Private directory owned by this session; created if missing. */
  readonly workspace: string;
  readonly ambientEnv: Readonly<Record<string, string | undefined>>;
  readonly passthroughNames: readonly string[];
  readonly logLevel?:
    | "trace"
    | "debug"
    | "info"
    | "warn"
    | "error"
    | "fatal"
    | "silent";
  readonly nodeExecutable?: string;
  readonly connectTimeoutMs?: number;
  readonly clientInfo?: { name: string; version: string };
}

export type ProgressCallback = NonNullable<RequestOptions["onprogress"]>;

export interface ToolCallOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressCallback;
  /** Skip schema validation (only for tools absent from the live catalog). */
  readonly skipValidation?: boolean;
}

export interface ToolCallOutcome {
  readonly session_id: string;
  readonly seq: number;
  readonly tool: string;
  readonly started_at: string;
  readonly duration_ms: number;
  /** Complete upstream result, unmodified. */
  readonly raw: Record<string, unknown>;
  readonly derived: DerivedToolResult;
  readonly effects: readonly string[];
  readonly validation: { ok: true } | ValidationFailure;
}

export class EvidenceOwnershipError extends Error {
  constructor(
    readonly evidenceId: string,
    readonly owningSession: string | null,
    readonly requestedSession: string,
  ) {
    super(
      owningSession === null
        ? `evidence ${evidenceId} is not retained by any live session`
        : `evidence ${evidenceId} belongs to session ${owningSession}, not ${requestedSession}`,
    );
    this.name = "EvidenceOwnershipError";
  }
}

export class ToolArgumentsRejectedError extends Error {
  constructor(readonly failure: ValidationFailure) {
    super(
      `arguments for ${failure.tool} rejected by the advertised input schema: ${failure.errors
        .map((e) => `${e.path} ${e.message}`)
        .join("; ")}`,
    );
    this.name = "ToolArgumentsRejectedError";
  }
}

export class UnknownToolError extends Error {
  constructor(readonly tool: string) {
    super(`tool ${tool} is not advertised by this session's live catalog`);
    this.name = "UnknownToolError";
  }
}

const effectNames = (tool: LiveTool | undefined): string[] => {
  const annotations = tool?.annotations ?? {};
  const names: string[] = [];
  if (annotations["destructiveHint"] === true) names.push("destructiveHint");
  if (annotations["openWorldHint"] === true) names.push("openWorldHint");
  if (annotations["readOnlyHint"] === false) names.push("mutatesSession");
  if (annotations["idempotentHint"] === true) names.push("idempotent");
  return names;
};

/**
 * One upstream REA MCP process bound to one investigation. Retained Evidence
 * references are valid only here; `assertOwnsEvidence` enforces that.
 */
export class ReaSession {
  readonly id: string = uuidv7();
  readonly workspace: string;
  readonly privateHome: string;
  readonly privateTemp: string;
  readonly startedAt = new Date().toISOString();
  private transport: OwnedStdioTransport | null = null;
  private client: Client | null = null;
  private discovery: Discovery | null = null;
  private readonly toolsByName = new Map<string, LiveTool>();
  private readonly validator = new ToolInputValidator();
  private readonly evidenceIds = new Set<string>();
  private seq = 0;
  private closed = false;

  constructor(private readonly options: ReaSessionOptions) {
    this.workspace = resolve(options.workspace);
    this.privateHome = join(this.workspace, "home");
    this.privateTemp = join(this.workspace, "tmp");
  }

  get pid(): number | null {
    return this.transport?.pid ?? null;
  }

  get stderr(): string {
    return this.transport?.stderrText ?? "";
  }

  get discovered(): Discovery {
    if (!this.discovery) throw new Error("session not started");
    return this.discovery;
  }

  get retainedEvidenceIds(): readonly string[] {
    return [...this.evidenceIds];
  }

  async start(): Promise<Discovery> {
    if (this.transport) throw new Error("session already started");
    await mkdir(this.privateHome, { recursive: true });
    await mkdir(this.privateTemp, { recursive: true });
    const launcher = join(this.options.reaRoot, "scripts", "rea.mjs");
    await stat(launcher);
    const env = buildChildEnvironment({
      ambient: this.options.ambientEnv,
      privateHome: this.privateHome,
      privateTemp: this.privateTemp,
      passthroughNames: this.options.passthroughNames,
      logLevel: this.options.logLevel ?? "warn",
    });
    this.transport = new OwnedStdioTransport({
      command: this.options.nodeExecutable ?? process.execPath,
      args: [launcher, "mcp"],
      cwd: this.workspace,
      env,
    });
    this.client = new Client(
      this.options.clientInfo ?? { name: "rea-web-runner", version: "0.1.0" },
    );
    await this.client.connect(this.transport, {
      timeout: this.options.connectTimeoutMs ?? 60_000,
    });
    this.discovery = await discover(this.client, {
      reaRoot: this.options.reaRoot,
      sourceSha: this.options.sourceSha,
    });
    for (const tool of this.discovery.tools)
      this.toolsByName.set(tool.name, tool);
    return this.discovery;
  }

  tool(name: string): LiveTool | undefined {
    return this.toolsByName.get(name);
  }

  ownsEvidence(evidenceId: string): boolean {
    return this.evidenceIds.has(evidenceId);
  }

  /** Reject retained-evidence references that this session did not produce. */
  assertOwnsEvidence(evidenceId: string): void {
    if (!this.evidenceIds.has(evidenceId))
      throw new EvidenceOwnershipError(evidenceId, null, this.id);
  }

  /** Walk arguments for `{kind:"retained-evidence", evidence_id}` references. */
  referencedEvidenceIds(
    args: unknown,
    out: string[] = [],
    depth = 0,
  ): string[] {
    if (depth > 12 || args === null || typeof args !== "object") return out;
    if (Array.isArray(args)) {
      for (const item of args) this.referencedEvidenceIds(item, out, depth + 1);
      return out;
    }
    const record = args as Record<string, unknown>;
    if (
      record["kind"] === "retained-evidence" &&
      typeof record["evidence_id"] === "string"
    )
      out.push(record["evidence_id"]);
    for (const value of Object.values(record))
      this.referencedEvidenceIds(value, out, depth + 1);
    return out;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: ToolCallOptions = {},
  ): Promise<ToolCallOutcome> {
    if (!this.client || this.closed) throw new Error("session is not open");
    const tool = this.toolsByName.get(name);
    if (!tool) throw new UnknownToolError(name);
    for (const ref of this.referencedEvidenceIds(args))
      this.assertOwnsEvidence(ref);
    const validation = options.skipValidation
      ? ({ ok: true } as const)
      : this.validator.validate(name, tool.inputSchema, args);
    if (!validation.ok) throw new ToolArgumentsRejectedError(validation);
    const seq = ++this.seq;
    const startedAt = new Date();
    const result = (await this.client.callTool(
      { name, arguments: args },
      {
        timeout: options.timeoutMs ?? 120_000,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: options.timeoutMs ? options.timeoutMs * 4 : 600_000,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onprogress: options.onProgress } : {}),
      },
    )) as Record<string, unknown>;
    const derived = deriveToolResult(
      result as {
        isError?: boolean;
        content?: { type: string; text?: string }[];
        structuredContent?: Record<string, unknown>;
      },
    );
    if (derived.evidence_id) this.evidenceIds.add(derived.evidence_id);
    if (name === "close_binary" && !derived.is_error) this.evidenceIds.clear();
    return {
      session_id: this.id,
      seq,
      tool: name,
      started_at: startedAt.toISOString(),
      duration_ms: Date.now() - startedAt.getTime(),
      raw: result,
      derived,
      effects: effectNames(tool),
      validation,
    };
  }

  /**
   * Export the complete session Evidence bundle to a path inside the
   * workspace before teardown. Returns the upstream result (which carries the
   * publication receipt) or null when the tool is not advertised.
   */
  async exportEvidence(
    relativePath = "evidence/bundle.json",
    options: ToolCallOptions = {},
  ): Promise<{ path: string; outcome: ToolCallOutcome } | null> {
    if (!this.toolsByName.has("export_evidence_bundle")) return null;
    const path = join(this.workspace, relativePath);
    await mkdir(resolve(path, ".."), { recursive: true });
    const outcome = await this.callTool(
      "export_evidence_bundle",
      { path, overwrite: true },
      options,
    );
    return { path, outcome };
  }

  /** Orderly teardown: close_binary, client close, group kill, report. */
  async close(
    graceMs = 5_000,
  ): Promise<CleanupReport & { kill: KillReport | null; exit: unknown }> {
    if (this.closed)
      return {
        status: "cleanup_complete",
        remaining_resource_kinds: [],
        kill: null,
        exit: this.transport?.exit ?? null,
      };
    this.closed = true;
    let closeBinaryDetail: string | undefined;
    if (this.client && this.toolsByName.has("close_binary")) {
      try {
        const r = await this.client.callTool(
          { name: "close_binary", arguments: {} },
          { timeout: Math.max(graceMs, 10_000) },
        );
        if (r.isError) closeBinaryDetail = "close_binary reported an error";
      } catch (error) {
        closeBinaryDetail = `close_binary failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    try {
      await this.client?.close();
    } catch {
      /* transport already gone */
    }
    const kill = this.transport ? await this.transport.kill(graceMs) : null;
    const pid = this.transport?.pid;
    const stillAlive = pid !== undefined && processAlive(pid);
    const remaining = stillAlive ? ["process"] : [];
    const status: CleanupReport["status"] =
      kill === null || (!stillAlive && kill.method !== "failed")
        ? "cleanup_complete"
        : "cleanup_incomplete";
    const detail = [closeBinaryDetail, kill?.detail].filter(Boolean).join("; ");
    return {
      status,
      remaining_resource_kinds: remaining,
      ...(detail ? { detail } : {}),
      kill,
      exit: this.transport?.exit ?? null,
    };
  }
}
