/**
 * Reading the free-form `encryption` and `signature` records of an export.
 * They are parsed with the manifest's own schemas; a record that does not
 * match is surfaced as unrecognised and shown verbatim, never guessed at.
 */
import { recoveryManifestSchema } from "@rea-web/contracts/browser";

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
