import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  DecryptionError,
  EncryptionKeyLocationError,
  PackageFormatError,
  assertKeyOutsidePackage,
  decryptExport,
  readEncryptionHeader,
  restorePackage,
  unpackExport,
  verifyPackage,
} from "@rea-web/recovery";
import { type Command, HELP, UsageError, parseCommand } from "./args.js";
import { parseEnvFile } from "./envFile.js";
import { exitCodeFor, summarize } from "./summary.js";
import { CLI_VERSION } from "./version.js";
import type { RestoreReport } from "@rea-web/contracts";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

type Env = Readonly<Record<string, string | undefined>>;

const isWithin = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}/`);

/** Real path of a file that may not exist yet: its parent is resolved. */
const realOutputPath = async (path: string): Promise<string> => {
  const abs = resolve(path);
  try {
    return await realpath(abs);
  } catch {
    return join(
      await realpath(dirname(abs)).catch(() => dirname(abs)),
      basename(abs),
    );
  }
};

async function emptyOrMissing(path: string, what: string): Promise<void> {
  try {
    if (!(await stat(path)).isDirectory())
      throw new UsageError(`${what} ${path} is not a directory`);
    if ((await readdir(path)).length > 0)
      throw new UsageError(`${what} ${path} is not empty`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const isEncrypted = async (path: string): Promise<boolean> => {
  try {
    await readEncryptionHeader(path);
    return true;
  } catch (error) {
    if (error instanceof DecryptionError && error.reason === "bad_header")
      return false;
    throw error;
  }
};

const readKey = async (keyFile: string): Promise<string> => {
  const text = (await readFile(keyFile, "utf8")).trim();
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text) as { keyBase64?: unknown };
    if (typeof parsed.keyBase64 === "string") return parsed.keyBase64;
    throw new UsageError(`${keyFile} has no keyBase64 field`);
  }
  return text;
};

/** Unpack an export (plain, or encrypted with a key file) under `outDir`. */
async function unpackAny(
  input: string,
  outDir: string,
  keyFile: string | undefined,
): Promise<string> {
  const out = resolve(outDir);
  await emptyOrMissing(out, "output directory");
  if (keyFile !== undefined) await assertKeyOutsidePackage(out, keyFile);
  let tarPath = input;
  let scratch: string | null = null;
  try {
    if (await isEncrypted(input)) {
      if (keyFile === undefined)
        throw new UsageError(
          "this export is encrypted: --key-file is required",
        );
      scratch = await mkdtemp(join(tmpdir(), "rea-recover-dec-"));
      tarPath = join(scratch, "export.tar");
      await decryptExport(input, tarPath, {
        keyBase64: await readKey(keyFile),
      });
    }
    const { root } = await unpackExport(tarPath, out);
    if (keyFile !== undefined) await assertKeyOutsidePackage(root, keyFile);
    return root;
  } finally {
    if (scratch !== null) await rm(scratch, { recursive: true, force: true });
  }
}

/** A package directory, unpacking a tar export into a private temp dir first. */
async function openPackage(
  input: string,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const info = await stat(input).catch(() => null);
  if (info === null) throw new UsageError(`${input} does not exist`);
  if (info.isDirectory())
    return { dir: input, cleanup: () => Promise.resolve() };
  const scratch = await mkdtemp(join(tmpdir(), "rea-recover-pkg-"));
  try {
    if (await isEncrypted(input))
      throw new UsageError(
        "this export is encrypted: run `rea-recover unpack` with --key-file first",
      );
    const { root } = await unpackExport(input, scratch);
    return {
      dir: root,
      cleanup: () => rm(scratch, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

async function writeReport(path: string, report: RestoreReport): Promise<void> {
  const target = resolve(path);
  const tmp = `${target}.partial-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
}

async function assertReportOutside(
  report: string | undefined,
  dir: string,
): Promise<void> {
  if (report === undefined) return;
  if (isWithin(await realpath(dir), await realOutputPath(report)))
    throw new UsageError(
      "--report must be outside the package: finalized packages are immutable",
    );
}

