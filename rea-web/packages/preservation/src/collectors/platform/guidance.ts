import { isLoopbackHost, safeSegment } from "../../util.js";
import { httpHost } from "./reader.js";
import type { SecretRef, SupabaseFacts, UrlFact } from "./types.js";

export interface ManualItem {
  id: string;
  title: string;
  reason: string;
  instructions: string;
  component_id: string;
}

const list = (items: readonly string[]): string =>
  items.length === 0 ? "none" : items.join(", ");

const refText = (label: string, ref: SecretRef): string => {
  if (ref.kind === "env") return `${label} ${ref.name}`;
  if (ref.kind === "literal")
    return `${label} is written as a literal in the file and was deliberately not recorded`;
  return `no ${label}`;
};

const urls = (facts: readonly UrlFact[]): string[] => facts.map((u) => u.url);

/** Hosts of the URLs that name a remote endpoint; loopback addresses are local development. */
const hostsOf = (facts: readonly UrlFact[]): string[] => [
  ...new Set(
    facts.flatMap((u) => {
      const host = httpHost(u);
      return host === null || isLoopbackHost(host) ? [] : [host];
    }),
  ),
];

const enabledProviders = (s: SupabaseFacts) =>
  (s.auth?.providers ?? []).filter((p) => p.enabled);

/** One sentence per fact class, for the integrations manual prerequisite. */
export const supabaseSummary = (s: SupabaseFacts): string => {
  const parts: string[] = [];
  const providers = enabledProviders(s).map((p) => p.name);
  if (providers.length > 0)
    parts.push(`OAuth providers enabled: ${list(providers)}`);
  const redirects = urls([
    ...(s.auth?.site_url ? [s.auth.site_url] : []),
    ...(s.auth?.additional_redirect_urls ?? []),
  ]);
  if (redirects.length > 0) parts.push(`Auth URLs: ${list(redirects)}`);
  if (s.functions.length > 0)
    parts.push(`Edge Functions: ${list(s.functions.map((f) => f.name))}`);
  const buckets = s.storage?.buckets ?? [];
  if (buckets.length > 0)
    parts.push(`Storage buckets: ${list(buckets.map((b) => b.name))}`);
  return `${s.path} declares - ${parts.length === 0 ? "no Auth, Function or Storage settings" : parts.join("; ")}.`;
};

const authItem = (
  cid: string,
  s: SupabaseFacts,
  tag: string,
): ManualItem | null => {
  const auth = s.auth;
  if (auth === null) return null;
  const providers = enabledProviders(s);
  const authUrls = [
    ...(auth.site_url ? [auth.site_url] : []),
    ...auth.additional_redirect_urls,
  ];
  if (providers.length === 0 && authUrls.length === 0) return null;
  const prodHosts = hostsOf(authUrls);
  return {
    id: `${cid}:supabase-config-auth-${tag}`,
    title: `Recreate Supabase Auth settings from ${s.path}`,
    reason: `${s.path} enables OAuth providers ${list(providers.map((p) => p.name))} and declares Site URL ${auth.site_url?.url ?? "(none)"} with redirect URLs ${list(urls(auth.additional_redirect_urls))}. The provider-side OAuth apps and the hosted project's Auth settings are not captured.`,
    instructions: [
      ...providers.map(
        (p) =>
          `Provider ${p.name}: create a new OAuth app for the restore environment and register the restore project's callback URL; the configuration references ${refText("client id variable", p.client_id)} and ${refText("secret variable", p.secret)} (names only, values are not captured).`,
      ),
      `Set the Site URL and allowed redirect URLs of the restore project to restore-environment addresses. Declared production URLs: ${list(urls(authUrls))}.`,
      prodHosts.length === 0
        ? ""
        : `Hosts ${list(prodHosts)} are production hosts; they are listed in restore_guards.blocked_hosts and must not be reused by a disposable restore.`,
    ]
      .filter((x) => x !== "")
      .join(" "),
    component_id: cid,
  };
};

const functionsItem = (
  cid: string,
  s: SupabaseFacts,
  tag: string,
): ManualItem | null => {
  if (s.functions.length === 0) return null;
  const open = s.functions
    .filter((f) => f.verify_jwt === false)
    .map((f) => f.name);
  return {
    id: `${cid}:supabase-config-functions-${tag}`,
    title: `Redeploy Supabase Edge Functions (${list(s.functions.map((f) => f.name))})`,
    reason: `${s.path} and supabase/functions declare Edge Functions ${list(s.functions.map((f) => f.name))}${s.edge_runtime?.policy ? ` (edge runtime policy ${s.edge_runtime.policy})` : ""}. Deployed function versions and their secrets are not captured.`,
    instructions: [
      "Deploy each function from the captured source to the restore project (supabase functions deploy <name>) and set its secrets by name with supabase secrets set; the variable names the function code reads are in env-names.json.",
      open.length === 0
        ? ""
        : `Functions ${list(open)} set verify_jwt = false and are publicly callable; keep that setting only if it is intended in the restore environment.`,
    ]
      .filter((x) => x !== "")
      .join(" "),
    component_id: cid,
  };
};

const storageItem = (
  cid: string,
  s: SupabaseFacts,
  tag: string,
): ManualItem | null => {
  const buckets = s.storage?.buckets ?? [];
  if (buckets.length === 0) return null;
  const described = buckets.map(
    (b) =>
      `${b.name} (${b.public === true ? "public" : b.public === false ? "private" : "visibility not stated"}${b.file_size_limit === null ? "" : `, limit ${b.file_size_limit}`}${b.allowed_mime_types.length === 0 ? "" : `, types ${b.allowed_mime_types.join(" ")}`})`,
  );
  return {
    id: `${cid}:supabase-config-storage-${tag}`,
    title: `Recreate Supabase Storage buckets (${list(buckets.map((b) => b.name))})`,
    reason: `${s.path} declares buckets ${list(described)}. Bucket settings and policies on the hosted project are not captured.`,
    instructions:
      "Create these buckets on the restore project with the visibility, size limit and MIME types listed in the reason, then re-upload the objects from the assets component.",
    component_id: cid,
  };
};

const projectItem = (
  cid: string,
  s: SupabaseFacts,
  tag: string,
): ManualItem | null => {
  const facts: string[] = [];
  if (s.project_id !== null) facts.push(`project_id ${s.project_id}`);
  if (s.db?.major_version != null)
    facts.push(`Postgres major version ${s.db.major_version}`);
  if (s.api !== null && s.api.schemas.length > 0)
    facts.push(`API schemas ${s.api.schemas.join(", ")}`);
  if (s.analytics?.enabled != null)
    facts.push(`analytics ${s.analytics.enabled ? "enabled" : "disabled"}`);
  if (facts.length === 0) return null;
  return {
    id: `${cid}:supabase-config-project-${tag}`,
    title: `Match Supabase project settings from ${s.path}`,
    reason: `${s.path} declares ${facts.join("; ")}. The hosted project's actual region, compute size and network restrictions are dashboard settings and are not captured.`,
    instructions:
      "Create the restore project (or local stack) with the same Postgres major version and the same exposed API schemas before restoring the database dump.",
    component_id: cid,
  };
};

/** Specific manual prerequisites for one Supabase config file. */
export const supabasePrerequisites = (
  cid: string,
  facts: SupabaseFacts,
): ManualItem[] => {
  const tag = safeSegment(facts.path);
  return [
    projectItem(cid, facts, tag),
    authItem(cid, facts, tag),
    functionsItem(cid, facts, tag),
    storageItem(cid, facts, tag),
  ].filter((x): x is ManualItem => x !== null);
};
