import type { OutgoingHttpHeaders } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
import { TERMINAL_JOB_STATES } from "@rea-web/contracts";
import type { JobEventRecord, JobRecord } from "@rea-web/db";
import type { AppContext } from "../context.js";
import { STREAMED, type Streamed } from "./types.js";

export const eventView = (event: JobEventRecord) => ({
  job_id: event.job_id,
  seq: event.seq,
  kind: event.kind,
  payload: event.payload,
  created_at: event.created_at,
});

const frame = (event: JobEventRecord): string =>
  `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(eventView(event))}\n\n`;

const PAGE = 200;

/** Parses `Last-Event-ID`; anything that is not a non-negative integer is ignored. */
export const parseLastEventId = (
  header: string | string[] | undefined,
): number | null => {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || !/^\d{1,15}$/u.test(value)) return null;
  return Number(value);
};

/**
 * Whether the client wants a stream. An explicit `text/event-stream` wins;
 * otherwise `?after=` or an explicit JSON preference selects the JSON page.
 */
export const wantsEventStream = (
  accept: string | undefined,
  after: number | undefined,
): boolean => {
  const header = accept ?? "";
  if (header.includes("text/event-stream")) return true;
  if (after !== undefined) return false;
  return !header.includes("application/json");
};

/**
 * Replays persisted events after `afterSeq`, then tails new ones. Authorisation
 * and job lookup happen before this is called, so a rejected request never
 * receives stream headers. Notifications are only a wake-up: every wake re-reads
 * the table, which keeps delivery ordered and gap-free across reconnects.
 */
export const streamJobEvents = (
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  job: JobRecord,
  afterSeq: number,
): Streamed => {
  const headers: OutgoingHttpHeaders = {
    ...(reply.getHeaders() as OutgoingHttpHeaders),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-request-id": req.id,
  };
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, headers);
  raw.flushHeaders();

  let closed = false;
  let lastSeq = afterSeq;
  let draining = false;
  let again = false;
  let unsubscribe: (() => void) | null = null;
  let ping: NodeJS.Timeout | null = null;

  let wakeClosed: () => void = () => undefined;
  const closedSignal = new Promise<void>((resolve) => {
    wakeClosed = resolve;
  });

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    if (ping !== null) clearInterval(ping);
    wakeClosed();
  };

  const write = async (chunk: string): Promise<void> => {
    if (closed || raw.writableEnded || raw.destroyed) return;
    if (!raw.write(chunk))
      await Promise.race([
        new Promise<void>((resolve) => raw.once("drain", resolve)),
        closedSignal,
      ]);
  };

  const finish = async (state: string): Promise<void> => {
    await write(
      `event: stream_end\ndata: ${JSON.stringify({ job_id: job.id, state, last_seq: lastSeq })}\n\n`,
    );
    cleanup();
    if (!raw.writableEnded) raw.end();
  };

  const drainOnce = async (): Promise<boolean> => {
    // State is read before events: terminal-state writes commit with their
    // final events, so a terminal state guarantees nothing is left unread.
    const current = await ctx.repos.jobs.findById(job.id);
    for (;;) {
      if (closed) return false;
      const rows = await ctx.repos.jobEvents.listAfter(job.id, lastSeq, PAGE);
      for (const row of rows) {
        await write(frame(row));
        lastSeq = row.seq;
      }
      if (rows.length < PAGE) break;
    }
    if (current === null || TERMINAL_JOB_STATES.has(current.state)) {
      await finish(current?.state ?? "deleted");
      return true;
    }
    return false;
  };

  const drain = async (): Promise<void> => {
    if (draining) {
      again = true;
      return;
    }
    draining = true;
    try {
      do {
        again = false;
        if (await drainOnce()) return;
      } while (again && !closed);
    } catch (error) {
      ctx.logger.warn({ err: error, job_id: job.id }, "sse drain failed");
      cleanup();
      raw.destroy();
    } finally {
      draining = false;
    }
  };

  req.raw.once("close", cleanup);
  raw.once("close", cleanup);
  // Subscribe before the first read so nothing appended in between is missed.
  unsubscribe = ctx.bus.subscribe(job.id, () => void drain());
  ping = setInterval(() => {
    void write(": ping\n\n");
    void drain();
  }, ctx.config.ssePingMs);
  ping.unref();

  void write("retry: 2000\n\n").then(() => drain());
  return STREAMED;
};
