import { describe, expect, it } from "vitest";
import { API_ROUTES } from "@rea-web/contracts/browser";
import {
  ApiClientError,
  buildPath,
  buildQuery,
  createApiClient,
  errorFromResponse,
} from "../src/api/client";
import { targetNameProblem } from "../src/api/upload";

interface Seen {
  url: string;
  init: RequestInit;
}

const P = "01970000-0000-7000-8000-000000000001";
const I = "01970000-0000-7000-8000-000000000002";

const fakeFetch = (
  respond: (seen: Seen) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Seen[] } => {
  const calls: Seen[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const seen = { url: String(input), init: init ?? {} };
      calls.push(seen);
      return respond(seen);
    },
  };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const headersOf = (init: RequestInit): Record<string, string> =>
  Object.fromEntries(
    Object.entries((init.headers ?? {}) as Record<string, string>).map(
      ([key, value]) => [key.toLowerCase(), value],
    ),
  );

describe("path building", () => {
  it("substitutes and encodes params", () => {
    expect(buildPath("/projects/:p/runners/:r", { p: "a b", r: "x/y" })).toBe(
      "/projects/a%20b/runners/x%2Fy",
    );
  });

  it("refuses a missing param", () => {
    expect(() => buildPath("/projects/:p", {})).toThrow(ApiClientError);
  });

  it("serialises queries without undefined values", () => {
    expect(buildQuery({ limit: 50, cursor: undefined, kind: "a&b" })).toBe(
      "?limit=50&kind=a%26b",
    );
    expect(buildQuery({})).toBe("");
  });

  it("builds same-origin urls from route contracts", () => {
    const client = createApiClient({ fetch: fakeFetch(() => json({})).fetch });
    expect(client.url("getEvidence", { params: { p: P, i: I, a: I } })).toBe(
      `/api/v1/projects/${P}/investigations/${I}/evidence/${I}`,
    );
    expect(() =>
      client.url("getEvidence", { params: { p: P, i: I, a: "../../x" } }),
    ).toThrow(ApiClientError);
  });
});

