/**
 * G05: a local companion runner next to a cloud runner. The companion
 * registers its allowlisted paths as runner-local targets (by path_hash only,
 * never the path) and investigations of those targets run on it, resolved
 * from its allowlist without uploading anything. The cloud runner cannot
 * claim them.
 */
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { investigationSchema, targetSchema } from "@rea-web/contracts";
import { localPathHash } from "../../apps/runner/src/preservation/localPaths.js";
import { REA_WEB_ROOT, Stack, stackUnavailableReason } from "./stack.js";

const unavailable = stackUnavailableReason();
if (unavailable) console.warn(`e2e skipped: ${unavailable}`);
const describeStack = unavailable ? describe.skip : describe;

const FIXTURE = join(REA_WEB_ROOT, "fixtures/investigation/js-cli-app");

describeStack("local companion runner next to a cloud runner", () => {
  const stack = new Stack();
  let project = "";
  let cloud = "";
  let companion = "";

  beforeAll(async () => {
    await stack.start();
    const registered = await stack.request("POST", "/auth/register", {
      body: {
        email: "companion@example.test",
        password: "correct horse battery",
      },
    });
    project = registered.json.memberships[0].project_id;
    const make = async (name: string, labels: string[]) =>
      (
        await stack.request("POST", `/projects/${project}/runners`, {
          body: { name, labels },
        })
      ).json as { id: string; token: string };
    const cloudRunner = await make("cloud-linux", ["cloud"]);
    const companionRunner = await make("operator-laptop", ["local"]);
    cloud = cloudRunner.id;
    companion = companionRunner.id;
    stack.startRunner(cloudRunner.token, {
      REA_WEB_RUNNER_NAME: "cloud-linux",
      REA_WEB_RUNNER_LABELS: "cloud",
    });
    stack.startRunner(companionRunner.token, {
      REA_WEB_RUNNER_NAME: "operator-laptop",
      REA_WEB_RUNNER_LABELS: "local",
      REA_WEB_RUNNER_LOCAL_TARGET_ALLOWLIST: FIXTURE,
    });
    await stack.waitFor(async () => {
      const list = await stack.request("GET", `/projects/${project}/runners`);
      return (
        list.json.items?.filter(
          (r: { status: string }) => r.status === "online",
        ).length === 2
      );
    }, 120_000);
  }, 300_000);

  afterAll(async () => {
    await stack.stop();
  });

  it("registers allowlisted paths as targets without revealing the path", async () => {
    let targets: unknown[] = [];
    await stack.waitFor(async () => {
      targets = (await stack.request("GET", `/projects/${project}/targets`))
        .json.items;
      return targets.length > 0;
    }, 60_000);
    const listed = targetSchema.parse(targets[0]);
    expect(listed).toMatchObject({
      kind: "runner_local",
      name: "js-cli-app",
      class: "javascript_directory",
      runner_id: companion,
      path_hash: localPathHash(await realpath(FIXTURE)),
    });
    const raw = JSON.stringify(targets);
    expect(raw).not.toContain(await realpath(FIXTURE));
    expect(raw).not.toContain(REA_WEB_ROOT);
  });

  it("runs an investigation of a local target on the companion only", async () => {
    const targets = (await stack.request("GET", `/projects/${project}/targets`))
      .json.items;
    const target = targets[0].id as string;
    const routing = await stack.request(
      "GET",
      `/projects/${project}/targets/${target}/routing`,
    );
    expect(routing.status).toBe(200);
    const created = await stack.request(
      "POST",
      `/projects/${project}/investigations`,
      {
        body: {
          target_id: target,
          question: "What does this local CLI do?",
          policy: { model_follow_up: false },
        },
      },
    );
    expect(created.status, created.text).toBe(201);
    let view: any = null;
    await stack.waitFor(async () => {
      view = (
        await stack.request(
          "GET",
          `/projects/${project}/investigations/${created.json.id}`,
        )
      ).json;
      return ["completed", "failed", "cancelled"].includes(view?.status);
    }, 300_000);
    expect(investigationSchema.parse(view).status, JSON.stringify(view)).toBe(
      "completed",
    );
    const job = (
      await stack.request("GET", `/projects/${project}/jobs/${view.job_id}`)
    ).json;
    // The claim event names the runner that executed the run.
    const events = (
      await stack.request(
        "GET",
        `/projects/${project}/jobs/${view.job_id}/events?after=0`,
      )
    ).json.items as { kind: string; payload: { runner_id?: string } }[];
    const claimed = events.filter((e) => e.kind === "job.claimed");
    expect(claimed.map((e) => e.payload.runner_id)).toEqual([companion]);
    expect(claimed.map((e) => e.payload.runner_id)).not.toContain(cloud);
    expect(job.state).toBe("succeeded");
    const calls = (
      await stack.request(
        "GET",
        `/projects/${project}/investigations/${created.json.id}/tool-calls?limit=200`,
      )
    ).json.items as { tool_name: string; is_error: boolean }[];
    const analysis = calls.find(
      (c) => c.tool_name === "analyze_javascript_application",
    );
    expect(analysis?.is_error).toBe(false);
  });
});
