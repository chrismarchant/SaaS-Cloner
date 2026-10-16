/**
 * The API has no list route for plans, captures, verifications or exports.
 * Each is created by a job whose input names it, so the project's jobs of a
 * kind, filtered by those inputs, are the only way to find earlier ones.
 */
import type { Job } from "@rea-web/contracts/browser";

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** Jobs whose input names `value` under `field`, newest first. */
export const jobsWhere = (
  jobs: readonly Job[],
  field: string,
  value: string,
): Job[] =>
  jobs
    .filter((job) => job.input[field] === value)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

/** The id of the resource a job produced, from the job input field `field`. */
export const producedId = (job: Job, field: string): string | null =>
  text(job.input[field]);
