import type { CollectorOutcome } from "../../runtime.js";
import type { ComponentDeclaration, Omission } from "../../types.js";
import { stepOf } from "../../util.js";
import type { EngineState, Stop, TargetOutcome } from "./s3Engine.js";
import type { S3Source, S3Target } from "./s3Source.js";

type AssetsDecl = Extract<ComponentDeclaration, { kind: "assets" }>;

export const MAX_SKIP_OMISSIONS = 25;

export const targetLabel = (source: S3Source, target: S3Target): string =>
  source.provider === "supabase_storage"
    ? `Supabase Storage bucket ${target.bucket}`
    : `S3 bucket ${target.bucket}${target.listPrefix === "" ? "" : ` (prefix ${target.listPrefix})`}`;

/** What the package will not contain even when every object is captured. */
export const notCaptured = (source: S3Source): Omission[] =>
  source.provider === "supabase_storage"
    ? [
        {
          what: "Supabase Storage bucket settings and storage policies",
          reason:
            "Public/private flags, file size and MIME limits, and the access policies on storage.objects are not read through the S3 protocol.",
          remediation:
            "Record the bucket settings and policies from the dashboard or the Management API; see the manual prerequisites.",
        },
      ]
    : [
        {
          what: "S3 bucket configuration, object ACLs and metadata",
          reason:
            "Only object bytes and the content type are captured; bucket policy, versioning, lifecycle, encryption, object ACLs, tags and other metadata are not.",
          remediation:
            "Record the bucket configuration manually; see the manual prerequisites.",
        },
      ];

export const restoreStep = (decl: AssetsDecl, root: string) =>
  stepOf({
    id: `assets-${decl.id.replace(/[^A-Za-z0-9_-]/gu, "_")}-restore`,
    title: `Restore asset files ${decl.id}`,
    run: [
      "cp",
      "-R",
      `{{package_root}}/${root}objects/.`,
      `{{assets_root}}/${decl.id}/`,
    ],
    requires: ["cp"],
    scope: "data_restore",
  });

export const manualItems = (
  cid: string,
  decl: AssetsDecl,
  source: S3Source,
): NonNullable<CollectorOutcome["manual"]> => {
  const restored = `{{assets_root}}/${decl.id}/`;
  if (source.provider === "supabase_storage")
    return [
      {
        id: `${cid}:supabase-buckets`,
        title: `Recreate Supabase Storage buckets ${source.targets.map((t) => t.bucket).join(", ")}`,
        reason:
          "Object files are restored into a directory; the buckets themselves, their public/private setting, file size limits and allowed MIME types are not captured.",
        instructions: `Create each bucket in the restore project with the same public/private setting, then upload the files from ${restored}<bucket>/ with the Supabase dashboard, CLI or an S3 client. Object metadata other than content-type is not restored.`,
        component_id: cid,
      },
      {
        id: `${cid}:supabase-storage-policies`,
        title: "Re-create Supabase Storage access policies",
        reason:
          "Row Level Security policies on storage.objects and bucket-level access rules are not read through the S3 protocol.",
        instructions:
          "Export the policies from the Supabase dashboard (Storage -> Policies) or with the Management API and apply them to the restore project.",
        component_id: cid,
      },
    ];
  const target = source.targets[0];
  return [
    {
      id: `${cid}:s3-bucket`,
      title: `Recreate S3 bucket ${target?.bucket ?? ""}`,
      reason:
        "Object files are restored into a directory; the bucket, its policy, versioning, lifecycle, encryption and CORS settings are not captured, and object ACLs and metadata other than content-type are not restored.",
      instructions: `Create the bucket ${target?.bucket ?? ""} in the restore environment, configure its access as needed, then upload the files from ${restored} with an S3 client (for example 'aws s3 sync'). Set ACLs and metadata other than content-type by hand if the application depends on them.`,
      component_id: cid,
    },
  ];
};

export const stopOmission = (
  source: S3Source,
  outcome: TargetOutcome,
  state: EngineState,
  redact: (text: string) => string,
): Omission | null => {
  const stop: Stop | null = outcome.stop;
  if (stop === null) return null;
  const label = targetLabel(source, outcome.target);
  if (!outcome.started)
    return {
      what: `${label} was not started`,
      reason: "The capture stopped earlier, before this bucket was read.",
      remediation:
        "Resolve the earlier omission and capture again, or declare this bucket as its own assets source.",
    };
  if (stop.kind === "objects_limit")
    return {
      what: `Objects beyond the ${stop.limit}-object limit in ${label}`,
      reason: `The capture stopped after examining ${stop.limit} keys (${state.objects} captured); the remaining keys were not examined.`,
      remediation:
        "Split the bucket into several assets sources by prefix or raise the object limit.",
    };
  if (stop.kind === "bytes_limit")
    return {
      what: `Objects beyond the ${stop.limit}-byte limit in ${label}`,
      reason: `Capturing the next object would exceed the byte limit (${state.bytes} bytes captured); the remaining keys were not read.`,
      remediation:
        "Split the bucket into several assets sources by prefix or raise the byte limit.",
    };
  const detail = redact(stop.failure.message);
  return {
    what: `${label} (incomplete)`,
    reason: `Capture stopped while ${stop.phase === "list" ? "listing" : stop.phase === "write" ? "writing" : "reading"} objects: ${stop.failure.kind.replaceAll("_", " ")}: ${detail}. Files written before the failure are complete and verified.`,
    remediation:
      stop.failure.kind === "network"
        ? "Check connectivity to the storage endpoint and capture again."
        : stop.failure.kind === "local_io"
          ? "Free disk space or fix permissions in the runner workspace and capture again."
          : "Check the credentials' permissions on the bucket and capture again.",
  };
};

export const LIMITATIONS: string[] = [
  "S3 has no point-in-time snapshot: objects written, replaced or deleted during the capture window (captured_at) may or may not be included.",
  "Only current object versions are captured. Noncurrent versions, delete markers, ACLs, tags, storage class, encryption settings and metadata other than content-type are not captured or restored.",
  "Each object is stored as a file named by its key; sha256 is computed on the received bytes and not compared with the service ETag.",
];

/** One omission per unsafe or unreadable key (capped), plus a count of the rest. */
export const skippedOmissions = (
  skipped: readonly { bucket: string; key: string; reason: string }[],
  total: number,
): Omission[] => {
  const out: Omission[] = skipped.slice(0, MAX_SKIP_OMISSIONS).map((s) => ({
    what: `Skipped ${s.bucket}/${JSON.stringify(s.key)}`,
    reason: s.reason,
    remediation:
      "Rename or re-upload the object under a safe key, or copy it by hand if its content must be preserved.",
  }));
  if (total > MAX_SKIP_OMISSIONS)
    out.push({
      what: `${total - MAX_SKIP_OMISSIONS} further skipped objects`,
      reason: "see skipped[] in objects.json",
      remediation:
        "Rename or re-upload the objects under safe keys, or copy them by hand.",
    });
  return out;
};
