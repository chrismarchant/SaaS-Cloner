import { z } from "zod";
import {
  verificationScopeSchema,
  verificationStatusSchema,
} from "./vocabulary.js";

/**
 * Report written by the standalone verifier/restorer (`rea-recover`) for one
 * run against one package. It is written outside the package (packages are
 * immutable once finalized) and uploaded by the runner as the verification
 * record. Statuses use the RECOVERY-FORMAT vocabulary; no percentage is ever
 * derived from them.
 */
export const RESTORE_REPORT_FORMAT = "rea-web-recovery-report" as const;

const tail = z.string().max(16_384);

export const restoreStepResultSchema = z.object({
  component_id: z.string(),
  step_id: z.string(),
  title: z.string(),
  /** Arguments as executed, with secret-bearing values replaced. */
  argv: z.array(z.string()),
  cwd: z.string(),
  network: z.enum(["none", "database", "registry", "unknown"]),
  /** Whether outbound network other than the step's class was denied. */
  network_isolated: z.boolean(),
  status: z.enum(["passed", "failed", "skipped", "blocked"]),
  exit_code: z.number().int().nullable(),
  signal: z.string().nullable(),
  timed_out: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
  stdout_tail: tail,
  stderr_tail: tail,
  reason: z.string().optional(),
});

export const invariantResultSchema = z.object({
  id: z.string(),
  sql_sha256: z.string(),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
  ok: z.boolean(),
  detail: z.string().optional(),
});

export const scopeResultSchema = z.object({
  scope: verificationScopeSchema,
  status: verificationStatusSchema,
  detail: z.string(),
  performed_at: z.string(),
  missing_tools: z.array(z.string()).default([]),
  steps: z.array(restoreStepResultSchema).default([]),
  invariants: z.array(invariantResultSchema).default([]),
});

export const restoreReportSchema = z.object({
  format: z.literal(RESTORE_REPORT_FORMAT),
  format_version: z.literal(1),
  package_id: z.string(),
  manifest_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  started_at: z.string(),
  finished_at: z.string(),
  verifier: z.object({
    name: z.literal("rea-recover"),
    version: z.string(),
    node: z.string(),
    platform: z.string(),
  }),
  /** How outbound network was denied for steps that need none. */
  network_isolation: z.object({
    mechanism: z.enum(["linux-network-namespace", "none"]),
    available: z.boolean(),
    detail: z.string(),
  }),
  guards: z.object({
    blocked_hosts: z.array(z.string()),
    database_host: z.string().nullable(),
    disabled_schedules: z.array(z.string()),
    disabled_webhooks: z.array(z.string()),
  }),
  scopes: z.array(scopeResultSchema),
  network_required: z.object({
    verdict: z.enum(["yes", "no", "unknown"]),
    reasons: z.array(z.string()),
  }),
  /** Overall status: the scope status when one scope ran, else `partial` unless all verified. */
  overall: verificationStatusSchema,
});
export type RestoreReport = z.infer<typeof restoreReportSchema>;
export type ScopeResult = z.infer<typeof scopeResultSchema>;
export type RestoreStepResult = z.infer<typeof restoreStepResultSchema>;
export type InvariantResult = z.infer<typeof invariantResultSchema>;
