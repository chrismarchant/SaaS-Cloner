import { describe, expect, it } from "vitest";
import { TARGET_CLASSES } from "./api/resources.js";
import { classifyTarget, ROUTE_TABLE, routeFor } from "./routing.js";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const classify = (name: string, head: Uint8Array) =>
  classifyTarget({ name, head });

describe("classifyTarget", () => {
  it("classifies native formats by magic bytes", () => {
    expect(classify("a.out", bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1))).toBe(
      "elf",
    );
    const core = new Uint8Array(20);
    core.set([0x7f, 0x45, 0x4c, 0x46], 0);
    core[16] = 0x04;
    core[17] = 0x00;
    expect(classify("core", core)).toBe("elf_core");
    expect(classify("app.exe", bytes(0x4d, 0x5a, 0x90, 0x00))).toBe("pe");
    expect(classify("lib", bytes(0xcf, 0xfa, 0xed, 0xfe))).toBe("macho");
    expect(classify("fat", bytes(0xca, 0xfe, 0xba, 0xbe))).toBe("macho");
    expect(classify("m.wasm", bytes(0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0))).toBe(
      "wasm",
    );
    expect(classify("x.pkg", bytes(0x78, 0x61, 0x72, 0x21))).toBe("pkg");
  });

  it("disambiguates zip containers by name", () => {
    const zip = bytes(0x50, 0x4b, 0x03, 0x04);
    expect(classify("app.apk", zip)).toBe("apk");
    expect(classify("app.ipa", zip)).toBe("ipa");
    expect(classify("app.msix", zip)).toBe("msix");
    expect(classify("bundle.zip", zip)).toBe("zip_archive");
    expect(classify("archive.jar", zip)).toBe("zip_archive");
  });

  it("classifies application trees, URLs and text formats", () => {
    expect(classify("app.asar", bytes(4, 0, 0, 0))).toBe("asar");
    expect(
      classifyTarget({ name: "tree", head: bytes(), isDirectory: true }),
    ).toBe("javascript_directory");
    expect(
      classifyTarget({
        name: "site",
        head: bytes(),
        url: "https://example.com",
      }),
    ).toBe("website_url");
    expect(classify("info.plist", Buffer.from("bplist00"))).toBe("plist");
    expect(classify("capture.har", Buffer.from('{"log":{}}'))).toBe("har");
    expect(classify("blob.dat", bytes(1, 2, 3, 4))).toBe("unknown");
  });
});

describe("ROUTE_TABLE", () => {
  it("covers every target class exactly once", () => {
    for (const targetClass of TARGET_CLASSES) {
      const matches = ROUTE_TABLE.filter((r) => r.class === targetClass);
      expect(matches, targetClass).toHaveLength(1);
    }
  });

  it("names a first tool that is part of the required tool set", () => {
    for (const route of ROUTE_TABLE) {
      if (route.first_tool !== null)
        expect(route.required_tools, route.class).toContain(route.first_tool);
      expect(route.required_tools).toContain("binary_session");
      expect(route.rationale.length).toBeGreaterThan(10);
    }
  });

  it("falls back to the unknown route", () => {
    expect(routeFor("unknown").first_tool).toBe("open_binary");
    expect(routeFor("asar").first_tool).toBe("analyze_javascript_application");
    expect(routeFor("website_url").required_providers_any_of).toContain(
      "rea-cdp-browser",
    );
  });
});
