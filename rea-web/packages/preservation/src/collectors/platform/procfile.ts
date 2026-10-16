import { type CommandFact, commandFact } from "./command.js";
import {
  type Extraction,
  type ExtractInput,
  emptyExtraction,
  serviceName,
} from "./types.js";

export interface ProcfileEntry {
  process_type: string;
  line_number: number;
  /** The line exactly as written (without its line ending). */
  original_line: string;
  command: CommandFact;
}

export type ProcfileResult =
  | { ok: true; entries: ProcfileEntry[] }
  | { ok: false; error: string };

const LINE = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/u;

/** Heroku-style Procfile: `<process type>: <command>`, blank lines and `#` comments. */
export const parseProcfile = (text: string): ProcfileResult => {
  const entries: ProcfileEntry[] = [];
  const lines = text.replace(/^﻿/u, "").split(/\r?\n/u);
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const m = LINE.exec(line);
    const command = m?.[2]?.trim() ?? "";
    const type = m?.[1];
    if (type === undefined || command === "")
      return {
        ok: false,
        error: `invalid Procfile at line ${i + 1}: expected '<process type>: <command>'`,
      };
    if (entries.some((e) => e.process_type === type))
      return {
        ok: false,
        error: `invalid Procfile at line ${i + 1}: process type declared twice`,
      };
    entries.push({
      process_type: type,
      line_number: i + 1,
      original_line: line,
      command: commandFact(command),
    });
  }
  return { ok: true, entries };
};

const kindOf = (type: string): string =>
  type === "web" || type === "release" ? type : "worker";

export function extractProcfile(input: ExtractInput): Extraction {
  const out = emptyExtraction();
  const entries = input.doc as ProcfileEntry[];
  out.parsed = { processes: entries };
  for (const e of entries)
    out.services.push({
      name:
        input.dir === ""
          ? e.process_type
          : `${serviceName("procfile", input.dir)}:${e.process_type}`,
      kind: kindOf(e.process_type),
      build_command: null,
      start_command: e.command,
      dir: input.dir,
      health_check: null,
      region: null,
      regions: [],
      volumes: [],
      depends_on: [],
      settings: { process_type: e.process_type, line_number: e.line_number },
    });
  return out;
}
