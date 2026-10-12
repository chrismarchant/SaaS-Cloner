import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DecryptionError, EncryptionKeyLocationError } from "./errors.js";
import {
  MANIFEST_FILE,
  O_NOFOLLOW,
  canonicalize,
  isInsideOrEqual,
  sha256Hex,
  tempSibling,
} from "./fsutil.js";
import { RECOVERY_FORMAT } from "@rea-web/contracts";

export const ENCRYPTION_MAGIC = "rea-web-enc" as const;
export const ENCRYPTION_SCHEME = "aes-256-gcm-envelope" as const;
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const TAG_BYTES = 16;
const IV_BYTES = 12;
const IV_MODULUS = 1n << 96n;

export interface RecoveryKey {
  keyBase64: string;
  keyId: string;
  /** Where the caller keeps this key; checked against the package root. */
  keyPath?: string;
}

export interface EncryptionHeader {
  magic: typeof ENCRYPTION_MAGIC;
  version: 1;
  scheme: typeof ENCRYPTION_SCHEME;
  key_id: string;
  chunk_size: number;
  /** Base IV, base64; chunk i uses base IV + i (mod 2^96). */
  iv: string;
  recipients: string[];
}

const keyIdOf = (key: Buffer): string => sha256Hex(key).slice(0, 16);

export function generateRecoveryKey(): { keyBase64: string; keyId: string } {
  const key = randomBytes(32);
  return { keyBase64: key.toString("base64"), keyId: keyIdOf(key) };
}

const decodeKey = (keyBase64: string): Buffer | undefined => {
  const key = Buffer.from(keyBase64, "base64");
  return key.length === 32 && key.toString("base64") === keyBase64.trim()
    ? key
    : undefined;
};

