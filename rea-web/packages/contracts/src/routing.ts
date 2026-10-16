import type { TargetClass } from "./api/resources.js";

/**
 * Route table transcribed from the upstream skill
 * `.agents/skills/reverse-engineer-anything/SKILL.md` ("Route the target first")
 * at the pinned revision. Each entry names the first tool, whether `open_binary`
 * must precede it, and provider candidates. Tool names are checked against the
 * runner's live catalog at job time; this table never asserts availability.
 */
export interface RouteEntry {
  readonly class: TargetClass;
  readonly first_tool: string | null;
  readonly requires_open_binary: boolean;
  readonly required_tools: readonly string[];
  readonly required_providers_any_of: readonly string[];
  readonly required_os: readonly ("linux" | "darwin" | "win32")[];
  readonly rationale: string;
}

export const ROUTE_TABLE: readonly RouteEntry[] = [
  {
    class: "asar",
    first_tool: "analyze_javascript_application",
    requires_open_binary: false,
    required_tools: ["analyze_javascript_application", "binary_session"],
    required_providers_any_of: [],
    required_os: [],
    rationale:
      "ASAR or extracted JavaScript/Electron tree routes to analyze_javascript_application (SKILL.md: Route the target first).",
  },
  {
    class: "javascript_directory",
    first_tool: "analyze_javascript_application",
    requires_open_binary: false,
    required_tools: ["analyze_javascript_application", "binary_session"],
    required_providers_any_of: [],
    required_os: [],
    rationale:
      "Extracted JavaScript/Electron tree routes to analyze_javascript_application.",
  },
  {
    class: "zip_archive",
    first_tool: "open_binary",
    requires_open_binary: true,
    required_tools: ["open_binary", "inspect_artifact", "binary_session"],
    required_providers_any_of: [],
    required_os: [],
    rationale:
      "Archive/package member inventory: open_binary with the supplied path, then inspect_artifact.",
  },
  {
    class: "apk",
    first_tool: "inspect_android_package",
    requires_open_binary: false,
    required_tools: ["inspect_android_package", "binary_session"],
    required_providers_any_of: ["jadx"],
    required_os: [],
    rationale:
      "Android APK code routes to inspect_android_package (requires caller-supplied jadx-headless-mcp); archive inventory still uses open_binary.",
  },
  {
    class: "ipa",
    first_tool: "open_binary",
    requires_open_binary: true,
    required_tools: ["open_binary", "inspect_artifact", "binary_session"],
    required_providers_any_of: [],
    required_os: [],
    rationale:
      "IPA is an archive; member inventory via open_binary + inspect_artifact.",
  },
  {
    class: "dmg",
    first_tool: "open_binary",
    requires_open_binary: true,
    required_tools: ["open_binary", "inspect_artifact", "binary_session"],
    required_providers_any_of: [],
    required_os: ["darwin"],
    rationale:
      "DMG child inventory uses a read-only native macOS mount (provider limitations in capabilities).",
  },
  {
    class: "pkg",
    first_tool: "open_binary",
    requires_open_binary: true,
    required_tools: ["open_binary", "inspect_artifact", "binary_session"],
    required_providers_any_of: [],
    required_os: [],
    rationale: "PKG remains root-hash-only in the artifact graph provider.",
  },
  {
    class: "msix",
    first_tool: "open_binary",
    requires_open_binary: true,
    required_tools: ["open_binary", "inspect_artifact", "binary_session"],
    required_providers_any_of: [],
    required_os: [],
    rationale: "MSIX/AppX member inventory via open_binary + inspect_artifact.",
  },
  {
    class: "pe_managed",
    first_tool: "inspect_managed_artifact",
    requires_open_binary: false,
    required_tools: [
      "inspect_managed_artifact",
      "inspect_managed_members",
      "binary_session",
    ],
    required_providers_any_of: [],
    required_os: [],
    rationale:
      "Managed PE/CLI assembly routes to inspect_managed_artifact (built-in static metadata provider).",
  },
  {
    class: "pe",
    first_tool: "inspect_pe_resources",
    requires_open_binary: false,
    required_tools: ["inspect_pe_resources", "binary_session"],
    required_providers_any_of: [],
    required_os: [],
    rationale:
      "Native PE: portable resource inspection first; deep analysis via open_binary needs ghidra|hopper|ida (recorded as optional provider step).",
  },
  {
    class: "elf",
    first_tool: "inspect_go_binary",
    requires_open_binary: false,
    required_tools: ["inspect_go_binary", "binary_session"],
    required_providers_any_of: [],
    required_os: [],
    rationale:
      "Native ELF: built-in target-free Go metadata inspection first; inspect_binary_layout needs pwntools; deep analysis via open_binary needs ghidra|hopper|ida.",
  },
  {
    class: "elf_core",
    first_tool: "inspect_recorded_crash",
    requires_open_binary: false,
    required_tools: ["inspect_recorded_crash", "binary_session"],
    required_providers_any_of: ["pwntools-elf"],
    required_os: ["linux"],
    rationale:
      "Linux x86-64 ELF core routes to inspect_recorded_crash (caller-supplied pwntools).",
  },
  {
    class: "macho",
    first_tool: "inspect_go_binary",
    requires_open_binary: false,
    required_tools: ["inspect_go_binary", "binary_session"],
    required_providers_any_of: [],
    required_os: [],
    rationale:
      "Mach-O: built-in Go metadata inspection is target-free everywhere; inspect_macho/inspect_signature/inspect_plist require macOS; deep analysis via open_binary needs ghidra|hopper|ida.",
  },
  {
    class: "wasm",
    first_tool: "inspect_wasm_artifact",
    requires_open_binary: false,
    required_tools: ["inspect_wasm_artifact", "binary_session"],
    required_providers_any_of: ["wabt-artifact"],
    required_os: [],
    rationale:
      "Explicit local WebAssembly artifact routes to inspect_wasm_artifact (WABT 1.0.42 via REA_WABT_BIN_DIRECTORY).",
  },
  {
    class: "evm_bytecode",
    first_tool: "inspect_evm_interface",
    requires_open_binary: false,
    required_tools: ["inspect_evm_interface", "binary_session"],
    required_providers_any_of: [],
    required_os: [],
    rationale:
      "Explicit EVM bytecode carrier routes to inspect_evm_interface (built-in EVMole worker).",
  },
  {
    class: "firmware_image",
    first_tool: "inspect_firmware_regions",
    requires_open_binary: false,
    required_tools: ["inspect_firmware_regions", "binary_session"],
    required_providers_any_of: ["binwalk", "unblob"],
    required_os: ["linux"],
    rationale:
      "Firmware image routes to inspect_firmware_regions when advertised (caller-supplied Binwalk/Unblob on Linux).",
  },
  {
    class: "har",
    first_tool: "inspect_web_network_capture",
    requires_open_binary: false,
    required_tools: ["inspect_web_network_capture", "binary_session"],
    required_providers_any_of: [],
    required_os: [],
    rationale:
      "Retained HAR capture routes to inspect_web_network_capture without fetching recorded URLs.",
  },
  {
    class: "mitmproxy_flow",
    first_tool: "inspect_web_network_capture",
    requires_open_binary: false,
    required_tools: ["inspect_web_network_capture", "binary_session"],
    required_providers_any_of: [],
    required_os: ["linux"],
    rationale:
      "Native mitmproxy capture decoding requires mitmdump on Linux (REA_MITMDUMP_COMMAND).",
  },
  {
    class: "process_capture",
    first_tool: "compare_process_captures",
    requires_open_binary: false,
    required_tools: ["compare_process_captures", "binary_session"],
    required_providers_any_of: [],
    required_os: [],
    rationale:
      "A supplied process capture is compared or inspected as inline Evidence; new captures execute foreign code and need approval.",
  },
  {
    class: "website_url",
    first_tool: "inspect_web_page",
    requires_open_binary: false,
    required_tools: [
      "inspect_web_page",
      "list_browser_targets",
      "binary_session",
    ],
    required_providers_any_of: ["rea-cdp-browser"],
    required_os: [],
    rationale:
      "Website targets need a runner-owned Chromium (REA_BROWSER_EXECUTABLE) and a CDP endpoint; a remote browser cannot inspect the operator's local machine.",
  },
  {
    class: "plist",
    first_tool: "inspect_keyed_archive",
    requires_open_binary: false,
    required_tools: ["inspect_keyed_archive", "binary_session"],
    required_providers_any_of: [],
    required_os: [],
    rationale: "Foundation keyed archives route to inspect_keyed_archive.",
  },
  {
    class: "unknown",
    first_tool: "open_binary",
    requires_open_binary: true,
    required_tools: ["open_binary", "inspect_artifact", "binary_session"],
    required_providers_any_of: [],
    required_os: [],
    rationale:
      "Unclassified input: open_binary with the supplied local path and inspect_artifact for observations and next probes.",
  },
];

