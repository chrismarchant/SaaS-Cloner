import { jobEventSchema, type JobEvent } from "@rea-web/contracts/browser";

/** Keeps events unique by `seq` and ordered; reconnects may replay frames. */
export const mergeEvents = (
  existing: readonly JobEvent[],
  incoming: readonly JobEvent[],
): JobEvent[] => {
  const bySeq = new Map<number, JobEvent>();
  for (const event of existing) bySeq.set(event.seq, event);
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
};

export const parseEventData = (data: string): JobEvent | null => {
  try {
    const parsed = jobEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export interface StreamEnd {
  readonly jobId: string;
  readonly state: string;
  readonly lastSeq: number;
}

export const parseStreamEnd = (data: string): StreamEnd | null => {
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    return typeof record["job_id"] === "string" &&
      typeof record["state"] === "string" &&
      typeof record["last_seq"] === "number"
      ? {
          jobId: record["job_id"],
          state: record["state"],
          lastSeq: record["last_seq"],
        }
      : null;
  } catch {
    return null;
  }
};

const SUMMARY_KEYS = [
  "message",
  "tool",
  "to",
  "decision",
  "state",
  "reason",
  "code",
] as const;

/** Short text for a timeline row, built only from fields the event carries. */
export const summariseEvent = (event: JobEvent): string => {
  const parts: string[] = [];
  const payload = event.payload;
  const from = payload["from"];
  const to = payload["to"];
  if (typeof from === "string" && typeof to === "string")
    parts.push(`${from} -> ${to}`);
  for (const key of SUMMARY_KEYS) {
    if (key === "to" && typeof from === "string") continue;
    const value = payload[key];
    if (typeof value === "string" || typeof value === "number")
      parts.push(key === "message" ? String(value) : `${key}: ${value}`);
  }
  if (typeof payload["seq"] === "number") parts.push(`call #${payload["seq"]}`);
  if (payload["is_error"] === true) parts.push("error result");
  return parts.join(" · ");
};
