import { readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  exceededBudgetDimension,
  ZERO_USAGE,
  type JobBudget,
  type JobBudgetUsage,
} from "@rea-web/contracts";

/**
 * Per-job usage accounting. Wall time, tool calls, model tokens and artifact
 * bytes are counted exactly. CPU and resident memory are sampled from
 * /proc for the owned process groups (Linux only); processes that exited
 * between samples are not counted, so CPU is a lower bound. Disk is the
 * workspace size measured by an lstat walk (symlinks not followed).
 */
export class UsageTracker {
  private readonly started = Date.now();
  private usage: JobBudgetUsage = { ...ZERO_USAGE };
  private readonly groups = new Set<number>();
  private readonly cpuByPid = new Map<number, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly budget: JobBudget,
    private readonly workspace: string,
    private readonly onExceeded: (
      dimension: keyof JobBudget,
      usage: JobBudgetUsage,
    ) => void,
  ) {}

  start(intervalMs = 2_000): void {
    this.timer = setInterval(() => void this.sample(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  trackProcessGroup(pgid: number | null): void {
    if (pgid !== null) this.groups.add(pgid);
  }

  addToolCall(): void {
    this.usage = { ...this.usage, tool_calls: this.usage.tool_calls + 1 };
    this.check();
  }

  addModelTokens(input: number, output: number): void {
    this.usage = {
      ...this.usage,
      model_input_tokens: this.usage.model_input_tokens + input,
      model_output_tokens: this.usage.model_output_tokens + output,
    };
    this.check();
  }

  addArtifactBytes(bytes: number): void {
    this.usage = {
      ...this.usage,
      artifact_bytes: this.usage.artifact_bytes + bytes,
    };
    this.check();
  }

  /** Remaining tool calls before the budget is hit. */
  get remainingToolCalls(): number {
    return Math.max(0, this.budget.tool_calls - this.usage.tool_calls);
  }

  snapshot(): JobBudgetUsage {
    return { ...this.usage, wall_ms: Date.now() - this.started };
  }

  private check(): void {
    const current = this.snapshot();
    const dimension = exceededBudgetDimension(this.budget, current);
    if (dimension) this.onExceeded(dimension, current);
  }

  async sample(): Promise<void> {
    const { cpuMs, rssBytes } = await sampleProcessGroups(
      this.groups,
      this.cpuByPid,
    );
    const disk = await directorySize(this.workspace);
    this.usage = {
      ...this.usage,
      cpu_ms: Math.max(this.usage.cpu_ms, cpuMs),
      memory_bytes_peak: Math.max(this.usage.memory_bytes_peak, rssBytes),
      disk_bytes: disk,
    };
    this.check();
  }
}

const CLOCK_TICKS = 100;
const PAGE_SIZE = 4096;

/** Sum CPU (cumulative, per pid high-water mark) and current RSS of the groups. */
export const sampleProcessGroups = async (
  groups: ReadonlySet<number>,
  cpuByPid: Map<number, number>,
): Promise<{ cpuMs: number; rssBytes: number }> => {
  if (process.platform !== "linux" || groups.size === 0) {
    let total = 0;
    for (const v of cpuByPid.values()) total += v;
    return { cpuMs: total, rssBytes: 0 };
  }
  let rss = 0;
  let entries: string[] = [];
  try {
    entries = await readdir("/proc");
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    let stat: string;
    try {
      stat = await readFile(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue;
    }
    // comm may contain spaces/parens; fields after the last ')' are fixed.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const pgrp = Number(rest[2]);
    if (!groups.has(pgrp)) continue;
    const utime = Number(rest[11]);
    const stime = Number(rest[12]);
    const rssPages = Number(rest[21]);
    const cpu = ((utime + stime) * 1000) / CLOCK_TICKS;
    const pid = Number(entry);
    cpuByPid.set(pid, Math.max(cpuByPid.get(pid) ?? 0, cpu));
    rss += rssPages * PAGE_SIZE;
  }
  let total = 0;
  for (const v of cpuByPid.values()) total += v;
  return { cpuMs: Math.round(total), rssBytes: rss };
};

export const directorySize = async (
  root: string,
  limit = 200_000,
): Promise<number> => {
  let total = 0;
  let visited = 0;
  const stack = [root];
  while (stack.length > 0 && visited < limit) {
    const dir = stack.pop() as string;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      visited += 1;
      const path = join(dir, name);
      try {
        const st = await lstat(path);
        if (st.isDirectory()) stack.push(path);
        else if (st.isFile()) total += st.size;
      } catch {
        /* vanished */
      }
    }
  }
  return total;
};
