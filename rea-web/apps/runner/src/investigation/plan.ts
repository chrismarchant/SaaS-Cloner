import { open } from "node:fs/promises";
import type { RouteEntry, TargetClass } from "@rea-web/contracts";

/**
 * Deterministic first-pass steps per target class. Each step names an upstream
 * tool and builds arguments from the workspace target path. Steps whose tool
 * is unavailable on this runner are not called; the unavailability (with the
 * runner's own reason and remediation) becomes an `unknown` finding.
 */
export interface PlannedStep {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly purpose: string;
  /** Skip without a finding when unavailable (optional enrichment). */
  readonly optional?: boolean;
}

const evmEncoding = async (path: string): Promise<"hex" | "raw"> => {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("latin1").trim();
    return /^(0x)?[0-9a-fA-F\s]+$/u.test(text) ? "hex" : "raw";
  } finally {
    await handle.close();
  }
};

export const planSteps = async (
  targetClass: TargetClass,
  targetPath: string | null,
  route: RouteEntry,
): Promise<PlannedStep[]> => {
  if (targetPath === null) return [];
  const path = targetPath;
  const archive = (): PlannedStep[] => [
    {
      tool: "open_binary",
      args: { path },
      purpose: "Select the supplied archive as the active target",
    },
    {
      tool: "inspect_artifact",
      args: {},
      purpose: "Inventory archive members, graph and findings",
    },
  ];
  switch (targetClass) {
    case "asar":
    case "javascript_directory":
      return [
        {
          tool: "analyze_javascript_application",
          args: { input_path: path },
          purpose:
            "Statically reconstruct the JavaScript/Electron application graph",
        },
      ];
    case "zip_archive":
    case "ipa":
    case "msix":
    case "pkg":
    case "dmg":
    case "unknown":
      return archive();
    case "apk":
      return [
        {
          tool: "inspect_android_package",
          args: { path },
          purpose: "Inspect APK declarations and manifest",
        },
        ...archive(),
      ];
    case "pe":
    case "pe_managed":
      return [
        {
          tool: "inspect_managed_artifact",
          args: { path },
          purpose: "Check for PE/CLI managed metadata",
        },
        {
          tool: "inspect_pe_resources",
          args: { path },
          purpose: "Inspect PE resources and icon groups",
        },
        {
          tool: "inspect_go_binary",
          args: { path },
          purpose: "Look for embedded Go build metadata",
          optional: true,
        },
      ];
    case "elf":
      return [
        {
          tool: "inspect_go_binary",
          args: { path },
          purpose: "Look for embedded Go build metadata",
        },
        {
          tool: "inspect_binary_layout",
          args: { path },
          purpose: "Offline ELF layout, symbols and mitigations",
        },
      ];
    case "elf_core":
      return [
        {
          tool: "inspect_recorded_crash",
          args: { path },
          purpose: "Read recorded threads and registers",
        },
      ];
    case "macho":
      return [
        {
          tool: "inspect_go_binary",
          args: { path },
          purpose: "Look for embedded Go build metadata",
        },
        {
          tool: "inspect_macho",
          args: { path },
          purpose: "Mach-O load commands (macOS host)",
          optional: true,
        },
      ];
    case "wasm":
      return [
        {
          tool: "inspect_wasm_artifact",
          args: { path },
          purpose: "Decode the WebAssembly module with WABT",
        },
      ];
    case "evm_bytecode":
      return [
        {
          tool: "inspect_evm_interface",
          args: { path, encoding: await evmEncoding(path) },
          purpose: "Infer EVM interface candidates",
        },
      ];
    case "firmware_image":
      return [
        {
          tool: "inspect_firmware_regions",
          args: { path },
          purpose: "Locate firmware signature candidates",
        },
      ];
    case "har":
      return [
        {
          tool: "inspect_web_network_capture",
          args: { capture_path: path, format: "har" },
          purpose: "Inspect retained HAR records without fetching URLs",
        },
      ];
    case "mitmproxy_flow":
      return [
        {
          tool: "inspect_web_network_capture",
          args: { capture_path: path, format: "mitmproxy" },
          purpose: "Inspect retained mitmproxy records without fetching URLs",
        },
      ];
    case "plist":
      return [
        {
          tool: "inspect_keyed_archive",
          args: { path },
          purpose: "Read a Foundation keyed archive",
        },
      ];
    case "process_capture":
    case "website_url":
      return [];
    default:
      return route.first_tool
        ? [{ tool: route.first_tool, args: { path }, purpose: route.rationale }]
        : [];
  }
};

/** Classes whose analysis needs a capability the runner cannot provide from a file alone. */
export const unsupportedClassReason = (
  targetClass: TargetClass,
): string | null => {
  if (targetClass === "website_url")
    return "Website analysis needs a runner-owned Chromium reachable over a loopback CDP endpoint (REA_BROWSER_EXECUTABLE plus a launched browser). This runner does not launch browsers for remote URLs; a remote browser cannot inspect an application on the operator's own computer.";
  if (targetClass === "process_capture")
    return "A single process capture is comparison input. Supply a second capture and use the comparison workflow (compare_process_captures).";
  return null;
};
