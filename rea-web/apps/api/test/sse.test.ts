import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type Account,
  type Harness,
  type RunnerHandle,
  createHarness,
  createRunner,
  describeDb,
  registerRunner,
  reportFor,
} from "./helpers/harness.js";
import {
  cancelQueuedJobs,
  claimOne,
  complete,
  postEvents,
  startInvestigation,
  transition,
} from "./helpers/flow.js";

interface Frame {
  id: number | null;
  event: string | null;
  data: unknown;
  comment: string | null;
}

/** Incremental `text/event-stream` reader with a hard deadline per wait. */
class SseReader {
  readonly frames: Frame[] = [];
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private lazyReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  ended = false;

  constructor(
    private readonly response: Response,
    private readonly abort: AbortController,
  ) {}

  /** Locks the body only on first read so error responses can still be consumed as text. */
  private get reader(): ReadableStreamDefaultReader<Uint8Array> {
    if (this.lazyReader === null) {
      if (this.response.body === null) throw new Error("response has no body");
      this.lazyReader = this.response.body.getReader();
    }
    return this.lazyReader;
  }

  private parse(block: string): void {
    const frame: Frame = {
      id: null,
      event: null,
      data: undefined,
      comment: null,
    };
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) frame.comment = line.slice(1).trim();
      else if (line.startsWith("id: ")) frame.id = Number(line.slice(4));
      else if (line.startsWith("event: ")) frame.event = line.slice(7);
      else if (line.startsWith("data: "))
        frame.data = JSON.parse(line.slice(6));
    }
    this.frames.push(frame);
  }

  private async pump(): Promise<void> {
    const { done, value } = await this.reader.read();
    if (done) {
      this.ended = true;
      return;
    }
    this.buffer += this.decoder.decode(value, { stream: true });
    let index = this.buffer.indexOf("\n\n");
    while (index !== -1) {
      this.parse(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index + 2);
      index = this.buffer.indexOf("\n\n");
    }
  }

  /** Reads until `predicate` holds over the frames so far, or fails at the deadline. */
  async until(
    predicate: (frames: readonly Frame[]) => boolean,
    timeoutMs = 8000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.frames)) {
      if (this.ended) throw new Error("stream ended before the condition held");
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(
          `timed out waiting for stream condition; saw ${JSON.stringify(this.frames)}`,
        );
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.pump(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timed out reading the stream")),
            remaining,
          );
        }),
      ]).finally(() => clearTimeout(timer));
    }
  }

  /** Reads to the end of the stream (server closed it) or fails at the deadline. */
  async untilClosed(timeoutMs = 8000): Promise<void> {
    await this.until(() => this.ended, timeoutMs).catch((error: unknown) => {
      if (!this.ended) throw error;
    });
  }

  eventIds(): number[] {
    return this.frames.flatMap((f) => (f.id === null ? [] : [f.id]));
  }

  close(): void {
    this.abort.abort();
    void this.lazyReader?.cancel().catch(() => undefined);
  }
}

