import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * SSRF guard. `validateTargetUrl` checks syntax and scheme without I/O.
 * `resolvePinnedAddress` resolves the host and rejects private, loopback,
 * link-local, multicast, reserved and CGNAT ranges; callers must connect to the
 * returned address with the original `Host` header to defeat DNS rebinding.
 */
export interface SafeUrlOptions {
  readonly allowedSchemes?: readonly string[];
  readonly allowLoopbackForTests?: boolean;
}

export type UrlRejection =
  | { kind: "invalid_url" }
  | { kind: "scheme_not_allowed"; scheme: string }
  | { kind: "credentials_in_url" }
  | { kind: "host_missing" }
  | { kind: "ip_literal_blocked"; address: string }
  | { kind: "hostname_blocked"; hostname: string }
  | { kind: "resolved_address_blocked"; address: string }
  | { kind: "resolution_failed"; message: string };

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

const parseV4 = (address: string): number[] | null => {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  return octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255)
    ? octets
    : null;
};

export const isBlockedIPv4 = (address: string): boolean => {
  const o = parseV4(address);
  if (!o) return true;
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && o[2] === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && o[2] === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && o[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
};

const expandV6 = (address: string): bigint | null => {
  let addr = address;
  let embeddedV4: number[] | null = null;
  const lastColon = addr.lastIndexOf(":");
  if (addr.includes(".") && lastColon !== -1) {
    embeddedV4 = parseV4(addr.slice(lastColon + 1));
    if (!embeddedV4) return null;
    addr = `${addr.slice(0, lastColon)}:0:0`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [
    ...head,
    ...(halves.length === 2 ? Array<string>(missing).fill("0") : []),
    ...tail,
  ];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/u.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  if (embeddedV4) {
    const [a, b, c, d] = embeddedV4 as [number, number, number, number];
    value =
      (value & ~0xffffffffn) |
      BigInt(((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
  }
  return value;
};

export const isBlockedIPv6 = (address: string): boolean => {
  const value = expandV6(address.replace(/%.*$/u, ""));
  if (value === null) return true;
  if (value === 0n) return true; // ::
  if (value === 1n) return true; // ::1
  const top16 = value >> 112n;
  if ((top16 & 0xffc0n) === 0xfe80n) return true; // fe80::/10 link-local
  if ((top16 & 0xfe00n) === 0xfc00n) return true; // fc00::/7 unique local
  if (top16 === 0xff00n || (top16 & 0xff00n) === 0xff00n) return true; // multicast
  if (top16 === 0x2001n && ((value >> 96n) & 0xffffn) === 0xdb8n) return true; // 2001:db8::/32
  const mappedPrefix = value >> 32n;
  if (mappedPrefix === 0xffffn) {
    const v4 = Number(value & 0xffffffffn);
    return isBlockedIPv4(
      `${(v4 >>> 24) & 255}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`,
    );
  }
  if (value >> 32n === 0n) return true; // IPv4-compatible / unspecified region
  if (top16 === 0x64n && ((value >> 96n) & 0xffffn) === 0xff9bn) {
    // 64:ff9b::/96 NAT64 — evaluate embedded v4
    const v4 = Number(value & 0xffffffffn);
    return isBlockedIPv4(
      `${(v4 >>> 24) & 255}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`,
    );
  }
  return false;
};

export const isBlockedAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return isBlockedIPv4(address);
  if (family === 6) return isBlockedIPv6(address);
  return true;
};

export const validateTargetUrl = (
  input: string,
  options: SafeUrlOptions = {},
): { ok: true; url: URL } | { ok: false; rejection: UrlRejection } => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, rejection: { kind: "invalid_url" } };
  }
  const schemes = options.allowedSchemes ?? ["http:", "https:"];
  if (!schemes.includes(url.protocol))
    return {
      ok: false,
      rejection: { kind: "scheme_not_allowed", scheme: url.protocol },
    };
  if (url.username !== "" || url.password !== "")
    return { ok: false, rejection: { kind: "credentials_in_url" } };
  if (url.hostname === "")
    return { ok: false, rejection: { kind: "host_missing" } };
  const bare = url.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(bare) !== 0) {
    if (isBlockedAddress(bare) && !options.allowLoopbackForTests)
      return {
        ok: false,
        rejection: { kind: "ip_literal_blocked", address: bare },
      };
    return { ok: true, url };
  }
  const lower = url.hostname.toLowerCase();
  if (
    (BLOCKED_HOSTNAMES.has(lower) ||
      lower.endsWith(".localhost") ||
      lower.endsWith(".local") ||
      lower.endsWith(".internal") ||
      !lower.includes(".")) &&
    !options.allowLoopbackForTests
  )
    return {
      ok: false,
      rejection: { kind: "hostname_blocked", hostname: url.hostname },
    };
  return { ok: true, url };
};

export const resolvePinnedAddress = async (
  url: URL,
  options: SafeUrlOptions & {
    readonly resolver?: (
      hostname: string,
    ) => Promise<readonly { address: string }[]>;
  } = {},
): Promise<
  { ok: true; address: string } | { ok: false; rejection: UrlRejection }
> => {
  const bare = url.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(bare) !== 0) {
    if (isBlockedAddress(bare) && !options.allowLoopbackForTests)
      return {
        ok: false,
        rejection: { kind: "ip_literal_blocked", address: bare },
      };
    return { ok: true, address: bare };
  }
  let addresses: readonly { address: string }[];
  try {
    addresses = await (options.resolver ?? ((h) => lookup(h, { all: true })))(
      bare,
    );
  } catch (error) {
    return {
      ok: false,
      rejection: {
        kind: "resolution_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (addresses.length === 0)
    return {
      ok: false,
      rejection: { kind: "resolution_failed", message: "no addresses" },
    };
  for (const { address } of addresses) {
    if (isBlockedAddress(address) && !options.allowLoopbackForTests)
      return {
        ok: false,
        rejection: { kind: "resolved_address_blocked", address },
      };
  }
  const first = addresses[0];
  return { ok: true, address: (first as { address: string }).address };
};
