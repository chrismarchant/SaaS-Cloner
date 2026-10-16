import {
  RESTORE_PLACEHOLDERS,
  type ManifestComponent,
  type RecoveryManifest,
  type RestoreStep,
} from "@rea-web/contracts";

type Manifest = RecoveryManifest;

const oneLine = (value: string): string => value.replace(/\s+/gu, " ").trim();

/** Plain text safe to embed in a heading, list item or paragraph. */
const text = (value: string): string =>
  oneLine(value).replace(/([\\`<>])/gu, "\\$1");

const tableCell = (value: string | number | boolean): string => {
  const rendered = text(String(value)).replace(/\|/gu, "\\|");
  return rendered === "" ? "-" : rendered;
};

const longestRun = (value: string, char: string): number => {
  let longest = 0;
  let current = 0;
  for (const c of value) {
    current = c === char ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
};

const code = (value: string): string => {
  const flat = oneLine(value);
  const ticks = "`".repeat(longestRun(flat, "`") + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${ticks}${pad}${flat}${pad}${ticks}`;
};

const fence = (body: string, lang = ""): string => {
  const marks = "`".repeat(Math.max(3, longestRun(body, "`") + 1));
  return `${marks}${lang}\n${body}\n${marks}`;
};

const humanBytes = (bytes: number): string => {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${bytes} B`
    : `${value.toFixed(1)} ${units[unit]} (${bytes} bytes)`;
};

const table = (
  header: readonly string[],
  rows: readonly (readonly (string | number | boolean)[])[],
): string[] => [
  `| ${header.join(" | ")} |`,
  `| ${header.map(() => "---").join(" | ")} |`,
  ...rows.map((row) => `| ${row.map(tableCell).join(" | ")} |`),
];

const bullets = (items: readonly string[], empty: string): string[] =>
  items.length === 0 ? [empty] : items.map((item) => `- ${item}`);

/** Display form of an argument; the JSON array beside it is authoritative. */
const displayArg = (arg: string): string =>
  arg !== "" && /^[A-Za-z0-9_\-./:=@%+,{}]+$/u.test(arg)
    ? arg
    : JSON.stringify(arg);

const PLACEHOLDER_MEANING: Record<
  (typeof RESTORE_PLACEHOLDERS)[number],
  string
> = {
  "{{target}}":
    "a new, empty, disposable directory chosen by the restorer; never an existing project or production path",
  "{{database_url}}":
    "connection URL of a disposable database instance chosen by the restorer; never a production database",
  "{{assets_root}}": "a disposable directory where asset payloads are restored",
  "{{package_root}}":
    "the root directory of this recovery package (where manifest.json lives)",
};

const identity = (m: Manifest): string[] => [
  "## Identity",
  "",
  `- Build: ${text(m.build.name)} (${code(m.build.id)})`,
  `- Project: ${code(m.build.project_slug)}`,
  `- Description: ${text(m.build.description)}`,
  `- Package id: ${code(m.package_id)}`,
  `- Format: ${code(m.format)} version ${m.format_version}`,
  `- Created at: ${code(m.created_at)}`,
  `- Producer: ${text(m.producer.name)} ${text(m.producer.version)}`,
  ...(m.producer.upstream_rea === null
    ? []
    : [
        `- Upstream REA: package ${text(m.producer.upstream_rea.package_version)}, source ${code(m.producer.upstream_rea.source_sha ?? "unknown")}, catalog digest ${code(m.producer.upstream_rea.catalog_digest ?? "unknown")}`,
      ]),
  ...m.producer.tools.map(
    (tool) => `- Tool: ${text(tool.name)} ${text(tool.version)}`,
  ),
  "",
];

const sourceRevisions = (m: Manifest): string[] => {
  if (m.source_revisions.length === 0) return [];
  const lines = ["### Source revisions", ""];
  for (const rev of m.source_revisions) {
    lines.push(
      `- Repository ${code(rev.repository)} at ${code(rev.head_sha)}`,
      `  - Remote (credentials redacted): ${rev.remote_url_redacted === null ? "none recorded" : code(rev.remote_url_redacted)}`,
      `  - Refs: ${rev.refs.length === 0 ? "none recorded" : rev.refs.map((r) => `${code(r.name)}=${code(r.sha)}`).join(", ")}`,
      `  - Submodules: ${rev.submodules.length === 0 ? "none" : rev.submodules.map((s) => `${code(s.path)} at ${code(s.sha)}`).join(", ")}`,
      `  - Git LFS: ${rev.lfs.count} objects, ${rev.lfs.bytes} bytes, payload ${rev.lfs.included ? "included" : "NOT included"}`,
      `  - Working tree: ${rev.working_tree.included ? "included" : "NOT included"}; ${rev.working_tree.dirty_files} modified and ${rev.working_tree.untracked_files} untracked files at capture`,
    );
  }
  lines.push("");
  return lines;
};

const componentNotes = (c: ManifestComponent): string[] => {
  if (c.limitations.length === 0 && c.omissions.length === 0) return [];
  return [
    `#### ${text(c.title)} (${code(c.id)}): limitations and omissions`,
    "",
    ...c.limitations.map((l) => `- Limitation: ${text(l)}`),
    ...c.omissions.map(
      (o) =>
        `- Omitted: ${text(o.what)}. Reason: ${text(o.reason)}. Remediation: ${text(o.remediation)}`,
    ),
    "",
  ];
};

const included = (m: Manifest): string[] => [
  "## What is included",
  "",
  "Status values: `captured` bytes exist with recorded hashes; `partial` some data is missing; `blocked` capture could not run; `manual` the restorer must obtain it by hand.",
  "",
  ...table(
    ["Component", "Title", "Kind", "Status", "Method", "Entries", "Bytes"],
    m.components.map((c) => [
      c.id,
      c.title,
      c.kind,
      c.status,
      c.method,
      c.entries,
      humanBytes(c.bytes),
    ]),
  ),
  "",
  ...sourceRevisions(m),
  ...m.components.flatMap(componentNotes),
  ...(m.relationships.length === 0
    ? []
    : [
        "### Relationships",
        "",
        ...m.relationships.map(
          (r) => `- ${code(r.from)} ${r.kind.replace("_", " ")} ${code(r.to)}`,
        ),
        "",
      ]),
];

const consistency = (m: Manifest): string[] => [
  "## Consistency",
  "",
  `- Strategy: ${text(m.consistency.strategy)}`,
  `- Classification: ${code(m.consistency.classification)}`,
  `- Capture window: ${m.consistency.window === null ? "not recorded" : `${code(m.consistency.window.start)} to ${code(m.consistency.window.end)}`}`,
  ...(m.consistency.classification === "single_point"
    ? []
    : [
        "- Components were not proven to be captured at a single point in time; treat cross-component state as potentially skewed.",
      ]),
  ...m.consistency.gaps.map((gap) => `- Gap: ${text(gap)}`),
  "",
];

const prerequisites = (m: Manifest): string[] => {
  const d = m.dependencies;
  return [
    "## Prerequisites and dependencies",
    "",
    "### Runtimes",
    "",
    ...bullets(
      d.runtimes.map(
        (r) => `${text(r.name)} ${text(r.version)} (from ${text(r.source)})`,
      ),
      "None declared.",
    ),
    "",
    "### Package managers",
    "",
    ...bullets(
      d.package_managers.map(
        (p) =>
          `${text(p.name)} ${p.version === null ? "(version unknown)" : text(p.version)}; lockfile: ${p.lockfile === null ? "none" : code(p.lockfile)}`,
      ),
      "None declared.",
    ),
    "",
    "### Container images",
    "",
    ...bullets(
      d.container_images.map(
        (i) =>
          `${code(i.ref)}${i.digest === null ? " (digest not pinned)" : ` @ ${code(i.digest)}`}`,
      ),
      "None declared.",
    ),
    "",
    "### Registries",
    "",
    ...bullets(
      d.registries.map(
        (r) =>
          `${code(r.url)}: required for ${r.required_for.length === 0 ? "unspecified use" : r.required_for.map(text).join(", ")}; credentials required: ${r.credentials_required ? "YES (supply your own; none are stored in this package)" : "no"}`,
      ),
      "None declared.",
    ),
    "",
    "### System packages",
    "",
    ...bullets(d.system_packages.map(text), "None declared."),
    "",
    "### Manual prerequisites",
    "",
    ...(m.manual_prerequisites.length === 0
      ? ["None declared.", ""]
      : m.manual_prerequisites
          .flatMap((p) => [
            `- ${code(p.id)} ${text(p.title)}${p.component_id === undefined ? "" : ` (component ${code(p.component_id)})`}`,
            `  - Why: ${text(p.reason)}`,
            `  - What to do: ${text(p.instructions)}`,
          ])
          .concat([""])),
  ];
};

const secrets = (m: Manifest): string[] => [
  "## Secrets handling",
  "",
  ...(m.secrets.mode === "names_only"
    ? [
        "Mode: names only. Secret values are never stored in this package; only the variable names below are recorded. Supply values from your own secret store when restoring.",
      ]
    : [
        `Mode: escrow. Values are held in a separately encrypted file${m.secrets.escrow_ref === undefined ? "" : ` (${code(m.secrets.escrow_ref)})`}. The recovery key is stored outside this package and is not recoverable from it. Names are recorded below.`,
      ]),
  "",
  ...bullets(m.secrets.names.map(code), "No secret names recorded."),
  "",
];

const stepLines = (step: RestoreStep): string[] => [
  `##### Step ${code(step.id)}: ${text(step.title)}`,
  "",
  fence(step.run.map(displayArg).join(" ")),
  "",
  `Exact argument array (authoritative; never pass through a shell): ${code(JSON.stringify(step.run))}`,
  "",
  `- Working directory: ${step.cwd === undefined ? "default" : code(step.cwd)}`,
  `- Requires: ${step.requires.length === 0 ? "nothing declared" : step.requires.map(code).join(", ")}`,
  `- Network: ${step.network}`,
  `- Verification scope: ${step.scope}`,
  `- Environment variable names: ${step.env_names.length === 0 ? "none" : step.env_names.map(code).join(", ")}`,
  "",
];

const restoreSteps = (m: Manifest): string[] => {
  const lines = [
    "## Restore steps",
    "",
    "Each command is an argument array executed directly, not a shell string. Placeholders are filled in by the restorer:",
    "",
    ...RESTORE_PLACEHOLDERS.map(
      (p) => `- ${code(p)}: ${PLACEHOLDER_MEANING[p]}`,
    ),
    "",
  ];
  for (const component of m.components) {
    lines.push(`### ${text(component.title)} (${code(component.id)})`, "");
    if (component.restore.steps.length === 0) {
      lines.push(
        `No automated restore steps (status ${component.status}).`,
        "",
      );
    } else {
      lines.push(...component.restore.steps.flatMap(stepLines));
    }
  }
  return lines;
};

const inlineList = (items: readonly string[]): string =>
  items.length === 0 ? "none declared" : items.map(code).join(", ");

const guards = (m: Manifest): string[] => [
  "## Restore guards",
  "",
  `- Default network policy during restore: ${code(m.restore_guards.default_network)}`,
  `- Blocked production hosts: ${inlineList(m.restore_guards.blocked_hosts)}`,
  `- Schedules that must stay disabled: ${inlineList(m.restore_guards.disabled_schedules)}`,
  `- Webhooks that must stay disabled: ${inlineList(m.restore_guards.disabled_webhooks)}`,
  "",
  "Restore into disposable directories and a disposable database. Leave the schedules and webhooks above disabled unless you explicitly override with `--allow-production` (refused in verifier mode).",
  "",
];

const verification = (m: Manifest): string[] => [
  "## Verification results",
  "",
  `Scopes: ${m.verification.scope.length === 0 ? "none declared" : m.verification.scope.map(code).join(", ")}`,
  "",
  ...(m.verification.results.length === 0
    ? ["No verification has been recorded in this manifest."]
    : table(
        ["Scope", "Status", "Detail", "Performed at", "Evidence"],
        m.verification.results.map((r) => [
          r.scope,
          r.status,
          r.detail,
          r.performed_at,
          r.evidence_path ?? "-",
        ]),
      )),
  "",
  `Network required to restore: ${code(m.verification.network_required.verdict)}${m.verification.network_required.reasons.length === 0 ? "" : ` (${m.verification.network_required.reasons.map(text).join("; ")})`}. A verdict of \`no\` is only given when every restore step completed with outbound network denied.`,
  "",
  "Statuses are reported per scope; no percentage is derived from them.",
  "",
];

const missing = (m: Manifest): string[] => [
  "## Missing or blocked",
  "",
  ...(m.missing_or_blocked.length === 0
    ? ["Nothing was recorded as missing, blocked or manual."]
    : table(
        ["Component", "Status", "Reason", "Remediation"],
        m.missing_or_blocked.map((x) => [
          x.component_id,
          x.status,
          x.reason,
          x.remediation,
        ]),
      )),
  "",
];

const howToVerify = (m: Manifest): string[] => [
  "## How to verify",
  "",
  "From the package directory, using the bundled verifier (Node 22, no network):",
  "",
  fence("rea-recover verify <dir>"),
  "",
  "or, without installing anything:",
  "",
  fence("node recovery/rea-recover.mjs verify <dir>"),
  "",
  "Verification checks every file listed in `manifest.json` against its recorded size and SHA-256 before any restore step runs.",
  ...(m.signature === undefined
    ? []
    : [
        "",
        `The manifest is signed (${m.signature.algorithm}, key id ${code(m.signature.public_key_id)}, signature file ${code(m.signature.detached_path)}). Verify the signature with the matching public key obtained out of band.`,
      ]),
  ...(m.encryption === undefined
    ? []
    : [
        "",
        `The export of this package is encrypted (${m.encryption.scheme}) for recipient key ids ${m.encryption.recipients.map(code).join(", ")}. The key is held ${m.encryption.key_location}ly and is not part of the package.`,
      ]),
  "",
];

const copies = (): string[] => [
  "## Keep copies outside the failure domain",
  "",
  "Keep at least one copy of every export outside the primary platform and account that produced it. A package that lives only next to the thing it protects is not a backup.",
  "",
];

/**
 * Deterministic restore guide rendered from the manifest alone. No clock,
 * environment or filesystem input, so it can be regenerated and compared.
 */
export const renderRecoveryMarkdown = (manifest: RecoveryManifest): string =>
  [
    `# Recovery guide: ${text(manifest.build.name)}`,
    "",
    "Generated from `manifest.json`; the manifest is authoritative.",
    "",
    ...identity(manifest),
    ...included(manifest),
    ...consistency(manifest),
    ...prerequisites(manifest),
    ...secrets(manifest),
    ...restoreSteps(manifest),
    ...guards(manifest),
    ...verification(manifest),
    ...missing(manifest),
    ...howToVerify(manifest),
    ...copies(),
  ]
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trimEnd() + "\n";
