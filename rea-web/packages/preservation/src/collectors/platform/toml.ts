/**
 * A small TOML 1.0 reader for platform configuration files.
 *
 * Supported: comments, bare and quoted keys, dotted keys, `[table]` and
 * `[[array.of.tables]]` headers, basic / literal / multi-line strings,
 * integers (decimal, hex, octal, binary), floats, booleans, arrays and
 * single-line inline tables.
 *
 * Not supported (the parse fails, it never guesses): date and time values,
 * `inf` / `nan`, integers beyond 2^53, and anything malformed. Error messages
 * name a line and column and a category; they never quote file content, so
 * they cannot carry a secret.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export type TomlResult =
  | { ok: true; value: TomlTable }
  | { ok: false; error: string };

class TomlError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
  }
}

const MAX_DEPTH = 64;
const BARE_KEY = /^[A-Za-z0-9_-]$/u;
const DELIMITERS = new Set([" ", "\t", "\n", "\r", ",", "]", "}", "#"]);
const SIMPLE_ESCAPES: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};
const INTEGER = /^[+-]?(?:0|[1-9](?:_?[0-9])*)$/u;
const RADIX_INTEGER =
  /^0(?:x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/u;
const FLOAT =
  /^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/u;
const DATE_LIKE = /^(?:\d{4}-\d{2}-\d{2}|\d{2}:\d{2})/u;

/** Tables made by headers, by dotted keys, or by inline tables are tracked so redefinition fails. */
interface Registry {
  explicit: WeakSet<object>;
  implicit: WeakSet<object>;
  dotted: WeakSet<object>;
  sealed: WeakSet<object>;
  arrays: WeakSet<object>;
}

const newTable = (): TomlTable => Object.create(null) as TomlTable;
const isTable = (v: unknown): v is TomlTable =>
  v !== null && typeof v === "object" && !Array.isArray(v);

class Reader {
  private i = 0;
  private line = 1;
  private lineStart = 0;
  private readonly reg: Registry = {
    explicit: new WeakSet(),
    implicit: new WeakSet(),
    dotted: new WeakSet(),
    sealed: new WeakSet(),
    arrays: new WeakSet(),
  };

  constructor(private readonly src: string) {}

  private fail(message: string): never {
    throw new TomlError(message, this.line, this.i - this.lineStart + 1);
  }

  private peek(offset = 0): string {
    return this.src.charAt(this.i + offset);
  }

  private atEnd(): boolean {
    return this.i >= this.src.length;
  }

  private newline(): void {
    this.line += 1;
    this.lineStart = this.i;
  }

  private skipBlank(): void {
    while (this.peek() === " " || this.peek() === "\t") this.i += 1;
  }

  /** Consume one end of line (LF or CRLF). */
  private eol(): boolean {
    if (this.peek() === "\n") {
      this.i += 1;
      this.newline();
      return true;
    }
    if (this.peek() === "\r" && this.peek(1) === "\n") {
      this.i += 2;
      this.newline();
      return true;
    }
    if (this.peek() === "\r") this.fail("bare carriage return");
    return false;
  }

  private comment(): void {
    if (this.peek() !== "#") return;
    while (!this.atEnd() && this.peek() !== "\n" && this.peek() !== "\r") {
      const code = this.peek().charCodeAt(0);
      if ((code < 0x20 && code !== 0x09) || code === 0x7f)
        this.fail("control character in comment");
      this.i += 1;
    }
  }

  /** Whitespace, comments and newlines (between statements and inside arrays). */
  private skipTrivia(): void {
    for (;;) {
      this.skipBlank();
      this.comment();
      if (!this.eol()) return;
    }
  }

  private endOfStatement(): void {
    this.skipBlank();
    this.comment();
    if (!this.atEnd() && !this.eol()) this.fail("expected end of line");
  }

  parse(): TomlTable {
    const root = newTable();
    let current = root;
    for (;;) {
      this.skipTrivia();
      if (this.atEnd()) return root;
      if (this.peek() === "[") current = this.header(root);
      else this.keyValue(current);
    }
  }

