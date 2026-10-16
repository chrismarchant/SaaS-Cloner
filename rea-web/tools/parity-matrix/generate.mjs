#!/usr/bin/env node
// Generate docs/PARITY-MATRIX.md from the pinned upstream catalogs and a live
// runtime probe. Nothing in the matrix is hardcoded: tool names, families,
// effects, provider ownership and availability come from the inputs.
//
// Usage:
//   node tools/parity-matrix/generate.mjs \
//     --repo-root .. \
//     --probe tools/parity-matrix/probes/<host>.json \
//     --out docs/PARITY-MATRIX.md
//
// The probe JSON is produced by tools/parity-matrix/probe.mjs and contains the
// live tools/list, prompts/list and binary_session result for one host.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i], process.argv[i + 1]);
const repoRoot = resolve(args.get("--repo-root") ?? "..");
const probePath = args.get("--probe");
const outPath = resolve(args.get("--out") ?? "docs/PARITY-MATRIX.md");
const guidedPath = resolve(
  args.get("--guided") ?? "tools/parity-matrix/guided-workflows.json",
);

const readJson = (p) =>
  JSON.parse(
    p.endsWith(".gz")
      ? gunzipSync(readFileSync(p)).toString("utf8")
      : readFileSync(p, "utf8"),
  );
const catalogPath = resolve(repoRoot, ".cache/mcp-tool-catalog.json");
const productPath = resolve(repoRoot, "docs/public/product-catalog.json");
for (const p of [catalogPath, productPath]) {
  if (!existsSync(p)) {
    console.error(
      `missing ${p}; run \`npm run test:prepare\` in the upstream root first`,
    );
    process.exit(2);
  }
}
const catalog = Object.values(readJson(catalogPath).catalog);
const product = readJson(productPath);
const probe = probePath ? readJson(resolve(probePath)) : null;
const guided = existsSync(guidedPath) ? readJson(guidedPath) : {};

const upstreamSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();

// family by tool
const familyByTool = new Map();
for (const family of product.tools.families)
  for (const tool of family.tools) familyByTool.set(tool, family.id);

// provider ownership by operation
const providersByTool = new Map();
for (const provider of product.providers)
  for (const op of provider.capabilities) {
    const list = providersByTool.get(op) ?? [];
    list.push(provider.id);
    providersByTool.set(op, list);
  }

// CLI command presence: tool snake_case -> kebab-case command
const cliCommands = new Set(product.cli.commands);
const cliAliases = product.cli.aliases ?? {};
const cliFor = (tool) => {
  const kebab = tool.replaceAll("_", "-");
  if (cliCommands.has(kebab)) return kebab;
  for (const [alias, target] of Object.entries(cliAliases))
    if (target === kebab && cliCommands.has(alias)) return alias;
  return null;
};

// live availability from probe
const liveGroupByTool = new Map();
let liveToolNames = new Set();
let liveIdentity = null;
let probeHost = "none";
if (probe) {
  liveToolNames = new Set(probe.tools.map((t) => t.name));
  const result =
    probe.binary_session?.structuredContent?.result ??
    probe.binary_session?.structuredContent?.normalized_result ??
    null;
  liveIdentity = result?.server_identity ?? null;
  for (const group of result?.tool_availability?.groups ?? [])
    for (const name of group.names) liveGroupByTool.set(name, group);
  probeHost = probe.summary?.host ?? probe.host ?? "unknown-host";
}

