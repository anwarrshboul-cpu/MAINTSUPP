/**
 * Password hashing — Stage 20.
 *
 * WHY PBKDF2. This code runs on the Cloudflare Workers runtime, where there is
 * no `node:crypto` and no way to load a native addon. bcrypt, scrypt and argon2
 * are all therefore off the table unless we ship a WASM blob and pay to
 * instantiate it on every sign-in. PBKDF2 is available directly from WebCrypto,
 * is implemented natively by the runtime, and is still an accepted password KDF.
 * It is the strongest option the platform actually offers, which is the honest
 * reason it was chosen — not because it is the best KDF in the abstract.
 *
 * Parameters follow OWASP's Password Storage Cheat Sheet for PBKDF2-HMAC-SHA512
 * (210,000 iterations). SHA-512 rather than SHA-256 because the OWASP-equivalent
 * work factor needs roughly a third of the iterations, which matters when the
 * whole derivation has to fit inside a Worker's CPU budget.
 *
 * WHY a self-describing string. The stored value carries its own algorithm,
 * digest, iteration count and salt:
 *
 *     pbkdf2$sha512$210000$<salt base64>$<derived key base64>
 *
 * so the cost can be raised later without invalidating every existing password.
 * A hash written under the old parameters still verifies, because verification
 * reads the parameters out of the stored value rather than assuming today's
 * constants. Anything else forces a flag day where nobody can sign in.
 *
 * Nothing in this module logs, throws, or returns a password, a salt or a
 * derived key. Errors are deliberately opaque for the same reason.
 */

const ALGORITHM = "pbkdf2";
const DIGEST = "sha512";
const ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

/**
 * Length bounds.
 *
 * The minimum follows NIST SP 800-63B: length is what actually resists
 * guessing, so there are deliberately no composition rules ("one capital, one
 * symbol") — they push people towards `Password1!` and buy nothing. The maximum
 * exists purely to bound CPU: PBKDF2 cost grows with the input, and an
 * unbounded password field is a free denial-of-service on the sign-in route.
 */
const MIN_LENGTH = 12;
const MAX_LENGTH = 200;

/**
 * A tiny blocklist, in the spirit of 800-63B's "check against known-bad".
 *
 * Not a substitute for a real breach corpus — it is a floor, and it is honest
 * about being one. It catches the handful of strings people actually reach for
 * when a form tells them twelve characters.
 */
const BLOCKED = new Set([
  "password1234",
  "passwordpassword",
  "123456789012",
  "qwertyuiop12",
  "administrator",
  "maintsupp123",
  "letmeinletmein",
  "welcome12345",
]);

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function digestName(digest: string) {
  return digest === "sha256" ? "SHA-256" : "SHA-512";
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
  digest: string,
  bits: number,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations,
      hash: digestName(digest),
    },
    key,
    bits,
  );
  return new Uint8Array(derived);
}

/**
 * Compares two derived keys without leaking where they first differ.
 *
 * A `===` on the base64 strings would return as soon as it found a mismatched
 * byte, and the time it took to do so is a measurable oracle: an attacker can
 * grind out the correct prefix one byte at a time. Every byte is examined here
 * regardless of the result. The length check ahead of it is safe because the
 * key length is a public parameter of the format, not a secret.
 */
function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

type ParsedHash = {
  iterations: number;
  digest: string;
  salt: Uint8Array;
  key: Uint8Array;
};

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 5) return null;
  const [algorithm, digest, iterations, salt, key] = parts;
  if (algorithm !== ALGORITHM) return null;
  if (digest !== "sha512" && digest !== "sha256") return null;
  const rounds = Number.parseInt(iterations, 10);
  if (!Number.isInteger(rounds) || rounds < 1000 || rounds > 5_000_000) {
    return null;
  }
  try {
    return {
      iterations: rounds,
      digest,
      salt: fromBase64(salt),
      key: fromBase64(key),
    };
  } catch {
    return null;
  }
}

/**
 * A syntactically valid hash of nothing in particular.
 *
 * Used when the account does not exist, has no password set, or has a corrupt
 * hash. Without it those cases would return in microseconds while a real
 * account spent 210,000 iterations failing — and that difference is a working
 * account-enumeration oracle, no matter how carefully the *response body* is
 * worded. Verification therefore always does the full derivation, against this
 * decoy when there is nothing real to check. The bytes are random and match no
 * password; they are not a credential.
 */
const DECOY_HASH = `${ALGORITHM}$${DIGEST}$${ITERATIONS}$Zx6/wQgzfF9PrIPZUyHxDg==$q5M4bvq0ZGdB/G7hqIDoSDI1zGmDsAFwAs7z2CCH+v8=`;

/** Hashes a password for storage. Never call this on a value you also log. */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const key = await derive(password, salt, ITERATIONS, DIGEST, KEY_BITS);
  return `${ALGORITHM}$${DIGEST}$${ITERATIONS}$${toBase64(salt)}$${toBase64(key)}`;
}

/**
 * True when `password` produced `stored`.
 *
 * `stored` is allowed to be null or malformed precisely so that callers do not
 * have to branch on "does this account exist" before checking a password — that
 * branch is exactly what leaks. A missing or unparseable hash burns the same
 * work against the decoy and returns false.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  const usable = typeof stored === "string" && stored.length > 0;
  const parsed = (usable ? parseHash(stored) : null) ?? parseHash(DECOY_HASH);
  // parseHash(DECOY_HASH) is a compile-time-known good value; the guard is for
  // the type checker rather than for a case that can actually happen.
  if (!parsed) return false;

  const candidate = await derive(
    password,
    parsed.salt,
    parsed.iterations,
    parsed.digest,
    parsed.key.length * 8,
  );
  const matches = constantTimeEqual(candidate, parsed.key);

  // The decoy can never legitimately match, so falling through with `matches`
  // would be equivalent — this is belt and braces against a future edit that
  // makes the decoy reachable some other way.
  return usable && matches;
}

/**
 * True when a stored hash was written under weaker parameters than today's.
 *
 * Lets a successful sign-in transparently upgrade the stored hash — the only
 * moment the plaintext is available to re-derive from.
 */
export function needsRehash(stored: string | null | undefined): boolean {
  if (typeof stored !== "string" || !stored.length) return true;
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return parsed.digest !== DIGEST || parsed.iterations < ITERATIONS;
}

/**
 * Why this password is unacceptable, or null when it is fine.
 *
 * Returns a message meant to be shown to the person choosing the password. It
 * is only ever used on *their own* password, never during sign-in, so it leaks
 * nothing about anybody else's account.
 */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || !password.length) {
    return "Choose a password.";
  }
  if (password.length < MIN_LENGTH) {
    return `Use at least ${MIN_LENGTH} characters. Length matters more than symbols.`;
  }
  if (password.length > MAX_LENGTH) {
    return `Keep the password under ${MAX_LENGTH} characters.`;
  }
  if (password.trim().length < MIN_LENGTH) {
    return "A password cannot be mostly spaces.";
  }
  if (BLOCKED.has(password.toLowerCase())) {
    return "That password is too easy to guess. Choose another.";
  }
  if (new Set(password).size < 5) {
    return "Use a wider mix of characters.";
  }
  return null;
}

export const PASSWORD_MIN_LENGTH = MIN_LENGTH;
