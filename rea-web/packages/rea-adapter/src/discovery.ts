import { createHash } from "node:crypto";
import type { Client } from "@modelcontextprotocol/client";
import type {
  AdvertisedTool,
  ReaIdentity,
  ToolAvailabilityGroup,
} from "@rea-web/contracts";
import { schemaSha256 } from "./validation.js";

export interface LiveTool {
  readonly name: string;
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly annotations: Record<string, unknown> | undefined;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown> | undefined;
  readonly inputSchemaSha256: string;
}

export interface Discovery {
  readonly discovered_at: string;
  readonly tools: readonly LiveTool[];
  readonly prompts: readonly { name: string; description?: string }[];
  readonly binary_session_result: Record<string, unknown> | null;
  readonly binary_session_error: string | null;
  readonly identity: ReaIdentity | null;
  readonly tool_availability: {
    groups: ToolAvailabilityGroup[];
    client_requirements?: unknown;
  };
  readonly analysis_provider_candidates: Record<string, unknown>[];
  readonly provider_capabilities: Record<string, unknown>[];
  readonly client_features: Record<string, unknown> | null;
  readonly server_version: { name: string; version: string } | null;
}

const hash = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

export const toAdvertisedTools = (
  tools: readonly LiveTool[],
): AdvertisedTool[] =>
  tools.map((t) => ({
    name: t.name,
    ...(t.title !== undefined ? { title: t.title } : {}),
    ...(t.description !== undefined ? { description: t.description } : {}),
    ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
    input_schema: t.inputSchema,
    input_schema_sha256: t.inputSchemaSha256,
    has_output_schema: t.outputSchema !== undefined,
  }));

/**
 * Discover the live catalog and session facts from a connected client:
 * paged tools/list, prompts/list, and `binary_session {}`. Nothing here is
 * inferred; unavailable facts stay null with the upstream error text.
 */
export const discover = async (
  client: Client,
  options: { reaRoot: string; sourceSha: string | null; timeoutMs?: number },
): Promise<Discovery> => {
  const timeout = options.timeoutMs ?? 60_000;
  const tools: LiveTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { timeout });
    for (const t of page.tools) {
      const inputSchema = t.inputSchema as Record<string, unknown>;
      tools.push({
        name: t.name,
        title: t.title,
        description: t.description,
        annotations: t.annotations as Record<string, unknown> | undefined,
        inputSchema,
        outputSchema: t.outputSchema as Record<string, unknown> | undefined,
        inputSchemaSha256: schemaSha256(inputSchema),
      });
    }
    cursor = page.nextCursor;
  } while (cursor);

  let prompts: Discovery["prompts"] = [];
  try {
    const page = await client.listPrompts({}, { timeout });
    prompts = page.prompts.map((p) => ({
      name: p.name,
      ...(p.description !== undefined ? { description: p.description } : {}),
    }));
  } catch {
    prompts = [];
  }

  let sessionResult: Record<string, unknown> | null = null;
  let sessionError: string | null = null;
  try {
    const call = await client.callTool(
      { name: "binary_session", arguments: {} },
      { timeout },
    );
    if (call.isError) {
      sessionError = (call.content as { type: string; text?: string }[])
        .map((c) => c.text ?? "")
        .join("")
        .slice(0, 4000);
    } else {
      const sc = call.structuredContent as Record<string, unknown> | undefined;
      sessionResult =
        (sc?.["result"] as Record<string, unknown> | undefined) ??
        (sc?.["normalized_result"] as Record<string, unknown> | undefined) ??
        null;
    }
  } catch (error) {
    sessionError = error instanceof Error ? error.message : String(error);
  }

  const identityRecord = sessionResult?.["server_identity"] as
    | Record<string, unknown>
    | undefined;
  const pkg = identityRecord?.["package"] as
    | Record<string, unknown>
    | undefined;
  const catalog = identityRecord?.["catalog"] as
    | { counts?: Record<string, number>; digests?: Record<string, string> }
    | undefined;
  const identity: ReaIdentity | null = identityRecord
    ? {
        package_version: String(pkg?.["version"] ?? "unknown"),
        root_path_hash: hash(options.reaRoot),
        build_commit:
          typeof pkg?.["build_commit"] === "string"
            ? pkg["build_commit"]
            : null,
        source_sha: options.sourceSha,
        sdk: (identityRecord["sdk"] as Record<string, unknown>) ?? {},
        negotiated_protocol_version:
          typeof identityRecord["negotiated_protocol_version"] === "string"
            ? identityRecord["negotiated_protocol_version"]
            : null,
        catalog: {
          counts: catalog?.counts ?? {},
          digests: catalog?.digests ?? {},
        },
        skill: (identityRecord["skill"] as Record<string, unknown>) ?? null,
        protocol_features:
          (identityRecord["protocol_features"] as Record<string, unknown>) ??
          null,
      }
    : null;

  const availability = sessionResult?.["tool_availability"] as
    | { groups?: ToolAvailabilityGroup[]; client_requirements?: unknown }
    | undefined;
  const serverVersion = client.getServerVersion();
  return {
    discovered_at: new Date().toISOString(),
    tools,
    prompts,
    binary_session_result: sessionResult,
    binary_session_error: sessionError,
    identity,
    tool_availability: {
      groups: availability?.groups ?? [],
      ...(availability?.client_requirements !== undefined
        ? { client_requirements: availability.client_requirements }
        : {}),
    },
    analysis_provider_candidates:
      (sessionResult?.["analysis_provider_candidates"] as Record<
        string,
        unknown
      >[]) ?? [],
    provider_capabilities:
      (sessionResult?.["capabilities"] as Record<string, unknown>[]) ?? [],
    client_features:
      (sessionResult?.["client_features"] as Record<string, unknown>) ?? null,
    server_version: serverVersion
      ? { name: serverVersion.name, version: serverVersion.version }
      : null,
  };
};
