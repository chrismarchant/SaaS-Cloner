import { describe, expect, it } from "vitest";
import {
  compareVersions,
  firstVersion,
  networkVerdict,
  overallStatus,
  parseDatabaseUrl,
  parseRequirement,
  scopeStatus,
  blockedDatabaseHost,
  satisfies,
} from "../src/verify/index.js";

const passed = { status: "passed" as const };
const failed = { status: "failed" as const };
const blocked = { status: "blocked" as const };
const skipped = { status: "skipped" as const };

describe("scope status", () => {
  it("is the scope's verified status only when every step passed and every invariant held", () => {
    expect(scopeStatus("clean_build", [passed, passed], [])).toBe(
      "clean_build_verified",
    );
    expect(scopeStatus("data_restore", [passed], [{ ok: true }])).toBe(
      "data_restore_verified",
    );
    expect(scopeStatus("behavior", [passed], [])).toBe("behavior_verified");
  });
  it("is failed when anything ran and did not pass", () => {
    expect(scopeStatus("clean_build", [passed, failed, skipped], [])).toBe(
      "failed",
    );
    expect(
      scopeStatus("data_restore", [passed], [{ ok: true }, { ok: false }]),
    ).toBe("failed");
    expect(scopeStatus("clean_build", [failed, blocked], [])).toBe("failed");
  });
  it("is blocked when it could not run, and when there was nothing to check", () => {
    expect(scopeStatus("clean_build", [passed, blocked], [])).toBe("blocked");
    expect(scopeStatus("clean_build", [skipped], [])).toBe("blocked");
    expect(scopeStatus("data_restore", [], [])).toBe("blocked");
  });
});

describe("overall status", () => {
  const r = (
    scope: Parameters<typeof overallStatus>[0][number]["scope"],
    status: Parameters<typeof overallStatus>[0][number]["status"],
  ) => ({ scope, status });
  it("is the scope's status when exactly one scope ran", () => {
    expect(overallStatus([r("integrity", "integrity_verified")])).toBe(
      "integrity_verified",
    );
    expect(overallStatus([r("clean_build", "failed")])).toBe("failed");
    expect(overallStatus([r("data_restore", "blocked")])).toBe("blocked");
  });
  it("is the most demanding verified status when all scopes are verified", () => {
    expect(
      overallStatus([
        r("integrity", "integrity_verified"),
        r("clean_build", "clean_build_verified"),
        r("data_restore", "data_restore_verified"),
        r("behavior", "behavior_verified"),
      ]),
    ).toBe("behavior_verified");
    expect(
      overallStatus([
        r("clean_build", "clean_build_verified"),
        r("integrity", "integrity_verified"),
      ]),
    ).toBe("clean_build_verified");
  });
  it("is failed or blocked only when all scopes are, otherwise partial", () => {
    expect(
      overallStatus([r("integrity", "failed"), r("clean_build", "failed")]),
    ).toBe("failed");
    expect(
      overallStatus([r("integrity", "blocked"), r("clean_build", "blocked")]),
    ).toBe("blocked");
    expect(
      overallStatus([
        r("integrity", "integrity_verified"),
        r("clean_build", "blocked"),
      ]),
    ).toBe("partial");
    expect(
      overallStatus([
        r("integrity", "integrity_verified"),
        r("clean_build", "failed"),
      ]),
    ).toBe("partial");
    expect(
      overallStatus([r("clean_build", "failed"), r("behavior", "blocked")]),
    ).toBe("partial");
  });
});

describe("network verdict", () => {
  it("is yes when a registry or unknown step was needed, run or not", () => {
    expect(
      networkVerdict({ needed: ["step x needs registry"], executed: [] })
        .verdict,
    ).toBe("yes");
    expect(
      networkVerdict({
        needed: ["step x"],
        executed: [{ label: "a", isolated: true }],
      }).verdict,
    ).toBe("yes");
  });
  it("is no only when steps ran and every one was isolated", () => {
    expect(
      networkVerdict({ needed: [], executed: [{ label: "a", isolated: true }] })
        .verdict,
    ).toBe("no");
    expect(
      networkVerdict({
        needed: [],
        executed: [
          { label: "a", isolated: true },
          { label: "b", isolated: false },
        ],
      }),
    ).toMatchObject({
      verdict: "unknown",
      reasons: [expect.stringContaining("b")],
    });
  });
  it("is unknown when nothing ran", () => {
    expect(networkVerdict({ needed: [], executed: [] }).verdict).toBe(
      "unknown",
    );
  });
});

