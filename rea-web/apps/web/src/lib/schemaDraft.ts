/**
 * What the operator typed (text, never coerced while editing) and its
 * conversion to tool arguments. Conversion happens once, in
 * `draftToArguments`, which reports every problem instead of dropping fields.
 */
import {
  type ArrayNode,
  type FormModel,
  type FormNode,
  type JsonRecord,
  isRecord,
  type ScalarNode,
} from "./schemaModel";

/** Draft key under which an object's free-form extra properties are kept. */
export const EXTRAS_KEY = "\u0000extras";

export type Draft = string | Draft[] | { [key: string]: Draft };

export interface FieldError {
  /** Human path such as `source.kind` or `items[0].name`. */
  readonly path: string;
  /** `required` problems drop nothing; `invalid` ones would. */
  readonly kind: "required" | "invalid";
  readonly message: string;
}

// --- drafts ---------------------------------------------------------------

const rawText = (value: unknown): string => JSON.stringify(value, null, 2);

/** Draft with no values entered. */
export const emptyDraft = (node: FormNode): Draft => {
  switch (node.kind) {
    case "object": {
      const draft: { [key: string]: Draft } = {};
      for (const field of node.fields) draft[field.name] = emptyDraft(field);
      if (node.extras !== null) draft[EXTRAS_KEY] = "";
      return draft;
    }
    case "array":
      return [];
    default:
      return "";
  }
};

const scalarText = (node: FormNode, value: unknown): string | null => {
  switch (node.kind) {
    case "string":
      return typeof value === "string" ? value : null;
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? String(value)
        : null;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : null;
    case "boolean":
      return typeof value === "boolean" ? String(value) : null;
    case "enum": {
      const index = node.options.findIndex(
        (option) => JSON.stringify(option) === JSON.stringify(value),
      );
      return index >= 0 ? String(index) : null;
    }
    default:
      return null;
  }
};

/**
 * Converts a JSON value into a draft. Anything the node cannot hold is added
 * to `unrepresented` rather than discarded.
 */
export const valueToDraft = (
  node: FormNode,
  value: unknown,
  path: string,
  unrepresented: string[],
): Draft => {
  switch (node.kind) {
    case "raw":
      return rawText(value);
    case "object": {
      if (!isRecord(value)) {
        unrepresented.push(path === "" ? "(root)" : path);
        return emptyDraft(node);
      }
      const draft: { [key: string]: Draft } = {};
      const known = new Set<string>();
      for (const field of node.fields) {
        known.add(field.name);
        draft[field.name] =
          field.name in value
            ? valueToDraft(
                field,
                value[field.name],
                joinPath(path, field.name),
                unrepresented,
              )
            : emptyDraft(field);
      }
      const extra: JsonRecord = {};
      for (const [key, entry] of Object.entries(value))
        if (!known.has(key)) extra[key] = entry;
      if (Object.keys(extra).length > 0) {
        if (node.extras !== null) draft[EXTRAS_KEY] = rawText(extra);
        else
          for (const key of Object.keys(extra))
            unrepresented.push(joinPath(path, key));
      }
      if (node.extras !== null && !(EXTRAS_KEY in draft))
        draft[EXTRAS_KEY] = "";
      return draft;
    }
    case "array": {
      if (!Array.isArray(value)) {
        unrepresented.push(path === "" ? "(root)" : path);
        return [];
      }
      // An empty list for an optional field is sent as "not set", which only
      // means the same thing when the schema's default is the empty list.
      if (value.length === 0 && !node.required && !hasEmptyListDefault(node))
        unrepresented.push(path === "" ? "(root)" : path);
      return value.map((entry, index) =>
        valueToDraft(node.item, entry, `${path}[${index}]`, unrepresented),
      );
    }
    default: {
      const text = scalarText(node, value);
      // An empty text box means "not set", so an explicit empty string can
      // only be kept in raw JSON.
      if (text === null || (node.kind === "string" && text === "")) {
        unrepresented.push(path === "" ? "(root)" : path);
        return "";
      }
      return text;
    }
  }
};

export const joinPath = (path: string, name: string): string =>
  path === "" ? name : `${path}.${name}`;

