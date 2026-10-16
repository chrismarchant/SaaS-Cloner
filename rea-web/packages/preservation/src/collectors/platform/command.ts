import {
  type RestoreStep,
  validateRestoreStepArguments,
} from "@rea-web/contracts";

/** Why a configured command is not a restore step. */
export const SHELL_SYNTAX_REASON =
  "shell syntax; not executable without a shell";

export interface CommandFact {
  /**
   * The command as written, except that values of shell variable
   * assignments (`NAME=value`, including after `export`/`env`) are replaced
   * by `<value omitted>`: assignments name configuration and may carry
   * secrets, and the text is copied into manual prerequisites.
   */
  text: string;
  /** Names whose assigned values were omitted from `text`. */
  omitted_assignments: string[];
  /** Argument array when the command is plain words and quoted strings only. */
  argv: string[] | null;
  /** Why `argv` is null. */
  issue: string | null;
  /** Which construct triggered the issue (never the command's content). */
  detail: string | null;
}

type Tokenized = { ok: true; argv: string[] } | { ok: false; detail: string };

const UNQUOTED_OPERATORS: Record<string, string> = {
  "&": "'&' or '&&'",
  "|": "'|' or '||'",
  ";": "';'",
  "<": "redirect '<'",
  ">": "redirect '>'",
  "(": "'('",
  ")": "')'",
  "{": "'{'",
  "}": "'}'",
  $: "'$' expansion",
  "`": "backtick",
  "*": "glob '*'",
  "?": "glob '?'",
  "[": "glob '['",
  "]": "glob ']'",
  "!": "'!'",
  "\\": "backslash escape",
  "\n": "newline",
  "\r": "newline",
};
const DOUBLE_QUOTE_HAZARDS: Record<string, string> = {
  $: "'$' expansion inside double quotes",
  "`": "backtick inside double quotes",
  "\\": "backslash escape inside double quotes",
  "!": "'!' inside double quotes",
  "\n": "newline inside quotes",
  "\r": "newline inside quotes",
};
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** Hazard in the body of a quoted string, or null when it is safe to take literally. */
const quoteHazard = (quote: string, body: string): string | null => {
  if (quote === "'")
    return /[\n\r]/u.test(body) ? "newline inside quotes" : null;
  for (const ch of body) {
    const hazard = DOUBLE_QUOTE_HAZARDS[ch];
    if (hazard !== undefined) return hazard;
  }
  return null;
};

/**
 * Split a command into words without interpreting it. Plain words and
 * single or double quoted strings are accepted; any construct a shell would
 * interpret (operators, redirects, expansions, globs, env assignments,
 * comments, a leading `~`) makes the whole command untokenizable.
 */
export const tokenize = (text: string): Tokenized => {
  const argv: string[] = [];
  let word = "";
  let inWord = false;
  const flush = (): void => {
    if (inWord) argv.push(word);
    word = "";
    inWord = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (c === " " || c === "\t") {
      flush();
    } else if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end === -1) return { ok: false, detail: "unterminated quote" };
      const body = text.slice(i + 1, end);
      const hazard = quoteHazard(c, body);
      if (hazard !== null) return { ok: false, detail: hazard };
      word += body;
      inWord = true;
      i = end;
    } else {
      const operator = UNQUOTED_OPERATORS[c];
      if (operator !== undefined) return { ok: false, detail: operator };
      if (c === "#" && !inWord) return { ok: false, detail: "comment '#'" };
      if (c === "~" && !inWord) return { ok: false, detail: "tilde expansion" };
      word += c;
      inWord = true;
    }
  }
  flush();
  const first = argv[0];
  if (first === undefined) return { ok: false, detail: "empty command" };
  if (ENV_ASSIGNMENT.test(first))
    return { ok: false, detail: "environment variable assignment" };
  return { ok: true, argv };
};

const ASSIGNMENT_IN_TEXT =
  /(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|)]*)/gu;

/** Replace assignment values with a marker; returns the text and the names. */
export const omitAssignmentValues = (
  text: string,
): { text: string; names: string[] } => {
  const names: string[] = [];
  const out = text.replace(
    ASSIGNMENT_IN_TEXT,
    (_match, lead: string, name: string, value: string) => {
      if (value === "") return `${lead}${name}=`;
      names.push(name);
      return `${lead}${name}=<value omitted>`;
    },
  );
  return { text: out, names: [...new Set(names)] };
};

/** Analyse one configured command line. Never throws. */
export const commandFact = (raw: string): CommandFact => {
  const tokens = tokenize(raw);
  const { text, names } = omitAssignmentValues(raw);
  if (tokens.ok)
    return {
      text,
      omitted_assignments: names,
      argv: tokens.argv,
      issue: null,
      detail: null,
    };
  return {
    text,
    omitted_assignments: names,
    argv: null,
    issue:
      tokens.detail === "empty command" ? "empty command" : SHELL_SYNTAX_REASON,
    detail: tokens.detail,
  };
};

export type StepVerdict =
  | { ok: true }
  | { ok: false; reason: string; detail: string | null };

/**
 * Whether `fact` can be a restore step: it must have tokenized, and the
 * resulting step must pass the contract's own validator (no shell
 * interpreters or launchers, only known placeholders, allowed cwd).
 */
export const stepVerdict = (
  fact: CommandFact,
  candidate: Pick<RestoreStep, "id" | "cwd" | "scope" | "title">,
): StepVerdict => {
  if (fact.argv === null)
    return {
      ok: false,
      reason: fact.issue ?? SHELL_SYNTAX_REASON,
      detail: fact.detail,
    };
  const verdict = validateRestoreStepArguments({
    ...candidate,
    run: fact.argv,
    env_names: [],
    requires: [],
    network: "none",
  });
  return verdict.ok
    ? { ok: true }
    : { ok: false, reason: verdict.reason, detail: null };
};
