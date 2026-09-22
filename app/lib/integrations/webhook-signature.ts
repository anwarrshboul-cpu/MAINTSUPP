/**
 * §35b — HOW A RECEIVER KNOWS A WEBHOOK CAME FROM THIS WORKSPACE, UNCHANGED.
 *
 *   Maintsupp-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
 *
 * The timestamp is inside what is signed, so a captured request cannot be
 * replayed later with a fresh time; a receiver rejects a `t` more than five
 * minutes from its own clock. `Maintsupp-Event-Id` is sent beside it and is the
 * idempotency key: the same event is retried with the same id, so a receiver
 * that has seen it can safely ignore the repeat.
 *
 * WebCrypto only, so the same code signs in Node and in the Workers runtime.
 * `verifyWebhookSignature` is what a receiver would write, and what the tests
 * use to prove the header is what this file says it is.
 *
 * No relative imports: the tests load this file directly.
 */

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The signature header for `body`, signed at `timestamp` (unix seconds). */
export async function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${body}`)}`;
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/**
 * True when `header` is a valid signature of `body` under `secret`, made within
 * `toleranceSeconds` of `now`. Any `v1` in the header may match, so a receiver
 * keeps working across a secret rollover.
 */
export async function verifyWebhookSignature(
  header: string | null | undefined,
  body: string,
  secret: string,
  toleranceSeconds = 300,
  now = Date.now(),
) {
  if (!header) return false;
  const parts = header.split(",").map((part) => part.trim().split("="));
  const timestamp = Number(parts.find(([name]) => name === "t")?.[1]);
  const signatures = parts.filter(([name]) => name === "v1").map(([, value]) => value ?? "");
  if (!Number.isInteger(timestamp) || !signatures.length) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = await hmacHex(secret, `${timestamp}.${body}`);
  return signatures.some((candidate) => constantTimeEqual(candidate, expected));
}

/** A new signing secret: `whsec_` and 32 random bytes, base64url. Shown once. */
export function newSigningSecret() {
  let binary = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(32))) binary += String.fromCharCode(byte);
  return `whsec_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
