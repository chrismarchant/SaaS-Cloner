/** Helpers for showing untrusted JSON as text. Nothing here produces markup. */

export const RAW_VIEW_LIMIT_BYTES = 2 * 1024 * 1024;
/** Largest raw result the browser will load on explicit request. */
export const RAW_FORCE_LIMIT_BYTES = 64 * 1024 * 1024;
export const TREE_PAGE_SIZE = 100;

export type JsonContainer = Record<string, unknown> | unknown[];

export const isContainer = (value: unknown): value is JsonContainer =>
  typeof value === "object" && value !== null;

export interface PrettyJson {
  readonly text: string;
  readonly truncated: boolean;
  readonly totalChars: number;
}

/** Pretty-printed JSON, cut at `maxChars` so the page never renders more. */
export const prettyJson = (value: unknown, maxChars: number): PrettyJson => {
  const text = JSON.stringify(value, null, 2) ?? "undefined";
  return text.length > maxChars
    ? {
        text: text.slice(0, maxChars),
        truncated: true,
        totalChars: text.length,
      }
    : { text, truncated: false, totalChars: text.length };
};

export const childEntries = (
  value: JsonContainer,
): readonly (readonly [string, unknown])[] =>
  Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as const)
    : Object.entries(value);

/** One-line description of a value for tree rows. */
export const describeValue = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value))
    return `array, ${value.length} ${value.length === 1 ? "item" : "items"}`;
  if (typeof value === "object")
    return `object, ${Object.keys(value).length} ${Object.keys(value).length === 1 ? "key" : "keys"}`;
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
};

/** Value of `structuredContent.normalized_result` in a raw upstream result. */
export const normalizedResultOf = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const structured = (raw as Record<string, unknown>)["structuredContent"];
  if (typeof structured !== "object" || structured === null) return undefined;
  return (structured as Record<string, unknown>)["normalized_result"];
};

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    value,
  );
