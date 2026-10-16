/**
 * The build form's draft model and its conversion to and from the contract.
 * The contract (`createBuildRequestSchema`) is the only judge of validity:
 * a draft becomes a candidate request body, the schema parses it, and its
 * issues are reported unchanged. Nothing here reads or stores a credential;
 * the form only ever holds environment variable NAMES.
 */
import {
  createBuildRequestSchema,
  type ComponentKind,
} from "@rea-web/contracts/browser";
import type { z } from "zod";

export type CreateBuildBody = z.input<typeof createBuildRequestSchema>;
export type BuildDefinition = z.output<typeof createBuildRequestSchema>;

export interface DraftProblem {
  /** Dotted path into the request body, e.g. `components.2.connection_env_name`. */
  readonly path: string;
  readonly message: string;
  /** Index of the component the problem belongs to, if any. */
  readonly component: number | null;
}

export type DraftResult =
  | { readonly ok: true; readonly body: CreateBuildBody }
  | { readonly ok: false; readonly problems: readonly DraftProblem[] };

export type ExpectKind = "none" | "text" | "number" | "boolean" | "null";

export interface InvariantDraft {
  readonly uid: string;
  readonly id: string;
  readonly sql: string;
  readonly expectKind: ExpectKind;
  /** Text for `text`/`number`; `true` or `false` for `boolean`. */
  readonly expect: string;
}

export type AssetSourceDraft =
  | {
      readonly kind: "s3";
      readonly bucket: string;
      readonly prefix: string;
      readonly endpointEnvName: string;
      readonly credentialsEnvPrefix: string;
    }
  | {
      readonly kind: "runner_local";
      readonly runnerId: string;
      readonly pathHash: string;
    }
  | {
      readonly kind: "supabase_storage";
      readonly projectRef: string;
      /** One bucket per line or comma-separated. */
      readonly buckets: string;
      readonly credentialsEnvPrefix: string;
    };

interface Base {
  readonly uid: string;
  readonly id: string;
}

export type ComponentDraft =
  | (Base & { readonly kind: "source" })
  | (Base & {
      readonly kind: "dependencies";
      /** One path per line. */
      readonly lockfiles: string;
      /** One image reference per line. */
      readonly containerImages: string;
    })
  | (Base & {
      readonly kind: "data";
      readonly engine: "postgresql" | "supabase";
      readonly connectionEnvName: string;
      readonly invariants: readonly InvariantDraft[];
    })
  | (Base & { readonly kind: "assets"; readonly source: AssetSourceDraft })
  | (Base & { readonly kind: "infrastructure"; readonly descriptor: string })
  | (Base & { readonly kind: "integrations"; readonly descriptor: string })
  | (Base & {
      readonly kind: "product";
      readonly sourceComponentId: string;
      readonly name: string;
      readonly reaTargetIds: string;
    })
  | (Base & { readonly kind: "artifacts"; readonly investigationIds: string });

export type SourceDraft =
  | {
      readonly kind: "git";
      readonly url: string;
      readonly ref: string;
      /** Not offered for a remote clone, but kept when copying a definition. */
      readonly includeWorkingTree: boolean;
      readonly includeLfs: boolean;
      readonly includeSubmodules: boolean;
    }
  | {
      readonly kind: "runner_local";
      readonly runnerId: string;
      readonly pathHash: string;
      readonly includeWorkingTree: boolean;
      readonly includeLfs: boolean;
      readonly includeSubmodules: boolean;
    };

export interface BuildDraft {
  readonly name: string;
  readonly description: string;
  readonly source: SourceDraft;
  readonly components: readonly ComponentDraft[];
  /** Preferred runner; empty means none. */
  readonly runnerId: string;
}

let counter = 0;
export const newUid = (): string => {
  counter += 1;
  return `u${counter}`;
};

export const splitLines = (text: string): string[] =>
  text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");

const splitList = (text: string): string[] =>
  text
    .split(/[\r\n,]+/u)
    .map((item) => item.trim())
    .filter((item) => item !== "");

export const componentLabel = (component: {
  kind: ComponentKind;
  id: string;
}): string => `${component.kind}:${component.id}`;

// --- defaults ----------------------------------------------------------------