async function runVerify(
  cmd: Extract<Command, { kind: "verify" }>,
  io: CliIo,
): Promise<number> {
  const pkg = await openPackage(cmd.input);
  try {
    await assertReportOutside(cmd.report, pkg.dir);
    const publicKeyPem =
      cmd.publicKey === undefined
        ? undefined
        : await readFile(cmd.publicKey, "utf8");
    const report = await verifyPackage(pkg.dir, {
      verifierVersion: CLI_VERSION,
      ...(publicKeyPem === undefined ? {} : { publicKeyPem }),
      allowProduction: cmd.allowProduction,
    });
    return await finish("verify", report, cmd.report, io);
  } finally {
    await pkg.cleanup();
  }
}

async function runRestore(
  cmd: Extract<Command, { kind: "restore" }>,
  env: Env,
  io: CliIo,
): Promise<number> {
  let databaseUrl: string | undefined;
  if (cmd.databaseUrlEnv !== undefined) {
    databaseUrl = env[cmd.databaseUrlEnv];
    if (databaseUrl === undefined || databaseUrl === "")
      throw new UsageError(
        `environment variable ${cmd.databaseUrlEnv} (--database-url-env) is not set`,
      );
  }
  const stepEnv =
    cmd.envFile === undefined
      ? undefined
      : parseEnvFile(await readFile(cmd.envFile, "utf8"), cmd.envFile);
  const publicKeyPem =
    cmd.publicKey === undefined
      ? undefined
      : await readFile(cmd.publicKey, "utf8");
  const pkg = await openPackage(cmd.input);
  try {
    await assertReportOutside(cmd.report, pkg.dir);
    const hostPath = env["PATH"];
    const report = await restorePackage(pkg.dir, {
      verifierVersion: CLI_VERSION,
      scopes: cmd.scopes,
      target: cmd.target,
      allowProduction: cmd.allowProduction,
      allowNetwork: cmd.allowNetwork,
      ...(databaseUrl === undefined ? {} : { databaseUrl }),
      ...(cmd.assetsRoot === undefined ? {} : { assetsRoot: cmd.assetsRoot }),
      ...(stepEnv === undefined ? {} : { stepEnv }),
      ...(publicKeyPem === undefined ? {} : { publicKeyPem }),
      ...(cmd.report === undefined ? {} : { reportPath: cmd.report }),
      ...(cmd.timeoutMs === undefined ? {} : { stepTimeoutMs: cmd.timeoutMs }),
      ...(hostPath === undefined ? {} : { hostPath }),
    });
    return await finish("restore", report, cmd.report, io);
  } finally {
    await pkg.cleanup();
  }
}

async function finish(
  command: string,
  report: RestoreReport,
  reportPath: string | undefined,
  io: CliIo,
): Promise<number> {
  io.stdout(summarize(command, report));
  if (reportPath !== undefined) {
    await writeReport(reportPath, report);
    io.stdout(`report written to ${reportPath}\n`);
  }
  return exitCodeFor(report);
}

/** Run the CLI. Resolves to the process exit code; never throws. */
export async function runCli(
  argv: string[],
  env: Env,
  io: CliIo,
): Promise<number> {
  try {
    const cmd = parseCommand(argv);
    switch (cmd.kind) {
      case "help":
        io.stdout(HELP);
        return 0;
      case "version":
        io.stdout(`rea-recover ${CLI_VERSION}\n`);
        return 0;
      case "verify":
        return await runVerify(cmd, io);
      case "restore":
        return await runRestore(cmd, env, io);
      case "unpack": {
        const root = await unpackAny(cmd.input, cmd.out, cmd.keyFile);
        io.stdout(`unpacked to ${root}\n`);
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(
        `rea-recover: ${error.message}\nRun rea-recover --help for usage.\n`,
      );
      return 1;
    }
    if (
      error instanceof PackageFormatError ||
      error instanceof DecryptionError ||
      error instanceof EncryptionKeyLocationError
    ) {
      io.stderr(`rea-recover: ${error.message}\n`);
      return 1;
    }
    io.stderr(`rea-recover: internal error: ${(error as Error).message}\n`);
    return 1;
  }
}
