/**
 * §35 — THE SECRET BOX: how this product stores a credential it must be able
 * to use again (a webhook signing secret, a Slack or Zapier URL), as opposed to
 * one it only has to recognise (a password, a session, an API token), which is
 * hashed and never recoverable.
 *
 * Owner decision Q2: build the architecture, add NO key to any deployment. So
 * the key is read from `MAINTSUPP_SECRETS_KEY` and, while it is absent, every
 * feature that needs the box says "not configured" in words and refuses to
 * store anything — never a plaintext fallback, never a key invented at runtime
 * (which would be lost on the next cold start along with everything sealed
 * under it).
 *
 *   MAINTSUPP_SECRETS_KEY           base64 of exactly 32 random bytes.
 *                                   `openssl rand -base64 32`
 *   MAINTSUPP_SECRETS_KEY_PREVIOUS  optional; OPENS only, so a key can be
 *                                   rotated without breaking what is sealed.
 *
 * AES-256-GCM through WebCrypto — the same code in Node and the Workers runtime,
 * no `node:crypto`. The data key is derived with HKDF from the configured key,
 * so the raw environment value is never itself a cipher key.
 *
 * THE ENVELOPE: `msb1.<kid>.<iv>.<ciphertext+tag>` (base64url). `kid` names the
 * key that sealed it, so the right key is chosen on open and a value sealed
 * under a key that is no longer configured fails honestly. The additional
 * authenticated data binds the value to WHERE it lives — purpose, workspace and
 * record — so a sealed secret copied into another row or another workspace does
 * not open.
 *
 * No relative imports: the tests load this file directly.
 */

const ENVELOPE_VERSION = "msb1";
const HKDF_INFO = "maintsupp/secret-box/v1";

export type SecretContext = {
  /** What the secret is for, e.g. `webhook.secret`. */
  purpose: string;
  organisationId: string;
  /** The row it belongs to. */
  recordId: string;
};

type EnvSource = Record<string, string | undefined>;

export class SecretBoxUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SecretBoxUnavailableError";
  }
}

function processEnv(): EnvSource {
  const holder = (globalThis as Record<string, unknown>).process as { env?: EnvSource } | undefined;
  return holder?.env ?? {};
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const normalised = value.trim().replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalised + "=".repeat((4 - (normalised.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string) {
  return decodeBase64(value);
}

const encoder = new TextEncoder();

async function keyIdOf(raw: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array([...raw, ...encoder.encode("kid")]));
  return [...new Uint8Array(digest).slice(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type LoadedKey = { kid: string; key: CryptoKey };
const derived = new Map<string, Promise<LoadedKey>>();

async function deriveKey(raw: Uint8Array<ArrayBuffer>): Promise<LoadedKey> {
  const material = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(HKDF_INFO) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { kid: await keyIdOf(raw), key };
}

function loadKey(value: string) {
  let pending = derived.get(value);
  if (!pending) {
    pending = deriveKey(decodeBase64(value)!);
    derived.set(value, pending);
  }
  return pending;
}

/** Why a configured value cannot be used, or null when it can. */
function problemWith(value: string | undefined): string | null {
  if (!value || !value.trim()) return "MAINTSUPP_SECRETS_KEY is not set on this deployment.";
  const raw = decodeBase64(value);
  if (!raw || raw.length !== 32) return "MAINTSUPP_SECRETS_KEY is set but does not decode to 32 bytes, so it is not used.";
  return null;
}

/**
 * Whether stored credentials can be sealed here, and if not, why — in words a
 * screen can show. `keyId` identifies the key without revealing it.
 */
export async function secretBoxStatus(env: EnvSource = processEnv()) {
  const problem = problemWith(env.MAINTSUPP_SECRETS_KEY);
  if (problem) return { configured: false as const, reason: problem, keyId: null };
  const { kid } = await loadKey(env.MAINTSUPP_SECRETS_KEY!);
  return { configured: true as const, reason: null, keyId: kid };
}

/** The same answer without deriving anything — for a route that only needs yes/no. */
export function secretBoxConfigured(env: EnvSource = processEnv()) {
  return problemWith(env.MAINTSUPP_SECRETS_KEY) === null;
}

function additionalData(kid: string, context: SecretContext) {
  return encoder.encode([ENVELOPE_VERSION, kid, context.purpose, context.organisationId, context.recordId].join("|"));
}

/** Seals `plain` for one purpose, workspace and record. Throws when no key is configured. */
export async function sealSecret(plain: string, context: SecretContext, env: EnvSource = processEnv()) {
  const problem = problemWith(env.MAINTSUPP_SECRETS_KEY);
  if (problem) throw new SecretBoxUnavailableError(problem);
  const { kid, key } = await loadKey(env.MAINTSUPP_SECRETS_KEY!);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(kid, context) },
    key,
    encoder.encode(plain),
  );
  return [ENVELOPE_VERSION, kid, base64url(iv), base64url(new Uint8Array(sealed))].join(".");
}

/**
 * Opens an envelope sealed by `sealSecret` for the same purpose, workspace and
 * record. Tries the current key and then the previous one, by key id. Throws on
 * anything else — a tampered value, a different record, a key that is gone.
 */
export async function openSecret(envelope: string, context: SecretContext, env: EnvSource = processEnv()) {
  const [version, kid, ivText, bodyText, extra] = envelope.split(".");
  if (version !== ENVELOPE_VERSION || !kid || !ivText || !bodyText || extra !== undefined) {
    throw new Error("This stored secret is not in a format this version can read.");
  }
  const candidates = [env.MAINTSUPP_SECRETS_KEY, env.MAINTSUPP_SECRETS_KEY_PREVIOUS].filter(
    (value): value is string => problemWith(value) === null,
  );
  if (!candidates.length) throw new SecretBoxUnavailableError(problemWith(env.MAINTSUPP_SECRETS_KEY)!);
  for (const candidate of candidates) {
    const loaded = await loadKey(candidate);
    if (loaded.kid !== kid) continue;
    const iv = fromBase64url(ivText);
    const body = fromBase64url(bodyText);
    if (!iv || !body) break;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: additionalData(kid, context) },
        loaded.key,
        body,
      );
      return new TextDecoder().decode(plain);
    } catch {
      throw new Error("This stored secret could not be opened: it was changed, or it belongs to another record.");
    }
  }
  throw new Error("This stored secret was sealed with a key that is no longer configured.");
}

/** What a screen may show of a secret: its last four characters, never more. */
export function secretHint(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "…";
  return `…${trimmed.slice(-4)}`;
}