  private header(root: TomlTable): TomlTable {
    const isArray = this.peek(1) === "[";
    this.i += isArray ? 2 : 1;
    const path = this.keyPath();
    if (isArray) {
      if (this.peek() !== "]" || this.peek(1) !== "]")
        this.fail("expected ']]'");
      this.i += 2;
    } else {
      if (this.peek() !== "]") this.fail("expected ']'");
      this.i += 1;
    }
    this.endOfStatement();
    return isArray
      ? this.openArrayTable(root, path)
      : this.openTable(root, path);
  }

  private descend(root: TomlTable, path: string[]): TomlTable {
    let table = root;
    for (const part of path) {
      const next = table[part];
      if (next === undefined) {
        const created = newTable();
        this.reg.implicit.add(created);
        table[part] = created;
        table = created;
      } else if (Array.isArray(next)) {
        const last = next[next.length - 1];
        if (!this.reg.arrays.has(next) || !isTable(last))
          this.fail("key is not a table");
        table = last;
      } else if (isTable(next)) {
        if (this.reg.sealed.has(next)) this.fail("cannot extend inline table");
        table = next;
      } else this.fail("key is not a table");
    }
    return table;
  }

  private openTable(root: TomlTable, path: string[]): TomlTable {
    const parent = this.descend(root, path.slice(0, -1));
    const name = path[path.length - 1] as string;
    const existing = parent[name];
    if (existing === undefined) {
      const created = newTable();
      this.reg.explicit.add(created);
      parent[name] = created;
      return created;
    }
    if (
      !isTable(existing) ||
      this.reg.explicit.has(existing) ||
      this.reg.dotted.has(existing) ||
      this.reg.sealed.has(existing)
    )
      this.fail("table is defined twice");
    this.reg.implicit.delete(existing);
    this.reg.explicit.add(existing);
    return existing;
  }

  private openArrayTable(root: TomlTable, path: string[]): TomlTable {
    const parent = this.descend(root, path.slice(0, -1));
    const name = path[path.length - 1] as string;
    const existing = parent[name];
    const entry = newTable();
    this.reg.explicit.add(entry);
    if (existing === undefined) {
      const list: TomlValue[] = [entry];
      this.reg.arrays.add(list);
      parent[name] = list;
    } else if (Array.isArray(existing) && this.reg.arrays.has(existing))
      existing.push(entry);
    else this.fail("key is not an array of tables");
    return entry;
  }

  private keyValue(into: TomlTable): void {
    const path = this.keyPath();
    this.skipBlank();
    if (this.peek() !== "=") this.fail("expected '='");
    this.i += 1;
    this.skipBlank();
    const value = this.value(0);
    this.endOfStatement();
    let table = into;
    for (const part of path.slice(0, -1)) {
      const next = table[part];
      if (next === undefined) {
        const created = newTable();
        this.reg.dotted.add(created);
        table[part] = created;
        table = created;
      } else if (
        isTable(next) &&
        !this.reg.sealed.has(next) &&
        this.reg.dotted.has(next)
      )
        table = next;
      else this.fail("key conflicts with an existing definition");
    }
    const name = path[path.length - 1] as string;
    if (table[name] !== undefined) this.fail("key is defined twice");
    table[name] = value;
  }

