import { basename } from "node:path";
import {
  type IntegrationsDescriptor,
  integrationsDescriptorSchema,
  parseDescriptor,
} from "../descriptors.js";
import {
  type CaptureRuntime,
  type CollectorOutcome,
  type Runtime,
  blockedOutcome,
  emptyOutcome,
} from "../runtime.js";
import {
  type ComponentDeclaration,
  type ComponentPlan,
  type Omission,
  componentId,
} from "../types.js";
import {
  type TreeEntry,
  componentRoot,
  hostOf,
  jsonText,
  listTree,
  redactUrl,
  safeSegment,
  unique,
  writeStaged,
} from "../util.js";
import { readFile } from "node:fs/promises";
import { supabaseSummary } from "./platform/guidance.js";
import { scanPlatformConfig } from "./platform/scan.js";
import type { SupabaseFacts } from "./platform/types.js";

type IntegDecl = Extract<ComponentDeclaration, { kind: "integrations" }>;

interface SdkRule {
  provider: string;
  npm?: RegExp;
  python?: RegExp;
}
const SDKS: SdkRule[] = [
  { provider: "Stripe", npm: /^(stripe|@stripe\/.+)$/u, python: /^stripe$/u },
  {
    provider: "Supabase",
    npm: /^@supabase\/.+$/u,
    python: /^supabase(-py)?$/u,
  },
  { provider: "AWS", npm: /^(aws-sdk|@aws-sdk\/.+)$/u, python: /^boto3?$/u },
  { provider: "Twilio", npm: /^twilio$/u, python: /^twilio$/u },
  {
    provider: "SendGrid",
    npm: /^(sendgrid|@sendgrid\/.+)$/u,
    python: /^sendgrid$/u,
  },
  { provider: "Resend", npm: /^resend$/u, python: /^resend$/u },
  { provider: "OpenAI", npm: /^openai$/u, python: /^openai$/u },
  {
    provider: "Anthropic",
    npm: /^@anthropic-ai\/.+$/u,
    python: /^anthropic$/u,
  },
  {
    provider: "Firebase",
    npm: /^(firebase|firebase-admin|@firebase\/.+)$/u,
    python: /^firebase-admin$/u,
  },
  {
    provider: "Google Cloud",
    npm: /^@google-cloud\/.+$/u,
    python: /^google-cloud-.+$/u,
  },
  { provider: "Clerk", npm: /^@clerk\/.+$/u },
  {
    provider: "Auth0",
    npm: /^(auth0|@auth0\/.+)$/u,
    python: /^auth0-python$/u,
  },
  { provider: "Mailgun", npm: /^(mailgun\.js|mailgun-js)$/u },
  { provider: "Postmark", npm: /^postmark$/u },
  { provider: "Slack", npm: /^@slack\/.+$/u, python: /^slack[-_]sdk$/u },
  { provider: "Plaid", npm: /^plaid$/u, python: /^plaid-python$/u },
  { provider: "GitHub", npm: /^@octokit\/.+$/u, python: /^PyGithub$/u },
  { provider: "PayPal", npm: /^@paypal\/.+$/u },
  { provider: "Shopify", npm: /^@shopify\/.+$/u },
  { provider: "Sentry", npm: /^@sentry\/.+$/u, python: /^sentry-sdk$/u },
];

export interface Detected {
  provider: string;
  evidence: { file: string; dependency: string }[];
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/gu, "");

