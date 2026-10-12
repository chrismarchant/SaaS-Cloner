import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  capabilityReportSchema,
  digestCapabilities,
  unmetRequirements,
  type CapabilityDigest,
  type CapabilityReport,
} from "./runner.js";

const FIXTURE_URL = new URL(
  "../test-fixtures/linux-no-providers-report.json",
  import.meta.url,
);

interface RawGroup {
  names: string[];
  available: boolean;
  reason?: string;
  remediation?: string | null;
  [key: string]: unknown;
}
interface RawReport {
  tool_availability: { groups: RawGroup[] };
  tools_list: { name: string }[];
  [key: string]: unknown;
}

/** The report exactly as captured from the upstream probe. */
const loadRawReport = (): RawReport =>
  JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as RawReport;

/**
 * Upstream emits `remediation: null` on groups that are available. The only
 * transformation applied here is dropping those nulls so the rest of the report
 * can be validated and typed independently of that one disagreement.
 */
const loadNormalisedReport = (): CapabilityReport => {
  const raw = loadRawReport();
  const groups = raw.tool_availability.groups.map((g) => {
    const { remediation, ...rest } = g;
    return remediation === null ? rest : g;
  });
  return capabilityReportSchema.parse({
    ...raw,
    tool_availability: { ...raw.tool_availability, groups },
  });
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

describe("linux-no-providers fixture", () => {
  it("validates against capabilityReportSchema as captured (verbatim upstream)", () => {
    // Spec section 7: tool_availability is carried verbatim from the upstream
    // binary_session result, which emits `remediation: null` for available
    // groups. The schema must accept what upstream actually sends.
    const result = capabilityReportSchema.safeParse(loadRawReport());
    expect(result.success ? [] : result.error.issues.slice(0, 3)).toEqual([]);
  });

  it("validates once the null remediation values are removed (nothing else is wrong)", () => {
    const report = loadNormalisedReport();
    expect(report.protocol_version).toBe(1);
    expect(report.host.os).toBe("linux");
    expect(report.rea?.package_version).toBe("6.4.0");
    expect(report.rea?.catalog.counts["mcp_tools"]).toBe(173);
  });

  it("carries 173 tools whose schema digests are sha256 of the serialised input schema", () => {
    const report = loadNormalisedReport();
    expect(report.tools_list).toHaveLength(173);
    for (const tool of report.tools_list) {
      expect(tool.input_schema_sha256).toBe(
        sha256(JSON.stringify(tool.input_schema)),
      );
    }
    expect(new Set(report.tools_list.map((t) => t.name)).size).toBe(173);
  });
});

describe("digestCapabilities (fixture)", () => {
  const report = loadNormalisedReport();
  const digest = digestCapabilities(report);

  it("partitions every advertised tool exactly once", () => {
    const total =
      digest.tools_available.length +
      digest.tools_target_required.length +
      digest.tools_unavailable.size;
    expect(total).toBe(report.tools_list.length);
    expect(total).toBe(173);

    const all = [
      ...digest.tools_available,
      ...digest.tools_target_required,
      ...digest.tools_unavailable.keys(),
    ];
    expect(new Set(all).size).toBe(173);
    expect(new Set(all)).toEqual(new Set(report.tools_list.map((t) => t.name)));
  });

  it("matches the probe counts: 63 available, 59 target_required, 51 unavailable", () => {
    expect(digest.tools_available).toHaveLength(63);
    expect(digest.tools_target_required).toHaveLength(59);
    expect(digest.tools_unavailable.size).toBe(51);
  });

  it("classifies unavailable tools only as provider_missing or unsupported_host", () => {
    const reasons = new Set(
      [...digest.tools_unavailable.values()].map((d) => d.reason),
    );
    expect([...reasons].sort()).toEqual([
      "provider_missing",
      "unsupported_host",
    ]);
    for (const detail of digest.tools_unavailable.values()) {
      expect(detail.remediation.length).toBeGreaterThan(0);
    }
  });

  it("reports none of the external analysis providers (ghidra, hopper, ida)", () => {
    expect(digest.providers_available).not.toContain("ghidra");
    expect(digest.providers_available).not.toContain("hopper");
    expect(digest.providers_available).not.toContain("ida");
    expect(digest.providers_available).not.toContain("native-macos");
  });

  it("reports built-in providers that have at least one available capability group", () => {
    // Observed: the two built-in providers expose available groups, so they are
    // listed. See the completion report on the "empty for this host" wording.
    expect(digest.providers_available).toEqual([
      "rea-artifact-graph",
      "rea-dotnet-static",
    ]);
  });

  it("copies host os, labels and collectors from the report", () => {
    expect(digest.os).toBe("linux");
    expect(digest.labels).toEqual(["linux", "no-providers"]);
    expect(digest.collectors).toEqual([]);
  });

  it("is deterministic", () => {
    const again = digestCapabilities(report);
    expect(again.tools_available).toEqual(digest.tools_available);
    expect([...again.tools_unavailable]).toEqual([...digest.tools_unavailable]);
  });
});

const baseReport = (): CapabilityReport => loadNormalisedReport();

const syntheticReport = (
  patch: Partial<CapabilityReport>,
): CapabilityReport => ({
  ...baseReport(),
  tools_list: [],
  tool_availability: { groups: [] },
  analysis_provider_candidates: [],
  provider_capabilities: [],
  ...patch,
});

describe("digestCapabilities (synthetic reports)", () => {
  it("falls back to reason 'unavailable' and empty remediation", () => {
    const digest = digestCapabilities(
      syntheticReport({
        tool_availability: { groups: [{ names: ["x"], available: false }] },
      }),
    );
    expect(digest.tools_unavailable.get("x")).toEqual({
      reason: "unavailable",
      remediation: "",
    });
  });

  it("does not treat an available group's reason as target_required", () => {
    const digest = digestCapabilities(
      syntheticReport({
        tool_availability: {
          groups: [
            { names: ["a"], available: true, reason: "target_required" },
            { names: ["b"], available: false, reason: "target_required" },
          ],
        },
      }),
    );
    expect(digest.tools_available).toEqual(["a"]);
    expect(digest.tools_target_required).toEqual(["b"]);
  });

  it("collects analysis providers whose availability status is available", () => {
    const digest = digestCapabilities(
      syntheticReport({
        analysis_provider_candidates: [
          { provider_id: "alpha", availability: { status: "available" } },
          { id: "beta", availability: { status: "available" } },
          { provider_id: "gamma", availability: { status: "unavailable" } },
          { provider_id: "delta" },
          { provider_id: 7, availability: { status: "available" } },
          { provider_id: "epsilon", availability: null },
        ],
      }),
    );
    expect(digest.providers_available).toEqual(["alpha", "beta"]);
  });

  it("adds capability providers with an available group once, without duplicating candidates", () => {
    const digest = digestCapabilities(
      syntheticReport({
        analysis_provider_candidates: [
          { provider_id: "alpha", availability: { status: "available" } },
        ],
        provider_capabilities: [
          { provider: { id: "alpha" }, groups: [{ available: true }] },
          {
            provider: { id: "beta" },
            groups: [{ available: false }, { available: true }],
          },
          { provider: { id: "gamma" }, groups: [{ available: false }] },
          { provider: { id: "delta" }, groups: "nope" },
          { provider: {}, groups: [{ available: true }] },
        ],
      }),
    );
    expect(digest.providers_available).toEqual(["alpha", "beta"]);
  });
});

const digestOf = (patch: Partial<CapabilityDigest> = {}): CapabilityDigest => ({
  ...digestCapabilities(baseReport()),
  ...patch,
});

const noRequirements = {
  tools: [] as string[],
  providers: [] as string[],
  os: [] as string[],
  labels: [] as string[],
};

describe("unmetRequirements", () => {
  const groups = loadRawReport().tool_availability.groups;
  const groupFor = (tool: string): RawGroup =>
    groups.find((g) => g.names.includes(tool)) as RawGroup;

  it("returns nothing for empty requirements", () => {
    expect(unmetRequirements(digestOf(), noRequirements)).toEqual([]);
  });

  it("returns nothing when required tools are available or target_required", () => {
    const digest = digestOf();
    expect(digest.tools_available).toContain("open_binary");
    expect(digest.tools_target_required.length).toBeGreaterThan(0);
    const targetRequired = digest.tools_target_required[0] as string;
    expect(
      unmetRequirements(digest, {
        ...noRequirements,
        tools: ["open_binary", "inspect_go_binary", targetRequired],
      }),
    ).toEqual([]);
  });

  it("reports a provider_missing tool with the upstream remediation text verbatim", () => {
    const unmet = unmetRequirements(digestOf(), {
      ...noRequirements,
      tools: ["inspect_android_package"],
    });
    expect(unmet).toEqual([
      {
        kind: "tool",
        value: "inspect_android_package",
        reason: "provider_missing",
        remediation:
          "Set REA_JADX_MCP_JAR to the absolute path of a caller-supplied jadx-headless-mcp 0.7.1 JAR. REA does not download or install it.",
      },
    ]);
    expect(unmet[0]?.remediation).toBe(
      groupFor("inspect_android_package").remediation,
    );
  });

  it("preserves non-ASCII characters in remediation text", () => {
    const unmet = unmetRequirements(digestOf(), {
      ...noRequirements,
      tools: ["inspect_firmware_regions"],
    });
    expect(unmet).toHaveLength(1);
    expect(unmet[0]?.remediation).toBe(
      groupFor("inspect_firmware_regions").remediation,
    );
    expect(unmet[0]?.remediation).toContain("format’s external extractor");
  });

  it("reports an unsupported_host tool with its upstream reason", () => {
    const unmet = unmetRequirements(digestOf(), {
      ...noRequirements,
      tools: ["inspect_macho"],
    });
    expect(unmet).toEqual([
      {
        kind: "tool",
        value: "inspect_macho",
        reason: "unsupported_host",
        remediation: "Native macOS utilities require macOS.",
      },
    ]);
  });

  it("reports a tool the catalog does not advertise as not_advertised", () => {
    expect(
      unmetRequirements(digestOf(), {
        ...noRequirements,
        tools: ["definitely_not_a_tool"],
      }),
    ).toEqual([
      {
        kind: "tool",
        value: "definitely_not_a_tool",
        reason: "not_advertised",
        remediation: "The runner's REA catalog does not advertise this tool.",
      },
    ]);
  });

  it("reports a missing provider and accepts a present one", () => {
    const unmet = unmetRequirements(digestOf(), {
      ...noRequirements,
      providers: ["ghidra", "rea-dotnet-static"],
    });
    expect(unmet.map((u) => [u.kind, u.value, u.reason])).toEqual([
      ["provider", "ghidra", "provider_unavailable"],
    ]);
  });

  it("reports an os mismatch as a single joined entry", () => {
    const unmet = unmetRequirements(digestOf(), {
      ...noRequirements,
      os: ["darwin", "win32"],
    });
    expect(unmet).toEqual([
      {
        kind: "os",
        value: "darwin|win32",
        reason: "unsupported_host",
        remediation: "Requires one of darwin, win32; runner is linux.",
      },
    ]);
  });

  it("accepts an os list that includes the runner's os", () => {
    expect(
      unmetRequirements(digestOf(), {
        ...noRequirements,
        os: ["darwin", "linux"],
      }),
    ).toEqual([]);
  });

  it("reports each missing label", () => {
    const unmet = unmetRequirements(digestOf(), {
      ...noRequirements,
      labels: ["linux", "gpu", "has-ida"],
    });
    expect(unmet.map((u) => [u.kind, u.value, u.reason])).toEqual([
      ["label", "gpu", "label_missing"],
      ["label", "has-ida", "label_missing"],
    ]);
  });

  it("reports a missing collector and treats an omitted collectors list as none", () => {
    const withCollectors = digestOf({ collectors: ["git"] });
    expect(
      unmetRequirements(withCollectors, {
        ...noRequirements,
        collectors: ["git", "postgres"],
      }),
    ).toEqual([
      {
        kind: "collector",
        value: "postgres",
        reason: "collector_missing",
        remediation: "Attach a runner with this collector enabled.",
      },
    ]);
    expect(unmetRequirements(withCollectors, noRequirements)).toEqual([]);
  });

  it("reports unmet entries grouped as tools, providers, os, labels, collectors", () => {
    const unmet = unmetRequirements(digestOf(), {
      tools: ["definitely_not_a_tool"],
      providers: ["ida"],
      os: ["win32"],
      labels: ["gpu"],
      collectors: ["git"],
    });
    expect(unmet.map((u) => u.kind)).toEqual([
      "tool",
      "provider",
      "os",
      "label",
      "collector",
    ]);
  });
});

describe("capabilityReportSchema constraints", () => {
  const valid = (): Record<string, unknown> => {
    const { tool_availability: _ta, ...rest } = loadRawReport();
    return { ...rest, tool_availability: { groups: [] } };
  };

  it("accepts a minimal valid report", () => {
    expect(capabilityReportSchema.safeParse(valid()).success).toBe(true);
  });

  it("rejects an unsupported protocol version", () => {
    expect(
      capabilityReportSchema.safeParse({ ...valid(), protocol_version: 2 })
        .success,
    ).toBe(false);
  });

  it("rejects env capability names that are not upper snake case", () => {
    expect(
      capabilityReportSchema.safeParse({
        ...valid(),
        env_capability_names: ["ghidra_install_dir"],
      }).success,
    ).toBe(false);
    expect(
      capabilityReportSchema.safeParse({
        ...valid(),
        env_capability_names: ["GHIDRA_INSTALL_DIR"],
      }).success,
    ).toBe(true);
  });

  it("rejects out-of-range concurrency and over-long label lists", () => {
    expect(
      capabilityReportSchema.safeParse({ ...valid(), max_concurrent_jobs: 0 })
        .success,
    ).toBe(false);
    expect(
      capabilityReportSchema.safeParse({ ...valid(), max_concurrent_jobs: 65 })
        .success,
    ).toBe(false);
    expect(
      capabilityReportSchema.safeParse({
        ...valid(),
        labels: Array.from({ length: 33 }, (_, i) => `l${i}`),
      }).success,
    ).toBe(false);
  });

  it("defaults collectors to an empty list", () => {
    const { collectors: _c, ...withoutCollectors } = valid();
    const parsed = capabilityReportSchema.parse(withoutCollectors);
    expect(parsed.collectors).toEqual([]);
  });
});