/** Nearest ancestor (or self) of `path` that is a recovery package root. */
async function findEnclosingPackageRoot(path: string): Promise<string | null> {
  let dir = dirname(await canonicalize(path));
  for (;;) {
    try {
      const manifest = resolve(dir, MANIFEST_FILE);
      const info = await stat(manifest);
      if (info.isFile() && info.size < 64 * 1024 * 1024) {
        const parsed = JSON.parse(await readFile(manifest, "utf8")) as {
          format?: unknown;
        };
        if (parsed.format === RECOVERY_FORMAT) return dir;
      }
    } catch {
      // not a package root; keep climbing
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Throws unless `keyPath` (or any output path) lies outside the package root. */
export async function assertKeyOutsidePackage(
  root: string,
  keyPath: string,
): Promise<void> {
  const [realRoot, realKey] = await Promise.all([
    canonicalize(root),
    canonicalize(keyPath),
  ]);
  if (isInsideOrEqual(realRoot, realKey))
    throw new EncryptionKeyLocationError(
      `${keyPath} is inside the package root ${root}; recovery keys must be stored outside the package`,
      keyPath,
    );
}

export interface EncryptOptions {
  /** Package root to guard; enclosing packages are also auto-detected. */
  packageRoot?: string;
  /** Additional key material locations to check. */
  keyPaths?: readonly string[];
  chunkSize?: number;
}

export interface EncryptionResult {
  path: string;
  size: number;
  sha256: string;
}

const ivFor = (base: Buffer, counter: number): Buffer => {
  const value =
    (BigInt(`0x${base.toString("hex")}`) + BigInt(counter)) % IV_MODULUS;
  return Buffer.from(value.toString(16).padStart(IV_BYTES * 2, "0"), "hex");
};

const aadFor = (
  headerHash: Buffer,
  counter: number,
  final: boolean,
): Buffer => {
  const aad = Buffer.alloc(headerHash.length + 9);
  headerHash.copy(aad);
  aad.writeBigUInt64BE(BigInt(counter), headerHash.length);
  aad.writeUInt8(final ? 1 : 0, headerHash.length + 8);
  return aad;
};

async function readBlock(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      length - filled,
      position + filled,
    );
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}

class HashingWriter {
  private position = 0;
  private readonly hash = createHash("sha256");
  constructor(private readonly handle: FileHandle) {}
  async write(data: Buffer): Promise<void> {
    this.hash.update(data);
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await this.handle.write(
        data,
        offset,
        data.length - offset,
        this.position + offset,
      );
      offset += bytesWritten;
    }
    this.position += data.length;
  }
  get size(): number {
    return this.position;
  }
  digest(): string {
    return this.hash.digest("hex");
  }
}

async function guardLocations(
  outPath: string,
  key: RecoveryKey,
  opts: EncryptOptions,
): Promise<void> {
  const roots = new Set<string>();
  if (opts.packageRoot !== undefined) roots.add(resolve(opts.packageRoot));
  const enclosing = await findEnclosingPackageRoot(outPath);
  if (enclosing !== null) roots.add(enclosing);
  const keyPaths = [key.keyPath, ...(opts.keyPaths ?? [])].filter(
    (p): p is string => p !== undefined,
  );
  for (const root of roots) {
    await assertKeyOutsidePackage(root, outPath);
    for (const keyPath of keyPaths)
      await assertKeyOutsidePackage(root, keyPath);
  }
  for (const keyPath of keyPaths) {
    const keyRoot = await findEnclosingPackageRoot(keyPath);
    if (keyRoot !== null) await assertKeyOutsidePackage(keyRoot, keyPath);
  }
}

/**
 * Chunked AES-256-GCM. Output: one header JSON line, then for each chunk the
 * ciphertext followed by its 16-byte tag. Every chunk is authenticated with
 * the header digest, its index and a final-chunk flag as AAD, so truncation,
 * reordering and header substitution are all detected.
 */
export async function encryptExport(
  tarPath: string,
  outPath: string,
  key: RecoveryKey,
  opts: EncryptOptions = {},
): Promise<EncryptionResult & { header: EncryptionHeader }> {
  const rawKey = decodeKey(key.keyBase64);
  if (rawKey === undefined || keyIdOf(rawKey) !== key.keyId)
    throw new RangeError("recovery key must be 32 base64 bytes matching keyId");
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (
    !Number.isInteger(chunkSize) ||
    chunkSize < 1 ||
    chunkSize > MAX_CHUNK_SIZE
  )
    throw new RangeError("chunkSize out of range");
  const out = resolve(outPath);
  await guardLocations(out, key, opts);

  const baseIv = randomBytes(IV_BYTES);
  const header: EncryptionHeader = {
    magic: ENCRYPTION_MAGIC,
    version: 1,
    scheme: ENCRYPTION_SCHEME,
    key_id: key.keyId,
    chunk_size: chunkSize,
    iv: baseIv.toString("base64"),
    recipients: [key.keyId],
  };
  const headerJson = JSON.stringify(header);
  const headerHash = createHash("sha256").update(headerJson).digest();

  await mkdir(dirname(out), { recursive: true });
  const tmp = tempSibling(out);
  const input = await open(tarPath, fsConstants.O_RDONLY | O_NOFOLLOW);
  let output: FileHandle | undefined;
  try {
    output = await open(tmp, "wx", 0o600);
    const writer = new HashingWriter(output);
    await writer.write(Buffer.from(`${headerJson}\n`, "utf8"));
    let position = 0;
    let current = await readBlock(input, position, chunkSize);
    for (let index = 0; ; index += 1) {
      position += current.length;
      const next =
        current.length === chunkSize
          ? await readBlock(input, position, chunkSize)
          : Buffer.alloc(0);
      const final = next.length === 0;
      const cipher = createCipheriv(
        "aes-256-gcm",
        rawKey,
        ivFor(baseIv, index),
        {
          authTagLength: TAG_BYTES,
        },
      );
      cipher.setAAD(aadFor(headerHash, index, final));
      const body = Buffer.concat([cipher.update(current), cipher.final()]);
      await writer.write(Buffer.concat([body, cipher.getAuthTag()]));
      if (final) break;
      current = next;
    }
    await output.close();
    output = undefined;
    await rename(tmp, out);
    return { path: out, size: writer.size, sha256: writer.digest(), header };
  } catch (error) {
    await output?.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw error;
  } finally {
    await input.close();
  }
}

const fail = (reason: DecryptionError["reason"], message: string): never => {
  throw new DecryptionError(reason, message);
};

const parseHeader = (line: string): EncryptionHeader => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return fail("bad_header", "encryption header is not valid JSON");
  }
  const h = value as Partial<EncryptionHeader> | null;
  if (
    h === null ||
    typeof h !== "object" ||
    h.magic !== ENCRYPTION_MAGIC ||
    h.version !== 1 ||
    h.scheme !== ENCRYPTION_SCHEME ||
    typeof h.key_id !== "string" ||
    typeof h.iv !== "string" ||
    Buffer.from(h.iv, "base64").length !== IV_BYTES ||
    !Number.isInteger(h.chunk_size) ||
    (h.chunk_size ?? 0) < 1 ||
    (h.chunk_size ?? 0) > MAX_CHUNK_SIZE ||
    !Array.isArray(h.recipients) ||
    !h.recipients.every((r) => typeof r === "string")
  )
    return fail("bad_header", "unrecognised or invalid encryption header");
  return h as EncryptionHeader;
};

