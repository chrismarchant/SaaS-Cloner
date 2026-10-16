import { type ChildProcess, spawn } from "node:child_process";
import type { CommandResult } from "./types.js";

export interface RunCommandOptions {
  cwd?: string;
  /** Exactly the child's environment (PATH is added from the parent if absent). */
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Per-stream cap; excess output is dropped and a marker appended. */
  maxOutputBytes?: number;
  input?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 16 * 1024 * 1024;
const KILL_GRACE_MS = 1_000;

class Capture {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    if (this.bytes >= this.limit) {
      this.truncated = true;
      return;
    }
    const room = this.limit - this.bytes;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (slice.length < chunk.length) this.truncated = true;
    this.chunks.push(slice);
    this.bytes += slice.length;
  }
  text(): string {
    const body = Buffer.concat(this.chunks).toString("utf8");
    return this.truncated
      ? `${body}\n[output truncated at ${this.limit} bytes]`
      : body;
  }
}

const killGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
};

/**
 * Run a program with an argument array: no shell, its own process group, the
 * whole group killed on timeout or abort. The environment is exactly `env`.
 * Spawn failures resolve (exitCode null, message in stderr) rather than reject.
 */
export function runCommand(
  argv: string[],
  opts: RunCommandOptions = {},
): Promise<CommandResult> {
  const started = Date.now();
  const [program, ...args] = argv;
  const result = (
    partial: Partial<CommandResult> & { stderr?: string },
  ): CommandResult => ({
    argv,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: Date.now() - started,
    timedOut: false,
    ...partial,
  });
  if (program === undefined || program === "")
    return Promise.resolve(result({ stderr: "empty argv" }));
  if (opts.signal?.aborted === true)
    return Promise.resolve(result({ stderr: "aborted before start" }));

  const env: Record<string, string> = { ...opts.env };
  if (env["PATH"] === undefined && process.env["PATH"] !== undefined)
    env["PATH"] = process.env["PATH"];
  const limit = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const out = new Capture(limit);
  const err = new Capture(limit);

  return new Promise<CommandResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        cwd: opts.cwd,
        env,
        shell: false,
        detached: true,
        stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve(result({ stderr: (error as Error).message }));
      return;
    }
    let timedOut = false;
    let settled = false;
    let spawnError: string | null = null;
    const timers: NodeJS.Timeout[] = [];
    const terminate = (): void => {
      killGroup(child, "SIGTERM");
      timers.push(setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS));
    };
    timers.push(
      setTimeout(() => {
        timedOut = true;
        terminate();
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    );
    const onAbort = (): void => terminate();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const settle = (code: number | null, sig: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      opts.signal?.removeEventListener("abort", onAbort);
      const stderr = err.text();
      resolve(
        result({
          exitCode: code,
          signal: sig,
          stdout: out.text(),
          stderr:
            spawnError === null
              ? stderr
              : `${spawnError}${stderr === "" ? "" : `\n${stderr}`}`,
          timedOut,
        }),
      );
    };
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    child.on("error", (error) => {
      spawnError = error.message;
      settle(null, null);
    });
    child.on("close", settle);
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(opts.input);
    }
  });
}

export const succeeded = (r: CommandResult): boolean =>
  r.exitCode === 0 && !r.timedOut && r.signal === null;
