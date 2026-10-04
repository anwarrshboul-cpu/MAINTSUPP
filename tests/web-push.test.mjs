/**
 * The installed app's notifications are only as good as the encryption and the
 * VAPID signature in app/lib/web-push.ts. A push service accepts a malformed
 * message (201) and the phone then silently drops it, so "it returned 201" is
 * not evidence. These tests play the BROWSER's side: they decrypt what the
 * server encrypted, exactly as RFC 8291 says a user agent must, and verify the
 * VAPID token with the public key a browser subscribes with.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/lib/web-push.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
});
const push = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const encoder = new TextEncoder();
const subtle = crypto.subtle;

async function hkdf(salt, ikm, info, length) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** A browser's subscription keys. */
async function browserSubscription() {
  const keys = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicRaw = new Uint8Array(await subtle.exportKey("raw", keys.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    keys,
    publicRaw,
    auth,
    subscription: { p256dh: push.toBase64Url(publicRaw), auth: push.toBase64Url(auth) },
  };
}

/** What a user agent does with an aes128gcm push body (RFC 8291 §3.4, RFC 8188). */
async function browserDecrypt(browser, body) {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16, false);
  const keyLength = body[20];
  const serverPublic = body.slice(21, 21 + keyLength);
  const ciphertext = body.slice(21 + keyLength);
  const serverKey = await subtle.importKey("raw", serverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(
    await subtle.deriveBits({ name: "ECDH", public: serverKey }, browser.keys.privateKey, 256),
  );
  const info = new Uint8Array([...encoder.encode("WebPush: info\0"), ...browser.publicRaw, ...serverPublic]);
  const ikm = await hkdf(browser.auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  return { recordSize, keyLength, record };
}

test("a browser can decrypt what the server encrypts", async () => {
  const browser = await browserSubscription();
  const message = JSON.stringify({ title: "MN-1234", body: "Status: Job Scheduled", url: "/app" });
  const body = await push.encryptPayload(browser.subscription, encoder.encode(message));
  const { recordSize, keyLength, record } = await browserDecrypt(browser, body);
  assert.equal(recordSize, 4096);
  assert.equal(keyLength, 65, "the server's ephemeral key travels uncompressed");
  assert.equal(record[record.length - 1], 2, "a single record ends with the last-record delimiter");
  assert.equal(new TextDecoder().decode(record.slice(0, -1)), message);
});

test("every message uses a fresh salt and server key", async () => {
  const browser = await browserSubscription();
  const one = await push.encryptPayload(browser.subscription, encoder.encode("x"));
  const two = await push.encryptPayload(browser.subscription, encoder.encode("x"));
  assert.notDeepEqual(one.slice(0, 16), two.slice(0, 16), "salt");
  assert.notDeepEqual(one.slice(21, 86), two.slice(21, 86), "ephemeral key");
});

test("the VAPID token verifies against the public key a browser subscribes with", async () => {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicRaw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  const header = await push.vapidAuthorization(
    "https://web.push.apple.com/QGuQyavXutnMH-example",
    { publicKey: push.toBase64Url(publicRaw), privateKey: jwk.d, subject: "mailto:info@maintsupp.com" },
    Date.UTC(2026, 9, 4),
  );
  const match = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(match, header);
  const [, head, claims, signature, k] = match;
  assert.equal(k, push.toBase64Url(publicRaw));
  const decoded = JSON.parse(new TextDecoder().decode(push.fromBase64Url(claims)));
  assert.equal(decoded.aud, "https://web.push.apple.com", "the audience is the push service's origin");
  assert.equal(decoded.sub, "mailto:info@maintsupp.com");
  assert.ok(decoded.exp - Date.UTC(2026, 9, 4) / 1000 <= 24 * 3600, "at most 24 hours");
  const valid = await subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pair.publicKey,
    push.fromBase64Url(signature),
    encoder.encode(`${head}.${claims}`),
  );
  assert.ok(valid, "ES256 signature verifies");
});

test("without keys nothing is sent and nothing throws", async () => {
  const before = { pub: process.env.VAPID_PUBLIC_KEY, priv: process.env.VAPID_PRIVATE_KEY };
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  try {
    assert.equal(push.pushConfigured(), false);
    const result = await push.sendPush(
      { endpoint: "https://example.invalid/x", p256dh: "a", auth: "b" },
      { title: "t", body: "b" },
    );
    assert.deepEqual(result, { ok: false, status: 0, gone: false });
  } finally {
    if (before.pub) process.env.VAPID_PUBLIC_KEY = before.pub;
    if (before.priv) process.env.VAPID_PRIVATE_KEY = before.priv;
  }
});
