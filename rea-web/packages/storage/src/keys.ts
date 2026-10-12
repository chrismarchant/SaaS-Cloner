import { validateRelativePath } from "@rea-web/contracts";
import { InvalidObjectKeyError } from "./errors.js";

const MAX_KEY_CHARS = 512;
const MAX_KEY_BYTES = 1024;
/** Leaves room for the `.json` sidecar suffix inside a 255 byte file name. */
const MAX_SEGMENT_BYTES = 240;

/**
 * Validate an object key and return its normalised form. Beyond the shared
 * relative-path rules (no traversal, absolute paths, control characters),
 * object keys must already be normal: no empty, `.` or backslash segments, so
 * the returned key always equals the input.
 */
export const validateObjectKey = (key: string): string => {
  if (typeof key !== "string")
    throw new InvalidObjectKeyError(String(key), "not_a_string");
  const validated = validateRelativePath(key, { maxLength: MAX_KEY_CHARS });
  if (!validated.ok)
    throw new InvalidObjectKeyError(key, validated.rejection.kind);
  if (key.includes("\\")) throw new InvalidObjectKeyError(key, "backslash");
  if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES)
    throw new InvalidObjectKeyError(key, "too_long");
  for (const segment of key.split("/")) {
    if (segment === "") throw new InvalidObjectKeyError(key, "empty_segment");
    if (segment === ".") throw new InvalidObjectKeyError(key, "dot_segment");
    if (Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES)
      throw new InvalidObjectKeyError(key, "segment_too_long");
  }
  if (validated.path !== key)
    throw new InvalidObjectKeyError(key, "not_normalised");
  return validated.path;
};

/**
 * Validate a list prefix. An empty prefix lists everything; otherwise the
 * prefix is a key-shaped string that may end with `/` or stop mid-segment.
 */
export const validateListPrefix = (prefix: string): string => {
  if (prefix === "") return "";
  validateObjectKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
  return prefix;
};
