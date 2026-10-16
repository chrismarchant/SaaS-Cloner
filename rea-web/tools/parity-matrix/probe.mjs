#!/usr/bin/env node
// Live runtime probe: start the upstream REA MCP server over stdio, list tools
// and prompts, call binary_session {} and write everything verbatim to JSON.
// Usage: node tools/parity-matrix/probe.mjs --repo-root .. --out probes/<host>.json
// Must run with the upstream checkout's node_modules resolvable; the simplest
// way is `cd .. && node rea-web/tools/parity-matrix/probe.mjs --repo-root . --out ...`.
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hostname, platform, arch, release } from "node:os";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i], process.argv[i + 1]);
const repoRoot = resolve(args.get("--repo-root") ?? "..");
const outPath = resolve(
  args.get("--out") ?? "tools/parity-matrix/probes/local.json",
);

const require = createRequire(resolve(repoRoot, "package.json"));
const { Client } = await import(
  require.resolve("@modelcontextprotocol/client")
);
const { StdioClientTransport } = await import(
  require.resolve("@modelcontextprotocol/client/stdio")
);

const started = Date.now();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(repoRoot, "scripts/rea.mjs"), "mcp"],
  env: { ...process.env, REA_LOG_LEVEL: "warn" },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (d) => (stderr += d.toString()));
const client = new Client({ name: "rea-web-parity-probe", version: "0.1.0" });
await client.connect(transport);

const tools = [];
let cursor;
do {
  const page = await client.listTools(cursor ? { cursor } : {});
  tools.push(...page.tools);
  cursor = page.nextCursor;
} while (cursor);
let prompts = [];
try {
  const page = await client.listPrompts({});
  prompts = page.prompts;
} catch (error) {
  prompts = [{ name: "<prompts/list failed>", description: String(error) }];
}
const session = await client.callTool(
  { name: "binary_session", arguments: {} },
  undefined,
  { timeout: 120_000 },
);
await client.close();

const host = `${platform()}-${arch()}-node${process.versions.node}`;
const summary = {
  probe_started_at: new Date(started).toISOString(),
  duration_ms: Date.now() - started,
  host,
  hostname_sha256: createHash("sha256").update(hostname()).digest("hex"),
  os_release: release(),
  tools_list_count: tools.length,
  prompts_count: prompts.length,
  binary_session_is_error: session.isError ?? false,
  stderr_tail: stderr.slice(-2000),
};
mkdirSync(dirname(outPath), { recursive: true });
const body = JSON.stringify(
  { summary, tools, prompts, binary_session: session },
  null,
  2,
);
writeFileSync(
  outPath,
  outPath.endsWith(".gz") ? gzipSync(Buffer.from(body), { level: 9 }) : body,
);
console.log(JSON.stringify(summary, null, 2));
