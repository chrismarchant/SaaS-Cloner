/**
 * Form model from JSON Schema (2020-12): which inputs to render. Anything the
 * form cannot represent faithfully (`anyOf`/`oneOf`/`allOf`, union types,
 * free-form objects, depth beyond the limit, unresolved `$ref`) becomes a raw
 * JSON node for that subtree, so no field is ever dropped.
 */

export type JsonRecord = Record<string, unknown>;

export const DEFAULT_MAX_DEPTH = 4;

interface NodeBase {
  /** Unique within one model; stable for one schema. */
  readonly id: string;
  /** Property name ("" for the root, "item" for array items). */
  readonly name: string;
  readonly title: string;
  readonly description: string | null;
  readonly required: boolean;
  readonly hasDefault: boolean;
  readonly defaultValue: unknown;
}

export interface ScalarNode extends NodeBase {
  readonly kind: "string" | "integer" | "number";
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly exclusiveMinimum: number | null;
  readonly exclusiveMaximum: number | null;
  readonly minLength: number | null;
  readonly maxLength: number | null;
  readonly pattern: string | null;
}

export interface BooleanNode extends NodeBase {
  readonly kind: "boolean";
}

export interface EnumNode extends NodeBase {
  readonly kind: "enum";
  readonly options: readonly unknown[];
  /** True when the schema used `const` (a single fixed value). */
  readonly fixed: boolean;
}

export interface ObjectNode extends NodeBase {
  readonly kind: "object";
  readonly fields: readonly FormNode[];
  /** Raw JSON field for properties outside `properties`, when the schema admits them. */
  readonly extras: RawNode | null;
}

export interface ArrayNode extends NodeBase {
  readonly kind: "array";
  readonly item: FormNode;
  readonly minItems: number | null;
  readonly maxItems: number | null;
}

export interface RawNode extends NodeBase {
  readonly kind: "raw";
  /** Why this subtree is edited as JSON. */
  readonly reason: string;
  /** Short descriptions of `anyOf`/`oneOf` branches, e.g. `kind=summary`. */
  readonly variants: readonly string[];
  readonly schema: unknown;
}

export type FormNode =
  | ScalarNode
  | BooleanNode
  | EnumNode
  | ObjectNode
  | ArrayNode
  | RawNode;

export interface FormModel {
  readonly root: FormNode;
  /** Schema-supplied `examples` (objects), shown only on request. */
  readonly examples: readonly unknown[];
}

/** What the operator typed. Interpretation depends on the node kind. */
export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const MAX_REF_HOPS = 32;

/** Resolves `#/...` JSON pointers against the root schema. */
export const resolvePointer = (root: unknown, ref: string): unknown => {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    let segment = raw;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      // keep the undecoded segment
    }
    segment = segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (isRecord(current)) current = current[segment];
    else return undefined;
  }
  return current;
};

interface Resolved {
  readonly schema: JsonRecord | boolean;
  readonly problem: string | null;
}

/** Follows `$ref` chains; sibling keywords override the referenced schema. */
const resolveSchema = (root: unknown, input: unknown): Resolved => {
  let current: unknown = input;
  let overrides: JsonRecord = {};
  for (let hop = 0; hop < MAX_REF_HOPS; hop += 1) {
    if (typeof current === "boolean") return { schema: current, problem: null };
    if (!isRecord(current))
      return { schema: {}, problem: "schema is not an object" };
    const ref = current["$ref"];
    if (typeof ref !== "string")
      return { schema: { ...current, ...overrides }, problem: null };
    const { $ref: _ref, ...siblings } = current;
    overrides = { ...siblings, ...overrides };
    const target = resolvePointer(root, ref);
    if (target === undefined)
      return { schema: overrides, problem: `unresolved $ref ${ref}` };
    current = target;
  }
  return { schema: overrides, problem: "$ref chain too deep" };
};

const branchLabel = (root: unknown, branch: unknown): string | null => {
  const { schema } = resolveSchema(root, branch);
  if (!isRecord(schema)) return null;
  const properties = schema["properties"];
  if (isRecord(properties)) {
    const consts: string[] = [];
    for (const [key, value] of Object.entries(properties)) {
      const resolved = resolveSchema(root, value).schema;
      if (isRecord(resolved) && "const" in resolved)
        consts.push(`${key}=${JSON.stringify(resolved["const"])}`);
    }
    if (consts.length > 0) return consts.join(", ");
  }
  for (const key of ["anyOf", "oneOf"]) {
    const nested = schema[key];
    if (Array.isArray(nested))
      return nested
        .map((entry) => branchLabel(root, entry))
        .filter((label): label is string => label !== null)
        .join(" | ");
  }
  const type = schema["type"];
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.join("|");
  return null;
};

const COMBINATORS = ["anyOf", "oneOf", "allOf", "not", "if", "then", "else"];

interface Builder {
  readonly root: unknown;
  readonly maxDepth: number;
  next: number;
}

interface Context {
  readonly name: string;
  readonly required: boolean;
  readonly depth: number;
  readonly titleOverride?: string;
}

const baseOf = (
  builder: Builder,
  schema: JsonRecord,
  ctx: Context,
): NodeBase => {
  builder.next += 1;
  return {
    id: `f${builder.next}`,
    name: ctx.name,
    title: ctx.titleOverride ?? str(schema["title"]) ?? ctx.name,
    description: str(schema["description"]),
    required: ctx.required,
    hasDefault: "default" in schema,
    defaultValue: schema["default"],
  };
};