describe("calls", () => {
  const project = {
    id: P,
    slug: "default",
    name: "Default",
    created_by: P,
    created_at: "2026-01-01T00:00:00Z",
    role: "owner",
  };

  it("sends same-origin credentials and parses the response with its schema", async () => {
    const fake = fakeFetch(() => json({ items: [project] }));
    const client = createApiClient({ fetch: fake.fetch });
    const result = await client.call("listProjects");
    expect(result.items[0]?.slug).toBe("default");
    expect(fake.calls[0]?.url).toBe("/api/v1/projects");
    expect(fake.calls[0]?.init.credentials).toBe("same-origin");
    expect(fake.calls[0]?.init.method).toBe("GET");
    expect(
      headersOf(fake.calls[0]?.init ?? {})["idempotency-key"],
    ).toBeUndefined();
  });

  it("adds an Idempotency-Key to idempotent POSTs only", async () => {
    let n = 0;
    const fake = fakeFetch(() => json({ id: P, name: "r", token: "t" }, 201));
    const client = createApiClient({
      fetch: fake.fetch,
      newKey: () => `key-${(n += 1)}`,
    });
    expect(API_ROUTES.createRunner.idempotent).toBe(true);
    await client.call("createRunner", {
      params: { p: P },
      body: { name: "runner", labels: [] },
    });
    await client.call("createRunner", {
      params: { p: P },
      body: { name: "runner", labels: [] },
    });
    const first = headersOf(fake.calls[0]?.init ?? {});
    const second = headersOf(fake.calls[1]?.init ?? {});
    expect(first["idempotency-key"]).toBe("key-1");
    expect(second["idempotency-key"]).toBe("key-2");
    expect(first["content-type"]).toBe("application/json");
    expect(fake.calls[0]?.init.body).toBe(
      JSON.stringify({ name: "runner", labels: [] }),
    );
  });

  it("reuses a caller supplied key and omits it on non-idempotent POSTs", async () => {
    const fake = fakeFetch(() => json({ ok: true }));
    const client = createApiClient({ fetch: fake.fetch });
    await client.call("logout");
    expect(API_ROUTES.logout.idempotent).toBeUndefined();
    expect(
      headersOf(fake.calls[0]?.init ?? {})["idempotency-key"],
    ).toBeUndefined();
    const created = fakeFetch(() =>
      json(
        {
          id: I,
          project_id: P,
          kind: "investigation.export",
          state: "queued",
          attempt: 1,
          created_at: "t",
          updated_at: "t",
        },
        202,
      ),
    );
    await createApiClient({ fetch: created.fetch }).call(
      "createInvestigationExport",
      { params: { p: P, i: I } },
      { idempotencyKey: "fixed" },
    );
    expect(headersOf(created.calls[0]?.init ?? {})["idempotency-key"]).toBe(
      "fixed",
    );
    expect(created.calls[0]?.init.body).toBeUndefined();
  });

  it("validates bodies before sending", async () => {
    const fake = fakeFetch(() => json({}));
    const client = createApiClient({ fetch: fake.fetch });
    await expect(
      client.call("login", { body: { email: "not-an-email", password: "x" } }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects a response that violates its contract", async () => {
    const client = createApiClient({
      fetch: fakeFetch(() => json({ items: [{ id: "nope" }] })).fetch,
    });
    await expect(client.call("listProjects")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("serialises query parameters from the route schema", async () => {
    const fake = fakeFetch(() => json({ items: [], next_cursor: null }));
    const client = createApiClient({ fetch: fake.fetch });
    await client.call("listTargets", {
      params: { p: P },
      query: { limit: 10, cursor: "abc" },
    });
    expect(fake.calls[0]?.url).toBe(
      `/api/v1/projects/${P}/targets?cursor=abc&limit=10`,
    );
  });
});

describe("errors", () => {
  const envelope = {
    error: {
      code: "capability_unavailable",
      message: "The investigation session has closed",
      details: {
        reason: "session_closed",
        remediation: "Re-run with a bundle import",
      },
      request_id: "req-1",
    },
  };

  it("parses the error envelope into a typed error", async () => {
    const client = createApiClient({
      fetch: fakeFetch(() => json(envelope, 409)).fetch,
    });
    const error = await client
      .call("createFollowUp", {
        params: { p: P, i: I },
        body: { tool: "t", arguments: {} },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      code: "capability_unavailable",
      status: 409,
      message: "The investigation session has closed",
      requestId: "req-1",
      details: {
        reason: "session_closed",
        remediation: "Re-run with a bundle import",
      },
    });
  });

  it("keeps registration_disabled and unsafe_url codes", () => {
    const disabled = errorFromResponse(
      403,
      JSON.stringify({
        error: {
          code: "registration_disabled",
          message: "Registration is disabled",
          request_id: "r",
        },
      }),
    );
    expect(disabled.code).toBe("registration_disabled");
    expect(disabled.message).toBe("Registration is disabled");
    const unsafe = errorFromResponse(
      400,
      JSON.stringify({
        error: {
          code: "unsafe_url",
          message: "bad",
          details: { host: "127.0.0.1" },
          request_id: "r",
        },
      }),
    );
    expect(unsafe.details).toEqual({ host: "127.0.0.1" });
  });

  it("handles non-envelope failures and network errors", async () => {
    const plain = errorFromResponse(502, "<html>Bad gateway</html>");
    expect(plain.code).toBe("unexpected_status");
    expect(plain.status).toBe(502);
    const client = createApiClient({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(client.call("listProjects")).rejects.toMatchObject({
      code: "network_error",
    });
  });

  it("returns checked responses for streaming routes", async () => {
    const ok = createApiClient({
      fetch: fakeFetch(() => new Response('{"a":1}')).fetch,
    });
    const response = await ok.stream("getToolCallRaw", {
      params: { p: P, i: I, c: I },
    });
    expect(await response.text()).toBe('{"a":1}');
    const bad = createApiClient({
      fetch: fakeFetch(() => json(envelope, 409)).fetch,
    });
    await expect(
      bad.stream("getToolCallRaw", { params: { p: P, i: I, c: I } }),
    ).rejects.toMatchObject({ code: "capability_unavailable" });
  });
});

describe("target names", () => {
  it("mirrors the API limits and HTTP header constraints", () => {
    expect(targetNameProblem("notes-cli.zip")).toBeNull();
    expect(targetNameProblem("")).not.toBeNull();
    expect(targetNameProblem("a/b")).not.toBeNull();
    expect(targetNameProblem("a\\b")).not.toBeNull();
    expect(targetNameProblem("..")).not.toBeNull();
    expect(targetNameProblem(" lead")).not.toBeNull();
    expect(targetNameProblem("x".repeat(256))).not.toBeNull();
    expect(targetNameProblem("bad\u0007name")).not.toBeNull();
    expect(targetNameProblem("café.zip")).toBeNull();
    expect(targetNameProblem("日本.zip")).toMatch(/header/u);
  });
});

describe("preserve routes", () => {
  const B = "01970000-0000-7000-8000-000000000003";
  const PLAN = "01970000-0000-7000-8000-000000000004";
  const JOB = "01970000-0000-7000-8000-000000000005";

  it("keeps plan_id and job_id from createPlan through response parsing", async () => {
    const { fetch } = fakeFetch(() =>
      json(
        {
          id: JOB,
          project_id: P,
          kind: "preservation.plan",
          state: "queued",
          attempt: 1,
          created_at: "2026-10-12T00:00:00.000Z",
          updated_at: "2026-10-12T00:00:00.000Z",
          plan_id: PLAN,
          job_id: JOB,
        },
        202,
      ),
    );
    const created = await createApiClient({ fetch }).call("createPlan", {
      params: { p: P, b: B },
      body: {},
    });
    expect(created.plan_id).toBe(PLAN);
    expect(created.job_id).toBe(JOB);
  });

  it("builds the list and download urls from the contracts", () => {
    const client = createApiClient({ fetch: fakeFetch(() => json({})).fetch });
    const root = `/api/v1/projects/${P}/builds/${B}`;
    expect(
      client.url("downloadVerificationReport", {
        params: { p: P, b: B, c: PLAN, v: JOB },
      }),
    ).toBe(`${root}/captures/${PLAN}/verifications/${JOB}/report`);
    expect(
      client.url("downloadExportSignature", { params: { p: P, b: B, e: JOB } }),
    ).toBe(`${root}/exports/${JOB}/signature`);
    expect(
      client.url("listExports", {
        params: { p: P, b: B },
        query: { limit: 50, capture_id: PLAN },
      }),
    ).toBe(`${root}/exports?limit=50&capture_id=${PLAN}`);
  });
});