  private keyPath(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipBlank();
      parts.push(this.keyPart());
      this.skipBlank();
      if (this.peek() !== ".") return parts;
      this.i += 1;
    }
  }

  private keyPart(): string {
    const c = this.peek();
    if (c === '"') return this.basicString();
    if (c === "'") return this.literalString();
    const start = this.i;
    while (!this.atEnd() && BARE_KEY.test(this.peek())) this.i += 1;
    if (this.i === start) this.fail("expected a key");
    return this.src.slice(start, this.i);
  }

  private value(depth: number): TomlValue {
    if (depth > MAX_DEPTH) this.fail("nesting too deep");
    const c = this.peek();
    if (c === '"')
      return this.peek(1) === '"' && this.peek(2) === '"'
        ? this.multilineBasic()
        : this.basicString();
    if (c === "'")
      return this.peek(1) === "'" && this.peek(2) === "'"
        ? this.multilineLiteral()
        : this.literalString();
    if (c === "[") return this.array(depth);
    if (c === "{") return this.inlineTable(depth);
    return this.scalar();
  }

  private scalar(): TomlValue {
    const start = this.i;
    while (!this.atEnd() && !DELIMITERS.has(this.peek())) this.i += 1;
    const token = this.src.slice(start, this.i);
    if (token === "") this.fail("expected a value");
    if (token === "true") return true;
    if (token === "false") return false;
    if (DATE_LIKE.test(token))
      this.fail("date and time values are not supported");
    if (/^[+-]?(?:inf|nan)$/u.test(token))
      this.fail("inf and nan values are not supported");
    if (INTEGER.test(token) || RADIX_INTEGER.test(token))
      return this.integer(token);
    if (FLOAT.test(token)) return Number(token.split("_").join(""));
    this.i = start;
    return this.fail("unrecognised value");
  }

  private integer(token: string): number {
    const clean = token.split("_").join("");
    const n = /^[+-]?0[xob]/u.test(clean)
      ? Number(clean)
      : Number.parseInt(clean, 10);
    if (!Number.isSafeInteger(n))
      this.fail("integer outside the supported range");
    return n;
  }

  private controlCheck(code: number): void {
    if ((code < 0x20 && code !== 0x09) || code === 0x7f)
      this.fail("control character in string");
  }

  private escape(): string {
    const e = this.peek();
    this.i += 1;
    const simple = SIMPLE_ESCAPES[e];
    if (simple !== undefined) return simple;
    if (e === "u" || e === "U") {
      const width = e === "u" ? 4 : 8;
      const hex = this.src.slice(this.i, this.i + width);
      if (hex.length !== width || !/^[0-9A-Fa-f]+$/u.test(hex))
        this.fail("invalid unicode escape");
      this.i += width;
      const code = Number.parseInt(hex, 16);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        this.fail("invalid unicode escape");
      return String.fromCodePoint(code);
    }
    return this.fail("invalid escape sequence");
  }

  private basicString(): string {
    this.i += 1;
    let out = "";
    for (;;) {
      if (this.atEnd() || this.peek() === "\n" || this.peek() === "\r")
        this.fail("unterminated string");
      const c = this.peek();
      if (c === '"') {
        this.i += 1;
        return out;
      }
      this.controlCheck(c.charCodeAt(0));
      this.i += 1;
      out += c === "\\" ? this.escape() : c;
    }
  }

  private literalString(): string {
    this.i += 1;
    const start = this.i;
    for (;;) {
      if (this.atEnd() || this.peek() === "\n" || this.peek() === "\r")
        this.fail("unterminated string");
      const c = this.peek();
      if (c === "'") {
        const out = this.src.slice(start, this.i);
        this.i += 1;
        return out;
      }
      this.controlCheck(c.charCodeAt(0));
      this.i += 1;
    }
  }

  /** Length of the run of `quote` characters at the cursor. */
  private quoteRun(quote: string): number {
    let n = 0;
    while (this.peek(n) === quote) n += 1;
    return n;
  }

  private openMultiline(): void {
    this.i += 3;
    if (this.peek() === "\n") {
      this.i += 1;
      this.newline();
    } else if (this.peek() === "\r" && this.peek(1) === "\n") {
      this.i += 2;
      this.newline();
    }
  }

  private multilineLiteral(): string {
    this.openMultiline();
    let out = "";
    for (;;) {
      if (this.atEnd()) this.fail("unterminated string");
      const c = this.peek();
      if (c === "'") {
        const run = this.quoteRun("'");
        if (run >= 3) {
          if (run > 5) this.fail("too many quotes");
          this.i += run;
          return out + "'".repeat(run - 3);
        }
        out += "'".repeat(run);
        this.i += run;
      } else out += this.multilineChar(c);
    }
  }

  private multilineChar(c: string): string {
    if (c === "\r" && this.peek(1) === "\n") {
      this.i += 2;
      this.newline();
      return "\n";
    }
    if (c === "\n") {
      this.i += 1;
      this.newline();
      return "\n";
    }
    this.controlCheck(c.charCodeAt(0));
    this.i += 1;
    return c;
  }

  private multilineBasic(): string {
    this.openMultiline();
    let out = "";
    for (;;) {
      if (this.atEnd()) this.fail("unterminated string");
      const c = this.peek();
      if (c === '"') {
        const run = this.quoteRun('"');
        if (run >= 3) {
          if (run > 5) this.fail("too many quotes");
          this.i += run;
          return out + '"'.repeat(run - 3);
        }
        out += '"'.repeat(run);
        this.i += run;
      } else if (c === "\\") {
        this.i += 1;
        out += this.multilineEscape();
      } else out += this.multilineChar(c);
    }
  }

  /** A backslash at the end of a line trims the whitespace that follows it. */
  private multilineEscape(): string {
    let j = this.i;
    while (this.src.charAt(j) === " " || this.src.charAt(j) === "\t") j += 1;
    const lineEnd =
      this.src.charAt(j) === "\n" ||
      (this.src.charAt(j) === "\r" && this.src.charAt(j + 1) === "\n");
    if (!lineEnd) return this.escape();
    this.i = j;
    for (;;) {
      if (this.eol()) continue;
      if (this.peek() === " " || this.peek() === "\t") this.i += 1;
      else return "";
    }
  }

  private array(depth: number): TomlValue[] {
    this.i += 1;
    const items: TomlValue[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.peek() === "]") {
        this.i += 1;
        return items;
      }
      if (this.atEnd()) this.fail("unterminated array");
      items.push(this.value(depth + 1));
      this.skipTrivia();
      if (this.peek() === ",") this.i += 1;
      else if (this.peek() !== "]") this.fail("expected ',' or ']'");
    }
  }

  private inlineTable(depth: number): TomlTable {
    this.i += 1;
    const table = newTable();
    this.reg.sealed.add(table);
    this.skipBlank();
    if (this.peek() === "}") {
      this.i += 1;
      return table;
    }
    for (;;) {
      this.inlineEntry(table, depth);
      this.skipBlank();
      if (this.peek() === ",") {
        this.i += 1;
        this.skipBlank();
        if (this.peek() === "}") this.fail("trailing comma in inline table");
      } else if (this.peek() === "}") {
        this.i += 1;
        return table;
      } else this.fail("expected ',' or '}' in inline table");
    }
  }

  private inlineEntry(table: TomlTable, depth: number): void {
    const path = this.keyPath();
    this.skipBlank();
    if (this.peek() !== "=") this.fail("expected '='");
    this.i += 1;
    this.skipBlank();
    const value = this.value(depth + 1);
    let target = table;
    for (const part of path.slice(0, -1)) {
      const next = target[part];
      if (next === undefined) {
        const created = newTable();
        target[part] = created;
        target = created;
      } else if (isTable(next)) target = next;
      else this.fail("key conflicts with an existing definition");
    }
    const name = path[path.length - 1] as string;
    if (target[name] !== undefined) this.fail("key is defined twice");
    target[name] = value;
  }
}

export const parseToml = (text: string): TomlResult => {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return { ok: true, value: new Reader(source).parse() };
  } catch (error) {
    if (error instanceof TomlError)
      return {
        ok: false,
        error: `invalid TOML at line ${error.line}, column ${error.column}: ${error.message}`,
      };
    if (error instanceof RangeError)
      return { ok: false, error: "invalid TOML: nesting too deep" };
    throw error;
  }
};
