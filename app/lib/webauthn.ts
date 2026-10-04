/**
 * WEBAUTHN — the checks behind "Sign in with Face ID".
 *
 * Pure functions over the bytes the browser hands back, using only WebCrypto,
 * so they run on every runtime this app deploys to and are tested directly
 * (tests/webauthn.test.mjs plays the authenticator with a real key pair).
 *
 * WHAT IS VERIFIED, AND WHY EACH ONE MATTERS
 *
 *   · `clientDataJSON.type` — a registration cannot be replayed as a sign-in;
 *   · `clientDataJSON.challenge` — returned to the caller, which must find it
 *     unused and unexpired in its own store and delete it (single use);
 *   · `clientDataJSON.origin` — must be one of OUR origins, so a passkey made
 *     for maintsupp.com is never accepted from a look-alike page;
 *   · the authenticator data's RP ID hash — SHA-256 of our host name;
 *   · "user present" AND "user verified" flags — the person was there and
 *     unlocked the key with Face ID, Touch ID, a fingerprint or the device PIN;
 *   · the signature (sign-in) over authenticatorData ‖ SHA-256(clientDataJSON)
 *     with the stored public key;
 *   · the signature counter must move forward when the device keeps one, which
 *     is how a cloned authenticator gives itself away.
 *
 * Attestation is NOT requested ("none"): it identifies the make of device,
 * which this product has no use for, and Apple's passkeys do not provide it.
 * The public key is taken from the browser's `getPublicKey()` (DER SPKI), and
 * the credential id is checked against the one inside the signed-over
 * authenticator data, so the key cannot be swapped for another credential's.
 */

type Bytes = Uint8Array<ArrayBuffer>;

