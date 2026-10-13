import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { JOB_EVENT_KINDS, type JobEvent } from "@rea-web/contracts/browser";
import {
  mergeEvents,
  parseEventData,
  parseStreamEnd,
  type StreamEnd,
} from "../lib/events";
import { API_PREFIX } from "./client";
import { keys } from "./hooks";

export type StreamStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "ended"
  | "failed";

export interface JobStream {
  readonly events: readonly JobEvent[];
  readonly status: StreamStatus;
  readonly end: StreamEnd | null;
}

/** Events that change what the job panel shows beyond the timeline itself. */
const REFRESH_KINDS = new Set<string>([
  "job.transition",
  "job.completed",
  "job.budget",
  "job.approval_requested",
  "job.approval_decided",
  "job.cancel_requested",
  "job.cleanup",
]);

/**
 * Follows a job's server-sent events. The server names each frame by event
 * kind, so a listener per kind is registered; `stream_end` closes the source
 * (otherwise the browser would reconnect forever). Reconnection and
 * `Last-Event-ID` are handled by `EventSource` itself; frames replayed after a
 * reconnect are de-duplicated by `seq`.
 */
export const useJobStream = (
  projectId: string,
  jobId: string | null,
): JobStream => {
  const client = useQueryClient();
  const [events, setEvents] = useState<readonly JobEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [end, setEnd] = useState<StreamEnd | null>(null);
  const pending = useRef<JobEvent[]>([]);

  useEffect(() => {
    setEvents([]);
    setEnd(null);
    setStatus("connecting");
    pending.current = [];
    if (jobId === null || typeof EventSource === "undefined") return;
    const source = new EventSource(
      `${API_PREFIX}/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/events`,
    );
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      flushTimer = null;
      const batch = pending.current;
      pending.current = [];
      if (batch.length === 0) return;
      setEvents((current) => mergeEvents(current, batch));
      if (batch.some((event) => REFRESH_KINDS.has(event.kind))) {
        void client.invalidateQueries({ queryKey: keys.job(projectId, jobId) });
        void client.invalidateQueries({
          queryKey: keys.approvals(projectId, jobId),
        });
      }
    };
    const onFrame = (message: MessageEvent<string>): void => {
      const event = parseEventData(message.data);
      if (event === null) return;
      pending.current.push(event);
      flushTimer ??= setTimeout(flush, 100);
    };
    for (const kind of JOB_EVENT_KINDS) source.addEventListener(kind, onFrame);
    source.onopen = () => setStatus("open");
    source.onerror = () =>
      setStatus(
        source.readyState === EventSource.CLOSED ? "failed" : "reconnecting",
      );
    source.addEventListener("stream_end", (message) => {
      flush();
      source.close();
      setEnd(parseStreamEnd((message as MessageEvent<string>).data));
      setStatus("ended");
      void client.invalidateQueries({ queryKey: keys.project(projectId) });
    });
    return () => {
      source.close();
      if (flushTimer !== null) clearTimeout(flushTimer);
    };
  }, [client, projectId, jobId]);

  return { events, status, end };
};
