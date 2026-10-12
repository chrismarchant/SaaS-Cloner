import { ApiError } from "@rea-web/contracts";
import type { AppContext } from "../context.js";
import { createSealer, sha256Hex, canonicalJson, type Sealer } from "./util.js";

export interface IdempotencyReplay {
  readonly status: number;
  readonly body: unknown;
}

/** Serialises concurrent requests that share one idempotency key (per process). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export interface IdempotencyService {
  readonly mutex: KeyedMutex;
  hashRequest(method: string, path: string, body: unknown): string;
  lookup(
    principalId: string,
    key: string,
    requestHash: string,
  ): Promise<IdempotencyReplay | null>;
  remember(input: {
    principalId: string;
    projectId: string | null;
    key: string;
    requestHash: string;
    status: number;
    body: unknown;
  }): Promise<void>;
}

const KEY_PATTERN = /^[\x21-\x7e]{1,128}$/u;

export const parseIdempotencyKey = (
  header: string | string[] | undefined,
): string | null => {
  if (header === undefined) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || !KEY_PATTERN.test(value))
    throw new ApiError(
      "validation_failed",
      "Idempotency-Key must be 1-128 printable ASCII characters",
    );
  return value;
};

export const createIdempotencyService = (
  ctx: Pick<AppContext, "repos" | "config">,
): IdempotencyService => {
  // Stored responses can include freshly issued credentials (runner tokens), so
  // they are sealed rather than written as readable JSON.
  const sealer: Sealer = createSealer(
    ctx.config.sessionSecret,
    "idempotency-response",
  );
  return {
    mutex: new KeyedMutex(),
    hashRequest: (method, path, body) =>
      sha256Hex(`${method.toUpperCase()}\n${path}\n${canonicalJson(body)}`),
    async lookup(principalId, key, requestHash) {
      const record = await ctx.repos.idempotency.find(principalId, key);
      if (record === null) return null;
      if (record.request_hash !== requestHash)
        throw new ApiError(
          "idempotency_conflict",
          "Idempotency-Key was already used with a different request",
        );
      const stored = record.response as { sealed?: unknown } | null;
      const opened =
        typeof stored?.sealed === "string" ? sealer.open(stored.sealed) : null;
      if (opened === null)
        throw new ApiError(
          "idempotency_conflict",
          "Stored response for this Idempotency-Key cannot be replayed",
        );
      return {
        status: record.status_code,
        body: JSON.parse(opened) as unknown,
      };
    },
    async remember(input) {
      await ctx.repos.idempotency.store({
        principal_id: input.principalId,
        project_id: input.projectId,
        key: input.key,
        request_hash: input.requestHash,
        status_code: input.status,
        response: { sealed: sealer.seal(JSON.stringify(input.body ?? null)) },
      });
    },
  };
};