const rawNode = (
  builder: Builder,
  schema: unknown,
  ctx: Context,
  reason: string,
): RawNode => {
  const record = isRecord(schema) ? schema : {};
  const variants: string[] = [];
  for (const key of ["anyOf", "oneOf"]) {
    const branches = record[key];
    if (Array.isArray(branches))
      for (const branch of branches) {
        const label = branchLabel(builder.root, branch);
        if (label !== null) variants.push(label);
      }
  }
  return {
    ...baseOf(builder, record, ctx),
    kind: "raw",
    reason,
    variants,
    schema,
  };
};

const buildObject = (
  builder: Builder,
  schema: JsonRecord,
  ctx: Context,
): FormNode => {
  const properties = schema["properties"];
  const additional = schema["additionalProperties"];
  const admitsExtras = additional === true || isRecord(additional);
  if (!isRecord(properties) || Object.keys(properties).length === 0) {
    if (admitsExtras || additional === undefined)
      return rawNode(builder, schema, ctx, "free-form object");
    return {
      ...baseOf(builder, schema, ctx),
      kind: "object",
      fields: [],
      extras: null,
    };
  }
  if (ctx.depth >= builder.maxDepth)
    return rawNode(builder, schema, ctx, "nesting depth limit");
  const required = new Set(
    Array.isArray(schema["required"])
      ? schema["required"].filter((entry): entry is string => !!str(entry))
      : [],
  );
  const base = baseOf(builder, schema, ctx);
  const fields = Object.entries(properties).map(([name, child]) =>
    buildNode(builder, child, {
      name,
      required: required.has(name),
      depth: ctx.depth + 1,
    }),
  );
  const extras = admitsExtras
    ? rawNode(
        builder,
        {},
        {
          name: "additional properties",
          required: false,
          depth: ctx.depth + 1,
          titleOverride: "Additional properties",
        },
        "additional properties admitted by the schema",
      )
    : null;
  return { ...base, kind: "object", fields, extras };
};

const buildArray = (
  builder: Builder,
  schema: JsonRecord,
  ctx: Context,
): FormNode => {
  const items = schema["items"];
  if (
    Array.isArray(schema["prefixItems"]) ||
    items === undefined ||
    typeof items === "boolean"
  )
    return rawNode(builder, schema, ctx, "array without a single item schema");
  if (ctx.depth >= builder.maxDepth)
    return rawNode(builder, schema, ctx, "nesting depth limit");
  const base = baseOf(builder, schema, ctx);
  return {
    ...base,
    kind: "array",
    item: buildNode(builder, items, {
      name: "item",
      required: true,
      depth: ctx.depth + 1,
    }),
    minItems: num(schema["minItems"]),
    maxItems: num(schema["maxItems"]),
  };
};

const buildScalar = (
  builder: Builder,
  schema: JsonRecord,
  ctx: Context,
  kind: "string" | "integer" | "number",
): ScalarNode => ({
  ...baseOf(builder, schema, ctx),
  kind,
  minimum: num(schema["minimum"]),
  maximum: num(schema["maximum"]),
  exclusiveMinimum: num(schema["exclusiveMinimum"]),
  exclusiveMaximum: num(schema["exclusiveMaximum"]),
  minLength: num(schema["minLength"]),
  maxLength: num(schema["maxLength"]),
  pattern: str(schema["pattern"]),
});

const buildNode = (
  builder: Builder,
  input: unknown,
  ctx: Context,
): FormNode => {
  const { schema, problem } = resolveSchema(builder.root, input);
  if (problem !== null) return rawNode(builder, schema, ctx, problem);
  if (typeof schema === "boolean")
    return rawNode(
      builder,
      schema,
      ctx,
      schema ? "any value" : "schema forbids every value",
    );
  const combinator = COMBINATORS.find((key) => key in schema);
  if (combinator !== undefined)
    return rawNode(builder, schema, ctx, combinator);
  if (Array.isArray(schema["enum"]) && schema["enum"].length > 0)
    return {
      ...baseOf(builder, schema, ctx),
      kind: "enum",
      options: schema["enum"],
      fixed: false,
    };
  if ("const" in schema)
    return {
      ...baseOf(builder, schema, ctx),
      kind: "enum",
      options: [schema["const"]],
      fixed: true,
    };
  const type = schema["type"];
  if (Array.isArray(type))
    return rawNode(builder, schema, ctx, `union type ${type.join("|")}`);
  if (type === "object" || (type === undefined && "properties" in schema))
    return buildObject(builder, schema, ctx);
  switch (type) {
    case "array":
      return buildArray(builder, schema, ctx);
    case "boolean":
      return { ...baseOf(builder, schema, ctx), kind: "boolean" };
    case "string":
    case "integer":
    case "number":
      return buildScalar(builder, schema, ctx, type);
    default:
      return rawNode(
        builder,
        schema,
        ctx,
        typeof type === "string" ? `unsupported type ${type}` : "no type",
      );
  }
};

export const buildFormModel = (
  schema: unknown,
  options: { maxDepth?: number } = {},
): FormModel => {
  const builder: Builder = {
    root: schema,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    next: 0,
  };
  const root = buildNode(builder, schema, {
    name: "",
    required: true,
    depth: 0,
  });
  const examples =
    isRecord(schema) && Array.isArray(schema["examples"])
      ? schema["examples"]
      : [];
  return { root, examples };
};
