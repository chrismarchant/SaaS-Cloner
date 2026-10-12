import { describe, it, expect } from "vitest";
import {
  canTransition,
  cleanupReportSchema,
  DEFAULT_JOB_BUDGET,
  exceededBudgetDimension,
  JOB_STATES,
  JOB_TRANSITIONS,
  jobBudgetSchema,
  jobRequirementsSchema,
  retryPolicySchema,
  TERMINAL_JOB_STATES,
  ZERO_USAGE,
  type JobBudget,
  type JobBudgetUsage,
  type JobState,
  type TransitionActor,
} from "./jobs.js";

const ACTORS: readonly TransitionActor[] = ["runner", "user", "system"];

describe("canTransition", () => {
  it("accepts every row of JOB_TRANSITIONS for each listed actor", () => {
    for (const row of JOB_TRANSITIONS) {
      for (const actor of row.actors) {
        expect(
          canTransition(row.from, row.to, actor),
          `${row.from} -> ${row.to} by ${actor}`,
        ).toBe(true);
      }
    }
  });

  it("rejects each listed transition for an actor not in its list", () => {
    let checked = 0;
    for (const row of JOB_TRANSITIONS) {
      for (const actor of ACTORS.filter((a) => !row.actors.includes(a))) {
        expect(
          canTransition(row.from, row.to, actor),
          `${row.from} -> ${row.to} by ${actor}`,
        ).toBe(false);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(JOB_TRANSITIONS.length);
  });

  it("matches the transition table exactly over the full state x state x actor space", () => {
    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        for (const actor of ACTORS) {
          const listed = JOB_TRANSITIONS.some(
            (t) => t.from === from && t.to === to && t.actors.includes(actor),
          );
          expect(canTransition(from, to, actor)).toBe(listed);
        }
      }
    }
  });

  it("rejects every transition out of a terminal state", () => {
    expect([...TERMINAL_JOB_STATES].sort()).toEqual([
      "cancelled",
      "failed",
      "succeeded",
    ]);
    for (const from of TERMINAL_JOB_STATES) {
      for (const to of JOB_STATES) {
        for (const actor of ACTORS) {
          expect(
            canTransition(from, to, actor),
            `${from} -> ${to} by ${actor}`,
          ).toBe(false);
        }
      }
    }
  });

  it("never lists a terminal state as the source of a table row", () => {
    for (const row of JOB_TRANSITIONS) {
      expect(TERMINAL_JOB_STATES.has(row.from)).toBe(false);
    }
  });

  it("does not allow queued -> running or running -> queued for any actor", () => {
    for (const actor of ACTORS) {
      expect(canTransition("queued", "running", actor)).toBe(false);
      expect(canTransition("running", "queued", actor)).toBe(false);
    }
  });

  it("does not allow a state to transition to itself", () => {
    for (const state of JOB_STATES) {
      for (const actor of ACTORS) {
        expect(canTransition(state, state, actor)).toBe(false);
      }
    }
  });

  it("only lets the system claim a queued job and only the user or system cancel it", () => {
    expect(canTransition("queued", "preparing", "system")).toBe(true);
    expect(canTransition("queued", "preparing", "runner")).toBe(false);
    expect(canTransition("queued", "preparing", "user")).toBe(false);
    expect(canTransition("queued", "cancelled", "user")).toBe(true);
    expect(canTransition("queued", "cancelled", "system")).toBe(true);
    expect(canTransition("queued", "cancelled", "runner")).toBe(false);
  });

  it("only lets the system mark a job interrupted (lease expiry)", () => {
    const sources: JobState[] = ["preparing", "running", "awaiting_approval"];
    for (const from of sources) {
      expect(canTransition(from, "interrupted", "system")).toBe(true);
      expect(canTransition(from, "interrupted", "runner")).toBe(false);
      expect(canTransition(from, "interrupted", "user")).toBe(false);
    }
  });

  it("only lets the system retry or fail an interrupted job", () => {
    expect(canTransition("interrupted", "queued", "system")).toBe(true);
    expect(canTransition("interrupted", "failed", "system")).toBe(true);
    expect(canTransition("interrupted", "succeeded", "system")).toBe(false);
    expect(canTransition("interrupted", "running", "runner")).toBe(false);
  });

  it("never lets a user cause anything but a queued cancel", () => {
    const userRows = JOB_TRANSITIONS.filter((t) => t.actors.includes("user"));
    expect(userRows.map((t) => `${t.from}->${t.to}`)).toEqual([
      "queued->cancelled",
    ]);
  });

  it("has no duplicate (from, to) rows", () => {
    const keys = JOB_TRANSITIONS.map((t) => `${t.from}->${t.to}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

const withUsage = (patch: Partial<JobBudgetUsage>): JobBudgetUsage => ({
  ...ZERO_USAGE,
  ...patch,
});

describe("exceededBudgetDimension", () => {
  it("returns null for zero usage and for usage exactly at the budget", () => {
    expect(exceededBudgetDimension(DEFAULT_JOB_BUDGET, ZERO_USAGE)).toBeNull();
    const atLimit = withUsage({
      wall_ms: DEFAULT_JOB_BUDGET.wall_ms,
      cpu_ms: DEFAULT_JOB_BUDGET.cpu_ms as number,
      memory_bytes_peak: DEFAULT_JOB_BUDGET.memory_bytes as number,
      disk_bytes: DEFAULT_JOB_BUDGET.disk_bytes,
      tool_calls: DEFAULT_JOB_BUDGET.tool_calls,
      model_input_tokens: DEFAULT_JOB_BUDGET.model_input_tokens,
      model_output_tokens: DEFAULT_JOB_BUDGET.model_output_tokens,
      artifact_bytes: DEFAULT_JOB_BUDGET.artifact_bytes,
    });
    expect(exceededBudgetDimension(DEFAULT_JOB_BUDGET, atLimit)).toBeNull();
  });

  const cases: ReadonlyArray<{
    dimension: keyof JobBudget;
    usageKey: keyof JobBudgetUsage;
  }> = [
    { dimension: "wall_ms", usageKey: "wall_ms" },
    { dimension: "cpu_ms", usageKey: "cpu_ms" },
    { dimension: "memory_bytes", usageKey: "memory_bytes_peak" },
    { dimension: "disk_bytes", usageKey: "disk_bytes" },
    { dimension: "tool_calls", usageKey: "tool_calls" },
    { dimension: "model_input_tokens", usageKey: "model_input_tokens" },
    { dimension: "model_output_tokens", usageKey: "model_output_tokens" },
    { dimension: "artifact_bytes", usageKey: "artifact_bytes" },
  ];

  for (const { dimension, usageKey } of cases) {
    it(`reports ${dimension} when only that dimension is over by one`, () => {
      const limit = DEFAULT_JOB_BUDGET[dimension] as number;
      const usage = withUsage({ [usageKey]: limit + 1 });
      expect(exceededBudgetDimension(DEFAULT_JOB_BUDGET, usage)).toBe(
        dimension,
      );
    });

    it(`does not report ${dimension} when usage equals the limit`, () => {
      const limit = DEFAULT_JOB_BUDGET[dimension] as number;
      const usage = withUsage({ [usageKey]: limit });
      expect(exceededBudgetDimension(DEFAULT_JOB_BUDGET, usage)).toBeNull();
    });
  }

  it("returns the first exceeded dimension in declaration order", () => {
    const usage = withUsage({
      artifact_bytes: DEFAULT_JOB_BUDGET.artifact_bytes + 1,
      tool_calls: DEFAULT_JOB_BUDGET.tool_calls + 1,
      disk_bytes: DEFAULT_JOB_BUDGET.disk_bytes + 1,
    });
    expect(exceededBudgetDimension(DEFAULT_JOB_BUDGET, usage)).toBe(
      "disk_bytes",
    );
    expect(
      exceededBudgetDimension(
        DEFAULT_JOB_BUDGET,
        withUsage({
          ...usage,
          wall_ms: DEFAULT_JOB_BUDGET.wall_ms + 1,
          model_output_tokens: DEFAULT_JOB_BUDGET.model_output_tokens + 1,
        }),
      ),
    ).toBe("wall_ms");
  });

  it("treats undefined cpu_ms and memory_bytes as never exceeded", () => {
    const {
      cpu_ms: _cpu,
      memory_bytes: _mem,
      ...required
    } = DEFAULT_JOB_BUDGET;
    const budget: JobBudget = required;
    const huge = withUsage({
      cpu_ms: Number.MAX_SAFE_INTEGER,
      memory_bytes_peak: Number.MAX_SAFE_INTEGER,
    });
    expect(budget.cpu_ms).toBeUndefined();
    expect(budget.memory_bytes).toBeUndefined();
    expect(exceededBudgetDimension(budget, huge)).toBeNull();
  });

  it("still enforces the required dimensions when optional ones are absent", () => {
    const { cpu_ms: _cpu, memory_bytes: _mem, ...budget } = DEFAULT_JOB_BUDGET;
    expect(
      exceededBudgetDimension(
        budget,
        withUsage({ tool_calls: budget.tool_calls + 1 }),
      ),
    ).toBe("tool_calls");
  });
});

describe("zod schemas", () => {
  it("jobRequirementsSchema.parse({}) yields all defaults", () => {
    expect(jobRequirementsSchema.parse({})).toEqual({
      tools: [],
      providers: [],
      os: [],
      labels: [],
      effects: [],
    });
  });

  it("jobRequirementsSchema accepts valid os values", () => {
    const parsed = jobRequirementsSchema.parse({
      os: ["linux", "darwin", "win32"],
    });
    expect(parsed.os).toEqual(["linux", "darwin", "win32"]);
  });

  it("jobRequirementsSchema rejects an invalid os", () => {
    expect(jobRequirementsSchema.safeParse({ os: ["freebsd"] }).success).toBe(
      false,
    );
    expect(jobRequirementsSchema.safeParse({ os: ["Linux"] }).success).toBe(
      false,
    );
  });

  it("jobRequirementsSchema rejects empty names and unknown effects", () => {
    expect(jobRequirementsSchema.safeParse({ tools: [""] }).success).toBe(
      false,
    );
    expect(jobRequirementsSchema.safeParse({ labels: [""] }).success).toBe(
      false,
    );
    expect(
      jobRequirementsSchema.safeParse({ effects: ["makesCoffee"] }).success,
    ).toBe(false);
    expect(
      jobRequirementsSchema.safeParse({ effects: ["executesForeignCode"] })
        .success,
    ).toBe(true);
  });

  it("DEFAULT_JOB_BUDGET satisfies jobBudgetSchema", () => {
    expect(jobBudgetSchema.parse(DEFAULT_JOB_BUDGET)).toEqual(
      DEFAULT_JOB_BUDGET,
    );
  });

  it("jobBudgetSchema rejects non-positive wall time and fractional values", () => {
    expect(
      jobBudgetSchema.safeParse({ ...DEFAULT_JOB_BUDGET, wall_ms: 0 }).success,
    ).toBe(false);
    expect(
      jobBudgetSchema.safeParse({ ...DEFAULT_JOB_BUDGET, tool_calls: -1 })
        .success,
    ).toBe(false);
    expect(
      jobBudgetSchema.safeParse({ ...DEFAULT_JOB_BUDGET, disk_bytes: 1.5 })
        .success,
    ).toBe(false);
  });

  it("jobBudgetSchema allows cpu_ms and memory_bytes to be omitted", () => {
    const { cpu_ms: _cpu, memory_bytes: _mem, ...rest } = DEFAULT_JOB_BUDGET;
    expect(jobBudgetSchema.safeParse(rest).success).toBe(true);
  });

  it("retryPolicySchema defaults to 3 attempts and bounds 1..10", () => {
    expect(retryPolicySchema.parse({})).toEqual({ max_attempts: 3 });
    expect(retryPolicySchema.safeParse({ max_attempts: 0 }).success).toBe(
      false,
    );
    expect(retryPolicySchema.safeParse({ max_attempts: 11 }).success).toBe(
      false,
    );
    expect(retryPolicySchema.safeParse({ max_attempts: 10 }).success).toBe(
      true,
    );
  });

  it("cleanupReportSchema defaults remaining_resource_kinds and rejects unknown status", () => {
    expect(cleanupReportSchema.parse({ status: "cleanup_complete" })).toEqual({
      status: "cleanup_complete",
      remaining_resource_kinds: [],
    });
    expect(cleanupReportSchema.safeParse({ status: "done" }).success).toBe(
      false,
    );
  });
});
