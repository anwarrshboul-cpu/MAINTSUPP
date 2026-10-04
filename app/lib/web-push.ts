/**
 * WEB PUSH, WITH NOTHING BUT WEBCRYPTO.
 *
 * Sends one encrypted notification to one browser push subscription — the
 * Apple, Google or Mozilla push service named in its `endpoint`. Two standards
 * do the work, and both are implemented here directly rather than through the
 * `web-push` package, which leans on Node's `crypto` and `https` and so would
 * not run on every runtime this codebase deploys to:
 *
 *   · RFC 8291 / RFC 8188 — the message is encrypted to the browser's own key
 *     (`p256dh`) and auth secret with ECDH P-256, HKDF-SHA-256 and AES-128-GCM
 *     ("aes128gcm"), so the push service relays bytes it cannot read;
 *   · RFC 8292 (VAPID) — the request is signed with this server's key, so the
 *     push service knows the messages for a subscription come from the server
 *     the browser subscribed to.
 *
 * Configuration is two environment variables, both base64url:
 *   VAPID_PUBLIC_KEY   the uncompressed P-256 point (65 bytes) the browser
 *                      subscribes with;
 *   VAPID_PRIVATE_KEY  the private scalar `d` (32 bytes).
 * and optionally VAPID_SUBJECT (a mailto: or https: contact for the push
 * service). With either key missing, `pushConfigured()` is false and nothing is
 * sent — the app still works, it just cannot notify.
 */

export type PushSubscriptionKeys = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushMessage = {
  title: string;
  body: string;
  /** A same-origin path the notification opens when tapped. */
  url?: string;
  /** Notifications with the same tag replace each other on the phone. */
  tag?: string;
};

export type PushResult = {
  ok: boolean;
  status: number;
  /** The push service says this subscription no longer exists. */
  gone: boolean;
};

/* ── base64url ───────────────────────────────────────────────────────────── */

/** Bytes backed by a plain ArrayBuffer — what every WebCrypto call accepts. */
type Bytes = Uint8Array<ArrayBuffer>;

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

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const encoder = new TextEncoder();
const utf8 = (text: string): Bytes => new Uint8Array(encoder.encode(text));

/* ── Configuration ───────────────────────────────────────────────────────── */

export function vapidPublicKey(): string | null {
  const value = process.env.VAPID_PUBLIC_KEY?.trim();
  return value ? value : null;
}

export function pushConfigured(): boolean {
  return Boolean(vapidPublicKey() && process.env.VAPID_PRIVATE_KEY?.trim());
}

function vapidSubject() {
  return process.env.VAPID_SUBJECT?.trim() || "mailto:info@maintsupp.com";
}

/* ── VAPID (RFC 8292) ────────────────────────────────────────────────────── */

async function vapidSigningKey(publicKey: string, privateKey: string) {
  const point = fromBase64Url(publicKey);
  if (point.length !== 65 || point[0] !== 4) {
    throw new Error("VAPID_PUBLIC_KEY is not an uncompressed P-256 point.");
  }
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: toBase64Url(point.slice(1, 33)),
      y: toBase64Url(point.slice(33, 65)),
      d: privateKey,
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/** The `Authorization: vapid t=…, k=…` header for one push service. */
export async function vapidAuthorization(
  endpoint: string,
  keys: { publicKey: string; privateKey: string; subject: string },
  now = Date.now(),
): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = toBase64Url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = toBase64Url(
    utf8(
      JSON.stringify({
        aud: audience,
        /* 12 hours; the specification allows at most 24. */
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: keys.subject,
      }),
    ),
  );
  const unsigned = `${header}.${claims}`;
  const key = await vapidSigningKey(keys.publicKey, keys.privateKey);
  /* WebCrypto's ECDSA signature is already the raw r||s that JWS ES256 wants. */
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(unsigned)),
  );
  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}

/* ── Encryption (RFC 8291, aes128gcm) ────────────────────────────────────── */

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8),
  );
}

/**
 * The encrypted request body for one message to one subscription.
 *
 * `salt` and `serverKeys` are parameters only so a test can pin a known answer;
 * production always lets them default to fresh random values.
 */
export async function encryptPayload(
  subscription: Pick<PushSubscriptionKeys, "p256dh" | "auth">,
  plaintext: Uint8Array,
  options: { salt?: Bytes; serverKeys?: CryptoKeyPair } = {},
): Promise<Bytes> {
  const receiverPublic = fromBase64Url(subscription.p256dh);
  const authSecret = fromBase64Url(subscription.auth);
  if (receiverPublic.length !== 65) throw new Error("The subscription's p256dh key is not valid.");
  if (authSecret.length < 16) throw new Error("The subscription's auth secret is not valid.");

  const serverKeys =
    options.serverKeys ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair);
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));
  const receiverKey = await crypto.subtle.importKey(
    "raw",
    receiverPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: receiverKey },
      serverKeys.privateKey,
      256,
    ),
  );

  /* IKM = HKDF(auth, ECDH secret, "WebPush: info\0" || ua_public || as_public) */
  const ikm = await hkdf(
    authSecret,
    shared,
    concat(utf8("WebPush: info\0"), receiverPublic, serverPublic),
    32,
  );
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  /* One record: the message, then the 0x02 "last record" delimiter. */
  const record = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record),
  );

  /* Header: salt(16) || record size(4, big-endian) || key length(1) || key(65) */
  const header = new Uint8Array(16 + 4 + 1 + serverPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = serverPublic.length;
  header.set(serverPublic, 21);
  return concat(header, ciphertext);
}

/* ── Sending ─────────────────────────────────────────────────────────────── */

/**
 * Sends one message. Never throws: a failure is a result, because a
 * notification must never be the reason the write that caused it fails.
 */
export async function sendPush(
  subscription: PushSubscriptionKeys,
  message: PushMessage,
): Promise<PushResult> {
  const publicKey = vapidPublicKey();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return { ok: false, status: 0, gone: false };
  try {
    const endpoint = new URL(subscription.endpoint);
    if (endpoint.protocol !== "https:") return { ok: false, status: 0, gone: true };

    const body = await encryptPayload(
      subscription,
      utf8(
        JSON.stringify({
          title: message.title.slice(0, 120),
          body: message.body.slice(0, 400),
          url: message.url && message.url.startsWith("/") ? message.url : undefined,
          tag: message.tag,
        }),
      ),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(endpoint.href, {
        method: "POST",
        headers: {
          Authorization: await vapidAuthorization(endpoint.href, {
            publicKey,
            privateKey,
            subject: vapidSubject(),
          }),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          /* Keep it a day if the phone is off; then it is stale news. */
          TTL: String(24 * 60 * 60),
          Urgency: "high",
        },
        body,
        signal: controller.signal,
      });
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        gone: response.status === 404 || response.status === 410,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, status: 0, gone: false };
  }
}