async function detect(files: TreeEntry[]): Promise<Detected[]> {
  const found = new Map<string, Detected>();
  const note = (rule: SdkRule, file: string, dependency: string): void => {
    const entry = found.get(rule.provider) ?? {
      provider: rule.provider,
      evidence: [],
    };
    if (entry.evidence.length < 8) entry.evidence.push({ file, dependency });
    found.set(rule.provider, entry);
  };
  for (const f of files) {
    const name = basename(f.rel);
    if (f.size > 4 * 1024 * 1024) continue;
    if (name === "package.json") {
      try {
        const pkg = JSON.parse(await readFile(f.abs, "utf8")) as Record<
          string,
          unknown
        >;
        for (const field of [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
        ]) {
          const deps = pkg[field];
          if (deps !== null && typeof deps === "object")
            for (const dep of Object.keys(deps))
              for (const rule of SDKS)
                if (rule.npm?.test(dep) === true) note(rule, f.rel, dep);
        }
      } catch {
        // unparseable package.json: nothing detected from it
      }
    } else if (/^requirements.*\.txt$/u.test(name)) {
      const text = await readFile(f.abs, "utf8").catch(() => "");
      for (const line of text.split("\n")) {
        const dep = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/u.exec(line)?.[1];
        if (dep !== undefined)
          for (const rule of SDKS)
            if (rule.python?.test(dep) === true) note(rule, f.rel, dep);
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.provider < b.provider ? -1 : 1));
}

const SUPABASE_CONFIG_EVIDENCE = "supabase/config.toml";

/** A parsed supabase/config.toml is evidence for the Supabase integration, even without an SDK dependency. */
const withSupabaseConfig = (
  detected: Detected[],
  configs: readonly SupabaseFacts[],
): Detected[] => {
  if (configs.length === 0) return detected;
  const evidence = configs.map((c) => ({
    file: c.path,
    dependency: SUPABASE_CONFIG_EVIDENCE,
  }));
  const existing = detected.find((d) => d.provider === "Supabase");
  if (existing === undefined)
    return [...detected, { provider: "Supabase", evidence }].sort((a, b) =>
      a.provider < b.provider ? -1 : 1,
    );
  return detected.map((d) =>
    d === existing
      ? { ...d, evidence: [...d.evidence, ...evidence].slice(0, 8) }
      : d,
  );
};

/** Parsed platform configuration that belongs to a provider; only Supabase has any. */
const configFor = (
  provider: string,
  configs: readonly SupabaseFacts[],
): { platform_config: SupabaseFacts[] } => ({
  platform_config: norm(provider).includes("supabase") ? [...configs] : [],
});

export async function plan(
  decl: IntegDecl,
  rt: Runtime,
): Promise<ComponentPlan> {
  const parsed = parseDescriptor(integrationsDescriptorSchema, decl.descriptor);
  const source = rt.build.components.find((c) => c.kind === "source");
  return {
    id: componentId(decl),
    kind: "integrations",
    collector: "integrations",
    permissions: [
      {
        check: "descriptor valid",
        ok: parsed.ok,
        detail: parsed.ok
          ? `${parsed.value.providers.length} providers declared`
          : parsed.issues.join("; "),
      },
    ],
    estimated_bytes: null,
    dependencies: source === undefined ? [] : [componentId(source)],
    method: "descriptor validation plus SDK detection in package manifests",
    omissions: [
      {
        what: "Provider accounts, API keys, OAuth apps and webhook registrations",
        reason:
          "These live at the providers and are not exported; each provider becomes a manual prerequisite.",
        remediation:
          "Recreate accounts and credentials for the restore environment by hand.",
      },
    ],
    feasible: parsed.ok,
  };
}

export async function capture(
  decl: IntegDecl,
  rt: CaptureRuntime,
): Promise<CollectorOutcome> {
  const cid = componentId(decl);
  const root = componentRoot(rt.build, decl);
  const base = {
    title: `Integrations (${decl.id})`,
    method: "declared descriptor + SDK detection",
    root,
  };
  const parsed = parseDescriptor(integrationsDescriptorSchema, decl.descriptor);
  if (!parsed.ok)
    return blockedOutcome(base, {
      what: "Integrations descriptor",
      reason: `descriptor failed validation: ${parsed.issues.join("; ")}`,
      remediation:
        "Correct the descriptor fields named above and capture again.",
    });
  const d: IntegrationsDescriptor = parsed.value;
  const start = rt.now();
  const omissions: Omission[] = [];
  const co = await rt.checkout(null);
  let detected: Detected[] = [];
  let supabaseConfigs: SupabaseFacts[] = [];
  const limitations = [
    "Provider-side state (accounts, keys, OAuth apps, webhook registrations) is not captured; see manual prerequisites.",
    "Inferred providers come from dependency names only.",
  ];
  if (co.ok) {
    const tree = await listTree(co.dir);
    detected = await detect(tree.files);
    const configs = await scanPlatformConfig(tree, { only: ["supabase"] });
    supabaseConfigs = configs.files.flatMap((f) =>
      f.extraction?.supabase == null ? [] : [f.extraction.supabase],
    );
    for (const f of configs.files.filter((x) => x.status === "unparsed"))
      limitations.push(
        `${f.path} could not be parsed, so the Supabase manual prerequisites are generic; the infrastructure component records the parse error.`,
      );
    detected = withSupabaseConfig(detected, supabaseConfigs);
  } else
    omissions.push({
      what: "SDK detection from source",
      reason: co.reason,
      remediation: co.remediation,
    });

  const consumed = new Set<string>();
  const providers = d.providers.map((p) => {
    const hits = detected.filter(
      (x) =>
        norm(p.name).includes(norm(x.provider)) ||
        norm(x.provider).includes(norm(p.name)),
    );
    hits.forEach((h) => consumed.add(h.provider));
    return {
      name: p.name,
      origin: "declared" as const,
      inferred: false,
      ...configFor(p.name, supabaseConfigs),
      api_version: p.api_version,
      scopes: p.scopes,
      webhooks: p.webhooks.map((w) => ({
        url: redactUrl(w.url),
        events: w.events,
      })),
      callbacks: p.callbacks.map(redactUrl),
      account_owner: p.account_owner,
      manual_steps: p.manual_steps,
      evidence: hits.flatMap((h) => h.evidence),
    };
  });
  const inferred = detected
    .filter((x) => !consumed.has(x.provider))
    .map((x) => ({
      name: x.provider,
      origin: "inferred" as const,
      inferred: true,
      ...configFor(x.provider, supabaseConfigs),
      api_version: null,
      scopes: [] as string[],
      webhooks: [] as { url: string; events: string[] }[],
      callbacks: [] as string[],
      account_owner: null,
      manual_steps: [] as string[],
      evidence: x.evidence,
    }));
  const all = [...providers, ...inferred];

  const stage = await rt.stageDir(cid);
  await writeStaged(
    stage,
    `${root}integrations.json`,
    jsonText(
      {
        note: "Declared providers come from the build descriptor. Inferred providers were detected from dependency manifests only and may be unused. Whether an integration is real or mocked in the running build is not determined here.",
        providers: all,
      },
      rt.ctx.redactor,
    ),
  );

  const manual = all.map((p) => ({
    id: `${cid}:${safeSegment(p.name.toLowerCase())}`,
    title: `Re-establish access to ${p.name}`,
    reason: p.inferred
      ? `${p.name} was detected in the source (${p.evidence.map((e) => e.dependency).join(", ")}) but the integration was not declared; whether and how it is used is unconfirmed.`
      : `Accounts, API keys, OAuth apps and webhook registrations at ${p.name} are not exported.`,
    instructions: [
      p.account_owner === null
        ? "Identify the account owner at the provider."
        : `Account owner: ${p.account_owner}.`,
      p.api_version === null ? "" : `API version: ${p.api_version}.`,
      p.scopes.length === 0 ? "" : `Scopes: ${p.scopes.join(", ")}.`,
      p.webhooks.length === 0
        ? ""
        : `Register test webhook endpoints for: ${p.webhooks.map((w) => `${w.url} [${w.events.join(", ")}]`).join("; ")}. Leave production webhooks untouched.`,
      p.callbacks.length === 0
        ? ""
        : `Register callback URLs for the restore environment (production callbacks: ${p.callbacks.join(", ")}).`,
      ...p.manual_steps,
      ...p.platform_config.map(supabaseSummary),
      "Create credentials dedicated to the restore environment; never reuse production secrets.",
    ]
      .filter((x) => x !== "")
      .join(" "),
    component_id: cid,
  }));

  const webhookUrls = unique(all.flatMap((p) => p.webhooks.map((w) => w.url)));
  const hosts = unique(
    all
      .flatMap((p) => [...p.webhooks.map((w) => w.url), ...p.callbacks])
      .map((u) => hostOf(u))
      .filter((h): h is string => h !== null),
  );
  const outcome = emptyOutcome(base);
  return {
    ...outcome,
    status: omissions.length > 0 ? "partial" : "captured",
    omissions,
    limitations,
    capturedAt: { start: start.toISOString(), end: rt.now().toISOString() },
    stageDir: stage,
    manual,
    guards: { disabled_webhooks: webhookUrls, blocked_hosts: hosts },
    relationships: co.ok
      ? [{ from: cid, to: co.sourceComponentId, kind: "depends_on" }]
      : [],
    details: {
      declared: providers.map((p) => p.name),
      inferred: inferred.map((p) => p.name),
      webhooks: webhookUrls.length,
    },
  };
}
