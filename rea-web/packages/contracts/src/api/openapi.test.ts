import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildOpenApiDocument, defineRoute } from "./openapi.js";

const createThing = defineRoute({
  id: "createThing",
  method: "post",
  path: "/projects/:p/things",
  summary: "Create a thing",
  tags: ["things"],
  auth: "user",
  role: "member",
  idempotent: true,
  params: z.object({ p: z.string() }),
  query: z.object({ dry_run: z.coerce.boolean().optional() }),
  body: z.object({ name: z.string().min(1) }),
  response: z.object({ id: z.string() }),
  responseStatus: 201,
});

const events = defineRoute({
  id: "jobEvents",
  method: "get",
  path: "/projects/:p/jobs/:j/events",
  summary: "Job events",
  tags: ["jobs"],
  auth: "runner",
  response: z.unknown(),
  streaming: "sse",
});

type Doc = {
  openapi: string;
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { securitySchemes: Record<string, unknown> };
};

describe("buildOpenApiDocument", () => {
  const doc = buildOpenApiDocument([createThing, events], {
    title: "t",
    version: "1",
    serverUrl: "/api/v1",
  }) as Doc;

  it("emits OpenAPI 3.1 with placeholder paths and security schemes", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual([
      "/projects/{p}/things",
      "/projects/{p}/jobs/{j}/events",
    ]);
    expect(Object.keys(doc.components.securitySchemes)).toEqual([
      "cookieSession",
      "bearerToken",
      "runnerToken",
    ]);
  });

  it("describes parameters, idempotency header, body and responses", () => {
    const op = doc.paths["/projects/{p}/things"]?.["post"] as {
      parameters: { name: string; in: string; required: boolean }[];
      requestBody: unknown;
      responses: Record<string, unknown>;
      security: unknown[];
      "x-required-role": string;
    };
    expect(op.parameters.map((p) => `${p.in}:${p.name}:${p.required}`)).toEqual(
      ["path:p:true", "query:dry_run:false", "header:Idempotency-Key:false"],
    );
    expect(op.requestBody).toBeDefined();
    expect(Object.keys(op.responses)).toEqual(["201", "default"]);
    expect(op.security).toEqual([{ cookieSession: [] }, { bearerToken: [] }]);
    expect(op["x-required-role"]).toBe("member");
  });

  it("describes SSE streams with runner security", () => {
    const op = doc.paths["/projects/{p}/jobs/{j}/events"]?.["get"] as {
      responses: Record<string, { content: Record<string, unknown> }>;
      security: unknown[];
    };
    expect(Object.keys(op.responses["200"]?.content ?? {})).toEqual([
      "text/event-stream",
    ]);
    expect(op.security).toEqual([{ runnerToken: [] }]);
  });
});
