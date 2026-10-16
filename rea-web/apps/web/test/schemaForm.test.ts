import { describe, expect, it } from "vitest";
import {
  argumentsToDraft,
  buildFormModel,
  draftToArguments,
  emptyDraft,
  initialDraft,
  resolvePointer,
  type Draft,
  type FormNode,
  type ObjectNode,
} from "../src/lib/schemaForm";
import { probeTool, probeTools } from "./fixtures";

const objectOf = (schema: unknown, maxDepth?: number): ObjectNode => {
  const { root } = buildFormModel(
    schema,
    maxDepth === undefined ? {} : { maxDepth },
  );
  if (root.kind !== "object") throw new Error(`root is ${root.kind}`);
  return root;
};

const field = (node: ObjectNode, name: string): FormNode => {
  const found = node.fields.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no field ${name}`);
  return found;
};

describe("resolvePointer", () => {
  it("follows JSON pointers with escapes", () => {
    const root = { $defs: { "a/b": { "c~d": 1 } } };
    expect(resolvePointer(root, "#/$defs/a~1b/c~0d")).toBe(1);
    expect(resolvePointer(root, "#")).toBe(root);
    expect(resolvePointer(root, "#/$defs/missing")).toBeUndefined();
    expect(resolvePointer(root, "https://example.test/x")).toBeUndefined();
  });
});

describe("form model from synthetic schemas", () => {
  const schema = {
    type: "object",
    required: ["name", "count"],
    properties: {
      name: { $ref: "#/$defs/name", description: "overridden" },
      count: { type: "integer", minimum: 1, maximum: 5, default: 2 },
      ratio: { type: "number", exclusiveMinimum: 0 },
      flag: { type: "boolean" },
      mode: { type: "string", enum: ["a", "b"] },
      fixed: { const: "x" },
      nested: {
        type: "object",
        required: ["inner"],
        properties: { inner: { type: "string", minLength: 2 } },
      },
      tags: { type: "array", items: { type: "string" }, minItems: 1 },
      either: { anyOf: [{ type: "string" }, { type: "null" }] },
      union: { type: ["string", "null"] },
      free: { type: "object", additionalProperties: true },
    },
    additionalProperties: false,
    $defs: { name: { type: "string", pattern: "^[a-z]+$", description: "d" } },
  };

  it("resolves $ref and lets sibling keywords override it", () => {
    const name = field(objectOf(schema), "name");
    expect(name).toMatchObject({
      kind: "string",
      pattern: "^[a-z]+$",
      description: "overridden",
      required: true,
    });
  });

  it("records required, default, enum and const", () => {
    const root = objectOf(schema);
    expect(field(root, "count")).toMatchObject({
      kind: "integer",
      required: true,
      hasDefault: true,
      defaultValue: 2,
      minimum: 1,
      maximum: 5,
    });
    expect(field(root, "mode")).toMatchObject({
      kind: "enum",
      options: ["a", "b"],
      fixed: false,
    });
    expect(field(root, "fixed")).toMatchObject({
      kind: "enum",
      options: ["x"],
      fixed: true,
    });
  });

  it("falls back to raw JSON for unsupported constructs without losing the field", () => {
    const root = objectOf(schema);
    expect(field(root, "either")).toMatchObject({
      kind: "raw",
      reason: "anyOf",
    });
    expect(field(root, "union")).toMatchObject({ kind: "raw" });
    expect(field(root, "free")).toMatchObject({
      kind: "raw",
      reason: "free-form object",
    });
    expect(root.fields.map((entry) => entry.name)).toEqual(
      Object.keys(schema.properties),
    );
  });

  it("converts drafts to arguments, applying defaults and omitting empty optionals", () => {
    const model = buildFormModel(schema);
    const draft = initialDraft(model.root) as { [k: string]: Draft };
    draft["name"] = "abc";
    const result = draftToArguments(model, draft);
    expect(result.errors).toEqual([]);
    expect(result.value).toEqual({ name: "abc", count: 2 });
  });

  it("reports required, range, pattern and nested problems with paths", () => {
    const model = buildFormModel(schema);
    const draft = emptyDraft(model.root) as { [k: string]: Draft };
    draft["name"] = "ABC";
    draft["count"] = "9";
    draft["ratio"] = "0";
    draft["nested"] = { inner: "x" };
    draft["tags"] = [];
    draft["either"] = "{not json";
    const { errors } = draftToArguments(model, draft);
    const byPath = Object.fromEntries(errors.map((e) => [e.path, e]));
    expect(byPath["name"]?.message).toMatch(/match/u);
    expect(byPath["count"]?.message).toMatch(/at most 5/u);
    expect(byPath["ratio"]?.message).toMatch(/greater than 0/u);
    expect(byPath["nested.inner"]?.message).toMatch(/at least 2/u);
    expect(byPath["either"]?.kind).toBe("invalid");
    expect(byPath["tags"]).toBeUndefined();
  });

  it("does not demand children of an untouched optional object", () => {
    const model = buildFormModel(schema);
    const draft = initialDraft(model.root) as { [k: string]: Draft };
    draft["name"] = "ok";
    expect(draftToArguments(model, draft).errors).toEqual([]);
  });

  it("round-trips arguments through the form", () => {
    const model = buildFormModel(schema);
    const args = {
      name: "abc",
      count: 3,
      ratio: 0.5,
      flag: false,
      mode: "b",
      fixed: "x",
      nested: { inner: "hello" },
      tags: ["one", "two"],
      either: null,
      free: { any: [1, 2] },
    };
    const loaded = argumentsToDraft(model, args);
    expect(loaded.unrepresented).toEqual([]);
    expect(draftToArguments(model, loaded.draft)).toEqual({
      value: args,
      errors: [],
    });
  });

  it("reports values the form cannot hold instead of dropping them", () => {
    const model = buildFormModel(schema);
    const loaded = argumentsToDraft(model, {
      name: "a",
      count: 1.5,
      extra: true,
    });
    expect(loaded.unrepresented).toEqual(
      expect.arrayContaining(["count", "extra"]),
    );
  });

  it("keeps additional properties the schema admits in a raw field", () => {
    const open = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: true,
    };
    const model = buildFormModel(open);
    const loaded = argumentsToDraft(model, { a: "1", other: { x: 1 } });
    expect(loaded.unrepresented).toEqual([]);
    expect(draftToArguments(model, loaded.draft).value).toEqual({
      a: "1",
      other: { x: 1 },
    });
  });

  it("limits nesting depth by turning deeper objects into raw JSON", () => {
    const deep = {
      type: "object",
      properties: {
        a: {
          type: "object",
          properties: {
            b: { type: "object", properties: { c: { type: "string" } } },
          },
        },
      },
    };
    const shallow = objectOf(deep, 2);
    const a = field(shallow, "a");
    expect(a.kind).toBe("object");
    expect(field(a as ObjectNode, "b")).toMatchObject({
      kind: "raw",
      reason: "nesting depth limit",
    });
    const full = objectOf(deep, 4);
    expect(field(field(full, "a") as ObjectNode, "b").kind).toBe("object");
  });

  it("stops at reference cycles", () => {
    const cyclic = {
      type: "object",
      properties: { next: { $ref: "#/$defs/node" } },
      $defs: {
        node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/node" } },
        },
      },
    };
    expect(() => buildFormModel(cyclic)).not.toThrow();
  });

  it("reports an unresolved $ref as a raw field", () => {
    const model = objectOf({
      type: "object",
      properties: { x: { $ref: "#/$defs/none" } },
    });
    expect(field(model, "x")).toMatchObject({ kind: "raw" });
  });
});

/**
 * An optional list left empty is not sent. That equals sending `[]` only where
 * the schema's default is `[]`, which the form model checks when loading.
 */
const withoutEmptyLists = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutEmptyLists);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => !(Array.isArray(entry) && entry.length === 0))
      .map(([key, entry]) => [key, withoutEmptyLists(entry)]),
  );
};

describe("upstream tool schemas", () => {
  it("renders inspect_analysis_view with raw source and view fields", () => {
    const tool = probeTool("inspect_analysis_view");
    const model = buildFormModel(tool.inputSchema);
    const root = model.root as ObjectNode;
    expect(root.fields.map((entry) => entry.name)).toEqual(["source", "view"]);
    const source = field(root, "source");
    expect(source).toMatchObject({
      kind: "raw",
      reason: "oneOf",
      required: true,
    });
    expect(source.kind === "raw" ? source.variants : []).toEqual(
      expect.arrayContaining(['kind="retained-evidence"', 'kind="inline"']),
    );

    const evidenceId = `ev_${"a".repeat(64)}`;
    const draft = emptyDraft(root) as { [k: string]: Draft };
    expect(draftToArguments(model, draft).errors.map((e) => e.path)).toEqual([
      "source",
      "view",
    ]);
    draft["source"] = JSON.stringify({
      kind: "retained-evidence",
      evidence_id: evidenceId,
    });
    draft["view"] = '{ "kind": "summary" }';
    expect(draftToArguments(model, draft)).toEqual({
      value: {
        source: { kind: "retained-evidence", evidence_id: evidenceId },
        view: { kind: "summary" },
      },
      errors: [],
    });
  });

  it("renders compare_bundles with typed path fields and a record pair array", () => {
    const tool = probeTool("compare_bundles");
    const model = buildFormModel(tool.inputSchema);
    const root = model.root as ObjectNode;
    expect(field(root, "left_bundle_path")).toMatchObject({
      kind: "string",
      required: true,
      minLength: 1,
      description: "Local filesystem path for left bundle.",
    });
    const pairs = field(root, "record_pairs");
    expect(pairs).toMatchObject({
      kind: "array",
      required: false,
      hasDefault: true,
    });

    const draft = initialDraft(root) as { [k: string]: Draft };
    draft["left_bundle_path"] = "/tmp/left.json";
    draft["right_bundle_path"] = "/tmp/right.json";
    expect(draftToArguments(model, draft).value).toEqual({
      left_bundle_path: "/tmp/left.json",
      right_bundle_path: "/tmp/right.json",
    });

    const id = `ev_${"b".repeat(64)}`;
    draft["record_pairs"] = [
      { left_evidence_id: id, right_evidence_id: "nope" },
    ];
    const bad = draftToArguments(model, draft);
    expect(bad.errors.map((e) => e.path)).toEqual([
      "record_pairs[0].right_evidence_id",
    ]);
    draft["record_pairs"] = [{ left_evidence_id: id, right_evidence_id: id }];
    expect(draftToArguments(model, draft).value).toMatchObject({
      record_pairs: [{ left_evidence_id: id, right_evidence_id: id }],
    });
  });

  it("never drops a top-level property of any advertised tool", () => {
    const tools = probeTools();
    expect(tools.length).toBeGreaterThan(100);
    for (const tool of tools) {
      const { root } = buildFormModel(tool.inputSchema);
      const properties = Object.keys(
        (tool.inputSchema["properties"] as
          | Record<string, unknown>
          | undefined) ?? {},
      );
      if (properties.length === 0) continue;
      expect(root.kind, tool.name).toBe("object");
      expect(
        (root as ObjectNode).fields.map((entry) => entry.name),
        tool.name,
      ).toEqual(properties);
    }
  });

  it("round-trips schema-supplied examples exactly, or says what the form cannot hold", () => {
    let exact = 0;
    let reported = 0;
    for (const tool of probeTools()) {
      const model = buildFormModel(tool.inputSchema);
      for (const example of model.examples) {
        const loaded = argumentsToDraft(model, example);
        if (loaded.unrepresented.length > 0) {
          reported += 1;
          continue;
        }
        const back = draftToArguments(model, loaded.draft);
        expect(back.errors, `${tool.name} example`).toEqual([]);
        expect(withoutEmptyLists(back.value), `${tool.name} example`).toEqual(
          withoutEmptyLists(example),
        );
        exact += 1;
      }
    }
    expect(exact).toBeGreaterThan(100);
    expect(reported).toBeLessThan(exact);
  });

  it("keeps an explicitly empty string out of the form rather than dropping it", () => {
    const model = buildFormModel({
      type: "object",
      properties: { pattern: { type: "string" } },
    });
    expect(argumentsToDraft(model, { pattern: "" }).unrepresented).toEqual([
      "pattern",
    ]);
  });
});