export const routeFor = (targetClass: TargetClass): RouteEntry =>
  ROUTE_TABLE.find((r) => r.class === targetClass) ??
  (ROUTE_TABLE.find((r) => r.class === "unknown") as RouteEntry);

/** Classify by sniffed magic bytes and name. Pure; no I/O. */
export const classifyTarget = (input: {
  readonly name: string;
  readonly head: Uint8Array;
  readonly isDirectory?: boolean;
  readonly url?: string | null;
}): TargetClass => {
  if (input.url) return "website_url";
  if (input.isDirectory) return "javascript_directory";
  const name = input.name.toLowerCase();
  const h = input.head;
  const startsWith = (...bytes: number[]) => bytes.every((b, i) => h[i] === b);
  const text = Buffer.from(h.subarray(0, Math.min(h.length, 512))).toString(
    "latin1",
  );
  if (name.endsWith(".asar")) return "asar";
  if (startsWith(0x7f, 0x45, 0x4c, 0x46)) {
    if (h.length > 16 && h[16] === 0x04 && h[17] === 0x00) return "elf_core";
    return "elf";
  }
  if (startsWith(0x4d, 0x5a))
    return name.endsWith(".dll") || name.endsWith(".exe") ? "pe" : "pe";
  if (
    startsWith(0xcf, 0xfa, 0xed, 0xfe) ||
    startsWith(0xce, 0xfa, 0xed, 0xfe) ||
    startsWith(0xca, 0xfe, 0xba, 0xbe) ||
    startsWith(0xfe, 0xed, 0xfa, 0xcf) ||
    startsWith(0xfe, 0xed, 0xfa, 0xce)
  )
    return "macho";
  if (startsWith(0x00, 0x61, 0x73, 0x6d)) return "wasm";
  if (
    startsWith(0x50, 0x4b, 0x03, 0x04) ||
    startsWith(0x50, 0x4b, 0x05, 0x06)
  ) {
    if (name.endsWith(".apk")) return "apk";
    if (name.endsWith(".ipa")) return "ipa";
    if (name.endsWith(".msix") || name.endsWith(".appx")) return "msix";
    return "zip_archive";
  }
  if (startsWith(0x78, 0x61, 0x72, 0x21)) return "pkg";
  if (name.endsWith(".dmg")) return "dmg";
  if (name.endsWith(".har") || /^\s*\{\s*"log"\s*:/u.test(text)) return "har";
  if (name.endsWith(".plist") || startsWith(0x62, 0x70, 0x6c, 0x69, 0x73, 0x74))
    return "plist";
  if (
    /^\s*\{[\s\S]*"process_capture"|"capture_process_scenario"/u.test(text) &&
    name.endsWith(".json")
  )
    return "process_capture";
  if (
    /^(0x)?[0-9a-fA-F]{40,}\s*$/u.test(text.trim()) &&
    (name.endsWith(".hex") || name.endsWith(".evm") || name.endsWith(".bin"))
  )
    return "evm_bytecode";
  if (name.endsWith(".flow") || name.endsWith(".mitm")) return "mitmproxy_flow";
  if (/\.(bin|img|fw|rom|trx|chk)$/u.test(name)) return "firmware_image";
  return "unknown";
};
