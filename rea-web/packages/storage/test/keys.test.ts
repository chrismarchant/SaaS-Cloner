import { describe, expect, it } from "vitest";
import { InvalidObjectKeyError, validateObjectKey } from "../src/index.js";

describe("validateObjectKey", () => {
  it("returns well-formed keys unchanged", () => {
    for (const key of [
      "a",
      "projects/p1/targets/t1/payload",
      "x/y.tar.sig",
      "unicode/é/文件",
      `${"x".repeat(200)}/${"y".repeat(200)}`,
    ])
      expect(validateObjectKey(key)).toBe(key);
  });

  it.each([
    ["../x", "traversal"],
    ["a/../b", "traversal"],
    ["/abs", "absolute"],
    ["C:/x", "absolute"],
    ["a//b", "empty_segment"],
    ["a/", "empty_segment"],
    ["a/./b", "dot_segment"],
    ["./a", "dot_segment"],
    ["a\\b", "backslash"],
    ["a\u0000b", "control_characters"],
    ["a\nb", "control_characters"],
    ["", "empty"],
    [`${"x".repeat(200)}/${"y".repeat(313)}`, "too_long"],
    ["nul", "reserved_name"],
    [`${"x".repeat(241)}`, "segment_too_long"],
  ])("rejects %j as %s", (key, reason) => {
    try {
      validateObjectKey(key);
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidObjectKeyError);
      expect((error as InvalidObjectKeyError).reason).toBe(reason);
      expect((error as InvalidObjectKeyError).key).toBe(key);
    }
  });
});