const effectsOf = (tool) =>
  Object.entries(tool.effects ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .join(", ") || "—";

const esc = (s) =>
  String(s ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");

const rows = catalog
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((tool) => {
    const name = tool.name;
    const cli = cliFor(name);
    const live = liveGroupByTool.get(name);
    const inLiveList = liveToolNames.has(name);
    let liveStatus = "not probed";
    let reason = "";
    let remediation = "";
    if (probe) {
      if (!inLiveList) liveStatus = "MISSING from live tools/list";
      else if (!live) liveStatus = "listed; no availability group";
      else if (live.available) liveStatus = "available";
      else {
        liveStatus = `unavailable (${live.reason ?? "unknown"})`;
        reason = live.reason ?? "";
        remediation = live.remediation ?? "";
      }
    }
    const providers = providersByTool.get(name) ?? [];
    const webRoute = guided[name]
      ? `guided: ${guided[name]}; advanced tool form`
      : "advanced tool form (schema-generated)";
    return {
      name,
      family: familyByTool.get(name) ?? "—",
      kind: tool.kind,
      cli,
      mcp: "yes",
      effects: effectsOf(tool),
      providers,
      liveStatus,
      reason,
      remediation,
      webRoute,
      requiresSession: tool.requiresSession,
    };
  });

const counts = {
  catalog_tools: catalog.length,
  product_total: product.tools.total,
  live_tools: probe ? liveToolNames.size : null,
  available_live: rows.filter((r) => r.liveStatus === "available").length,
  target_required: rows.filter((r) =>
    r.liveStatus.startsWith("unavailable (target_required"),
  ).length,
  provider_missing: rows.filter((r) =>
    r.liveStatus.startsWith("unavailable (provider_missing"),
  ).length,
  unsupported_host: rows.filter((r) =>
    r.liveStatus.startsWith("unavailable (unsupported_host"),
  ).length,
  missing_live: rows.filter((r) => r.liveStatus.startsWith("MISSING")).length,
  with_cli: rows.filter((r) => r.cli).length,
  cli_commands: product.cli.commands.length,
  prompts: product.runtime_catalog.counts.mcp_prompts,
};

const consistency = [];
if (counts.catalog_tools !== counts.product_total)
  consistency.push(
    `catalog tool count ${counts.catalog_tools} differs from product catalog total ${counts.product_total}`,
  );
if (probe && counts.live_tools !== counts.catalog_tools)
  consistency.push(
    `live tools/list count ${counts.live_tools} differs from catalog ${counts.catalog_tools}`,
  );
if (probe) {
  const extraLive = [...liveToolNames].filter(
    (n) => !catalog.some((t) => t.name === n),
  );
  if (extraLive.length)
    consistency.push(`live tools not in catalog: ${extraLive.join(", ")}`);
  if (liveIdentity?.catalog?.counts?.mcp_tools !== counts.catalog_tools)
    consistency.push(
      `server_identity.catalog.counts.mcp_tools=${liveIdentity?.catalog?.counts?.mcp_tools} differs from catalog ${counts.catalog_tools}`,
    );
  if (
    liveIdentity?.catalog?.digests?.tools_sha256 &&
    product.runtime_catalog?.digests?.tools_sha256 &&
    liveIdentity.catalog.digests.tools_sha256 !==
      product.runtime_catalog.digests.tools_sha256
  )
    consistency.push(
      "tools_sha256 differs between live server and product catalog",
    );
}

const lines = [];
lines.push("# Parity matrix");
lines.push("");
lines.push(
  "Generated by `rea-web/tools/parity-matrix/generate.mjs`. Do not edit by hand; regenerate after any upstream update or runner probe.",
);
lines.push("");
lines.push("## Sources");
lines.push("");
lines.push(`- Upstream revision: \`${upstreamSha}\``);
lines.push(
  `- Pinned catalog: \`.cache/mcp-tool-catalog.json\` (${counts.catalog_tools} tools), \`docs/public/product-catalog.json\` (package ${product.package.name}@${product.package.version}, skill version ${product.package.skill_version}, SDK server ${product.package.sdk.server})`,
);
lines.push(
  `- Runtime catalog counts (product catalog): CLI commands ${product.runtime_catalog.counts.cli_commands}, MCP tools ${product.runtime_catalog.counts.mcp_tools}, MCP prompts ${product.runtime_catalog.counts.mcp_prompts}`,
);
if (probe) {
  lines.push(
    `- Live probe: host \`${esc(probeHost)}\`, probed at ${probe.summary?.probe_started_at ?? "unknown"}, server ${liveIdentity?.server?.name}@${liveIdentity?.server?.version}, protocol ${liveIdentity?.negotiated_protocol_version}, tools_sha256 \`${liveIdentity?.catalog?.digests?.tools_sha256}\`, combined_sha256 \`${liveIdentity?.catalog?.digests?.combined_sha256}\``,
  );
} else {
  lines.push("- Live probe: none supplied (live columns read `not probed`)");
}
lines.push("");
lines.push("## Summary");
lines.push("");
lines.push("| Metric | Value |");
lines.push("| --- | ---: |");
for (const [k, v] of Object.entries(counts))
  lines.push(`| ${k} | ${v === null ? "—" : v} |`);
lines.push("");
lines.push("## Consistency checks");
lines.push("");
if (consistency.length === 0)
  lines.push(
    "All counts agree: catalog, product catalog, live `tools/list` and `server_identity.catalog.counts.mcp_tools` describe the same inventory.",
  );
else for (const c of consistency) lines.push(`- ${c}`);
lines.push("");
lines.push("## Verification status legend");
lines.push("");
lines.push(
  "- `catalog+live`: present in the pinned catalog and in the live `tools/list` of the probed host; schema and effects discovered, not exercised.",
);
lines.push(
  "- `exercised`: called through the web control plane against a fixture with recorded raw output (set per gate by later probes; none at G00 except `binary_session`).",
);
lines.push(
  "- Live availability is the probed host's own `binary_session.tool_availability` fact; `reason`/`remediation` are upstream text, unmodified.",
);
lines.push("");
lines.push("## Tools");
lines.push("");
lines.push(
  "| Tool | Family | CLI command | MCP | Effects (true) | Providers declaring the operation | Live availability (probed host) | Upstream remediation | Web access | Verification |",
);
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  const verification = !probe
    ? "catalog only"
    : r.name === "binary_session"
      ? "catalog+live; exercised (discovery probe)"
      : r.liveStatus.startsWith("MISSING")
        ? "catalog only (missing live)"
        : "catalog+live";
  lines.push(
    `| \`${r.name}\` | ${r.family} | ${r.cli ? `\`rea ${r.cli}\`` : "—"} | ${r.mcp} | ${esc(r.effects)} | ${r.providers.length ? r.providers.map((p) => `\`${p}\``).join(", ") : "—"} | ${esc(r.liveStatus)} | ${esc(r.remediation) || "—"} | ${esc(r.webRoute)} | ${verification} |`,
  );
}
lines.push("");
lines.push("## MCP prompts");
lines.push("");
if (probe?.prompts) {
  for (const p of probe.prompts)
    lines.push(`- \`${p.name}\`: ${esc(p.description ?? "")}`);
} else
  lines.push(
    `- ${counts.prompts} prompts in the product catalog; names not probed.`,
  );
lines.push("");
lines.push("## CLI commands without a same-named MCP tool");
lines.push("");
const toolKebabs = new Set(catalog.map((t) => t.name.replaceAll("_", "-")));
const cliOnly = product.cli.commands.filter((c) => !toolKebabs.has(c));
lines.push(
  `${cliOnly.length} of ${product.cli.commands.length} CLI commands have no identically named MCP tool (CLI-specific workflows, aliases, setup and diagnostics). They remain available through the preserved upstream CLI; the web control plane exposes them only where a verified workflow requires the CLI (evidence inspect/import of exported bundles at G02).`,
);
lines.push("");
lines.push(cliOnly.map((c) => `\`${c}\``).join(", "));
lines.push("");
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(JSON.stringify({ out: outPath, counts, consistency }, null, 2));
