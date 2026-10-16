import { posix } from "node:path";
import { Node, envReferences, httpHost, secretRef, urlFact } from "./reader.js";
import {
  type Extraction,
  type ExtractInput,
  type SupabaseFacts,
  type SupabaseFunctionFact,
  type SupabaseProviderFact,
  type UrlFact,
  emptyExtraction,
} from "./types.js";

type AuthFacts = NonNullable<SupabaseFacts["auth"]>;

const readProviders = (auth: Node): SupabaseProviderFact[] =>
  (auth.obj("external")?.subtables() ?? [])
    .map(({ name, node }) => {
      const redirect = node.str("redirect_uri");
      const url = node.str("url");
      return {
        name,
        enabled: node.bool("enabled") ?? false,
        client_id: secretRef(node.str("client_id")),
        secret: secretRef(node.str("secret")),
        redirect_uri:
          redirect === undefined || redirect === "" ? null : urlFact(redirect),
        url: url === undefined || url === "" ? null : urlFact(url),
        skip_nonce_check: node.bool("skip_nonce_check") ?? null,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));

const readHooks = (auth: Node): AuthFacts["hooks"] =>
  (auth.obj("hook")?.subtables() ?? []).map(({ name, node }) => {
    const uri = node.str("uri");
    return {
      name,
      enabled: node.bool("enabled") ?? null,
      uri: uri === undefined || uri === "" ? null : urlFact(uri),
    };
  });

const readAuth = (root: Node): SupabaseFacts["auth"] => {
  const auth = root.obj("auth");
  if (auth === undefined) return null;
  const site = auth.str("site_url");
  return {
    enabled: auth.bool("enabled") ?? null,
    site_url: site === undefined || site === "" ? null : urlFact(site),
    additional_redirect_urls: (
      auth.strList("additional_redirect_urls") ?? []
    ).map(urlFact),
    providers: readProviders(auth),
    hooks: readHooks(auth),
  };
};

const readStorage = (root: Node): SupabaseFacts["storage"] => {
  const storage = root.obj("storage");
  if (storage === undefined) return null;
  return {
    file_size_limit: storage.text("file_size_limit") ?? null,
    buckets: (storage.children("buckets") ?? [])
      .map(({ name, node }) => ({
        name,
        public: node.bool("public") ?? null,
        file_size_limit: node.text("file_size_limit") ?? null,
        allowed_mime_types: node.strList("allowed_mime_types") ?? [],
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
  };
};

/** Function directories under `<supabase dir>/functions/`; `_shared` and dot-directories are not functions. */
export const functionDirectories = (
  supabaseDir: string,
  allPaths: readonly string[],
): string[] => {
  const prefix = posix.join(supabaseDir, "functions") + "/";
  const names = new Set<string>();
  for (const p of allPaths) {
    if (!p.startsWith(prefix)) continue;
    const [name, ...rest] = p.slice(prefix.length).split("/");
    if (name !== undefined && rest.length > 0 && !/^[._]/u.test(name))
      names.add(name);
  }
  return [...names].sort();
};

const readFunctions = (
  root: Node,
  directories: readonly string[],
): SupabaseFunctionFact[] => {
  const byName = new Map<string, SupabaseFunctionFact>();
  for (const name of directories)
    byName.set(name, {
      name,
      origin: "directory",
      verify_jwt: null,
      enabled: null,
      entrypoint: null,
    });
  for (const { name, node } of root.children("functions") ?? []) {
    const existing = byName.get(name);
    byName.set(name, {
      name,
      origin: existing === undefined ? "config" : "both",
      verify_jwt: node.bool("verify_jwt") ?? null,
      enabled: node.bool("enabled") ?? null,
      entrypoint: node.str("entrypoint") ?? null,
    });
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
};

const readApi = (root: Node): SupabaseFacts["api"] => {
  const api = root.obj("api");
  if (api === undefined) return null;
  return {
    port: api.num("port") ?? null,
    schemas: api.strList("schemas") ?? [],
  };
};

const readDb = (root: Node): SupabaseFacts["db"] => {
  const db = root.obj("db");
  if (db === undefined) return null;
  return {
    major_version: db.num("major_version") ?? null,
    port: db.num("port") ?? null,
  };
};

const readEdgeRuntime = (root: Node): SupabaseFacts["edge_runtime"] => {
  const edge = root.obj("edge_runtime");
  if (edge === undefined) return null;
  return {
    enabled: edge.bool("enabled") ?? null,
    policy: edge.str("policy") ?? null,
    deno_version: edge.num("deno_version") ?? null,
  };
};

const readAnalytics = (root: Node): SupabaseFacts["analytics"] => {
  const analytics = root.obj("analytics");
  if (analytics === undefined) return null;
  return {
    enabled: analytics.bool("enabled") ?? null,
    backend: analytics.str("backend") ?? null,
    port: analytics.num("port") ?? null,
  };
};

/** URLs in the config that name a remote http(s) endpoint. */
const remoteUrls = (facts: SupabaseFacts): UrlFact[] => {
  const auth = facts.auth;
  if (auth === null) return [];
  const all: (UrlFact | null)[] = [
    auth.site_url,
    ...auth.additional_redirect_urls,
    ...auth.providers.flatMap((p) => [p.redirect_uri, p.url]),
    ...auth.hooks.map((h) => h.uri),
  ];
  return all.filter((u): u is UrlFact => u !== null && httpHost(u) !== null);
};

export function extractSupabase(input: ExtractInput): Extraction {
  const out = emptyExtraction();
  const root = Node.root(input.doc, input.audit);
  if (root === null) {
    out.limitations.push("The document is not an object; nothing was read.");
    return out;
  }
  const facts: SupabaseFacts = {
    path: input.path,
    project_id: root.str("project_id") ?? null,
    api: readApi(root),
    db: readDb(root),
    auth: readAuth(root),
    storage: readStorage(root),
    edge_runtime: readEdgeRuntime(root),
    functions: readFunctions(
      root,
      functionDirectories(posix.dirname(input.path), input.allPaths),
    ),
    analytics: readAnalytics(root),
  };
  const references = envReferences(input.doc);
  out.parsed = {
    ...facts,
    enabled_providers: (facts.auth?.providers ?? [])
      .filter((p) => p.enabled)
      .map((p) => p.name),
    env_references: references,
  };
  out.supabase = facts;
  out.env_names = references;
  out.hosts = remoteUrls(facts);
  out.limitations.push(
    "Secrets are not recorded: provider client secrets and other env(...) references are listed by variable name only, and literal values are never copied.",
    "Dashboard-only settings (custom SMTP, email templates, hosted project region and compute size) are not in config.toml.",
  );
  return out;
}