export const newInvariant = (uid: string = newUid()): InvariantDraft => ({
  uid,
  id: "",
  sql: "",
  expectKind: "none",
  expect: "",
});

export const emptySource = (): SourceDraft => ({
  kind: "git",
  url: "",
  ref: "",
  includeWorkingTree: false,
  includeLfs: true,
  includeSubmodules: true,
});

export const newComponent = (
  kind: ComponentKind,
  options: { uid?: string; runnerId?: string; id?: string } = {},
): ComponentDraft => {
  const uid = options.uid ?? newUid();
  const id = options.id ?? "";
  switch (kind) {
    case "source":
      return { uid, kind, id };
    case "dependencies":
      return { uid, kind, id, lockfiles: "", containerImages: "" };
    case "data":
      return {
        uid,
        kind,
        id,
        engine: "postgresql",
        connectionEnvName: "",
        invariants: [],
      };
    case "assets":
      return {
        uid,
        kind,
        id,
        source: {
          kind: "runner_local",
          runnerId: options.runnerId ?? "",
          pathHash: "",
        },
      };
    case "infrastructure":
    case "integrations":
      return { uid, kind, id, descriptor: "{}" };
    case "product":
      return {
        uid,
        kind,
        id,
        sourceComponentId: "",
        name: "",
        reaTargetIds: "",
      };
    case "artifacts":
      return { uid, kind, id, investigationIds: "" };
  }
};

export const emptyBuildDraft = (): BuildDraft => ({
  name: "",
  description: "",
  source: emptySource(),
  components: [newComponent("source", { id: "main" })],
  runnerId: "",
});

// --- draft -> request body ---------------------------------------------------

type Candidate = Record<string, unknown>;

interface Built {
  readonly candidate: Candidate;
  readonly problems: DraftProblem[];
}

const problem = (
  component: number,
  field: string,
  message: string,
): DraftProblem => ({
  path: `components.${component}.${field}`,
  message,
  component,
});

