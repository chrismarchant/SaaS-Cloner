import { pino, type DestinationStream, type Logger } from "pino";
import { REDACTED, type Redactor } from "@rea-web/contracts";

export interface LoggerOptions {
  readonly level: string;
  readonly redactor: Redactor;
  /** Defaults to stdout. Receives already-redacted newline-delimited JSON. */
  readonly destination?: { write(line: string): unknown };
}

/** Header and field paths that carry transport credentials. */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  "headers.authorization",
  "headers.cookie",
];

/** Redact parsed fields so the output stays valid JSON; fall back to text. */
const scrubLine = (redactor: Redactor, line: string): string => {
  try {
    const parsed: unknown = JSON.parse(line);
    return `${JSON.stringify(redactor.redactValue(parsed))}\n`;
  } catch {
    return redactor.redactText(line);
  }
};

/**
 * pino logger whose output passes through the configured redactor line by
 * line. Header paths are censored structurally, and the final serialised line
 * is scrubbed of configured secret values and transport credentials, so a
 * secret that reaches any field (URL, message, error text) is still removed.
 */
export const createLogger = (options: LoggerOptions): Logger => {
  const sink = options.destination ?? process.stdout;
  const stream: DestinationStream = {
    write(line: string) {
      sink.write(scrubLine(options.redactor, line));
    },
  };
  return pino(
    {
      level: options.level,
      redact: { paths: REDACT_PATHS, censor: REDACTED },
    },
    stream,
  );
};