async function readHeader(
  handle: FileHandle,
): Promise<{ header: EncryptionHeader; json: string; length: number }> {
  const head = await readBlock(handle, 0, MAX_HEADER_BYTES + 1);
  const newline = head.indexOf(0x0a);
  if (newline < 0 || newline > MAX_HEADER_BYTES)
    return fail("bad_header", "encryption header line not found");
  const json = head.subarray(0, newline).toString("utf8");
  return { header: parseHeader(json), json, length: newline + 1 };
}

/** Read only the (unauthenticated) header of an encrypted export. */
export async function readEncryptionHeader(
  encPath: string,
): Promise<EncryptionHeader> {
  const handle = await open(encPath, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    return (await readHeader(handle)).header;
  } finally {
    await handle.close();
  }
}

export async function decryptExport(
  encPath: string,
  outPath: string,
  key: { keyBase64: string },
): Promise<EncryptionResult> {
  const rawKey = decodeKey(key.keyBase64);
  if (rawKey === undefined)
    return fail("bad_key", "recovery key must be 32 base64 bytes");
  const out = resolve(outPath);
  const input = await open(encPath, fsConstants.O_RDONLY | O_NOFOLLOW);
  const tmp = tempSibling(out);
  let output: FileHandle | undefined;
  try {
    const { header, json, length } = await readHeader(input);
    if (header.key_id !== keyIdOf(rawKey))
      fail("bad_key", "key does not match the key id in the encrypted export");
    const headerHash = createHash("sha256").update(json).digest();
    const baseIv = Buffer.from(header.iv, "base64");
    const blockSize = header.chunk_size + TAG_BYTES;
    const total = (await input.stat()).size - length;
    if (total < TAG_BYTES)
      fail("truncated", "encrypted export has no complete chunk");
    const blocks = Math.ceil(total / blockSize);

    await mkdir(dirname(out), { recursive: true });
    output = await open(tmp, "wx", 0o600);
    const writer = new HashingWriter(output);
    for (let index = 0; index < blocks; index += 1) {
      const final = index === blocks - 1;
      const block = await readBlock(
        input,
        length + index * blockSize,
        blockSize,
      );
      if (block.length < TAG_BYTES)
        fail("truncated", "encrypted export ends inside a chunk tag");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        rawKey,
        ivFor(baseIv, index),
        {
          authTagLength: TAG_BYTES,
        },
      );
      decipher.setAAD(aadFor(headerHash, index, final));
      decipher.setAuthTag(block.subarray(block.length - TAG_BYTES));
      let plain: Buffer;
      try {
        plain = Buffer.concat([
          decipher.update(block.subarray(0, block.length - TAG_BYTES)),
          decipher.final(),
        ]);
      } catch {
        return fail(
          "authentication_failed",
          `chunk ${index} failed authentication (tampered, truncated, reordered or wrong key)`,
        );
      }
      await writer.write(plain);
    }
    await output.close();
    output = undefined;
    await rename(tmp, out);
    return { path: out, size: writer.size, sha256: writer.digest() };
  } catch (error) {
    await output?.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw error;
  } finally {
    await input.close();
  }
}
