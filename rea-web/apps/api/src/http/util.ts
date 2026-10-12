import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const sha256Hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

/** Deterministic JSON: object keys sorted recursively, `undefined` dropped. */
export const canonicalJson = (value: unknown): string => {
  if (value === undefined) return "null";
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const randomToken = (prefix: string, bytes = 32): string =>
  `${prefix}${randomBytes(bytes).toString("base64url")}`;

export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * AES-256-GCM envelope for values stored at rest that may contain freshly
 * issued credentials (idempotent replays of token-bearing responses). The key
 * is derived from the deployment's session secret.
 */
export interface Sealer {
  seal(plaintext: string): string;
  open(sealed: string): string | null;
}

export const createSealer = (secret: string, purpose: string): Sealer => {
  const key = createHash("sha256").update(`${purpose}\0${secret}`).digest();
  return {
    seal(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString(
        "base64url",
      );
    },
    open(sealed) {
      try {
        const raw = Buffer.from(sealed, "base64url");
        if (raw.length < 28) return null;
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          raw.subarray(0, 12),
        );
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([
          decipher.update(raw.subarray(28)),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        return null;
      }
    },
  };
};
