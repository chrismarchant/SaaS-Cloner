import { afterAll, beforeAll, expect, it } from "vitest";
import {
  API_ROUTE_LIST,
  DEFAULT_SECRET_ENV_NAMES,
  redactorFromEnvironment,
} from "@rea-web/contracts";
import type { Database } from "@rea-web/db";
import Fastify from "fastify";
import { createApp, createContext } from "../src/app.js";
import { registerRoutes } from "../src/routes/index.js";
import { createLogger } from "../src/logging.js";
import { createHandlers } from "../src/routes/index.js";
import { type Harness, createHarness, describeDb } from "./helpers/harness.js";

const noBus = {
  subscribe: () => () => undefined,
  subscribeAll: () => () => undefined,
  start: async () => undefined,
  close: async () => undefined,
  connected: true,
};

describeDb("route binding", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("provides a handler for every contract id", () => {
    const handlers = createHandlers() as unknown as Record<string, unknown>;
    const missing = API_ROUTE_LIST.filter(
      (route) => typeof handlers[route.id] !== "function",
    ).map((route) => route.id);
    expect(missing).toEqual([]);
    expect(Object.keys(handlers).sort()).toEqual(
      API_ROUTE_LIST.map((route) => route.id).sort(),
    );
  });

  it("refuses to register routes when a contract has no handler", async () => {
    const handlers = { ...createHandlers() } as Record<string, unknown>;
    const victim = API_ROUTE_LIST[0]?.id as string;
    delete handlers[victim];
    const { ownsBus: _ownsBus, ...ctx } = createContext({
      repos: h.repos,
      db: h.db,
      store: h.store,
      config: h.config,
      logger: h.app.log,
      bus: noBus,
    });
    const probe = Fastify();
    try {
      await expect(
        registerRoutes(
          probe,
          ctx,
          handlers as unknown as ReturnType<typeof createHandlers>,
        ),
      ).rejects.toThrow(victim);
    } finally {
      await probe.close();
    }
  });

  it("registers every contract on its method and path", () => {
    for (const route of API_ROUTE_LIST) {
      expect(
        h.app.hasRoute({
          method: route.method.toUpperCase() as "GET",
          url: `/api/v1${route.path}`,
        }),
        `${route.method} ${route.path} (${route.id})`,
      ).toBe(true);
    }
  });

  it("serves a valid OpenAPI 3.1 document with every path", async () => {
    const response = await h.api("GET", "/openapi.json");
    expect(response.status).toBe(200);
    const doc = response.json as {
      openapi: string;
      info: { title: string };
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("REA Web API");
    expect(doc.servers[0]?.url).toBe("/api/v1");
    for (const route of API_ROUTE_LIST) {
      const openApiPath = route.path.replace(/:([A-Za-z_]+)/gu, "{$1}");
      expect(
        doc.paths[openApiPath]?.[route.method]?.operationId,
        `${route.method} ${openApiPath}`,
      ).toBe(route.id);
    }
  });

  it("answers unknown routes and malformed ids with the error shape", async () => {
    const unknown = await h.api("GET", "/api/v1/nope");
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe("not_found");
    expect(typeof unknown.json.error.request_id).toBe("string");
    const account = await h.register("shape@example.com");
    const bad = await h.api("GET", "/api/v1/projects/not-a-uuid", {
      auth: account.auth,
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("validation_failed");
    expect(bad.headers["x-request-id"]).toBe(bad.json.error.request_id);
  });

  it("honours a well-formed incoming request id and rejects hostile ones", async () => {
    const ok = await h.app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { "x-request-id": "trace-123" },
    });
    expect(ok.headers["x-request-id"]).toBe("trace-123");
    const hostile = await h.app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { "x-request-id": 'a b"c' },
    });
    expect(hostile.headers["x-request-id"]).not.toBe('a b"c');
  });

  it("serves an unauthenticated health check that reports database failures without details", async () => {
    const ok = await h.app.inject({ method: "GET", url: "/api/v1/health" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ status: "ok" });

    const failing = {
      ...h.db,
      query: async () => {
        throw new Error(
          "connect ECONNREFUSED postgres://user:hunter2@db.internal:5432/rea",
        );
      },
    } as unknown as Database;
    const broken = await createApp({
      repos: h.repos,
      db: failing,
      store: h.store,
      config: h.config,
      logger: createLogger({
        level: "silent",
        redactor: redactorFromEnvironment({}, DEFAULT_SECRET_ENV_NAMES),
      }),
      bus: noBus,
    });
    try {
      const down = await broken.inject({
        method: "GET",
        url: "/api/v1/health",
      });
      expect(down.statusCode).toBe(503);
      expect(down.json()).toEqual({ status: "unavailable" });
      expect(down.body).not.toMatch(/postgres|hunter2|internal/u);
    } finally {
      await broken.close();
    }
  });

  it("treats an empty JSON body as no body and malformed JSON as a validation error", async () => {
    const account = await h.register("emptybody@example.com");
    const projectId = account.defaultProjectId as string;
    const empty = await h.api("POST", `/api/v1/projects/${projectId}/builds`, {
      auth: account.auth,
      payload: "",
      headers: { "content-type": "application/json" },
    });
    expect(empty.status).toBe(400);
    expect(empty.json.error.code).toBe("validation_failed");
    const broken = await h.api("POST", "/api/v1/auth/login", {
      payload: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(broken.status).toBe(400);
    expect(broken.json.error.code).toBe("validation_failed");
  });
});