export const ALGORITHM_ES256 = -7;
export const ALGORITHM_RS256 = -257;
export const SUPPORTED_ALGORITHMS = [ALGORITHM_ES256, ALGORITHM_RS256] as const;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Bytes {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function equal(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

export function newChallenge(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/* ── Authenticator data ──────────────────────────────────────────────────── */

export type AuthenticatorData = {
  rpIdHash: Bytes;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
  credentialId: Bytes | null;
};

export function parseAuthenticatorData(data: Bytes): AuthenticatorData {
  if (data.length < 37) throw new Error("The authenticator data is too short.");
  const flags = data[32];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const signCount = view.getUint32(33, false);
  let credentialId: Bytes | null = null;
  /* AT flag: attested credential data follows — AAGUID(16) ‖ length(2) ‖ id. */
  if (flags & 0x40) {
    if (data.length < 55) throw new Error("The attested credential data is missing.");
    const length = view.getUint16(53, false);
    if (data.length < 55 + length) throw new Error("The credential id is truncated.");
    credentialId = data.slice(55, 55 + length);
  }
  return {
    rpIdHash: data.slice(0, 32),
    userPresent: Boolean(flags & 0x01),
    userVerified: Boolean(flags & 0x04),
    signCount,
    credentialId,
  };
}

/* ── Client data ─────────────────────────────────────────────────────────── */

export type ClientData = { type: string; challenge: string; origin: string };

export function parseClientData(clientDataJSON: Bytes): ClientData {
  const parsed = JSON.parse(new TextDecoder().decode(clientDataJSON)) as Partial<ClientData>;
  if (
    typeof parsed.type !== "string" ||
    typeof parsed.challenge !== "string" ||
    typeof parsed.origin !== "string"
  ) {
    throw new Error("The client data is not WebAuthn client data.");
  }
  return { type: parsed.type, challenge: parsed.challenge, origin: parsed.origin };
}

/* ── Keys and signatures ─────────────────────────────────────────────────── */

async function importPublicKey(spki: Bytes, algorithm: number) {
  if (algorithm === ALGORITHM_ES256) {
    return crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
  }
  if (algorithm === ALGORITHM_RS256) {
    return crypto.subtle.importKey(
      "spki",
      spki,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }
  throw new Error("That kind of passkey is not supported.");
}

/**
 * An authenticator's ECDSA signature is DER (SEQUENCE of two INTEGERs);
 * WebCrypto wants the raw 64-byte r ‖ s.
 */
export function derToRawSignature(der: Bytes): Bytes {
  if (der[0] !== 0x30) throw new Error("The signature is not DER.");
  let offset = 2;
  if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f);
  const readInteger = () => {
    if (der[offset] !== 0x02) throw new Error("The signature is not DER.");
    const length = der[offset + 1];
    let value = der.slice(offset + 2, offset + 2 + length);
    offset += 2 + length;
    while (value.length > 32 && value[0] === 0) value = value.slice(1);
    if (value.length > 32) throw new Error("The signature is malformed.");
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return padded;
  };
  const r = readInteger();
  const s = readInteger();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

/* ── The two ceremonies ──────────────────────────────────────────────────── */

export type VerifyFailure = { ok: false; error: string };

function originAllowed(origin: string, allowedOrigins: readonly string[]) {
  return allowedOrigins.includes(origin);
}

/**
 * Registration. The caller has already found `clientData.challenge` unused,
 * unexpired and issued to this signed-in person.
 */
export async function verifyRegistration(input: {
  clientData: ClientData;
  authenticatorData: Bytes;
  credentialId: Bytes;
  publicKey: Bytes;
  algorithm: number;
  allowedOrigins: readonly string[];
}): Promise<{ ok: true; rpId: string; signCount: number } | VerifyFailure> {
  if (input.clientData.type !== "webauthn.create") {
    return { ok: false, error: "That was not a passkey registration." };
  }
  if (!originAllowed(input.clientData.origin, input.allowedOrigins)) {
    return { ok: false, error: "That passkey was made for a different site." };
  }
  const rpId = new URL(input.clientData.origin).hostname;
  let data: AuthenticatorData;
  try {
    data = parseAuthenticatorData(input.authenticatorData);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "Bad authenticator data." };
  }
  if (!equal(data.rpIdHash, await sha256(new TextEncoder().encode(rpId) as Bytes))) {
    return { ok: false, error: "That passkey was made for a different site." };
  }
  if (!data.userPresent || !data.userVerified) {
    return { ok: false, error: "Face ID, fingerprint or the device passcode is required." };
  }
  if (!data.credentialId || !equal(data.credentialId, input.credentialId)) {
    return { ok: false, error: "The passkey's id does not match what the device signed." };
  }
  if (!(SUPPORTED_ALGORITHMS as readonly number[]).includes(input.algorithm)) {
    return { ok: false, error: "That kind of passkey is not supported." };
  }
  try {
    await importPublicKey(input.publicKey, input.algorithm);
  } catch {
    return { ok: false, error: "The passkey's public key could not be read." };
  }
  return { ok: true, rpId, signCount: data.signCount };
}

/**
 * Sign-in. The caller has looked the passkey up by its id and consumed the
 * challenge named in `clientData`.
 */
export async function verifyAssertion(input: {
  clientData: ClientData;
  clientDataJSON: Bytes;
  authenticatorData: Bytes;
  signature: Bytes;
  publicKey: Bytes;
  algorithm: number;
  storedSignCount: number;
  allowedOrigins: readonly string[];
}): Promise<{ ok: true; signCount: number } | VerifyFailure> {
  if (input.clientData.type !== "webauthn.get") {
    return { ok: false, error: "That was not a passkey sign-in." };
  }
  if (!originAllowed(input.clientData.origin, input.allowedOrigins)) {
    return { ok: false, error: "That passkey belongs to a different site." };
  }
  const rpId = new URL(input.clientData.origin).hostname;
  let data: AuthenticatorData;
  try {
    data = parseAuthenticatorData(input.authenticatorData);
  } catch {
    return { ok: false, error: "The passkey response could not be read." };
  }
  if (!equal(data.rpIdHash, await sha256(new TextEncoder().encode(rpId) as Bytes))) {
    return { ok: false, error: "That passkey belongs to a different site." };
  }
  if (!data.userPresent || !data.userVerified) {
    return { ok: false, error: "Face ID, fingerprint or the device passcode is required." };
  }

  const signed = new Uint8Array(input.authenticatorData.length + 32);
  signed.set(input.authenticatorData, 0);
  signed.set(await sha256(input.clientDataJSON), input.authenticatorData.length);

  let valid = false;
  try {
    const key = await importPublicKey(input.publicKey, input.algorithm);
    valid =
      input.algorithm === ALGORITHM_ES256
        ? await crypto.subtle.verify(
            { name: "ECDSA", hash: "SHA-256" },
            key,
            derToRawSignature(input.signature),
            signed,
          )
        : await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, input.signature, signed);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: "That passkey could not be verified." };

  /* A counter that fails to move forward is a cloned key. Zero means the
     device does not count (Apple's synced passkeys), which is allowed. */
  if ((data.signCount !== 0 || input.storedSignCount !== 0) && data.signCount <= input.storedSignCount) {
    return { ok: false, error: "This passkey looks like a copy and was refused." };
  }
  return { ok: true, signCount: data.signCount };
}
