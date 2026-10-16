import { z } from "zod";

export const JOB_STATES = [
  "queued",
  "preparing",
  "running",
  "awaiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type JobState = (typeof JOB_STATES)[number];
export const jobStateSchema = z.enum(JOB_STATES);

export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export const JOB_KINDS = [
  "investigation.run",
  "investigation.follow_up",
  "investigation.compare",
  "investigation.export",
  "preservation.plan",
  "preservation.capture",
  "recovery.verify",
  "recovery.export",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const jobKindSchema = z.enum(JOB_KINDS);

/** Who may cause a transition. The API enforces this per endpoint. */
export type TransitionActor = "runner" | "user" | "system";

interface Transition {
  readonly from: JobState;
  readonly to: JobState;
  readonly actors: readonly TransitionActor[];
}

export const JOB_TRANSITIONS: readonly Transition[] = [
  { from: "queued", to: "preparing", actors: ["system"] },
  { from: "queued", to: "cancelled", actors: ["user", "system"] },
  { from: "preparing", to: "running", actors: ["runner"] },
  { from: "preparing", to: "failed", actors: ["runner", "system"] },
  { from: "preparing", to: "cancelled", actors: ["runner"] },
  { from: "preparing", to: "interrupted", actors: ["system"] },
  { from: "running", to: "awaiting_approval", actors: ["runner"] },
  { from: "running", to: "succeeded", actors: ["runner"] },
  { from: "running", to: "failed", actors: ["runner", "system"] },
  { from: "running", to: "cancelled", actors: ["runner"] },
  { from: "running", to: "interrupted", actors: ["system"] },
  { from: "awaiting_approval", to: "running", actors: ["runner"] },
  { from: "awaiting_approval", to: "cancelled", actors: ["runner", "system"] },
  { from: "awaiting_approval", to: "interrupted", actors: ["system"] },
  { from: "interrupted", to: "queued", actors: ["system"] },
  { from: "interrupted", to: "failed", actors: ["system"] },
];

export const canTransition = (
  from: JobState,
  to: JobState,
  actor: TransitionActor,
): boolean =>
  JOB_TRANSITIONS.some(
    (t) => t.from === from && t.to === to && t.actors.includes(actor),
  );

export const jobBudgetSchema = z.object({
  wall_ms: z.number().int().positive(),
  cpu_ms: z.number().int().positive().optional(),
  memory_bytes: z.number().int().positive().optional(),
  disk_bytes: z.number().int().positive(),
  tool_calls: z.number().int().nonnegative(),
  model_input_tokens: z.number().int().nonnegative(),
  model_output_tokens: z.number().int().nonnegative(),
  artifact_bytes: z.number().int().positive(),
});
export type JobBudget = z.infer<typeof jobBudgetSchema>;

export const DEFAULT_JOB_BUDGET: JobBudget = {
  wall_ms: 30 * 60_000,
  cpu_ms: 20 * 60_000,
  memory_bytes: 4 * 1024 * 1024 * 1024,
  disk_bytes: 10 * 1024 * 1024 * 1024,
  tool_calls: 200,
  model_input_tokens: 400_000,
  model_output_tokens: 60_000,
  artifact_bytes: 2 * 1024 * 1024 * 1024,
};

export const jobBudgetUsageSchema = z.object({
  wall_ms: z.number().int().nonnegative(),
  cpu_ms: z.number().int().nonnegative(),
  memory_bytes_peak: z.number().int().nonnegative(),
  disk_bytes: z.number().int().nonnegative(),
  tool_calls: z.number().int().nonnegative(),
  model_input_tokens: z.number().int().nonnegative(),
  model_output_tokens: z.number().int().nonnegative(),
  artifact_bytes: z.number().int().nonnegative(),
});
export type JobBudgetUsage = z.infer<typeof jobBudgetUsageSchema>;

export const ZERO_USAGE: JobBudgetUsage = {
  wall_ms: 0,
  cpu_ms: 0,
  memory_bytes_peak: 0,
  disk_bytes: 0,
  tool_calls: 0,
  model_input_tokens: 0,
  model_output_tokens: 0,
  artifact_bytes: 0,
};

/** Returns the first exceeded dimension, or null. */
export const exceededBudgetDimension = (
  budget: JobBudget,
  usage: JobBudgetUsage,
): keyof JobBudget | null => {
  if (usage.wall_ms > budget.wall_ms) return "wall_ms";
  if (budget.cpu_ms !== undefined && usage.cpu_ms > budget.cpu_ms)
    return "cpu_ms";
  if (
    budget.memory_bytes !== undefined &&
    usage.memory_bytes_peak > budget.memory_bytes
  )
    return "memory_bytes";
  if (usage.disk_bytes > budget.disk_bytes) return "disk_bytes";
  if (usage.tool_calls > budget.tool_calls) return "tool_calls";
  if (usage.model_input_tokens > budget.model_input_tokens)
    return "model_input_tokens";
  if (usage.model_output_tokens > budget.model_output_tokens)
    return "model_output_tokens";
  if (usage.artifact_bytes > budget.artifact_bytes) return "artifact_bytes";
  return null;
};

/** Upstream effect vocabulary (closed set, mirrors REA `effects`). */
export const TOOL_EFFECTS = [
  "accessesNetwork",
  "changesUiState",
  "executesForeignCode",
  "idempotent",
  "launchesProcess",
  "mayDiscardData",
  "mutatesDevice",
  "mutatesSession",
  "mutatesTarget",
  "writesFilesystem",
] as const;
export type ToolEffect = (typeof TOOL_EFFECTS)[number];
export const toolEffectSchema = z.enum(TOOL_EFFECTS);

export const DEFAULT_APPROVAL_EFFECTS: readonly ToolEffect[] = [
  "executesForeignCode",
  "mutatesDevice",
  "mayDiscardData",
  "accessesNetwork",
];

export const jobRequirementsSchema = z.object({
  tools: z.array(z.string().min(1)).default([]),
  providers: z.array(z.string().min(1)).default([]),
  os: z.array(z.enum(["linux", "darwin", "win32"])).default([]),
  labels: z.array(z.string().min(1)).default([]),
  effects: z.array(toolEffectSchema).default([]),
});
export type JobRequirements = z.infer<typeof jobRequirementsSchema>;

export const jobFailureSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  retryable: z.boolean(),
});
export type JobFailure = z.infer<typeof jobFailureSchema>;

