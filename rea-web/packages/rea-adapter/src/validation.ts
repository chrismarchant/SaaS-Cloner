import { createHash } from "node:crypto";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/**
 * Validates tool arguments against the live advertised input schema before a
 * call is dispatched. Schemas are compiled lazily and cached by content hash so
 * a catalog refresh with identical schemas reuses compiled validators.
 */
export interface ValidationFailure {
  readonly ok: false;
  readonly tool: string;
  readonly errors: readonly {
    readonly path: string;
    readonly message: string;
    readonly keyword: string;
  }[];
}
export type ValidationOutcome = { readonly ok: true } | ValidationFailure;

export const schemaSha256 = (schema: unknown): string =>
  createHash("sha256").update(JSON.stringify(schema)).digest("hex");

export class ToolInputValidator {
  private readonly ajv: Ajv2020;
  private readonly compiled = new Map<string, ValidateFunction>();

  constructor() {
    this.ajv = new Ajv2020({
      strict: false,
      allErrors: true,
      allowUnionTypes: true,
      validateFormats: true,
    });
    // ajv-formats is CommonJS; under NodeNext the default import is the
    // callable `module.exports` at runtime while its types describe the module.
    (addFormats as unknown as (ajv: Ajv2020) => unknown)(this.ajv);
  }

  validate(
    tool: string,
    inputSchema: Record<string, unknown>,
    args: unknown,
  ): ValidationOutcome {
    const digest = schemaSha256(inputSchema);
    let fn = this.compiled.get(digest);
    if (!fn) {
      // Strip $id/$schema collisions: schemas share local refs only.
      const { $id: _ignored, ...rest } = inputSchema as { $id?: unknown };
      fn = this.ajv.compile(rest);
      this.compiled.set(digest, fn);
    }
    if (fn(args)) return { ok: true };
    return {
      ok: false,
      tool,
      errors: (fn.errors ?? []).map((e) => ({
        path: e.instancePath || "/",
        message: e.message ?? "invalid",
        keyword: e.keyword,
      })),
    };
  }
}
