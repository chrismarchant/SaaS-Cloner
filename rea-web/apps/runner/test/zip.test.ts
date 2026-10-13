import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZipWriter } from "../src/zip.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "rea-web-zip-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("ZipWriter", () => {
  it("writes stored and deflated members an independent reader verifies", async () => {
    const path = join(scratch, "ok.zip");
    const zip = await ZipWriter.create(path);
    await zip.add("a.json", Buffer.from("x".repeat(10_000)));
    await zip.add("raw/1-tool.json", Buffer.from([0, 1, 2, 3]));
    await zip.add("empty.txt", Buffer.alloc(0));
    await zip.finish();
    const out = execFileSync(
      "python3",
      [
        "-I",
        "-c",
        "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(','.join(f'{i.filename}:{i.file_size}:{i.compress_type}' for i in z.infolist()))",
        path,
      ],
      { encoding: "utf8" },
    ).trim();
    expect(out).toBe("a.json:10000:8,raw/1-tool.json:4:0,empty.txt:0:0");
  });

  it("refuses traversal, absolute, odd and duplicate member names", async () => {
    const zip = await ZipWriter.create(join(scratch, "bad.zip"));
    for (const name of [
      "../x",
      "a/../../x",
      "/etc/passwd",
      "a\\b",
      "",
      "a//b",
      "./a",
      "näme",
    ])
      await expect(zip.add(name, Buffer.from("x"))).rejects.toThrow(
        /unsafe zip member name/u,
      );
    await zip.add("ok", Buffer.from("x"));
    await expect(zip.add("ok", Buffer.from("y"))).rejects.toThrow(/duplicate/u);
    await zip.abort();
  });
});