/**
 * Empty draft with the schema's defaults filled in. Defaults inside an
 * optional object stay unset: filling them would make the object count as
 * entered and demand its other required fields.
 */
export const initialDraft = (node: FormNode, included = true): Draft => {
  if (included && node.hasDefault && node.defaultValue !== undefined) {
    const issues: string[] = [];
    const draft = valueToDraft(node, node.defaultValue, node.name, issues);
    if (issues.length === 0) return draft;
  }
  if (node.kind === "object") {
    const draft: { [key: string]: Draft } = {};
    for (const field of node.fields)
      draft[field.name] = initialDraft(field, included && node.required);
    if (node.extras !== null) draft[EXTRAS_KEY] = "";
    return draft;
  }
  if (node.kind === "enum" && node.fixed && node.required) return "0";
  return emptyDraft(node);
};

// --- draft -> value -------------------------------------------------------

interface Converted {
  readonly present: boolean;
  readonly value: unknown;
  /**
   * Whether the operator entered something in this subtree. A required child
   * object is "present" even when empty, but that alone must not make its
   * optional parent count as filled in.
   */
  readonly touched: boolean;
}

const ABSENT: Converted = { present: false, value: undefined, touched: false };

const present = (value: unknown, touched = true): Converted => ({
  present: true,
  value,
  touched,
});

const hasEmptyListDefault = (node: ArrayNode): boolean =>
  Array.isArray(node.defaultValue) && node.defaultValue.length === 0;

const countCodePoints = (text: string): number => [...text].length;

const convertScalar = (
  node: ScalarNode,
  text: string,
  path: string,
  errors: FieldError[],
): Converted => {
  const fail = (message: string): Converted => {
    errors.push({ path, kind: "invalid", message });
    return ABSENT;
  };
  if (node.kind === "string") {
    if (node.minLength !== null && countCodePoints(text) < node.minLength)
      return fail(`must be at least ${node.minLength} characters`);
    if (node.maxLength !== null && countCodePoints(text) > node.maxLength)
      return fail(`must be at most ${node.maxLength} characters`);
    if (node.pattern !== null) {
      let expression: RegExp | null = null;
      try {
        expression = new RegExp(node.pattern, "u");
      } catch {
        expression = null;
      }
      if (expression !== null && !expression.test(text))
        return fail(`must match ${node.pattern}`);
    }
    return present(text);
  }
  const trimmed = text.trim();
  const parsed =
    node.kind === "integer"
      ? /^[+-]?\d+$/u.test(trimmed)
        ? Number(trimmed)
        : Number.NaN
      : trimmed === ""
        ? Number.NaN
        : Number(trimmed);
  if (
    node.kind === "integer"
      ? !Number.isSafeInteger(parsed)
      : !Number.isFinite(parsed)
  )
    return fail(
      node.kind === "integer" ? "must be an integer" : "must be a number",
    );
  if (node.minimum !== null && parsed < node.minimum)
    return fail(`must be at least ${node.minimum}`);
  if (node.maximum !== null && parsed > node.maximum)
    return fail(`must be at most ${node.maximum}`);
  if (node.exclusiveMinimum !== null && parsed <= node.exclusiveMinimum)
    return fail(`must be greater than ${node.exclusiveMinimum}`);
  if (node.exclusiveMaximum !== null && parsed >= node.exclusiveMaximum)
    return fail(`must be less than ${node.exclusiveMaximum}`);
  return present(parsed);
};

const isBlank = (draft: Draft | undefined): boolean =>
  draft === undefined || (typeof draft === "string" && draft.trim() === "");

