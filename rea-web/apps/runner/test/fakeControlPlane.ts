import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_JOB_BUDGET,
  ZERO_USAGE,
  uuidv7,
  type CapabilityReport,
  type Job,
  type JobBudget,
} from "@rea-web/contracts";

/**
 * In-process stand-in for the runner protocol (docs/API.md "Runner protocol").
 * It is a test double for the control plane only; the REA session the runner
 * drives is the real upstream server.
 */
export interface FakeJob {
  job: Job;
  fencing: number;
  targetPath: string | null;
  events: { kind: string; payload: Record<string, unknown> }[];
  toolCalls: Record<string, unknown>[];
  findings: Record<string, unknown>[];
  artifacts: { kind: string; name: string; key: string; bytes: Buffer }[];
  transitions: string[];
  completion: Record<string, unknown> | null;
  cancelRequested: boolean;
  rejectLease: boolean;
  approvals: { approval_id: string; decision: "approved" | "rejected" }[];
  pendingApprovals: Record<string, unknown>[];
}

export class FakeControlPlane {
  readonly token = "rwr_test_runner_token_value";
  report: CapabilityReport | null = null;
  readonly jobs = new Map<string, FakeJob>();
  private readonly queue: string[] = [];
  private server: Server | null = null;
  url = "";
  /** Automatic decision for approval requests (null = wait for test). */
  autoApproval: "approved" | "rejected" | null = null;
  readonly staleRejections: string[] = [];
  /** Per-investigation timeline: upstream call key -> allocated seq. */
  readonly timeline = new Map<string, Map<string, number>>();

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server?.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  enqueue(
    kind: Job["kind"],
    input: Record<string, unknown>,
    opts: { targetPath?: string; budget?: Partial<JobBudget> } = {},
  ): FakeJob {
    const now = new Date().toISOString();
    const job: Job = {
      id: uuidv7(),
      project_id: uuidv7(),
      kind,
      state: "queued",
      attempt: 1,
      requirements: {
        tools: [],
        providers: [],
        os: [],
        labels: [],
        effects: [],
      },
      budget: { ...DEFAULT_JOB_BUDGET, ...opts.budget },
      usage: { ...ZERO_USAGE },
      input,
      result: null,
      failure: null,
      cancel_requested_at: null,
      lease: null,
      created_at: now,
      updated_at: now,
    };
    const fake: FakeJob = {
      job,
      fencing: 0,
      targetPath: opts.targetPath ?? null,
      events: [],
      toolCalls: [],
      findings: [],
      artifacts: [],
      transitions: [],
      completion: null,
      cancelRequested: false,
      rejectLease: false,
      approvals: [],
      pendingApprovals: [],
    };
    this.jobs.set(job.id, fake);
    this.queue.push(job.id);
    return fake;
  }

  async waitFor(predicate: () => boolean, timeoutMs = 180_000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > timeoutMs)
        throw new Error("timed out waiting for fake control plane state");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  private send(res: ServerResponse, status: number, body?: unknown): void {
    res.statusCode = status;
    if (body === undefined) return void res.end();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }

  private fenced(
    res: ServerResponse,
    fake: FakeJob | undefined,
    token: unknown,
  ): fake is FakeJob {
    if (!fake) {
      this.send(res, 404, {
        error: { code: "not_found", message: "job", request_id: "t" },
      });
      return false;
    }
    if (Number(token) !== fake.fencing || fake.rejectLease) {
      this.staleRejections.push(fake.job.id);
      this.send(res, 409, {
        error: {
          code: "stale_lease",
          message: "stale fencing token",
          request_id: "t",
        },
      });
      return false;
    }
    return true;
  }

  private jobView(fake: FakeJob): Job {
    return {
      ...fake.job,
      lease:
        fake.fencing > 0
          ? {
              runner_id: "runner-1",
              fencing_token: fake.fencing,
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            }
          : null,
    };
  }

