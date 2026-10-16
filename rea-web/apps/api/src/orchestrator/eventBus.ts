import { JOB_EVENTS_CHANNEL, type Database } from "@rea-web/db";
import type { TxClient } from "../db/extra.js";

type PoolClient = TxClient;

export interface JobEventBus {
  /** Calls `listener` whenever events are appended to `jobId` (or after a reconnect). */
  subscribe(jobId: string, listener: () => void): () => void;
  /** Calls `listener` for every job's events (claim wake-ups). */
  subscribeAll(listener: (jobId: string | null) => void): () => void;
  start(): Promise<void>;
  close(): Promise<void>;
  readonly connected: boolean;
}

export interface JobEventBusOptions {
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * One dedicated `LISTEN job_events` connection per process, fanned out by job
 * id. Notifications are a wake-up hint only: consumers re-read the table, so a
 * missed notification during a reconnect is repaired by the post-reconnect
 * broadcast (job id `null` wakes every subscriber).
 */
export const createJobEventBus = (
  db: Database,
  options: JobEventBusOptions = {},
): JobEventBus => {
  const perJob = new Map<string, Set<() => void>>();
  const all = new Set<(jobId: string | null) => void>();
  let client: PoolClient | null = null;
  let closed = false;
  let connecting: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let attempt = 0;
  const minMs = options.reconnectMinMs ?? 250;
  const maxMs = options.reconnectMaxMs ?? 5000;

  const guarded = (fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      options.onError?.(error);
    }
  };

  const notify = (jobId: string | null): void => {
    if (jobId === null) {
      for (const listeners of perJob.values())
        for (const listener of listeners) guarded(listener);
    } else {
      for (const listener of perJob.get(jobId) ?? []) guarded(listener);
    }
    for (const listener of all) guarded(() => listener(jobId));
  };

  const scheduleReconnect = (): void => {
    if (closed || timer !== null) return;
    const delay = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 10));
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, delay);
    timer.unref();
  };

  const detach = new Map<PoolClient, () => void>();

  const attach = (active: PoolClient): (() => void) => {
    const onNotification = (message: {
      channel: string;
      payload?: string | undefined;
    }): void => {
      if (message.channel === JOB_EVENTS_CHANNEL)
        notify(message.payload ?? null);
    };
    const onError = (error: Error): void => drop(active, error);
    const onEnd = (): void => drop(active, new Error("listener ended"));
    active.on("notification", onNotification);
    active.on("error", onError);
    active.on("end", onEnd);
    return () => {
      active.off("notification", onNotification);
      active.off("error", onError);
      active.off("end", onEnd);
    };
  };

  const drop = (current: PoolClient, error: unknown): void => {
    if (client !== current) return;
    client = null;
    detach.get(current)?.();
    detach.delete(current);
    options.onError?.(error);
    try {
      current.release(
        error instanceof Error ? error : new Error("listener lost"),
      );
    } catch {
      // already released
    }
    scheduleReconnect();
  };

  const connect = (): Promise<void> => {
    if (closed || client !== null) return Promise.resolve();
    connecting ??= (async () => {
      let candidate: PoolClient | null = null;
      try {
        candidate = await db.pool.connect();
        if (closed) {
          candidate.release();
          return;
        }
        const active = candidate;
        detach.set(active, attach(active));
        await active.query(`LISTEN ${JOB_EVENTS_CHANNEL}`);
        client = active;
        attempt = 0;
        // Anything appended while the listener was down is only in the table.
        notify(null);
      } catch (error) {
        if (candidate !== null) {
          detach.get(candidate)?.();
          detach.delete(candidate);
          try {
            candidate.release(
              error instanceof Error ? error : new Error("listen failed"),
            );
          } catch {
            // already released
          }
        }
        options.onError?.(error);
        scheduleReconnect();
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  };

  return {
    get connected() {
      return client !== null;
    },
    subscribe(jobId, listener) {
      let listeners = perJob.get(jobId);
      if (listeners === undefined) {
        listeners = new Set();
        perJob.set(jobId, listeners);
      }
      listeners.add(listener);
      return () => {
        const set = perJob.get(jobId);
        set?.delete(listener);
        if (set !== undefined && set.size === 0) perJob.delete(jobId);
      };
    },
    subscribeAll(listener) {
      all.add(listener);
      return () => {
        all.delete(listener);
      };
    },
    start: connect,
    async close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      await connecting;
      const current = client;
      client = null;
      if (current !== null) {
        try {
          await current.query(`UNLISTEN ${JOB_EVENTS_CHANNEL}`);
        } catch {
          // connection may already be gone
        }
        detach.get(current)?.();
        detach.delete(current);
        current.release();
      }
      perJob.clear();
      all.clear();
    },
  };
};
