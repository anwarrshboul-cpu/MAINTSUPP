/**
 * The Face ID routes (2026-10-04). Source pins for the rules that keep a
 * passkey from becoming a way round the account's own state.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("a passkey is only ever added to the account that is signed in", async () => {
  const options = await read("app/api/auth/passkeys/options/route.ts");
  const register = await read("app/api/auth/passkeys/register/route.ts");
  assert.match(options, /if \(body\.purpose === "register"\) \{\s*const session = await getSession\(request\);\s*if \(!session\)/);
  assert.match(register, /const session = await getSession\(request\);\s*if \(!session\)/);
  assert.match(register, /consumeChallenge\(db, clientData\.challenge, "register", session\.user\.id\)/);
  assert.match(register, /userId: session\.user\.id,/);
});

test("a challenge is single-use, purpose-bound and expires", async () => {
  const store = await read("app/lib/passkey-store.ts");
  const consume = store.slice(store.indexOf("export async function consumeChallenge"));
  assert.match(consume, /await db\.delete\(webauthnChallenges\)\.where\(eq\(webauthnChallenges\.id, challenge\)\);\s*if \(row\.purpose !== purpose\) return null;/);
  assert.match(consume, /if \(row\.expiresAt < Date\.now\(\)\) return null;/);
});

test("a valid passkey does not let a disabled account in", async () => {
  const login = await read("app/api/auth/passkeys/login/route.ts");
  assert.match(login, /\(!user\.status \|\| user\.status === "active"\)/);
  assert.match(login, /if \(!usable\) return Response\.json\(\{ error: REJECTED \}, \{ status: 401 \}\);/);
  /* The session is the same one a password makes. */
  assert.match(login, /createSession\(d1, \{/);
  assert.match(login, /sessionCookie\(token, request\)/);
  assert.match(login, /safeRedirectPath\(body\.next\)/);
});

test("a passkey can only be removed by its owner", async () => {
  const store = await read("app/lib/passkey-store.ts");
  assert.match(store, /and\(eq\(passkeys\.id, id\), eq\(passkeys\.userId, userId\)\)/);
});

test("the sign-in form keeps the password path and only offers Face ID where it works", async () => {
  const form = await read("app/(app)/login/sign-in-form.tsx");
  assert.match(form, /deviceUnlockAvailable\(\)/);
  assert.match(form, /\{unlock && \(/);
  assert.match(form, /type="password"/);
});
