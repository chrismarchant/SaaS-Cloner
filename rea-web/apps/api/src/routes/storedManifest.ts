import {
  ApiError,
  recoveryManifestSchema,
  type RecoveryManifest,
} from "@rea-web/contracts";
import { ObjectNotFoundError } from "@rea-web/storage";
import type { AppContext } from "../context.js";
import { zodIssues } from "../http/errors.js";

/** Manifests list every package file; allow far more than tool arguments. */
const MANIFEST_READ_LIMIT = 64 * 1024 * 1024;

/**
 * Reads and parses a stored `manifest.json` with the contract schema, the one
 * place the API interprets it. A manifest the runner stored that does not
 * parse is a server-side fault, not a client error.
 */
export const readStoredManifest = async (
  ctx: Pick<AppContext, "store">,
  key: string,
): Promise<RecoveryManifest> => {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of await ctx.store.get(key)) {
      const buffer = Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > MANIFEST_READ_LIMIT)
        throw new ApiError("internal", "Stored manifest is too large", {
          limit: MANIFEST_READ_LIMIT,
        });
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError)
      throw new ApiError("not_found", "Manifest not found");
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("internal", "Stored manifest is not valid JSON");
  }
  const parsed = recoveryManifestSchema.safeParse(json);
  if (!parsed.success)
    throw new ApiError(
      "internal",
      "Stored manifest does not match its schema",
      {
        issues: zodIssues(parsed.error),
      },
    );
  return parsed.data;
};
