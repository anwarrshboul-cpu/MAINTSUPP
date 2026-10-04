/**
 * "Sign in with Face ID" stands on app/lib/webauthn.ts. These tests play the
 * phone's authenticator with a real P-256 key pair and check both that a
 * genuine ceremony passes and that each tampering the module guards against
 * is refused.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/lib/webauthn.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
});
const wa = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const subtle = crypto.subtle;
const enc = new TextEncoder();
const ORIGIN = "https://maintsupp.com";
const ALLOWED = [ORIGIN];

async function sha(bytes) {
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}

function rawToDer(raw) {
  const int = (bytes) => {
    let value = Array.from(bytes);
    while (value.length > 1 && value[0] === 0 && value[1] < 0x80) value.shift();
    if (value[0] & 0x80) value = [0, ...value];
    return [0x02, value.length, ...value];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

async function authenticator() {
  const keys = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await subtle.exportKey("spki", keys.publicKey));
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  return { keys, spki, credentialId };
}

async function authData({ rpId = "maintsupp.com", flags = 0x05, counter = 0, credentialId = null }) {
  const parts = [...(await sha(enc.encode(rpId))), flags | (credentialId ? 0x40 : 0)];
  parts.push((counter >>> 24) & 255, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255);
  if (credentialId) {
    parts.push(...new Uint8Array(16), (credentialId.length >> 8) & 255, credentialId.length & 255, ...credentialId);
  }
  return new Uint8Array(parts);
}

function clientData(type, challenge, origin = ORIGIN) {
  return enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

async function signIn(device, { counter = 0, origin = ORIGIN, flags = 0x05, tamper = false } = {}) {
  const challenge = wa.newChallenge();
  const cdj = clientData("webauthn.get", challenge, origin);
  const ad = await authData({ counter, flags });
  const signed = new Uint8Array([...ad, ...(await sha(cdj))]);
  const raw = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, device.keys.privateKey, signed));
  if (tamper) raw[5] ^= 1;
  return { challenge, cdj, ad, signature: rawToDer(raw) };
}

test("a genuine registration passes and reports the site", async () => {
  const device = await authenticator();
  const challenge = wa.newChallenge();
  const cdj = clientData("webauthn.create", challenge);
  const result = await wa.verifyRegistration({
    clientData: wa.parseClientData(cdj),
    authenticatorData: await authData({ credentialId: device.credentialId }),
    credentialId: device.credentialId,
    publicKey: device.spki,
    algorithm: -7,
    allowedOrigins: ALLOWED,
  });
  assert.deepEqual(result, { ok: true, rpId: "maintsupp.com", signCount: 0 });
  assert.equal(wa.parseClientData(cdj).challenge, challenge);
});

test("registration refuses another site, no Face ID, and a swapped credential", async () => {
  const device = await authenticator();
  const base = async (overrides) =>
    wa.verifyRegistration({
      clientData: wa.parseClientData(clientData("webauthn.create", "c", overrides.origin ?? ORIGIN)),
      authenticatorData: await authData({ credentialId: device.credentialId, flags: overrides.flags ?? 0x05, rpId: overrides.rpId }),
      credentialId: overrides.credentialId ?? device.credentialId,
      publicKey: device.spki,
      algorithm: -7,
      allowedOrigins: ALLOWED,
    });
  assert.equal((await base({ origin: "https://maintsupp.evil" })).ok, false);
  assert.equal((await base({ rpId: "evil.com" })).ok, false);
  assert.equal((await base({ flags: 0x01 })).ok, false, "user verification is required");
  assert.equal((await base({ credentialId: new Uint8Array(16) })).ok, false);
});

test("a genuine sign-in verifies; a tampered or foreign one does not", async () => {
  const device = await authenticator();
  const verify = async (assertion, storedSignCount = 0) =>
    wa.verifyAssertion({
      clientData: wa.parseClientData(assertion.cdj),
      clientDataJSON: assertion.cdj,
      authenticatorData: assertion.ad,
      signature: assertion.signature,
      publicKey: device.spki,
      algorithm: -7,
      storedSignCount,
      allowedOrigins: ALLOWED,
    });
  assert.deepEqual(await verify(await signIn(device)), { ok: true, signCount: 0 });
  assert.equal((await verify(await signIn(device, { tamper: true }))).ok, false, "bad signature");
  assert.equal((await verify(await signIn(device, { origin: "https://evil.example" }))).ok, false);
  assert.equal((await verify(await signIn(device, { flags: 0x01 }))).ok, false, "no Face ID");
  const other = await authenticator();
  const foreign = await signIn(other);
  assert.equal((await verify(foreign)).ok, false, "another device's key");
});

test("a counter that goes backwards is refused as a cloned key", async () => {
  const device = await authenticator();
  const verify = async (assertion, storedSignCount) =>
    wa.verifyAssertion({
      clientData: wa.parseClientData(assertion.cdj),
      clientDataJSON: assertion.cdj,
      authenticatorData: assertion.ad,
      signature: assertion.signature,
      publicKey: device.spki,
      algorithm: -7,
      storedSignCount,
      allowedOrigins: ALLOWED,
    });
  assert.equal((await verify(await signIn(device, { counter: 6 }), 5)).ok, true);
  assert.equal((await verify(await signIn(device, { counter: 5 }), 5)).ok, false);
});

test("a registration cannot be replayed as a sign-in", async () => {
  const device = await authenticator();
  const assertion = await signIn(device);
  const asCreate = clientData("webauthn.create", assertion.challenge);
  const result = await wa.verifyAssertion({
    clientData: wa.parseClientData(asCreate),
    clientDataJSON: asCreate,
    authenticatorData: assertion.ad,
    signature: assertion.signature,
    publicKey: device.spki,
    algorithm: -7,
    storedSignCount: 0,
    allowedOrigins: ALLOWED,
  });
  assert.equal(result.ok, false);
});
