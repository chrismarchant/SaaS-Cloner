export const PACKAGE_NAME = "@rea-web/recovery";

export {
  DecryptionError,
  EncryptionKeyLocationError,
  IntegrityError,
  PackageFormatError,
  SignatureError,
} from "./errors.js";
export {
  type ComponentInput,
  type FileBody,
  type FileOptions,
  type FinalizeMeta,
  type PackageBuilder,
  createPackageBuilder,
} from "./builder.js";
export { PACKAGE_COMPONENT_ID } from "./layout.js";
export { renderRecoveryMarkdown } from "./markdown.js";
export {
  generatedFileContents,
  materializeGeneratedFiles,
  writeGeneratedFiles,
} from "./generated.js";
export {
  type IntegrityReport,
  type VerifyIntegrityOptions,
  readPackage,
  verifyIntegrity,
} from "./read.js";
export { type ExportResult, packExport, unpackExport } from "./archive.js";
export {
  type SigningKeyPair,
  generateSigningKeyPair,
  signManifest,
  verifySignature,
} from "./signing.js";
export {
  type EncryptOptions,
  type EncryptionHeader,
  type EncryptionResult,
  type RecoveryKey,
  ENCRYPTION_MAGIC,
  ENCRYPTION_SCHEME,
  DEFAULT_CHUNK_SIZE,
  assertKeyOutsidePackage,
  decryptExport,
  encryptExport,
  generateRecoveryKey,
  readEncryptionHeader,
} from "./encryption.js";
export {
  type RestoreOptions,
  type RestoreScope,
  type VerifyOptions,
  restorePackage,
  verifyPackage,
} from "./verify/index.js";
