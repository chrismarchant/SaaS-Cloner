import type { ArchiveRejection } from "@rea-web/contracts";

/** The package (directory, manifest, or archive) does not satisfy the format. */
export class PackageFormatError extends Error {
  readonly reason: string;
  readonly rejection: ArchiveRejection | undefined;
  constructor(
    reason: string,
    options?: { cause?: unknown; rejection?: ArchiveRejection },
  ) {
    super(
      `invalid recovery package: ${reason}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "PackageFormatError";
    this.reason = reason;
    this.rejection = options?.rejection;
  }
}

/** Package contents on disk are not what the manifest records. */
export class IntegrityError extends Error {
  readonly paths: readonly string[];
  constructor(message: string, paths: readonly string[] = []) {
    super(message);
    this.name = "IntegrityError";
    this.paths = paths;
  }
}

/** Key material (or an encrypted output) would live inside the package. */
export class EncryptionKeyLocationError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(message);
    this.name = "EncryptionKeyLocationError";
    this.path = path;
  }
}

/** Ciphertext is malformed, truncated, tampered with, or the key is wrong. */
export class DecryptionError extends Error {
  readonly reason:
    | "bad_header"
    | "bad_key"
    | "truncated"
    | "authentication_failed";
  constructor(reason: DecryptionError["reason"], message: string) {
    super(message);
    this.name = "DecryptionError";
    this.reason = reason;
  }
}

/** Signing could not be performed or the signature material is unusable. */
export class SignatureError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SignatureError";
  }
}
