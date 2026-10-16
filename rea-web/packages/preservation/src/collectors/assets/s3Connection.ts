import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { type LookupFunction, isIP } from "node:net";
import { S3Client } from "@aws-sdk/client-s3";
import {
  type UrlRejection,
  resolvePinnedAddress,
  validateTargetUrl,
} from "@rea-web/contracts";
import type { Omission } from "../../types.js";

/** Test-only and tuning inputs; production callers get the defaults. */
export interface S3CaptureOptions {
  /** TEST ONLY: allow a loopback or private endpoint. Never set in production. */
  allowLoopbackEndpoint?: boolean;
  /** Replaces DNS resolution (SSRF-guard tests). */
  resolver?: (hostname: string) => Promise<readonly { address: string }[]>;
  /** Stop capturing once more than this many keys were examined. Default 1,000,000. */
  maxObjects?: number;
  /** Stop capturing before the captured bytes would exceed this. Default 200 GiB. */
  maxBytes?: number;
  /** ListObjectsV2 pages the plan paginates before giving up on an estimate. Default 100. */
  estimatePageLimit?: number;
  /** ListObjectsV2 MaxKeys. Default 1000. */
  pageSize?: number;
  /** SDK attempts per request. Default 3. */
  maxAttempts?: number;
}

/**
 * Collector contexts carry S3 options under this key so they reach the
 * collector through `planPreservation` / `capturePackage` without widening
 * the public contract. Only tests set it.
 */
export const S3_OPTIONS: unique symbol = Symbol("rea-web.preservation.s3");

export interface S3OptionsCarrier {
  readonly [S3_OPTIONS]?: S3CaptureOptions;
}

export const s3OptionsOf = (ctx: object): S3CaptureOptions =>
  (ctx as S3OptionsCarrier)[S3_OPTIONS] ?? {};

export const DEFAULT_MAX_OBJECTS = 1_000_000;
export const DEFAULT_MAX_BYTES = 200 * 1024 ** 3;
export const DEFAULT_ESTIMATE_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_SIZE = 1000;

export interface S3ConnectionSpec {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | undefined;
  region: string;
  /** Custom endpoint URL; `undefined` selects the AWS default for `region`. */
  endpoint: string | undefined;
  forcePathStyle: boolean;
}

export interface S3Connection {
  readonly client: S3Client;
  /** Host names that requests may reach, for restore guards. */
  readonly hosts: readonly string[];
  destroy(): void;
}

const REGION = /^[a-z0-9][a-z0-9-]{0,40}$/u;
export const isValidRegion = (region: string): boolean => REGION.test(region);

export const describeRejection = (rejection: UrlRejection): string => {
  switch (rejection.kind) {
    case "invalid_url":
      return "the endpoint is not a valid URL";
    case "scheme_not_allowed":
      return `the endpoint scheme ${rejection.scheme} is not allowed (https is required)`;
    case "credentials_in_url":
      return "the endpoint URL contains embedded credentials";
    case "host_missing":
      return "the endpoint URL has no host";
    case "ip_literal_blocked":
      return `the endpoint is the private, loopback or reserved address ${rejection.address}`;
    case "hostname_blocked":
      return `the endpoint host ${rejection.hostname} is a local or internal name`;
    case "resolved_address_blocked":
      return `the endpoint host resolves to the private, loopback or reserved address ${rejection.address}`;
    case "resolution_failed":
      return `the endpoint host could not be resolved (${rejection.message})`;
  }
};

export const ssrfOmission = (reason: string): Omission => ({
  what: "Object storage endpoint",
  reason: `Endpoint refused by the network safety guard: ${reason}.`,
  remediation:
    "Use a public https endpoint that resolves to a public address. Private, loopback and link-local endpoints are never contacted by the capture runner.",
});

/** Defaults to AWS (`s3.<region>.amazonaws.com`) when no endpoint is given. */
const guardedHostname = (spec: S3ConnectionSpec): string =>
  spec.endpoint === undefined
    ? `s3.${spec.region}.amazonaws.com`
    : (new URL(spec.endpoint).hostname ?? "");

/**
 * Validate the endpoint, resolve it through the SSRF guard and build a client
 * whose every connection uses a guarded, pinned address (so DNS cannot change
 * between the check and the connect).
 */
export async function connectS3(
  spec: S3ConnectionSpec,
  options: S3CaptureOptions,
): Promise<
  { ok: true; connection: S3Connection } | { ok: false; reason: string }
> {
  const allowLoopbackForTests = options.allowLoopbackEndpoint === true;
  const guard = {
    allowedSchemes: allowLoopbackForTests ? ["https:", "http:"] : ["https:"],
    allowLoopbackForTests,
  };
  const checked = validateTargetUrl(
    spec.endpoint ?? `https://s3.${spec.region}.amazonaws.com`,
    guard,
  );
  if (!checked.ok)
    return { ok: false, reason: describeRejection(checked.rejection) };
  const resolveOptions = {
    allowLoopbackForTests,
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
  };
  const pins = new Map<string, string>();
  const pin = async (
    hostname: string,
  ): Promise<{ ok: true; address: string } | { ok: false; reason: string }> => {
    const key = hostname.toLowerCase();
    const known = pins.get(key);
    if (known !== undefined) return { ok: true, address: known };
    const resolved = await resolvePinnedAddress(
      new URL(
        `https://${hostname.includes(":") ? `[${hostname}]` : hostname}/`,
      ),
      resolveOptions,
    );
    if (!resolved.ok)
      return { ok: false, reason: describeRejection(resolved.rejection) };
    pins.set(key, resolved.address);
    return { ok: true, address: resolved.address };
  };
  const first = await pin(guardedHostname(spec));
  if (!first.ok) return first;

  const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
    void pin(hostname).then((result) => {
      if (!result.ok) {
        callback(new Error(`connection refused: ${result.reason}`), "", 4);
        return;
      }
      const family = isIP(result.address) === 6 ? 6 : 4;
      if (lookupOptions.all === true)
        (
          callback as unknown as (
            error: null,
            addresses: { address: string; family: number }[],
          ) => void
        )(null, [{ address: result.address, family }]);
      else callback(null, result.address, family);
    });
  };
  const httpsAgent = new HttpsAgent({ lookup, keepAlive: false });
  const httpAgent = new HttpAgent({ lookup, keepAlive: false });
  const client = new S3Client({
    region: spec.region,
    ...(spec.endpoint === undefined
      ? { followRegionRedirects: true }
      : { endpoint: spec.endpoint }),
    forcePathStyle: spec.forcePathStyle,
    credentials: {
      accessKeyId: spec.accessKeyId,
      secretAccessKey: spec.secretAccessKey,
      ...(spec.sessionToken === undefined
        ? {}
        : { sessionToken: spec.sessionToken }),
    },
    maxAttempts: options.maxAttempts ?? 3,
    // S3-compatible services (Supabase, Railway) reject the CRC32 trailers the
    // SDK adds by default; only send and verify them when required.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: {
      httpAgent,
      httpsAgent,
      connectionTimeout: 15_000,
      requestTimeout: 120_000,
    },
  });
  const hosts = [guardedHostname(spec)];
  return {
    ok: true,
    connection: {
      client,
      hosts,
      destroy: () => {
        client.destroy();
        httpAgent.destroy();
        httpsAgent.destroy();
      },
    },
  };
}
