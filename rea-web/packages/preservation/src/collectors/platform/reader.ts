import { redactUrl } from "../../util.js";
import { commandFact, type CommandFact } from "./command.js";
import type { SecretRef, UrlFact } from "./types.js";

const PLAIN_KEY = /^[A-Za-z0-9_-]+$/u;

const joinPath = (parent: string, key: string): string => {
  if (!PLAIN_KEY.test(key)) return `${parent}[${JSON.stringify(key)}]`;
  return parent === "" ? key : `${parent}.${key}`;
};

const describeType = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

const hasOwn = (o: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, key);

/** Shared by every node of one document. */
export class Audit {
  private readonly nodes: Node[] = [];
  private readonly mismatches: string[] = [];

  register(node: Node): void {
    this.nodes.push(node);
  }

  mismatch(path: string, expected: string, found: unknown): void {
    this.mismatches.push(
      `${path} (expected ${expected}, found ${describeType(found)})`,
    );
  }

  /** Keys nothing read, plus values of an unexpected type; paths only, never values. */
  unknownKeys(): string[] {
    const keys = [...this.mismatches];
    for (const node of this.nodes) keys.push(...node.unreadKeys());
    return [...new Set(keys)].sort();
  }
}

/**
 * A JSON or TOML object whose keys are tracked: whatever a parser does not
 * read through this class is reported as an unknown key, so the "known"
 * set can never drift from the code that interprets the file.
 */
export class Node {
  private readonly used = new Set<string>();

  private constructor(
    private readonly table: Record<string, unknown>,
    readonly path: string,
    private readonly audit: Audit,
  ) {
    audit.register(this);
  }

  /** The document root; null when the document is not an object. */
  static root(value: unknown, audit: Audit): Node | null {
    return isRecord(value) ? new Node(value, "", audit) : null;
  }

  private at(key: string): unknown {
    this.used.add(key);
    if (!hasOwn(this.table, key)) return undefined;
    const value = this.table[key];
    return value === null ? undefined : value;
  }

  private typed<T>(
    key: string,
    expected: string,
    accept: (value: unknown) => value is T,
  ): T | undefined {
    const value = this.at(key);
    if (value === undefined) return undefined;
    if (accept(value)) return value;
    this.audit.mismatch(joinPath(this.path, key), expected, value);
    return undefined;
  }

  str(key: string): string | undefined {
    return this.typed(key, "string", (v): v is string => typeof v === "string");
  }

  num(key: string): number | undefined {
    return this.typed(
      key,
      "number",
      (v): v is number => typeof v === "number" && Number.isFinite(v),
    );
  }

  bool(key: string): boolean | undefined {
    return this.typed(
      key,
      "boolean",
      (v): v is boolean => typeof v === "boolean",
    );
  }

  /** Array of strings; a non-string element makes the whole value unexpected. */
  strList(key: string): string[] | undefined {
    return this.typed(
      key,
      "array of strings",
      (v): v is string[] =>
        Array.isArray(v) && v.every((x) => typeof x === "string"),
    );
  }

  /** A string or a number, as written (durations and sizes appear as both). */
  text(key: string): string | undefined {
    const value = this.typed(
      key,
      "string or number",
      (v): v is string | number =>
        typeof v === "string" || (typeof v === "number" && Number.isFinite(v)),
    );
    return value === undefined ? undefined : String(value);
  }

