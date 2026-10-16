import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type Harness,
  SESSION_SECRET,
  cookieFrom,
  createHarness,
  createRunner,
  describeDb,
  registerRunner,
  reportFor,
} from "./helpers/harness.js";
import {
  claimOne,
  complete,
  heartbeat,
  startInvestigation,
  transition,
} from "./helpers/flow.js";

describeDb("secret handling in logs", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("never logs the session secret, session cookies, API tokens, runner tokens or passwords", async () => {
    const password = "a very distinctive password 7d1f";
    const register = await h.api("POST", "/api/v1/auth/register", {
      body: { email: "secrets@example.com", password },
    });
    expect(register.status).toBe(201);
    const registerCookie = cookieFrom(register.headers) as string;
    const login = await h.api("POST", "/api/v1/auth/login", {
      body: { email: "secrets@example.com", password },
    });
    expect(login.status).toBe(200);
    const loginCookie = cookieFrom(login.headers) as string;
    const projectId = register.json.memberships[0].project_id as string;

    const tokenResponse = await h.api("POST", "/api/v1/auth/tokens", {
      auth: { cookie: loginCookie },
      body: { name: "ci" },
    });
    expect(tokenResponse.status).toBe(201);
    const apiToken = tokenResponse.json.token as string;
    expect(apiToken).toMatch(/^rwt_/u);

    const account = {
      email: "secrets@example.com",
      userId: register.json.user.id as string,
      cookie: registerCookie,
      auth: { bearer: apiToken },
      defaultProjectId: projectId,
    };
    const runner = await createRunner(h, account, projectId, "secret-runner");
    expect(runner.token).toMatch(/^rwr_/u);
    await registerRunner(h, runner, reportFor("secret-runner"));

    const setup = await startInvestigation(h, account, projectId, {
      name: "secrets.asar",
      runnerId: runner.id,
    });
    const claimed = await claimOne(h, runner);
    await transition(h, runner, setup.jobId, claimed.token, "running");
    await heartbeat(h, runner, [
      { job_id: setup.jobId, fencing_token: claimed.token },
    ]);
    // Failed authentication attempts carry credentials in headers too.
    await h.api("GET", "/api/v1/auth/me", { auth: { bearer: `${apiToken}x` } });
    await h.api("GET", "/api/v1/auth/me", {
      auth: { cookie: `${registerCookie}x` },
    });
    await h.api("POST", `/api/v1/runners/${runner.id}/claim`, {
      auth: { bearer: apiToken },
      body: { wait_ms: 0 },
    });
    expect(
      (await complete(h, runner, setup.jobId, claimed.token, "succeeded"))
        .status,
    ).toBe(200);
    await h.api("POST", "/api/v1/auth/logout", {
      auth: { cookie: registerCookie },
    });

    const output = h.logs.join("");
    // The capture is real: requests were logged, and a planted secret is scrubbed.
    expect(output).toContain("/api/v1/auth/login");
    h.app.log.info(
      { planted: SESSION_SECRET, nested: { value: `x ${SESSION_SECRET} y` } },
      `msg ${SESSION_SECRET}`,
    );
    const planted = h.logs[h.logs.length - 1] as string;
    expect(planted).toContain("planted");
    expect(planted).not.toContain(SESSION_SECRET);

    const cookieValue = (cookie: string): string =>
      cookie.slice(cookie.indexOf("=") + 1);
    const everything = h.logs.join("");
    const secrets: Array<[string, string]> = [
      ["REA_WEB_SESSION_SECRET", SESSION_SECRET],
      ["register session cookie", cookieValue(registerCookie)],
      ["login session cookie", cookieValue(loginCookie)],
      ["decoded session cookie", decodeURIComponent(cookieValue(loginCookie))],
      ["API token", apiToken],
      ["API token body", apiToken.slice("rwt_".length)],
      ["runner token", runner.token],
      ["runner token body", runner.token.slice("rwr_".length)],
      ["password", password],
    ];
    for (const [label, value] of secrets) {
      expect(value.length, label).toBeGreaterThan(8);
      expect(everything.includes(value), `${label} leaked into logs`).toBe(
        false,
      );
    }
  });
});
