import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 16_384;
const R = 8;
const P = 1;
const KEY_BYTES = 64;

const derive = (
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      KEY_BYTES,
      { N: n, r, p, maxmem: 128 * n * r * 2 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });

/** `scrypt$N$r$p$salt$hash` with a random 16 byte salt (base64url fields). */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
};

export const verifyPassword = async (
  password: string,
  stored: string,
): Promise<boolean> => {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const params = [Number(n), Number(r), Number(p)] as const;
  if (params.some((v) => !Number.isInteger(v) || v <= 0)) return false;
  // Refuse parameters that would let a hostile row exhaust memory.
  if (params[0] > 1 << 20) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await derive(
    password,
    Buffer.from(salt, "base64url"),
    params[0],
    params[1],
    params[2],
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

let dummyHash: Promise<string> | undefined;

/**
 * Verifies against a throwaway hash so a login for an unknown email costs the
 * same as one for a known email.
 */
export const burnPasswordWork = async (password: string): Promise<void> => {
  dummyHash ??= hashPassword(randomBytes(12).toString("hex"));
  await verifyPassword(password, await dummyHash);
};
