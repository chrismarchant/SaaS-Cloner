import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "../src/index.js";
import { isRemoteGitUrl, redactUrl } from "../src/util.js";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pres-cmd-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runCommand", () => {
  it("passes argument arrays without a shell", async () => {
    const hostile = "a; touch pwned && echo $(id) `id` | cat > pwned";
    const r = await runCommand(
      ["node", "-e", "console.log(process.argv[1])", hostile],
      { cwd: dir },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(hostile);
    await expect(readFile(join(dir, "pwned"))).rejects.toThrow();
  });

  it("runs with exactly the given environment (plus PATH)", async () => {
    process.env["PRESERVATION_AMBIENT_SENTINEL"] = "leaked";
    const r = await runCommand(
      [
        "node",
        "-e",
        "console.log(JSON.stringify(Object.keys(process.env).sort()))",
      ],
      { env: { ONLY_THIS: "1" } },
    );
    delete process.env["PRESERVATION_AMBIENT_SENTINEL"];
    const keys = JSON.parse(r.stdout) as string[];
    expect(keys).toContain("ONLY_THIS");
    expect(keys).toContain("PATH");
    expect(keys).not.toContain("PRESERVATION_AMBIENT_SENTINEL");
  });

  it("kills the whole process group on timeout", async () => {
    const marker = join(dir, "grandchild-ran");
    const script = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',"setTimeout(()=>require('fs').writeFileSync(process.argv[1],'x'),1500)",${JSON.stringify(marker)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const r = await runCommand(["node", "-e", script], { timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await expect(readFile(marker)).rejects.toThrow();
  });

  it("stops on abort and reports it", async () => {
    const controller = new AbortController();
    const pending = runCommand(["node", "-e", "setInterval(()=>{},1000)"], {
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    setTimeout(() => controller.abort(), 150);
    const r = await pending;
    expect(r.exitCode).not.toBe(0);
    expect(r.durationMs).toBeLessThan(10_000);
    const early = await runCommand(["node", "-e", "1"], {
      signal: controller.signal,
    });
    expect(early.exitCode).toBeNull();
  });

  it("caps output and reports spawn failures without throwing", async () => {
    const big = await runCommand(
      ["node", "-e", "process.stdout.write('x'.repeat(100000))"],
      { maxOutputBytes: 1000 },
    );
    expect(big.stdout.length).toBeLessThan(1200);
    expect(big.stdout).toContain("[output truncated");
    const missing = await runCommand(["definitely-not-a-real-binary-xyz"]);
    expect(missing.exitCode).toBeNull();
    expect(missing.stderr).toMatch(/ENOENT/u);
  });

  it("feeds stdin", async () => {
    const r = await runCommand(
      ["node", "-e", "process.stdin.pipe(process.stdout)"],
      { input: "hello" },
    );
    expect(r.stdout).toBe("hello");
  });
});

describe("git location helpers", () => {
  it("classifies remote and local locations", () => {
    expect(isRemoteGitUrl("https://github.com/o/r.git")).toBe(true);
    expect(isRemoteGitUrl("git@github.com:o/r.git")).toBe(true);
    expect(isRemoteGitUrl("ssh://git@host/o/r")).toBe(true);
    expect(isRemoteGitUrl("/srv/repos/app")).toBe(false);
    expect(isRemoteGitUrl("./app")).toBe(false);
    expect(isRemoteGitUrl("file:///srv/repos/app")).toBe(true);
  });

  it("strips userinfo, query and fragment", () => {
    expect(redactUrl("https://user:tok3n@example.com/o/r.git?x=1#f")).toBe(
      "https://example.com/o/r.git",
    );
    expect(redactUrl("git@github.com:o/r.git")).toBe("github.com:o/r.git");
    expect(redactUrl("/local/path")).toBe("/local/path");
  });
});
