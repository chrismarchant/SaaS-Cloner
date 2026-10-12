import { describe, expect, it } from "vitest";
import {
  isBlockedAddress,
  isBlockedIPv6,
  resolvePinnedAddress,
  validateTargetUrl,
} from "./ssrf.js";

const rejectionKind = (input: string): string | "accepted" => {
  const result = validateTargetUrl(input);
  return result.ok ? "accepted" : result.rejection.kind;
};

describe("validateTargetUrl", () => {
  it("accepts public http(s) hosts and public IP literals", () => {
    expect(rejectionKind("https://example.com/path?q=1")).toBe("accepted");
    expect(rejectionKind("http://93.184.216.34")).toBe("accepted");
    expect(rejectionKind("https://[2606:4700::6810:84e5]/")).toBe("accepted");
  });

  it("rejects non-http schemes, credentials, and missing hosts", () => {
    expect(rejectionKind("ftp://example.com/x")).toBe("scheme_not_allowed");
    expect(rejectionKind("file:///etc/passwd")).toBe("scheme_not_allowed");
    expect(rejectionKind("javascript:alert(1)")).toBe("scheme_not_allowed");
    expect(rejectionKind("https://user:pass@example.com/")).toBe(
      "credentials_in_url",
    );
    expect(rejectionKind("not a url")).toBe("invalid_url");
  });

  it("rejects loopback, local and bare hostnames", () => {
    for (const host of [
      "localhost",
      "foo.localhost",
      "printer.local",
      "db.internal",
      "metadata.google.internal",
      "intranet",
    ])
      expect(rejectionKind(`http://${host}/`)).toBe("hostname_blocked");
  });

  it("rejects private, loopback, link-local, CGNAT and unspecified IPv4 literals", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.5.5",
      "172.31.255.254",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
    ])
      expect(rejectionKind(`http://${ip}/`)).toBe("ip_literal_blocked");
  });

  it("rejects loopback, link-local, ULA, mapped and NAT64 IPv6 literals", () => {
    for (const ip of [
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "fc00::abcd",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "64:ff9b::7f00:1",
      "ff02::1",
    ])
      expect(rejectionKind(`http://[${ip}]/`)).toBe("ip_literal_blocked");
  });

  it("can allow loopback for local tests only when explicitly requested", () => {
    const result = validateTargetUrl("http://127.0.0.1:8080/", {
      allowLoopbackForTests: true,
    });
    expect(result.ok).toBe(true);
  });
});

describe("isBlockedIPv6", () => {
  it("treats malformed input as blocked", () => {
    expect(isBlockedIPv6("::1::2")).toBe(true);
    expect(isBlockedIPv6("1:2:3")).toBe(true);
    expect(isBlockedIPv6("zzzz::1")).toBe(true);
  });
  it("accepts a public global unicast address", () => {
    expect(isBlockedIPv6("2001:4860:4860::8888")).toBe(false);
    expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false);
  });
  it("blocks the documentation prefix", () => {
    expect(isBlockedIPv6("2001:db8::1")).toBe(true);
  });
});

describe("resolvePinnedAddress", () => {
  it("returns the first address when every resolved address is public", async () => {
    const result = await resolvePinnedAddress(new URL("https://example.com"), {
      resolver: () =>
        Promise.resolve([
          { address: "93.184.216.34" },
          { address: "2606:2800:220:1:248:1893:25c8:1946" },
        ]),
    });
    expect(result).toEqual({ ok: true, address: "93.184.216.34" });
  });

  it("rejects when any resolved address is private (rebinding guard)", async () => {
    const result = await resolvePinnedAddress(new URL("https://example.com"), {
      resolver: () =>
        Promise.resolve([
          { address: "93.184.216.34" },
          { address: "10.0.0.1" },
        ]),
    });
    expect(result).toEqual({
      ok: false,
      rejection: { kind: "resolved_address_blocked", address: "10.0.0.1" },
    });
  });

  it("reports resolver failures and empty answers", async () => {
    const failed = await resolvePinnedAddress(new URL("https://example.com"), {
      resolver: () => Promise.reject(new Error("ENOTFOUND")),
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.rejection.kind).toBe("resolution_failed");
    const empty = await resolvePinnedAddress(new URL("https://example.com"), {
      resolver: () => Promise.resolve([]),
    });
    expect(empty.ok).toBe(false);
  });

  it("never calls the resolver for IP literals", async () => {
    let calls = 0;
    const result = await resolvePinnedAddress(new URL("http://93.184.216.34"), {
      resolver: () => {
        calls += 1;
        return Promise.resolve([{ address: "127.0.0.1" }]);
      },
    });
    expect(calls).toBe(0);
    expect(result).toEqual({ ok: true, address: "93.184.216.34" });
  });
});