  // eslint-disable-next-line complexity
  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.token}`)
      return this.send(res, 401, {
        error: { code: "unauthorized", message: "bad token", request_id: "t" },
      });
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname.replace(/^\/api\/v1/u, "");
    const raw = await this.body(req);
    const json = (): Record<string, unknown> =>
      raw.length
        ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>)
        : {};
    let m: RegExpMatchArray | null;
    if (path === "/runners/register" && req.method === "POST") {
      this.report = json() as unknown as CapabilityReport;
      return this.send(res, 200, {
        runner_id: "0192f1a0-0000-7000-8000-00000000aaaa",
        server_time: new Date().toISOString(),
        protocol_version: 1,
        lease_ttl_ms: 60_000,
        heartbeat_interval_ms: 200,
      });
    }
    if ((m = path.match(/^\/runners\/[^/]+\/claim$/u))) {
      const id = this.queue.shift();
      if (!id) {
        await new Promise((r) => setTimeout(r, 100));
        return this.send(res, 204);
      }
      const fake = this.jobs.get(id) as FakeJob;
      fake.fencing += 1;
      fake.job = { ...fake.job, state: "preparing" };
      return this.send(res, 200, {
        job: this.jobView(fake),
        fencing_token: fake.fencing,
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    if ((m = path.match(/^\/runners\/[^/]+\/heartbeat$/u))) {
      const leases = (json()["leases"] ?? []) as {
        job_id: string;
        fencing_token: number;
      }[];
      return this.send(res, 200, {
        leases: leases.map((l) => {
          const fake = this.jobs.get(l.job_id);
          if (!fake || fake.rejectLease || fake.fencing !== l.fencing_token)
            return {
              job_id: l.job_id,
              fencing_token: l.fencing_token,
              accepted: false,
              reason: "stale_lease",
              cancel_requested: false,
              approvals: [],
            };
          const approvals = fake.approvals.splice(0).map((a) => ({
            ...a,
            decided_by: "tester",
            decided_at: new Date().toISOString(),
          }));
          return {
            job_id: l.job_id,
            fencing_token: l.fencing_token,
            accepted: true,
            cancel_requested: fake.cancelRequested,
            approvals,
          };
        }),
      });
    }
    if (!(m = path.match(/^\/jobs\/([^/]+)\/(.+)$/u)))
      return this.send(res, 404, {
        error: { code: "not_found", message: path, request_id: "t" },
      });
    const fake = this.jobs.get(m[1] as string);
    const action = m[2] as string;
    if (action === "inputs/target") {
      if (!this.fenced(res, fake, req.headers["x-fencing-token"])) return;
      if (!fake.targetPath)
        return this.send(res, 404, {
          error: { code: "not_found", message: "no target", request_id: "t" },
        });
      res.statusCode = 200;
      createReadStream(fake.targetPath).pipe(res);
      return;
    }
    if (action === "artifacts/upload") {
      if (!this.fenced(res, fake, req.headers["x-fencing-token"])) return;
      const key = `fake/${fake.job.id}/${String(req.headers["x-artifact-kind"])}/${fake.artifacts.length}`;
      fake.artifacts.push({
        kind: String(req.headers["x-artifact-kind"]),
        name: String(req.headers["x-artifact-name"]),
        key,
        bytes: raw,
      });
      return this.send(res, 201, {
        object_key: key,
        sha256: createHash("sha256").update(raw).digest("hex"),
        size: raw.length,
        artifact_id: null,
      });
    }
    const body = json();
    if (!this.fenced(res, fake, body["fencing_token"])) return;
    if (action === "events") {
      fake.events.push(...(body["events"] as FakeJob["events"]));
      return this.send(res, 200, { seqs: [] });
    }
    if (action === "tool-calls") {
      // Like the real control plane: the investigation timeline seq is
      // allocated here, idempotently per (upstream_session_id, upstream_seq).
      const investigation = String(body["investigation_id"]);
      const key = `${String(body["upstream_session_id"])}#${String(body["upstream_seq"])}`;
      const calls = (this.timeline.get(investigation) ?? new Map()) as Map<
        string,
        number
      >;
      this.timeline.set(investigation, calls);
      let seq = calls.get(key);
      if (seq === undefined) {
        seq = calls.size + 1;
        calls.set(key, seq);
        fake.toolCalls.push({ ...body, seq });
      }
      return this.send(res, 201, { ...body, seq });
    }
    if (action === "findings") {
      fake.findings.push(...(body["findings"] as Record<string, unknown>[]));
      return this.send(res, 201, {
        count: (body["findings"] as unknown[]).length,
      });
    }
    if (action === "transition") {
      const to = String(body["to"]);
      fake.transitions.push(to);
      fake.job = { ...fake.job, state: to as Job["state"] };
      if (to === "awaiting_approval") {
        const approval = body["approval"] as Record<string, unknown>;
        fake.pendingApprovals.push(approval);
        if (this.autoApproval)
          fake.approvals.push({
            approval_id: String(approval["approval_id"]),
            decision: this.autoApproval,
          });
      }
      return this.send(res, 200, this.jobView(fake));
    }
    if (action === "complete") {
      fake.completion = body;
      fake.job = { ...fake.job, state: body["outcome"] as Job["state"] };
      return this.send(res, 200, this.jobView(fake));
    }
    return this.send(res, 404, {
      error: { code: "not_found", message: action, request_id: "t" },
    });
  }
}
