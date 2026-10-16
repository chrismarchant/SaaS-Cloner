import { validateRelativePath } from "@rea-web/contracts";
import type {
  CollectorContext,
  ComponentDeclaration,
  Omission,
} from "../../types.js";
import { type S3ConnectionSpec, isValidRegion } from "./s3Connection.js";

type AssetsDecl = Extract<ComponentDeclaration, { kind: "assets" }>;
export type ObjectSource = Exclude<
  AssetsDecl["source"],
  { kind: "runner_local" }
>;

export interface S3Target {
  bucket: string;
  /** Prefix exactly as declared. */
  declaredPrefix: string;
  /** Prefix sent to ListObjectsV2: the declared prefix as a directory. */
  listPrefix: string;
  /** Directory below `objects/` that receives this target's files ("" or "<bucket>/"). */
  outDir: string;
}

export interface S3Source {
  provider: "s3" | "supabase_storage";
  /** Names (never values) of the credential variables, for messages. */
  credentialNames: string;
  /** Names of credential variables that are set; reported in the manifest. */
  secretNames: string[];
  endpointHint: string;
  connection: S3ConnectionSpec;
  targets: S3Target[];
  /** Declared buckets that cannot be captured (unsafe as package paths). */
  rejected: Omission[];
}

export type S3SourceResult =
  | { ok: true; source: S3Source }
  | { ok: false; omission: Omission; secretNames: string[] };

const SUPABASE_REF = /^[a-z0-9][a-z0-9-]{0,62}$/u;

const present = (value: string | undefined): value is string =>
  value !== undefined && value !== "";

/** A prefix is a directory: "uploads" and "uploads/" list the same keys. */
export const listPrefixOf = (declared: string): string =>
  declared === "" || declared.endsWith("/") ? declared : `${declared}/`;

/** Endpoint URL (undefined means AWS) and how to describe it in remediation text. */
function resolveEndpoint(
  src: ObjectSource,
  env: CollectorContext["env"],
  what: string,
):
  | { endpoint: string | undefined; endpointHint: string }
  | { omission: Omission } {
  const p = src.credentials_env_prefix;
  if (src.kind === "s3") {
    if (src.endpoint_env_name === undefined)
      return {
        endpoint: undefined,
        endpointHint: `the AWS region in ${p}_REGION`,
      };
    const endpoint = env[src.endpoint_env_name];
    if (!present(endpoint))
      return {
        omission: {
          what,
          reason: `The endpoint variable ${src.endpoint_env_name} declared for this source is not set; the AWS default endpoint is not used in its place.`,
          remediation: `Set ${src.endpoint_env_name} to the S3-compatible endpoint URL, or remove endpoint_env_name from the declaration to use AWS.`,
        },
      };
    return {
      endpoint,
      endpointHint: `the endpoint in ${src.endpoint_env_name}`,
    };
  }
  if (!SUPABASE_REF.test(src.project_ref))
    return {
      omission: {
        what,
        reason:
          "The declared Supabase project_ref is not a valid project reference.",
        remediation:
          "Use the project reference from the Supabase dashboard (the subdomain of the project URL).",
      },
    };
  const override = env[`${p}_ENDPOINT`];
  return present(override)
    ? { endpoint: override, endpointHint: `the endpoint in ${p}_ENDPOINT` }
    : {
        endpoint: `https://${src.project_ref}.supabase.co/storage/v1/s3`,
        endpointHint: `the project reference ${src.project_ref}`,
      };
}