const convert = (
  node: FormNode,
  draft: Draft | undefined,
  path: string,
  errors: FieldError[],
): Converted => {
  const missing = (): Converted => {
    if (node.required)
      errors.push({ path, kind: "required", message: "is required" });
    return ABSENT;
  };
  switch (node.kind) {
    case "object": {
      const record =
        draft !== undefined &&
        typeof draft === "object" &&
        !Array.isArray(draft)
          ? draft
          : {};
      const out: JsonRecord = {};
      let any = false;
      const before = errors.length;
      for (const field of node.fields) {
        const result = convert(
          field,
          record[field.name],
          joinPath(path, field.name),
          errors,
        );
        if (result.present) out[field.name] = result.value;
        if (result.touched) any = true;
      }
      if (node.extras !== null) {
        const extras = convertRaw(
          record[EXTRAS_KEY],
          joinPath(path, "additional properties"),
          errors,
          false,
        );
        if (extras.present) {
          if (isRecord(extras.value)) {
            for (const [key, value] of Object.entries(extras.value))
              if (key in out)
                errors.push({
                  path: joinPath(path, key),
                  kind: "invalid",
                  message: "is already set by its own field",
                });
              else {
                out[key] = value;
                any = true;
              }
          } else
            errors.push({
              path: joinPath(path, "additional properties"),
              kind: "invalid",
              message: "must be a JSON object",
            });
        }
      }
      if (any || node.required) return present(out, any);
      // Optional object with nothing entered: its required children are not
      // demanded, so drop the "required" errors recorded for them. Invalid
      // input is never discarded.
      const added = errors.splice(before);
      errors.push(...added.filter((entry) => entry.kind === "invalid"));
      return ABSENT;
    }
    case "array": {
      const items = Array.isArray(draft) ? draft : [];
      const out: unknown[] = [];
      items.forEach((entry, index) => {
        const result = convert(node.item, entry, `${path}[${index}]`, errors);
        if (result.present) out.push(result.value);
      });
      if (
        node.minItems !== null &&
        items.length < node.minItems &&
        (items.length > 0 || node.required)
      )
        errors.push({
          path,
          kind: "invalid",
          message: `needs at least ${node.minItems} items`,
        });
      if (node.maxItems !== null && items.length > node.maxItems)
        errors.push({
          path,
          kind: "invalid",
          message: `allows at most ${node.maxItems} items`,
        });
      if (items.length === 0)
        return node.required ? present([], false) : ABSENT;
      return present(out);
    }
    case "raw":
      return convertRaw(draft, path, errors, node.required);
    default: {
      if (
        typeof draft !== "string" ||
        (node.kind !== "string" ? isBlank(draft) : draft === "")
      )
        return missing();
      switch (node.kind) {
        case "boolean":
          return draft === "true"
            ? present(true)
            : draft === "false"
              ? present(false)
              : missing();
        case "enum": {
          const index = Number(draft);
          return Number.isInteger(index) &&
            index >= 0 &&
            index < node.options.length
            ? present(node.options[index], !node.fixed)
            : missing();
        }
        default:
          return convertScalar(node, draft, path, errors);
      }
    }
  }
};

const convertRaw = (
  draft: Draft | undefined,
  path: string,
  errors: FieldError[],
  required: boolean,
): Converted => {
  if (typeof draft !== "string" || draft.trim() === "") {
    if (required)
      errors.push({ path, kind: "required", message: "is required" });
    return ABSENT;
  }
  try {
    return present(JSON.parse(draft) as unknown);
  } catch (error) {
    errors.push({
      path,
      kind: "invalid",
      message: `is not valid JSON (${error instanceof Error ? error.message : "parse error"})`,
    });
    return ABSENT;
  }
};

export interface ArgumentsResult {
  readonly value: JsonRecord;
  readonly errors: readonly FieldError[];
}

/** Tool arguments from a draft of the model's root object. */
export const draftToArguments = (
  model: FormModel,
  draft: Draft,
): ArgumentsResult => {
  const errors: FieldError[] = [];
  const result = convert(model.root, draft, "", errors);
  if (result.present && !isRecord(result.value)) {
    errors.push({
      path: "(root)",
      kind: "invalid",
      message: "arguments must be a JSON object",
    });
    return { value: {}, errors };
  }
  return { value: isRecord(result.value) ? result.value : {}, errors };
};

export interface DraftFromArguments {
  readonly draft: Draft;
  /** Paths in the supplied arguments that the form cannot hold. */
  readonly unrepresented: readonly string[];
}

/** Loads existing arguments into the form without discarding anything. */
export const argumentsToDraft = (
  model: FormModel,
  args: unknown,
): DraftFromArguments => {
  const unrepresented: string[] = [];
  const draft = valueToDraft(model.root, args, "", unrepresented);
  return { draft, unrepresented };
};

export const describeError = (error: FieldError): string =>
  `${error.path === "" ? "(root)" : error.path} ${error.message}`;
