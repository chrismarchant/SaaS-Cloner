/** Read-only rows describing a stored build definition. Text only. */
import type { ComponentDeclaration } from "@rea-web/contracts/browser";
import type { BuildDefinition } from "./buildDraft";
import { prettyJson } from "./json";

export interface Row {
  readonly label: string;
  readonly value: string;
  /** Multi-line value shown preformatted. */
  readonly block?: boolean;
}

const yesNo = (value: boolean): string => (value ? "yes" : "no");
const list = (items: readonly string[]): string =>
  items.length === 0 ? "none" : items.join(", ");

export const describeSource = (source: BuildDefinition["source"]): Row[] =>
  source.kind === "git"
    ? [
        { label: "Kind", value: "git (remote)" },
        { label: "URL", value: source.url },
        { label: "Ref", value: source.ref },
        { label: "Include LFS", value: yesNo(source.include_lfs) },
        {
          label: "Include submodules",
          value: yesNo(source.include_submodules),
        },
      ]
    : [
        { label: "Kind", value: "runner_local" },
        { label: "Runner", value: source.runner_id },
        { label: "Path hash", value: source.path_hash },
        {
          label: "Include working tree",
          value: yesNo(source.include_working_tree),
        },
        { label: "Include LFS", value: yesNo(source.include_lfs) },
        {
          label: "Include submodules",
          value: yesNo(source.include_submodules),
        },
      ];

const describeAssets = (
  source: Extract<ComponentDeclaration, { kind: "assets" }>["source"],
): Row[] => {
  switch (source.kind) {
    case "s3":
      return [
        { label: "Asset source", value: "s3" },
        { label: "Bucket", value: source.bucket },
        {
          label: "Prefix",
          value: source.prefix === "" ? "(none)" : source.prefix,
        },
        {
          label: "Endpoint variable name",
          value: source.endpoint_env_name ?? "(default endpoint)",
        },
        {
          label: "Credentials variable prefix",
          value: source.credentials_env_prefix,
        },
      ];
    case "runner_local":
      return [
        { label: "Asset source", value: "runner_local" },
        { label: "Runner", value: source.runner_id },
        { label: "Path hash", value: source.path_hash },
      ];
    case "supabase_storage":
      return [
        { label: "Asset source", value: "supabase_storage" },
        { label: "Project ref", value: source.project_ref },
        { label: "Buckets", value: list(source.buckets) },
        {
          label: "Credentials variable prefix",
          value: source.credentials_env_prefix,
        },
      ];
  }
};

export const describeComponent = (component: ComponentDeclaration): Row[] => {
  switch (component.kind) {
    case "source":
      return [];
    case "dependencies":
      return [
        { label: "Lockfiles", value: list(component.lockfiles) },
        { label: "Container images", value: list(component.container_images) },
      ];
    case "data":
      return [
        { label: "Engine", value: component.engine },
        {
          label: "Connection variable name",
          value: component.connection_env_name,
        },
        ...component.invariants.map((invariant) => ({
          label: `Invariant ${invariant.id}`,
          value: `${invariant.sql}  ->  ${invariant.expect === undefined ? "(no expected value)" : JSON.stringify(invariant.expect)}`,
        })),
      ];
    case "assets":
      return describeAssets(component.source);
    case "infrastructure":
    case "integrations":
      return [
        {
          label: "Descriptor",
          value: prettyJson(component.descriptor, 20_000).text,
          block: true,
        },
      ];
    case "product":
      return [
        { label: "Source component", value: component.source_component_id },
        { label: "Product name", value: component.name },
        { label: "REA targets", value: list(component.rea_target_ids) },
      ];
    case "artifacts":
      return [
        { label: "Investigations", value: list(component.investigation_ids) },
      ];
  }
};
