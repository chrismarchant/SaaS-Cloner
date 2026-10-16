import { UsageError } from "./args.js";

/**
 * Parse `NAME=value` lines (optional `export`, `#` comments, matching quotes
 * stripped). No expansion. Values are never echoed in errors.
 */
export function parseEnvFile(
  text: string,
  path: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  text.split(/\r?\n/u).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const m = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (m === null)
      throw new UsageError(
        `${path}:${index + 1}: expected NAME=value with an upper-case name`,
      );
    let value = m[2] ?? "";
    const quote = value[0];
    if (
      value.length >= 2 &&
      (quote === '"' || quote === "'") &&
      value.endsWith(quote)
    )
      value = value.slice(1, -1);
    out[m[1] as string] = value;
  });
  return out;
}
