import { spawn, type ChildProcess } from "node:child_process";
import type { Transport } from "@modelcontextprotocol/client";

/**
 * Minimal stdio JSON-RPC transport over a child process that the adapter owns
 * outright: spawned detached so it leads its own process group, argument
 * arrays only, allowlisted environment, captured stderr, and group-wide kill
 * with escalation. Framing is newline-delimited JSON, as the MCP stdio
 * transport specifies.
 */
export interface OwnedProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stderrLimitBytes?: number;
}

export interface OwnedProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly at: string;
}

export interface KillReport {
  readonly method: "already_exited" | "sigterm" | "sigkill" | "failed";
  readonly group: boolean;
  readonly waitedMs: number;
  readonly detail?: string;
}

const encoder = new TextEncoder();

export class OwnedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;
  readonly pid: number;
  readonly startedAt = new Date().toISOString();
  private readonly child: ChildProcess;
  private buffer = "";
  private stderrChunks: string[] = [];
  private stderrBytes = 0;
  private exitInfo: OwnedProcessExit | null = null;
  private readonly exitPromise: Promise<OwnedProcessExit>;
  private readonly stderrLimit: number;
  private started = false;

  constructor(private readonly options: OwnedProcessOptions) {
    this.stderrLimit = options.stderrLimitBytes ?? 256 * 1024;
    this.child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: false,
    });
    if (this.child.pid === undefined)
      throw new Error("REA process failed to spawn (no pid)");
    this.pid = this.child.pid;
    this.exitPromise = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.exitInfo = { code, signal, at: new Date().toISOString() };
        resolve(this.exitInfo);
        this.onclose?.();
      });
    });
    this.child.once("error", (error) => this.onerror?.(error));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      if (this.stderrBytes >= this.stderrLimit) return;
      const text = chunk.toString("utf8");
      this.stderrBytes += text.length;
      this.stderrChunks.push(text);
    });
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) {
          try {
            this.onmessage?.(JSON.parse(line));
          } catch (error) {
            this.onerror?.(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
        newline = this.buffer.indexOf("\n");
      }
    });
    return Promise.resolve();
  }

  send(message: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child.stdin;
      if (!stdin || stdin.destroyed || this.exitInfo)
        return reject(new Error("REA process stdin is closed"));
      const payload = encoder.encode(`${JSON.stringify(message)}\n`);
      stdin.write(payload, (error) => (error ? reject(error) : resolve()));
    });
  }

  /** Transport.close(): orderly close of stdin; the owner then calls kill(). */
  close(): Promise<void> {
    this.child.stdin?.end();
    return Promise.resolve();
  }

  get exit(): OwnedProcessExit | null {
    return this.exitInfo;
  }

  get stderrText(): string {
    return this.stderrChunks.join("");
  }

  waitForExit(timeoutMs: number): Promise<OwnedProcessExit | null> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    return Promise.race([
      this.exitPromise,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs).unref(),
      ),
    ]);
  }

  /** Terminate the owned process group: SIGTERM, wait, then SIGKILL. */
  async kill(graceMs = 5_000): Promise<KillReport> {
    const started = Date.now();
    if (this.exitInfo)
      return { method: "already_exited", group: false, waitedMs: 0 };
    const group = process.platform !== "win32";
    const signalTarget = group ? -this.pid : this.pid;
    const deliver = (signal: NodeJS.Signals): string | null => {
      try {
        process.kill(signalTarget, signal);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    const termError = deliver("SIGTERM");
    if (termError && !this.exitInfo) {
      // Group delivery can fail if the leader already exited; fall back to pid.
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* exited */
      }
    }
    if (await this.waitForExit(graceMs))
      return { method: "sigterm", group, waitedMs: Date.now() - started };
    const killError = deliver("SIGKILL");
    if (killError) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* exited */
      }
    }
    if (await this.waitForExit(2_000))
      return { method: "sigkill", group, waitedMs: Date.now() - started };
    return {
      method: "failed",
      group,
      waitedMs: Date.now() - started,
      detail: killError ?? termError ?? "process did not exit after SIGKILL",
    };
  }
}

/** True when a process with this pid still exists (ESRCH otherwise). */
export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