const parseDescriptor = (
  text: string,
  index: number,
): { value: Candidate; problems: DraftProblem[] } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      value: {},
      problems: [
        problem(
          index,
          "descriptor",
          `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return {
      value: {},
      problems: [problem(index, "descriptor", "Must be a JSON object")],
    };
  return { value: parsed as Candidate, problems: [] };
};

const expectValue = (
  invariant: InvariantDraft,
  index: number,
  position: number,
): { value: unknown; defined: boolean; problems: DraftProblem[] } => {
  const field = `invariants.${position}.expect`;
  switch (invariant.expectKind) {
    case "none":
      return { value: undefined, defined: false, problems: [] };
    case "null":
      return { value: null, defined: true, problems: [] };
    case "text":
      return { value: invariant.expect, defined: true, problems: [] };
    case "boolean":
      return invariant.expect === "true" || invariant.expect === "false"
        ? {
            value: invariant.expect === "true",
            defined: true,
            problems: [],
          }
        : {
            value: undefined,
            defined: false,
            problems: [problem(index, field, "Choose true or false")],
          };
    case "number": {
      const number = Number(invariant.expect);
      return invariant.expect.trim() === "" || !Number.isFinite(number)
        ? {
            value: undefined,
            defined: false,
            problems: [problem(index, field, "Not a number")],
          }
        : { value: number, defined: true, problems: [] };
    }
  }
};

const assetSource = (source: AssetSourceDraft): Candidate => {
  switch (source.kind) {
    case "s3":
      return {
        kind: "s3",
        bucket: source.bucket.trim(),
        prefix: source.prefix,
        ...(source.endpointEnvName.trim() === ""
          ? {}
          : { endpoint_env_name: source.endpointEnvName.trim() }),
        credentials_env_prefix: source.credentialsEnvPrefix.trim(),
      };
    case "runner_local":
      return {
        kind: "runner_local",
        runner_id: source.runnerId,
        path_hash: source.pathHash.trim(),
      };
    case "supabase_storage":
      return {
        kind: "supabase_storage",
        project_ref: source.projectRef.trim(),
        buckets: splitList(source.buckets),
        credentials_env_prefix: source.credentialsEnvPrefix.trim(),
      };
  }
};

const componentCandidate = (
  component: ComponentDraft,
  index: number,
): { value: Candidate; problems: DraftProblem[] } => {
  const head = { kind: component.kind, id: component.id.trim() };
  switch (component.kind) {
    case "source":
      return { value: head, problems: [] };
    case "dependencies":
      return {
        value: {
          ...head,
          lockfiles: splitLines(component.lockfiles),
          container_images: splitLines(component.containerImages),
        },
        problems: [],
      };
    case "data": {
      const problems: DraftProblem[] = [];
      const invariants = component.invariants.map((invariant, position) => {
        const expect = expectValue(invariant, index, position);
        problems.push(...expect.problems);
        return {
          id: invariant.id.trim(),
          sql: invariant.sql,
          ...(expect.defined ? { expect: expect.value } : {}),
        };
      });
      return {
        value: {
          ...head,
          engine: component.engine,
          connection_env_name: component.connectionEnvName.trim(),
          invariants,
        },
        problems,
      };
    }
    case "assets":
      return {
        value: { ...head, source: assetSource(component.source) },
        problems: [],
      };
    case "infrastructure":
    case "integrations": {
      const descriptor = parseDescriptor(component.descriptor, index);
      return {
        value: { ...head, descriptor: descriptor.value },
        problems: descriptor.problems,
      };
    }
    case "product":
      return {
        value: {
          ...head,
          source_component_id: component.sourceComponentId.trim(),
          name: component.name.trim(),
          rea_target_ids: splitLines(component.reaTargetIds),
        },
        problems: [],
      };
    case "artifacts":
      return {
        value: {
          ...head,
          investigation_ids: splitLines(component.investigationIds),
        },
        problems: [],
      };
  }
};

const sourceCandidate = (source: SourceDraft): Candidate =>
  source.kind === "git"
    ? {
        kind: "git",
        url: source.url.trim(),
        ...(source.ref.trim() === "" ? {} : { ref: source.ref.trim() }),
        include_working_tree: source.includeWorkingTree,
        include_lfs: source.includeLfs,
        include_submodules: source.includeSubmodules,
      }
    : {
        kind: "runner_local",
        runner_id: source.runnerId,
        path_hash: source.pathHash.trim(),
        include_working_tree: source.includeWorkingTree,
        include_lfs: source.includeLfs,
        include_submodules: source.includeSubmodules,
      };

const candidateOf = (draft: BuildDraft): Built => {
  const problems: DraftProblem[] = [];
  const components = draft.components.map((component, index) => {
    const built = componentCandidate(component, index);
    problems.push(...built.problems);
    return built.value;
  });
  const seen = new Set<string>();
  draft.components.forEach((component, index) => {
    const label = componentLabel({
      kind: component.kind,
      id: component.id.trim(),
    });
    if (component.id.trim() !== "" && seen.has(label))
      problems.push(
        problem(
          index,
          "id",
          `Duplicate component ${label}; ids are unique per kind`,
        ),
      );
    seen.add(label);
  });
  return {
    candidate: {
      name: draft.name.trim(),
      description: draft.description,
      source: sourceCandidate(draft.source),
      components,
      ...(draft.runnerId === "" ? {} : { runner_id: draft.runnerId }),
    },
    problems,
  };
};

const issuePath = (path: readonly PropertyKey[]): string =>
  path.map((part) => String(part)).join(".");

const componentOf = (path: readonly PropertyKey[]): number | null =>
  path[0] === "components" && typeof path[1] === "number" ? path[1] : null;

/**
 * The request body for a draft, validated with the contract schema, or every
 * problem found. The returned body is the schema's output, so contract
 * defaults are explicit in it.
 */
export const bodyFromDraft = (draft: BuildDraft): DraftResult => {
  const { candidate, problems } = candidateOf(draft);
  const parsed = createBuildRequestSchema.safeParse(candidate);
  if (parsed.success)
    return problems.length === 0
      ? { ok: true, body: parsed.data }
      : { ok: false, problems };
  const flagged = new Set(problems.map((entry) => entry.path));
  const issues = parsed.error.issues
    .filter((issue) => !flagged.has(issuePath(issue.path)))
    .map((issue) => ({
      path: issuePath(issue.path),
      message: issue.message,
      component: componentOf(issue.path),
    }));
  return { ok: false, problems: [...problems, ...issues] };
};

// --- request body -> draft ---------------------------------------------------

const expectDraft = (
  expect: string | number | boolean | null | undefined,
): Pick<InvariantDraft, "expectKind" | "expect"> => {
  if (expect === undefined) return { expectKind: "none", expect: "" };
  if (expect === null) return { expectKind: "null", expect: "" };
  if (typeof expect === "number")
    return { expectKind: "number", expect: String(expect) };
  if (typeof expect === "boolean")
    return { expectKind: "boolean", expect: String(expect) };
  return { expectKind: "text", expect };
};

const assetDraft = (
  source: Extract<
    BuildDefinition["components"][number],
    { kind: "assets" }
  >["source"],
): AssetSourceDraft => {
  switch (source.kind) {
    case "s3":
      return {
        kind: "s3",
        bucket: source.bucket,
        prefix: source.prefix,
        endpointEnvName: source.endpoint_env_name ?? "",
        credentialsEnvPrefix: source.credentials_env_prefix,
      };
    case "runner_local":
      return {
        kind: "runner_local",
        runnerId: source.runner_id,
        pathHash: source.path_hash,
      };
    case "supabase_storage":
      return {
        kind: "supabase_storage",
        projectRef: source.project_ref,
        buckets: source.buckets.join("\n"),
        credentialsEnvPrefix: source.credentials_env_prefix,
      };
  }
};

export const draftFromComponent = (
  component: BuildDefinition["components"][number],
  uid: () => string = newUid,
): ComponentDraft => {
  const head = { uid: uid(), id: component.id };
  switch (component.kind) {
    case "source":
      return { ...head, kind: "source" };
    case "dependencies":
      return {
        ...head,
        kind: "dependencies",
        lockfiles: component.lockfiles.join("\n"),
        containerImages: component.container_images.join("\n"),
      };
    case "data":
      return {
        ...head,
        kind: "data",
        engine: component.engine,
        connectionEnvName: component.connection_env_name,
        invariants: component.invariants.map((invariant) => ({
          uid: uid(),
          id: invariant.id,
          sql: invariant.sql,
          ...expectDraft(invariant.expect),
        })),
      };
    case "assets":
      return { ...head, kind: "assets", source: assetDraft(component.source) };
    case "infrastructure":
    case "integrations":
      return {
        ...head,
        kind: component.kind,
        descriptor: JSON.stringify(component.descriptor, null, 2),
      };
    case "product":
      return {
        ...head,
        kind: "product",
        sourceComponentId: component.source_component_id,
        name: component.name,
        reaTargetIds: component.rea_target_ids.join("\n"),
      };
    case "artifacts":
      return {
        ...head,
        kind: "artifacts",
        investigationIds: component.investigation_ids.join("\n"),
      };
  }
};

export const draftFromDefinition = (
  definition: BuildDefinition,
  uid: () => string = newUid,
): BuildDraft => ({
  name: definition.name,
  description: definition.description,
  source:
    definition.source.kind === "git"
      ? {
          kind: "git",
          url: definition.source.url,
          ref: definition.source.ref,
          includeWorkingTree: definition.source.include_working_tree,
          includeLfs: definition.source.include_lfs,
          includeSubmodules: definition.source.include_submodules,
        }
      : {
          kind: "runner_local",
          runnerId: definition.source.runner_id,
          pathHash: definition.source.path_hash,
          includeWorkingTree: definition.source.include_working_tree,
          includeLfs: definition.source.include_lfs,
          includeSubmodules: definition.source.include_submodules,
        },
  components: definition.components.map((component) =>
    draftFromComponent(component, uid),
  ),
  runnerId: definition.runner_id ?? "",
});

// --- hints ---------------------------------------------------------------------

/**
 * A reason to doubt a git source URL before it is stored. Advisory only: the
 * runner makes the binding decision and refuses host paths and URLs that
 * carry credentials.
 */
export const gitUrlConcern = (url: string): string | null => {
  const value = url.trim();
  if (value === "") return null;
  if (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~") ||
    /^file:/iu.test(value) ||
    /^[A-Za-z]:[\\/]/u.test(value)
  )
    return "This looks like a path on a host. The runner refuses host paths for a git source; use runner_local with a path hash instead.";
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*:[^/?#@]*@/iu.test(value))
    return "This URL embeds a password. The runner refuses URLs with credentials, and the URL would be stored with the build definition.";
  return null;
};
