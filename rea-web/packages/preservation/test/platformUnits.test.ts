import { describe, expect, it } from "vitest";
import {
  SHELL_SYNTAX_REASON,
  commandFact,
  tokenize,
} from "../src/collectors/platform/command.js";
import { parseProcfile } from "../src/collectors/platform/procfile.js";
import { parseToml } from "../src/collectors/platform/toml.js";

const ok = (text: string): unknown => {
  const r = parseToml(text);
  if (!r.ok) throw new Error(r.error);
  return JSON.parse(JSON.stringify(r.value));
};
const fail = (text: string): string => {
  const r = parseToml(text);
  if (r.ok) throw new Error("expected a parse failure");
  return r.error;
};

describe("TOML subset parser", () => {
  it("reads tables, arrays of tables, dotted keys and every string form", () => {
    expect(
      ok(`
# comment
title = "a \\"b\\" \\u00e9"  # trailing
lit = 'C:\\path'
ml = """
line1
line2 \\
   joined"""
mll = '''
raw \\n'''
n = 1_000
hex = 0xFF
f = 1.5e2
t = true
arr = [1, "two", [3.5], { x = 1 }]
multi = [
  "a", # note
  "b",
]
a.b.c = 1
"quoted key" = 2

[server]
port = 8080
[server.tls]
on = false

[[items]]
name = "one"
[[items]]
name = "two"
[items.meta]
k = "v"
`),
    ).toEqual({
      title: 'a "b" é',
      lit: "C:\\path",
      ml: "line1\nline2 joined",
      mll: "raw \\n",
      n: 1000,
      hex: 255,
      f: 150,
      t: true,
      arr: [1, "two", [3.5], { x: 1 }],
      multi: ["a", "b"],
      a: { b: { c: 1 } },
      "quoted key": 2,
      server: { port: 8080, tls: { on: false } },
      items: [{ name: "one" }, { name: "two", meta: { k: "v" } }],
    });
  });

  it("accepts CRLF line endings and a byte order mark", () => {
    expect(ok('\uFEFFa = 1\r\n[t]\r\nb = "x"\r\n')).toEqual({
      a: 1,
      t: { b: "x" },
    });
  });

  it("keeps __proto__ as an ordinary key", () => {
    const r = parseToml("[__proto__]\npolluted = true\n");
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it.each([
    ["a = 1\na = 2", /key is defined twice/u],
    ["[a]\n[a]", /table is defined twice/u],
    ["a = 1\n[a]", /table is defined twice/u],
    ["[a]\nb.c = 1\n[a.b]", /table is defined twice/u],
    ["a = { b = 1 }\n[a.c]", /cannot extend inline table/u],
    ["a = [1]\n[[a]]", /key is not an array of tables/u],
    ['a = "x', /unterminated string/u],
    ['a = "x\\q"', /invalid escape sequence/u],
    ["a = [1, 2", /unterminated array|expected/u],
    ["a = {b = 1,}", /trailing comma/u],
    ["a =", /expected a value/u],
    ["a = nope", /unrecognised value/u],
    ["a = 2026-01-01", /date and time values are not supported/u],
    ["a = 12:30:00", /date and time values are not supported/u],
    ["a = inf", /inf and nan/u],
    ["a = 9007199254740993", /outside the supported range/u],
    ["a = 01", /unrecognised value/u],
    ["a = 1 b = 2", /expected end of line/u],
    ["= 1", /expected a key/u],
    ["a = 1\rb = 2", /bare carriage return/u],
  ])("fails closed on %j", (text, message) => {
    const error = fail(text);
    expect(error).toMatch(/^invalid TOML at line \d+, column \d+: /u);
    expect(error).toMatch(message);
  });

  it("never quotes file content in an error", () => {
    expect(fail('token = "sk_live_should_not_leak" oops')).not.toMatch(
      /sk_live/u,
    );
  });

  it("rejects absurd nesting without overflowing the stack", () => {
    expect(fail(`a = ${"[".repeat(5000)}`)).toMatch(/nesting too deep/u);
  });
});

describe("conservative command tokenizer", () => {
  it.each([
    ["npm run build", ["npm", "run", "build"]],
    ["  next   build  ", ["next", "build"]],
    [
      'node scripts/build.js --name "two words"',
      ["node", "scripts/build.js", "--name", "two words"],
    ],
    ["node 'a $b' c", ["node", "a $b", "c"]],
    ["make CC=gcc", ["make", "CC=gcc"]],
    ['pkg"a b"c', ["pkga bc"]],
  ])("splits %j into words", (text, argv) => {
    expect(tokenize(text)).toEqual({ ok: true, argv });
  });

  it.each([
    ["npm ci && npm run build", "'&' or '&&'"],
    ["a | b", "'|' or '||'"],
    ["a ; b", "';'"],
    ["echo $(date)", "'$' expansion"],
    ["echo `date`", "backtick"],
    ["a > out.txt", "redirect '>'"],
    ["a < in.txt", "redirect '<'"],
    ["cat *.txt", "glob '*'"],
    ["ls ?.txt", "glob '?'"],
    ["ls [ab].txt", "glob '['"],
    ["NODE_ENV=production npm run build", "environment variable assignment"],
    ["cd web && npm run build", "'&' or '&&'"],
    ["echo $HOME", "'$' expansion"],
    ['echo "$HOME"', "'$' expansion inside double quotes"],
    ["echo ~/x", "tilde expansion"],
    ["echo # not a comment here", "comment '#'"],
    ["a\nb", "newline"],
    ["echo 'unterminated", "unterminated quote"],
    ["(cd x)", "'('"],
    ["echo {a,b}", "'{'"],
    ["echo a\\ b", "backslash escape"],
  ])("refuses %j (%s)", (text, detail) => {
    expect(tokenize(text)).toEqual({ ok: false, detail });
    expect(commandFact(text)).toMatchObject({
      argv: null,
      issue: SHELL_SYNTAX_REASON,
      detail,
      // Assignment values never reach recorded text.
      text: text.replace(/^(\w+)=\S+/u, "$1=<value omitted>"),
    });
  });

  it("keeps the original text next to the argument array", () => {
    expect(commandFact("npm run build")).toEqual({
      text: "npm run build",
      omitted_assignments: [],
      argv: ["npm", "run", "build"],
      issue: null,
      detail: null,
    });
    expect(commandFact("   ")).toMatchObject({
      argv: null,
      issue: "empty command",
    });
  });
});

describe("Procfile parser", () => {
  it("returns process types, token arrays and the verbatim line", () => {
    const r = parseProcfile(
      '# comment\n\nweb: node server.js --port 80\nworker:   node w.js "a b"  \r\n',
    );
    expect(r).toMatchObject({
      ok: true,
      entries: [
        {
          process_type: "web",
          line_number: 3,
          original_line: "web: node server.js --port 80",
          command: { argv: ["node", "server.js", "--port", "80"] },
        },
        {
          process_type: "worker",
          line_number: 4,
          original_line: 'worker:   node w.js "a b"  ',
          command: { argv: ["node", "w.js", "a b"] },
        },
      ],
    });
  });

  it("fails on lines it does not understand and on duplicate types", () => {
    expect(parseProcfile("web node server.js")).toEqual({
      ok: false,
      error: "invalid Procfile at line 1: expected '<process type>: <command>'",
    });
    expect(parseProcfile("web: a\nweb: b")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/line 2: process type declared twice/u),
    });
  });
});

describe("assignment values in recorded commands", () => {
  it("names assignments but never copies their values into recorded text", () => {
    const fact = commandFact(
      "API_KEY=abc123secret npm run build && export TOKEN='x y' && env DB=\"p w\" node x.js",
    );
    expect(fact.text).not.toContain("abc123secret");
    expect(fact.text).not.toContain("x y");
    expect(fact.text).not.toContain("p w");
    expect(fact.text).toContain("API_KEY=<value omitted>");
    expect(fact.omitted_assignments).toEqual(["API_KEY", "TOKEN", "DB"]);
    expect(fact.argv).toBeNull();
    // Options are not assignments.
    expect(commandFact("node build.mjs --mode=production").text).toBe(
      "node build.mjs --mode=production",
    );
  });
});
