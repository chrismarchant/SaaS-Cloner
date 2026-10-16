import { parseArgs } from "node:util";

export type Command =
  | {
      kind: "verify";
      input: string;
      publicKey: string | undefined;
      archiveSignature: string | undefined;
      archiveKey: string | undefined;
      report: string | undefined;
      allowProduction: boolean;
    }
  | {
      kind: "restore";
      input: string;
      scopes: ("clean_build" | "data_restore" | "behavior")[];
      target: string;
      databaseUrlEnv: string | undefined;
      assetsRoot: string | undefined;
      allowNetwork: ("registry" | "unknown")[];
      envFile: string | undefined;
      publicKey: string | undefined;
      archiveSignature: string | undefined;
      archiveKey: string | undefined;
      report: string | undefined;
      timeoutMs: number | undefined;
      allowProduction: boolean;
    }
  | {
      kind: "unpack";
      input: string;
      out: string;
      keyFile: string | undefined;
      archiveSignature: string | undefined;
      archiveKey: string | undefined;
    }
  | { kind: "help" }
  | { kind: "version" };

export class UsageError extends Error {}

const SCOPES = ["clean_build", "data_restore", "behavior"] as const;
const NETWORKS = ["registry", "unknown"] as const;

const list = <T extends string>(
  raw: string,
  allowed: readonly T[],
  flag: string,
): T[] => {
  const out: T[] = [];
  for (const part of raw.split(",").map((p) => p.trim())) {
    if (part === "") continue;
    const match = allowed.find((a) => a === part);
    if (match === undefined)
      throw new UsageError(
        `${flag}: unknown value "${part}" (expected ${allowed.join(", ")})`,
      );
    if (!out.includes(match)) out.push(match);
  }
  return out;
};

const one = (positionals: string[], what: string): string => {
  const [first, ...rest] = positionals;
  if (first === undefined) throw new UsageError(`missing ${what}`);
  if (rest.length > 0)
    throw new UsageError(`unexpected argument ${JSON.stringify(rest[0])}`);
  return first;
};

const parse = (
  args: string[],
  options: NonNullable<Parameters<typeof parseArgs>[0]>["options"],
): {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
} => {
  try {
    const r = parseArgs({
      args,
      options,
      allowPositionals: true,
      strict: true,
    });
    return {
      values: r.values as Record<string, string | boolean | undefined>,
      positionals: r.positionals,
    };
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
};

const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

/** Parse argv (without `node` and the script). Throws UsageError. */
export function parseCommand(argv: string[]): Command {
  const [name, ...rest] = argv;
  if (
    name === undefined ||
    name === "--help" ||
    name === "-h" ||
    name === "help"
  )
    return { kind: "help" };
  if (name === "--version" || name === "-V" || name === "version")
    return { kind: "version" };
  if (rest.includes("--help") || rest.includes("-h")) return { kind: "help" };
  switch (name) {
    case "verify": {
      const { values, positionals } = parse(rest, {
        "public-key": { type: "string" },
        "archive-signature": { type: "string" },
        "archive-key": { type: "string" },
        report: { type: "string" },
        "allow-production": { type: "boolean" },
      });
      return {
        kind: "verify",
        input: one(positionals, "package directory or export tar"),
        publicKey: str(values["public-key"]),
        archiveSignature: str(values["archive-signature"]),
        archiveKey: str(values["archive-key"]),
        report: str(values["report"]),
        allowProduction: values["allow-production"] === true,
      };
    }
    case "restore": {
      const { values, positionals } = parse(rest, {
        scope: { type: "string" },
        target: { type: "string" },
        "database-url-env": { type: "string" },
        "assets-root": { type: "string" },
        "allow-network": { type: "string" },
        "env-file": { type: "string" },
        "public-key": { type: "string" },
        "archive-signature": { type: "string" },
        "archive-key": { type: "string" },
        report: { type: "string" },
        "timeout-ms": { type: "string" },
        "allow-production": { type: "boolean" },
      });
      const scope = str(values["scope"]);
      if (scope === undefined) throw new UsageError("--scope is required");
      const scopes = list(scope, SCOPES, "--scope");
      if (scopes.length === 0) throw new UsageError("--scope names no scope");
      const target = str(values["target"]);
      if (target === undefined) throw new UsageError("--target is required");
      const timeoutRaw = str(values["timeout-ms"]);
      const timeoutMs =
        timeoutRaw === undefined ? undefined : Number(timeoutRaw);
      if (
        timeoutMs !== undefined &&
        (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
      )
        throw new UsageError("--timeout-ms must be a positive integer");
      return {
        kind: "restore",
        input: one(positionals, "package directory or export tar"),
        scopes,
        target,
        databaseUrlEnv: str(values["database-url-env"]),
        assetsRoot: str(values["assets-root"]),
        allowNetwork: list(
          str(values["allow-network"]) ?? "",
          NETWORKS,
          "--allow-network",
        ),
        envFile: str(values["env-file"]),
        publicKey: str(values["public-key"]),
        archiveSignature: str(values["archive-signature"]),
        archiveKey: str(values["archive-key"]),
        report: str(values["report"]),
        timeoutMs,
        allowProduction: values["allow-production"] === true,
      };
    }
    case "unpack": {
      const { values, positionals } = parse(rest, {
        out: { type: "string" },
        "key-file": { type: "string" },
        "archive-signature": { type: "string" },
        "archive-key": { type: "string" },
      });
      const out = str(values["out"]);
      if (out === undefined) throw new UsageError("--out is required");
      return {
        kind: "unpack",
        input: one(positionals, "export file"),
        out,
        keyFile: str(values["key-file"]),
        archiveSignature: str(values["archive-signature"]),
        archiveKey: str(values["archive-key"]),
      };
    }
    default:
      throw new UsageError(`unknown command ${JSON.stringify(name)}`);
  }
}

export const HELP = `rea-recover: verify and restore a REA Web recovery package without the control plane

Usage:
  rea-recover verify <package-dir|export.tar> [--public-key <file>] [--archive-signature <file> --archive-key <public.pem>] [--report <file>]
  rea-recover restore <package-dir|export.tar> --scope clean_build[,data_restore,behavior]
                      --target <empty-dir> [--database-url-env NAME] [--assets-root <dir>]
                      [--allow-network registry[,unknown]] [--env-file <file>]
                      [--public-key <file>] [--archive-signature <file> --archive-key <public.pem>] [--report <file>] [--timeout-ms N]
  rea-recover unpack <export.tar|export.tar.enc> --out <empty-dir> [--key-file <file>]
                     [--archive-signature <file> --archive-key <public.pem>]
  rea-recover --version | --help

verify checks every file hash, the manifest and (with --public-key) the signature.
--archive-signature checks a detached export signature (rea-web-export-signature)
against the archive file exactly as given, before anything is unpacked, with
the signer's public key in --archive-key (--public-key is the manifest
signature key). A signature that does not verify exits 3.
restore verifies first, then replays the declared restore steps into the empty
--target directory and, for data_restore, an empty disposable database whose URL
is read from the environment variable named by --database-url-env.
--allow-production is accepted and refused: verification never touches production.

Exit codes: 0 verified, 2 failed, 3 blocked, 4 partial, 1 usage or internal error.
`;