export const cleanupReportSchema = z.object({
  status: z.enum(["cleanup_complete", "cleanup_incomplete", "not_attempted"]),
  remaining_resource_kinds: z.array(z.string()).default([]),
  detail: z.string().optional(),
});
export type CleanupReport = z.infer<typeof cleanupReportSchema>;

export const JOB_EVENT_KINDS = [
  "job.created",
  "job.claimed",
  "job.transition",
  "job.progress",
  "job.log",
  "job.tool_call",
  "job.approval_requested",
  "job.approval_decided",
  "job.budget",
  "job.cancel_requested",
  "job.stale_rejected",
  "job.cleanup",
  "job.completed",
] as const;
export type JobEventKind = (typeof JOB_EVENT_KINDS)[number];

export const jobEventSchema = z.object({
  job_id: z.string(),
  seq: z.number().int().positive(),
  kind: z.enum(JOB_EVENT_KINDS),
  payload: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});
export type JobEvent = z.infer<typeof jobEventSchema>;

export const retryPolicySchema = z.object({
  max_attempts: z.number().int().min(1).max(10).default(3),
});
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

export const jobSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  kind: jobKindSchema,
  state: jobStateSchema,
  attempt: z.number().int().positive(),
  requirements: jobRequirementsSchema,
  budget: jobBudgetSchema,
  usage: jobBudgetUsageSchema,
  input: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).nullable(),
  failure: jobFailureSchema.nullable(),
  cancel_requested_at: z.string().nullable(),
  lease: z
    .object({
      runner_id: z.string(),
      fencing_token: z.number().int().positive(),
      expires_at: z.string(),
    })
    .nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Job = z.infer<typeof jobSchema>;
