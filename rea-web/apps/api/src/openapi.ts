import { API_ROUTE_LIST, buildOpenApiDocument } from "@rea-web/contracts";

/** OpenAPI 3.1 projection of the route contracts; built once per process. */
export const buildApiDocument = (version: string): Record<string, unknown> =>
  buildOpenApiDocument(API_ROUTE_LIST, {
    title: "REA Web API",
    version,
    serverUrl: "/api/v1",
  });
