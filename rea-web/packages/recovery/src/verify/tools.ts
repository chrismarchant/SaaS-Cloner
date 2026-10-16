import { access, constants, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { execProcess } from "./exec.js";

export type VersionOperator = ">=" | ">" | "<=" | "<" | "=";

export interface Requirement {
  readonly raw: string;
  readonly tool: string;
  readonly constraint: {
    readonly operator: VersionOperator;
    readonly version: readonly number[];
  } | null;
}

const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/u;
const REQUIREMENT =
  /^([A-Za-z0-9][A-Za-z0-9_.+-]*)\s*(?:(>=|<=|==|=|>|<)\s*v?(\d+(?:\.\d+){0,2}))?$/u;

/** Parse `git`, `git>=2.30`, `pg_restore`, ... Returns null for anything else. */
export const parseRequirement = (raw: string): Requirement | null => {
  const m = REQUIREMENT.exec(raw.trim());
  if (m === null) return null;
  const tool = m[1] as string;
  if (m[2] === undefined || m[3] === undefined)
    return { raw, tool, constraint: null };
  const operator = (m[2] === "==" ? "=" : m[2]) as VersionOperator;
  return {
    raw,
    tool,
    constraint: { operator, version: m[3].split(".").map(Number) },
  };
};

export const compareVersions = (
  a: readonly number[],
  b: readonly number[],
): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
};

/** The first `x.y[.z]` a `--version` banner prints. */
export const firstVersion = (text: string): number[] | null => {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/u.exec(text);
  if (m === null) return null;
  return [m[1], m[2], m[3]]
    .filter((p): p is string => p !== undefined)
    .map(Number);
};

export const satisfies = (
  found: readonly number[],
  constraint: NonNullable<Requirement["constraint"]>,
): boolean => {
  const c = compareVersions(found, constraint.version);
  switch (constraint.operator) {
    case ">=":
      return c >= 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    case "<":
      return c < 0;
    case "=":
      return c === 0;
  }
};

/** Find an executable regular file named `tool` on `pathVar`. */
export const findOnPath = async (
  tool: string,
  pathVar: string,
): Promise<string | null> => {
  if (!TOOL_NAME.test(tool)) return null;
  for (const dir of pathVar.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, tool);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
};

/** Looks tools up once per run; `--version` is executed at most once per tool. */
export class ToolChecker {
  private readonly found = new Map<string, Promise<string | null>>();
  private readonly versions = new Map<string, Promise<number[] | null>>();
  constructor(
    private readonly pathVar: string,
    private readonly childEnv: Readonly<Record<string, string>>,
  ) {}

  locate(tool: string): Promise<string | null> {
    let hit = this.found.get(tool);
    if (hit === undefined) {
      hit = findOnPath(tool, this.pathVar);
      this.found.set(tool, hit);
    }
    return hit;
  }

  private version(tool: string, path: string): Promise<number[] | null> {
    let hit = this.versions.get(tool);
    if (hit === undefined) {
      hit = execProcess([path, "--version"], {
        env: this.childEnv,
        timeoutMs: 15_000,
        tailBytes: 4096,
      }).then((r) => firstVersion(`${r.stdout}\n${r.stderr}`));
      this.versions.set(tool, hit);
    }
    return hit;
  }

  /**
   * Requirements that are not met, each formatted for the report:
   * `tool` (not on PATH), `tool>=x (found y)`, or `<text> (unparseable)`.
   */
  async missing(requirements: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const raw of new Set(requirements)) {
      const req = parseRequirement(raw);
      if (req === null) {
        out.push(`${raw} (unparseable requirement)`);
        continue;
      }
      const path = await this.locate(req.tool);
      if (path === null) {
        out.push(req.raw);
        continue;
      }
      if (req.constraint === null) continue;
      const found = await this.version(req.tool, path);
      if (found === null) out.push(`${req.raw} (version not reported)`);
      else if (!satisfies(found, req.constraint))
        out.push(`${req.raw} (found ${found.join(".")})`);
    }
    return out;
  }
}