/** Buckets to capture; Supabase bucket names must be single safe path segments. */
function resolveTargets(src: ObjectSource): {
  targets: S3Target[];
  rejected: Omission[];
} {
  if (src.kind === "s3")
    return {
      targets: [
        {
          bucket: src.bucket,
          declaredPrefix: src.prefix,
          listPrefix: listPrefixOf(src.prefix),
          outDir: "",
        },
      ],
      rejected: [],
    };
  const targets: S3Target[] = [];
  const rejected: Omission[] = [];
  const seen = new Set<string>();
  for (const bucket of src.buckets) {
    const v = validateRelativePath(bucket);
    if (!v.ok || v.path !== bucket || bucket.includes("/")) {
      rejected.push({
        what: `Supabase Storage bucket ${JSON.stringify(bucket)}`,
        reason:
          "The bucket name is not usable as a single package path segment.",
        remediation:
          "Rename the bucket or export it manually with the Supabase CLI or an S3 client.",
      });
    } else if (!seen.has(bucket.toLowerCase())) {
      seen.add(bucket.toLowerCase());
      targets.push({
        bucket,
        declaredPrefix: "",
        listPrefix: "",
        outDir: `${bucket}/`,
      });
    }
  }
  return { targets, rejected };
}

export function resolveS3Source(
  src: ObjectSource,
  env: CollectorContext["env"],
): S3SourceResult {
  const p = src.credentials_env_prefix;
  const idName = `${p}_ACCESS_KEY_ID`;
  const secretName = `${p}_SECRET_ACCESS_KEY`;
  const tokenName = `${p}_SESSION_TOKEN`;
  const regionName = `${p}_REGION`;
  const accessKeyId = env[idName];
  const secretAccessKey = env[secretName];
  const sessionToken = env[tokenName];
  const secretNames = [
    idName,
    secretName,
    ...(present(sessionToken) ? [tokenName] : []),
  ];
  const supabase = src.kind === "supabase_storage";
  const what = supabase
    ? `Supabase Storage access (project ${src.project_ref})`
    : `S3 access (bucket ${src.bucket})`;
  if (!present(accessKeyId) || !present(secretAccessKey))
    return {
      ok: false,
      secretNames,
      omission: {
        what,
        reason: `Credential variables ${[idName, secretName].filter((n) => !present(env[n])).join(" and ")} ${
          !present(accessKeyId) && !present(secretAccessKey) ? "are" : "is"
        } not set in the runner environment.`,
        remediation: supabase
          ? `Create S3 access keys in the Supabase dashboard (Storage -> S3 connection -> New access key) and set ${idName} and ${secretName} on the runner. The service role key (${p}_SERVICE_ROLE_KEY) is not used for Storage S3 access.`
          : `Set ${idName} and ${secretName} (and ${tokenName} for temporary credentials) on the runner, with s3:ListBucket on the bucket and s3:GetObject on its objects.`,
      },
    };

  const region = present(env[regionName]) ? env[regionName] : "us-east-1";
  if (!isValidRegion(region))
    return {
      ok: false,
      secretNames,
      omission: {
        what,
        reason: `${regionName} is not a valid region name.`,
        remediation: `Set ${regionName} to the bucket region, for example us-east-1.`,
      },
    };

  const where = resolveEndpoint(src, env, what);
  if ("omission" in where)
    return { ok: false, secretNames, omission: where.omission };
  const { endpoint, endpointHint } = where;
  const { targets, rejected } = resolveTargets(src);
  if (targets.length === 0)
    return {
      ok: false,
      secretNames,
      omission: {
        what,
        reason:
          src.kind === "supabase_storage" && src.buckets.length === 0
            ? "No buckets are declared for this Supabase Storage source."
            : "None of the declared buckets can be captured.",
        remediation:
          "Declare the Supabase Storage buckets to preserve (buckets[]) and capture again.",
      },
    };
  return {
    ok: true,
    source: {
      provider: src.kind,
      credentialNames: `${idName} / ${secretName}`,
      secretNames,
      endpointHint,
      connection: {
        accessKeyId,
        secretAccessKey,
        sessionToken: present(sessionToken) ? sessionToken : undefined,
        region,
        endpoint,
        forcePathStyle: endpoint !== undefined,
      },
      targets,
      rejected,
    },
  };
}
