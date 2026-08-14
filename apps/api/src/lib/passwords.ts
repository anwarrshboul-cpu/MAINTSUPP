import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/*
 * scrypt, from node:crypto — no native module to compile and nothing to install.
 *
 * Chosen over PBKDF2 (what the legacy app used, at 210,000 iterations) because
 * scrypt is memory-hard: an attacker with GPUs gains far less against it, since
 * the cost is RAM rather than arithmetic. Chosen over argon2/bcrypt because both
 * are native addons, and a native build step is a deployment failure waiting to
 * happen on a platform whose image you do not control.
 *
 * N=2^15 with r=8 is ~32MB per hash and lands around 100ms on a small Railway
 * instance — slow enough to matter to an attacker, fast enough that a sign-in
 * does not feel broken. `maxmem` must be raised explicitly or Node refuses N
 * this large with a confusing "invalid params" error.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

/** `scrypt$N$r$p$salt$hash`, all base64url. Self-describing on purpose. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, PARAMS);
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

/**
 * Verifies a password against a stored hash.
 *
 * The parameters are read back out of the stored string rather than taken from
 * the constants above, so raising the cost later does not lock out every
 * existing account — old hashes keep verifying at their original settings.
 *
 * A null or malformed hash returns false. That is the case of an invited user
 * who has not set a password yet: "no password" must never verify as "any
 * password", which is what a bare `if (!stored) return true`-shaped mistake
 * would produce.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(hashB64, "base64url");
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: PARAMS.maxmem,
    });
  } catch {
    // Absurd stored parameters would otherwise throw and 500 the sign-in.
    return false;
  }

  // Constant-time: a plain `===` leaks how many leading bytes matched through
  // its timing, which is enough to reconstruct a hash byte by byte.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Whether a stored hash was made with weaker parameters than we now use, so a
 * successful sign-in can transparently upgrade it.
 */
export function needsRehash(stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number(parts[1]) < PARAMS.N || Number(parts[2]) < PARAMS.r;
}

/**
 * The password rules, in one place.
 *
 * A length floor and nothing else. Composition rules ("one capital, one
 * symbol") measurably push people towards `Password1!` and were dropped from
 * the NIST guidance for that reason; length is what actually costs an attacker.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return "Use a password of at least 10 characters.";
  if (password.length > 200) return "That password is too long.";
  return null;
}