  /** An object whose values are strings (a process table). */
  strMap(key: string): Record<string, string> | undefined {
    const table = this.typed(key, "object", isRecord);
    if (table === undefined) return undefined;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(table)) {
      if (typeof value === "string") out[name] = value;
      else
        this.audit.mismatch(
          joinPath(joinPath(this.path, key), name),
          "string",
          value,
        );
    }
    return out;
  }

  /** A string or an array of strings. */
  strOrList(key: string): string[] | undefined {
    const value = this.typed(
      key,
      "string or array of strings",
      (v): v is string | string[] =>
        typeof v === "string" ||
        (Array.isArray(v) && v.every((x) => typeof x === "string")),
    );
    return value === undefined ? undefined : [value].flat();
  }

  obj(key: string): Node | undefined {
    const value = this.typed(key, "object", isRecord);
    return value === undefined
      ? undefined
      : new Node(value, joinPath(this.path, key), this.audit);
  }

  /** An array whose elements are objects. */
  objList(key: string): Node[] | undefined {
    const list = this.typed(
      key,
      "array of objects",
      (v): v is Record<string, unknown>[] =>
        Array.isArray(v) && v.every(isRecord),
    );
    return list?.map(
      (item, i) =>
        new Node(item, `${joinPath(this.path, key)}[${i}]`, this.audit),
    );
  }

  /** An object whose values are objects (named sub-tables). */
  children(key: string): { name: string; node: Node }[] | undefined {
    const table = this.typed(key, "object", isRecord);
    if (table === undefined) return undefined;
    const base = joinPath(this.path, key);
    const out: { name: string; node: Node }[] = [];
    // The container itself is fully consumed; each child is audited on its own.
    const holder = new Node(table, base, this.audit);
    for (const name of Object.keys(table)) {
      const child = holder.obj(name);
      if (child !== undefined) out.push({ name, node: child });
    }
    return out;
  }

  /** Sub-tables of a mixed table (scalar settings next to named tables). */
  subtables(): { name: string; node: Node }[] {
    const out: { name: string; node: Node }[] = [];
    for (const [name, value] of Object.entries(this.table))
      if (isRecord(value)) {
        const node = this.obj(name);
        if (node !== undefined) out.push({ name, node });
      }
    return out;
  }

  /** Names of a map of scalars (an environment table); values are never read. */
  names(key: string): string[] | undefined {
    const table = this.typed(key, "object", isRecord);
    return table === undefined ? undefined : Object.keys(table).sort();
  }

  /** All entries of this node, marking every key as read. */
  entries(): [string, unknown][] {
    for (const key of Object.keys(this.table)) this.used.add(key);
    return Object.entries(this.table);
  }

  /** Count this object without itemising it (rule lists); its keys are not reported as unknown. */
  counted(): void {
    this.entries();
  }

  unreadKeys(): string[] {
    return Object.keys(this.table)
      .filter((key) => !this.used.has(key))
      .map((key) => joinPath(this.path, key));
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Command text from a node key, as an analysed command. */
export const commandAt = (node: Node, key: string): CommandFact | undefined => {
  const text = node.str(key);
  return text === undefined || text.trim() === ""
    ? undefined
    : commandFact(text);
};

/** Commands from a key holding one string or a list of strings. */
export const commandsAt = (node: Node, key: string): CommandFact[] =>
  (node.strOrList(key) ?? [])
    .filter((text) => text.trim() !== "")
    .map(commandFact);

export const urlFact = (raw: string): UrlFact => {
  const trimmed = raw.trim();
  let scheme: string | null = null;
  let host: string | null = null;
  try {
    const url = new URL(trimmed);
    scheme = url.protocol.replace(/:$/u, "");
    host = url.hostname === "" ? null : url.hostname.toLowerCase();
  } catch {
    // not an absolute URL (a path, a relative redirect, a custom scheme)
  }
  const wildcard = host !== null && /[*%]/u.test(host);
  return { url: redactUrl(trimmed), scheme, host, wildcard };
};

/** URLs that name a network host, for restore guards. */
export const httpHost = (fact: UrlFact): string | null =>
  fact.host !== null &&
  !fact.wildcard &&
  (fact.scheme === "http" ||
    fact.scheme === "https" ||
    fact.scheme === "ws" ||
    fact.scheme === "wss")
    ? fact.host
    : null;

const ENV_REF = /^env\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)$/u;

/** `env(NAME)` is a reference to a variable; any other value is a literal and is never recorded. */
export const secretRef = (value: string | undefined): SecretRef => {
  if (value === undefined || value === "") return { kind: "absent" };
  const m = ENV_REF.exec(value.trim());
  return m?.[1] === undefined
    ? { kind: "literal" }
    : { kind: "env", name: m[1] };
};

/** Every `env(NAME)` reference anywhere in a document, with the key that holds it. */
export const envReferences = (
  value: unknown,
  path = "",
  out: { name: string; key: string }[] = [],
  depth = 0,
): { name: string; key: string }[] => {
  if (depth > 32) return out;
  if (typeof value === "string") {
    const ref = secretRef(value);
    if (ref.kind === "env") out.push({ name: ref.name, key: path });
  } else if (Array.isArray(value))
    value.forEach((v, i) => envReferences(v, `${path}[${i}]`, out, depth + 1));
  else if (isRecord(value))
    for (const [k, v] of Object.entries(value))
      envReferences(v, joinPath(path, k), out, depth + 1);
  return out;
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
export const isEnvName = (name: string): boolean => ENV_NAME.test(name);

export { joinPath };
