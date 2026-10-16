/**
 * Reading the free-form `encryption` and `signature` records of an export.
 * They are parsed with the manifest's own schemas; a record that does not
 * match is surfaced as unrecognised and shown verbatim, never guessed at.
 */
import {
  exportSignatureSummarySchema,
  recoveryManifestSchema,
} from "@rea-web/contracts/browser";

export type EncryptionView =
  | { readonly state: "plain" }
  | {
      readonly state: "encrypted";
      readonly scheme: string;
      readonly recipients: readonly string[];
      readonly keyLocation: string;
    }
  | { readonly state: "unrecognised"; readonly raw: Record<string, unknown> };

export const readEncryption = (
  value: Record<string, unknown> | null,
): EncryptionView => {
  if (value === null) return { state: "plain" };
  const parsed = recoveryManifestSchema.shape.encryption.safeParse(value);
  if (parsed.success && parsed.data !== undefined)
    return {
      state: "encrypted",
      scheme: parsed.data.scheme,
      recipients: parsed.data.recipients,
      keyLocation: parsed.data.key_location,
    };
  return { state: "unrecognised", raw: value };
};

/** Recipient key ids typed one per line or separated by commas or spaces. */
export const parseRecipients = (text: string): string[] => [
  ...new Set(text.split(/[\s,]+/u).filter((id) => id !== "")),
];

export type SignatureView =
  | { readonly state: "unsigned" }
  | {
      readonly state: "signed";
      readonly algorithm: string;
      readonly publicKeyId: string;
      readonly archiveSha256: string;
      readonly signedAt: string;
      /** Whether the signed digest is the archive digest the API recorded. */
      readonly signsRecordedArchive: boolean | null;
    }
  | { readonly state: "unrecognised"; readonly raw: Record<string, unknown> };

/** The runner's signature summary, read with the contract schema; unknown shapes are shown as stored. */
export const readSignature = (
  value: Record<string, unknown> | null,
  recordedArchiveSha256: string | null,
): SignatureView => {
  if (value === null) return { state: "unsigned" };
  const parsed = exportSignatureSummarySchema.safeParse(value);
  if (!parsed.success) return { state: "unrecognised", raw: value };
  return {
    state: "signed",
    algorithm: parsed.data.algorithm,
    publicKeyId: parsed.data.public_key_id,
    archiveSha256: parsed.data.archive_sha256,
    signedAt: parsed.data.signed_at,
    signsRecordedArchive:
      recordedArchiveSha256 === null
        ? null
        : parsed.data.archive_sha256 === recordedArchiveSha256,
  };
};

/** Public key ids are the sha256 of the key: 64 lowercase hex characters. */
export const SIGNING_KEY_ID = /^[0-9a-f]{64}$/u;

/** Arguments only; the operator supplies the downloaded archive, signature and public key. */
export const VERIFY_ARCHIVE_COMMAND =
  "rea-recover verify <archive> --archive-signature <sig.json> --archive-key <public.pem>";