describeDb("job event stream", () => {
  let h: Harness;
  let base: string;
  let owner: Account;
  let outsider: Account;
  let p: string;
  let runner: RunnerHandle;
  const open: SseReader[] = [];

  beforeAll(async () => {
    h = await createHarness();
    base = await h.listen();
    owner = await h.register("sse-owner@example.com");
    outsider = await h.register("sse-outsider@example.com");
    p = owner.defaultProjectId as string;
    runner = await createRunner(h, owner, p, "sse-runner");
    await registerRunner(h, runner, reportFor("sse-runner"));
  });
  afterAll(async () => {
    for (const reader of open) reader.close();
    await h.close();
  });

  const connect = async (
    jobId: string,
    headers: Record<string, string> = {},
    account: Account = owner,
  ): Promise<{ response: Response; reader: SseReader }> => {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 20000);
    timeout.unref();
    const response = await fetch(
      `${base}/api/v1/projects/${p}/jobs/${jobId}/events`,
      {
        headers: {
          accept: "text/event-stream",
          cookie: account.cookie,
          ...headers,
        },
        signal: abort.signal,
      },
    );
    const reader = new SseReader(response, abort);
    open.push(reader);
    return { response, reader };
  };

  const runningJob = async (name: string) => {
    await cancelQueuedJobs(h, owner, p);
    const setup = await startInvestigation(h, owner, p, {
      name,
      runnerId: runner.id,
    });
    const claimed = await claimOne(h, runner);
    expect(claimed.jobId).toBe(setup.jobId);
    expect(
      (await transition(h, runner, setup.jobId, claimed.token, "running"))
        .status,
    ).toBe(200);
    return { ...setup, token: claimed.token };
  };

  it("replays history, then resumes after Last-Event-ID with only later events", async () => {
    const job = await runningJob("resume.asar");
    const logged = await postEvents(h, runner, job.jobId, job.token, [
      { kind: "job.log", payload: { line: "one" } },
      { kind: "job.log", payload: { line: "two" } },
      { kind: "job.log", payload: { line: "three" } },
    ]);
    expect(logged.status).toBe(200);
    const all = await h.repos.jobEvents.listAfter(job.jobId, 0);
    const lastSeq = all[all.length - 1]?.seq as number;
    expect(lastSeq).toBeGreaterThanOrEqual(5);

    const full = await connect(job.jobId);
    expect(full.response.status).toBe(200);
    expect(full.response.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    await full.reader.until((frames) => frames.some((f) => f.id === lastSeq));
    expect(full.reader.eventIds()).toEqual(all.map((e) => e.seq));
    expect(full.reader.frames.some((f) => f.event === "job.log")).toBe(true);
    full.reader.close();

    const resumeFrom = lastSeq - 2;
    const resumed = await connect(job.jobId, {
      "last-event-id": String(resumeFrom),
    });
    await resumed.reader.until((frames) =>
      frames.some((f) => f.id === lastSeq),
    );
    expect(resumed.reader.eventIds()).toEqual([resumeFrom + 1, resumeFrom + 2]);
    const first = resumed.reader.frames.find((f) => f.id === resumeFrom + 1);
    expect(first?.data).toMatchObject({
      job_id: job.jobId,
      seq: resumeFrom + 1,
    });
    resumed.reader.close();

    await complete(h, runner, job.jobId, job.token, "succeeded");
  });

  it("delivers an event appended after the stream was opened", async () => {
    const job = await runningJob("live.asar");
    const before = await h.repos.jobEvents.listAfter(job.jobId, 0);
    const lastSeq = before[before.length - 1]?.seq as number;
    const { reader } = await connect(job.jobId);
    await reader.until((frames) => frames.some((f) => f.id === lastSeq));

    const appended = await postEvents(h, runner, job.jobId, job.token, [
      { kind: "job.log", payload: { line: "live" } },
    ]);
    expect(appended.status).toBe(200);
    await reader.until((frames) =>
      frames.some((f) => f.event === "job.log" && (f.id ?? 0) > lastSeq),
    );
    const live = reader.frames.find((f) => (f.id ?? 0) > lastSeq);
    expect(live?.data).toMatchObject({ payload: { line: "live" } });
    expect(reader.eventIds()).toEqual(
      [...reader.eventIds()].sort((a, b) => a - b),
    );

    // An event written straight to the table (no API call) is also delivered.
    const direct = await h.repos.jobEvents.append(
      undefined,
      job.jobId,
      "job.log",
      {
        line: "direct",
      },
    );
    await reader.until((frames) => frames.some((f) => f.id === direct.seq));
    reader.close();
    await complete(h, runner, job.jobId, job.token, "succeeded");
  });

  it("flushes remaining events, announces the end and closes on a terminal state", async () => {
    const job = await runningJob("terminal.asar");
    const { reader } = await connect(job.jobId);
    await reader.until((frames) =>
      frames.some((f) => f.event === "job.transition"),
    );

    const done = await complete(h, runner, job.jobId, job.token, "succeeded");
    expect(done.status).toBe(200);
    await reader.untilClosed();
    expect(reader.ended).toBe(true);

    const all = await h.repos.jobEvents.listAfter(job.jobId, 0);
    const finalSeq = all[all.length - 1]?.seq as number;
    const ids = reader.eventIds();
    expect(ids[ids.length - 1]).toBe(finalSeq);
    expect(ids).toEqual(all.map((e) => e.seq));
    const end = reader.frames[reader.frames.length - 1];
    expect(end?.event).toBe("stream_end");
    expect(end?.data).toMatchObject({
      job_id: job.jobId,
      state: "succeeded",
      last_seq: finalSeq,
    });
  });

  it("closes immediately after replay when the job is already terminal", async () => {
    const setup = await startInvestigation(h, owner, p, {
      name: "cancelled.asar",
      runnerId: runner.id,
    });
    const cancel = await h.api(
      "POST",
      `/api/v1/projects/${p}/jobs/${setup.jobId}/cancel`,
      {
        auth: owner.auth,
      },
    );
    expect(cancel.json.state).toBe("cancelled");
    const { reader } = await connect(setup.jobId);
    await reader.untilClosed();
    expect(reader.frames[reader.frames.length - 1]?.event).toBe("stream_end");
    expect(reader.frames[reader.frames.length - 1]?.data).toMatchObject({
      state: "cancelled",
    });
  });

  it("rejects another project's job with a JSON error and writes no stream bytes", async () => {
    const setup = await startInvestigation(h, owner, p, {
      name: "private.asar",
      runnerId: runner.id,
    });
    const { response, reader } = await connect(setup.jobId, {}, outsider);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const text = await response.text();
    expect(text).not.toContain("retry:");
    expect(text).not.toContain("event:");
    expect(JSON.parse(text).error.code).toBe("not_found");
    reader.close();

    const anonymous = await fetch(
      `${base}/api/v1/projects/${p}/jobs/${setup.jobId}/events`,
      {
        headers: { accept: "text/event-stream" },
        signal: AbortSignal.timeout(8000),
      },
    );
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("content-type")).toContain("application/json");
    await anonymous.text();
  });

  it("sends keep-alive comments while idle", async () => {
    const job = await runningJob("ping.asar");
    const { reader } = await connect(job.jobId);
    await reader.until((frames) => frames.some((f) => f.comment === "ping"));
    reader.close();
    await complete(h, runner, job.jobId, job.token, "succeeded");
  });
});
