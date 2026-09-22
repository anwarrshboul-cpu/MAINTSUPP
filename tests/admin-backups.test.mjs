/**
 * §39 — the /admin Backups screen: visibility only, and truthful.
 *
 * The spec forbids fake buttons: the portal cannot start, restore or read the
 * database host's backups, so the screen must offer none of those and must say
 * so. What it can see — the database it runs on, whether files are in the
 * private bucket, whether the stored migration fingerprint matches this build —
 * it states as measured.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the backups API is read-only and for platform staff alone", async () => {
  const route = code(await read("app/api/admin/backups/route.ts"));
  assert.match(route, /export async function GET\(/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)\(/, "no action behind the screen, so no write route");
  assert.match(route, /if \(scope\.platformAdmin !== true \|\| !scope\.authenticated\) \{\s*return Response\.json\([^)]*\{ status: 403 \}/);
  assert.ok(route.indexOf("scope.platformAdmin") < route.indexOf("schema_state"), "refused before anything is read");
  assert.match(route, /current: storedFingerprint === SCHEMA_FINGERPRINT/, "the migration state is measured, not asserted");
  assert.match(route, /visible: false/, "backup status is stated as not visible from here");
});

test("the screen offers no button, form or link that pretends to back anything up", async () => {
  const view = code(await read("app/(app)/admin/backups-view.tsx"));
  assert.doesNotMatch(view, /<button|<form|onClick=|adminWrite\(/);
  assert.match(view, /useAdminResource<Payload>\("\/api\/admin\/backups"\)/);
  const page = await read("app/(app)/admin/backups/page.tsx");
  assert.ok(page.indexOf("requirePageSession(") < page.indexOf("requirePlatformAdmin("), "the console's two guards, in order");
});

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const serverUp = await (async () => {
  try {
    return (await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) })).status < 500;
  } catch {
    return false;
  }
})();

test("live: platform staff read the measured state; a workspace member is refused", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com", password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026" }),
  });
  if (!login.ok) return t.skip("the seeded owner could not sign in here");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
  const staff = await fetch(`${BASE_URL}/api/admin/backups`, { headers: { cookie, accept: "application/json" } });
  if (staff.status === 403) return t.skip("this identity is not platform staff here");
  assert.equal(staff.status, 200);
  const body = await staff.json();
  assert.equal(body.backups.visible, false);
  assert.equal(body.migrations.current, body.migrations.storedFingerprint === body.migrations.codeFingerprint);
  assert.ok(Array.isArray(body.omissions) && body.omissions.length >= 1);
  const member = await fetch(`${BASE_URL}/api/admin/backups`, {
    headers: { accept: "application/json", "x-maintsupp-identity": "client@demo-client-ltd.test.maintsupp.com" },
  });
  assert.ok(member.status === 403 || member.status === 401, `a workspace member answered ${member.status}`);
});