describe("tool requirements", () => {
  it("parses tool names and version constraints", () => {
    expect(parseRequirement("git")).toMatchObject({
      tool: "git",
      constraint: null,
    });
    expect(parseRequirement("git>=2.30")?.constraint).toEqual({
      operator: ">=",
      version: [2, 30],
    });
    expect(parseRequirement("node == 22")?.constraint).toEqual({
      operator: "=",
      version: [22],
    });
    expect(parseRequirement("pg_restore")?.tool).toBe("pg_restore");
    expect(parseRequirement("git>=")).toBeNull();
    expect(parseRequirement("rm -rf /")).toBeNull();
    expect(parseRequirement("../bin/git")).toBeNull();
  });
  it("reads the first x.y[.z] from a banner and compares numerically", () => {
    expect(firstVersion("git version 2.43.0")).toEqual([2, 43, 0]);
    expect(
      firstVersion("pg_restore (PostgreSQL) 16.4 (Ubuntu 16.4-1)"),
    ).toEqual([16, 4]);
    expect(
      firstVersion("git-lfs/3.4.1 (GitHub; linux amd64; go 1.22.2)"),
    ).toEqual([3, 4, 1]);
    expect(firstVersion("no digits")).toBeNull();
    expect(compareVersions([2, 9], [2, 30])).toBe(-1);
    expect(compareVersions([2, 30], [2, 30, 0])).toBe(0);
    expect(satisfies([2, 43, 0], { operator: ">=", version: [2, 30] })).toBe(
      true,
    );
    expect(satisfies([2, 9], { operator: ">=", version: [2, 30] })).toBe(false);
  });
});

describe("database URLs", () => {
  it("separates the password and normalises hosts", () => {
    const parsed = parseDatabaseUrl(
      "postgres://u:p%40ss@DB.Example.com.:5432/app?sslmode=require",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.db.password).toBe("p@ss");
    expect(parsed.db.hosts).toEqual(["db.example.com"]);
    expect(parsed.db.viaSocket).toBe(false);
    expect(parsed.db.urlWithoutPassword).not.toContain("p%40ss");
    expect(parsed.db.urlWithoutPassword).not.toContain("p@ss");
    expect(parsed.db.urlWithoutPassword).toContain("sslmode=require");
    expect(blockedDatabaseHost(parsed.db, ["db.example.com:5432"])).toBe(
      "db.example.com",
    );
    expect(blockedDatabaseHost(parsed.db, ["other.example.com"])).toBeNull();
  });
  it("recognises Unix socket hosts and a password given as a query parameter", () => {
    const socket = parseDatabaseUrl(
      "postgres://u@/app?host=/var/run/postgresql&password=querypw",
    );
    expect(socket.ok && socket.db.viaSocket).toBe(true);
    expect(socket.ok && socket.db.password).toBe("querypw");
    expect(socket.ok && socket.db.urlWithoutPassword).not.toContain("querypw");
    expect(socket.ok && socket.db.urlWithoutPassword).toBe(
      "postgres://u@/app?host=%2Fvar%2Frun%2Fpostgresql",
    );
    const mixed = parseDatabaseUrl(
      "postgres://u@h/app?host=/tmp,db.example.com",
    );
    expect(mixed.ok && mixed.db.viaSocket).toBe(false);
    const v6 = parseDatabaseUrl("postgres://u:pw@[::1]:5432/app");
    expect(v6.ok && v6.db.hosts).toEqual(["::1"]);
  });
  it("rejects other schemes without echoing the value", () => {
    const bad = parseDatabaseUrl("mysql://u:topsecretvalue@h/db");
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("topsecret");
    expect(parseDatabaseUrl("not a url").ok).toBe(false);
  });
});
