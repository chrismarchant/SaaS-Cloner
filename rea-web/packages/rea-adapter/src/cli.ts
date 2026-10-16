import { spawn } from "node:child_process";
import { join } from "node:path";
import { buildChildEnvironment } from "./environment.js";

/**
 * Run one upstream CLI command (`scripts/rea.mjs <command> ... --format json`)
 * with an argument array, bounded output and a private environment. Used only
 * where upstream documents a CLI-only workflow (e.g. inspecting an exported
 * Evidence bundle); analysis goes through the MCP session.
 */
export interface ReaCliOptions {
  readonly reaRoot: string;
  readonly cwd: string;
  readonly ambientEnv: Readonly<Record<string, string | undefined>>;
  readonly passthroughNames: readonly string[];
  readonly privateHome: string;
  readonly privateTemp: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
  readonly nodeExecutable?: string;
}

export interface ReaCliResult {
  readonly command: readonly string[];
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdout_truncated: boolean;
  readonly duration_ms: number;
  readonly json: unknown | null;
  readonly timed_out: boolean;
}

export const runReaCli = (
  args: readonly string[],
  options: ReaCliOptions,
): Promise<ReaCliResult> =>
  new Promise((resolvePromise, reject) => {
    const launcher = join(options.reaRoot, "scripts", "rea.mjs");
    const command = [launcher, ...args];
    const limit = options.maxOutputBytes ?? 64 * 1024 * 1024;
    const started = Date.now();
    const child = spawn(options.nodeExecutable ?? process.execPath, command, {
      cwd: options.cwd,
      env: buildChildEnvironment({
        ambient: options.ambientEnv,
        privateHome: options.privateHome,
        privateTemp: options.privateTemp,
        passthroughNames: options.passthroughNames,
        logLevel: "silent",
      }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (outBytes + chunk.length > limit) {
        truncated = true;
        const room = Math.max(0, limit - outBytes);
        if (room > 0) out.push(chunk.subarray(0, room));
        outBytes = limit;
        return;
      }
      outBytes += chunk.length;
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.reduce((n, b) => n + b.length, 0) < 1024 * 1024) err.push(chunk);
    });
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* exited */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5_000).unref();
    }, options.timeoutMs ?? 300_000);
    const onAbort = () => killGroup("SIGTERM");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(out).toString("utf8");
      let json: unknown = null;
      if (!truncated) {
        try {
          json = JSON.parse(stdout);
        } catch {
          json = null;
        }
      }
      resolvePromise({
        command,
        exit_code: code,
        signal,
        stdout,
        stderr: Buffer.concat(err).toString("utf8"),
        stdout_truncated: truncated,
        duration_ms: Date.now() - started,
        json,
        timed_out: timedOut,
      });
    });
  });
