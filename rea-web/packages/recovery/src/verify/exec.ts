import { type ChildProcess, spawn } from "node:child_process";

/** Rolling tail of a byte stream: only the last `limit` bytes are retained. */
class Tail {
  private chunks: Buffer[] = [];
  private bytes = 0;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    if (this.bytes > this.limit * 2) this.compact();
  }
  private compact(): void {
    const all = Buffer.concat(this.chunks);
    const kept = all.subarray(Math.max(0, all.length - this.limit));
    this.chunks = [kept];
    this.bytes = kept.length;
  }
  text(): string {
    const all = Buffer.concat(this.chunks);
    return all
      .subarray(Math.max(0, all.length - this.limit))
      .toString("utf8")
      .replace(/^�+/u, "");
  }
}

export interface ExecOptions {
  readonly cwd?: string | undefined;
  /** Exactly the child's environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  /** Bytes of each stream retained (default 64 KiB). */
  readonly tailBytes?: number;
}

export interface ExecOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the program could not be started. */
  readonly spawnError: string | null;
}

const KILL_GRACE_MS = 1_000;
/** If the group is gone but a pipe is still held open, stop waiting after this. */
const PIPE_DRAIN_MS = 2_000;

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
 * Run `argv` without a shell in its own process group. On timeout or abort the
 * whole group receives SIGTERM, then SIGKILL after a grace period. Spawn
 * failures resolve (they are facts about the step) instead of rejecting.
 */
export function execProcess(
  argv: readonly string[],
  options: ExecOptions,
): Promise<ExecOutcome> {
  const started = Date.now();
  const [program, ...args] = argv;
  const tailBytes = options.tailBytes ?? 64 * 1024;
  const outcome = (partial: Partial<ExecOutcome>): ExecOutcome => ({
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: false,
    durationMs: Date.now() - started,
    stdout: "",
    stderr: "",
    spawnError: null,
    ...partial,
  });
  if (program === undefined || program === "")
    return Promise.resolve(outcome({ spawnError: "empty argv" }));
  if (options.signal?.aborted === true)
    return Promise.resolve(outcome({ aborted: true }));

  const out = new Tail(tailBytes);
  const err = new Tail(tailBytes);
  return new Promise<ExecOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        cwd: options.cwd,
        env: { ...options.env },
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve(outcome({ spawnError: (error as Error).message }));
      return;
    }
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let spawnError: string | null = null;
    const timers: NodeJS.Timeout[] = [];
    const settle = (code: number | null, sig: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(
        outcome({
          exitCode: code,
          signal: sig,
          timedOut,
          aborted,
          stdout: out.text(),
          stderr: err.text(),
          spawnError,
        }),
      );
    };
    const terminate = (): void => {
      killGroup(child, "SIGTERM");
      // Not cleared on settle: group members may outlive the leader.
      setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS).unref();
      timers.push(
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle(null, "SIGKILL");
        }, KILL_GRACE_MS + PIPE_DRAIN_MS),
      );
    };
    function onAbort(): void {
      aborted = true;
      terminate();
    }
    timers.push(
      setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs),
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    child.on("error", (error) => {
      spawnError = error.message;
      settle(null, null);
    });
    child.on("close", settle);
  });
}
