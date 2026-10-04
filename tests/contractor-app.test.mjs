/**
 * The contractor app (2026-10-04): contractors sign in to the same MAINTSUPP
 * app by an invite link, an email code or a text code, and see ONLY the jobs
 * assigned to them, without prices. Source pins for the rules that keep it so.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("only hashes of tokens and codes are stored", async () => {
  const auth = await read("app/lib/contractor-auth.ts");
  assert.match(auth, /tokenHash: await sha256Hex\(token\),\s*contractorId: input\.contractor\.id/);
  assert.match(auth, /codeHash: await sha256Hex\(`\$\{identity\}:\$\{code\}`\)/);
  assert.doesNotMatch(auth, /\btoken: token\b/);
});

test("a session is re-checked on every request, and an archived contractor is out at once", async () => {
  const auth = await read("app/lib/contractor-auth.ts");
  const scope = auth.slice(auth.indexOf("export async function contractorScope"));
  assert.match(scope, /isNull\(contractorSessions\.revokedAt\)/);
  assert.match(scope, /new Date\(session\.expiresAt\)\.getTime\(\) < Date\.now\(\)\) return null/);
  assert.match(scope, /eq\(contractors\.active, true\)/);
  /* Other workspaces' records only while the anchor still carries the identity. */
  assert.match(scope, /if \(anchorIdentities\.includes\(session\.identity\)\)/);
  assert.match(auth, /export async function contractorsForIdentity[\s\S]*?eq\(contractors\.active, true\)/);
});

test("codes expire, are single-use and allow five tries", async () => {
  const auth = await read("app/lib/contractor-auth.ts");
  assert.match(auth, /const CODE_LIFETIME_MS = 10 \* 60 \* 1000;/);
  assert.match(auth, /const CODE_ATTEMPTS = 5;/);
  const check = auth.slice(auth.indexOf("export async function checkLoginCode"));
  assert.match(check, /row\.attempts >= CODE_ATTEMPTS/);
  assert.match(check, /attempts: row\.attempts \+ 1/);
  /* The right code deletes the row, so it cannot be used twice. */
  assert.match(check, /await db\.delete\(contractorLoginCodes\)\.where\(eq\(contractorLoginCodes\.id, row\.id\)\);\s*return true;/);
});

test("'send me a code' does not tell anyone who is a contractor", async () => {
  const start = await read("app/api/contractor/code/start/route.ts");
  /* The same answer whether or not the address matched. */
  assert.match(start, /if \(matches\.length\) \{[\s\S]*?\}\s*return Response\.json\(\{\s*ok: true,/);
  assert.match(start, /If that email is on our contractor list/);
  assert.match(start, /If that mobile is on our contractor list/);
});

test("a contractor sees only jobs assigned to them, and never a price", async () => {
  const me = await read("app/api/contractor/me/route.ts");
  assert.match(me, /if \(!scope\) return Response\.json\(\{ signedIn: false \}, \{ status: 401 \}\);/);
  assert.match(me, /inArray\(maintenanceRequests\.contractorId, ids\)/);
  assert.match(me, /isNull\(maintenanceRequests\.deletedAt\)/);
  const select = me.slice(me.indexOf(".select({"), me.indexOf(".from(maintenanceRequests)"));
  for (const field of ["cost", "price", "quote", "invoice", "amount", "rate", "budget"]) {
    assert.doesNotMatch(select, new RegExp(field, "i"), `the contractor job list must not carry ${field}`);
  }
  const open = await read("app/api/contractor/jobs/[id]/open/route.ts");
  assert.match(open, /inArray\(maintenanceRequests\.contractorId, ids\)/);
  assert.match(open, /audience: "contractor"/);
});

test("only the office, with board.edit, can create an app invite", async () => {
  const invites = await read("app/api/contractor/invites/route.ts");
  assert.match(invites, /scopedDbWithCapability\(request, "board\.edit"\)/);
  assert.match(invites, /eq\(contractors\.organisationId, orgId\)/);
  assert.match(invites, /if \(!contractor\.active\)/);
  const auth = await read("app/lib/contractor-auth.ts");
  assert.match(auth, /const INVITE_LIFETIME_MS = 14 \* 86_400_000;/);
  assert.match(auth, /if \(!invite \|\| Number\(invite\.expiresAt\) < Date\.now\(\)\) return null;/);
});

test("the contractor drawer offers the app link, and /app sends a signed-in contractor to their jobs", async () => {
  const profile = await read("app/(app)/portal/contractor-profile.tsx");
  assert.match(profile, /<ContractorAppInvite contractorId=\{contractor\.id\}/);
  const invite = await read("app/(app)/portal/contractor-app-invite.tsx");
  assert.match(invite, /fetch\("\/api\/contractor\/invites"/);
  const home = await read("app/(public)/app/app-home.tsx");
  assert.match(home, /fetch\("\/api\/contractor\/me"[\s\S]*?window\.location\.replace\("\/contractor"\)/);
  assert.match(home, /href="\/contractor"/);
});

test("assigning a contractor tells them, by app alert and by message", async () => {
  const push = await read("app/lib/push-notify.ts");
  assert.match(push, /column === "contractor"/);
  assert.match(push, /notifyContractorAssigned/);
  const messaging = await read("app/lib/contractor-messaging.ts");
  assert.match(messaging, /export async function tellContractorAboutJob/);
  assert.match(messaging, /sendWhatsAppJob/);
  assert.match(messaging, /sendSms/);
});

test("UK mobiles are one identity however they are typed", async () => {
  const auth = await read("app/lib/contractor-auth.ts");
  assert.match(auth, /digits = `44\$\{digits\.slice\(1\)\}`;/);
});

test("the sign-in screen offers codes only when the server can send them, and always takes a pasted app link", async () => {
  const start = await read("app/api/contractor/code/start/route.ts");
  assert.match(start, /export function GET\(\) \{[\s\S]*?email: emailDeliveryStatus\(\)\.deliverable, text: verifyConfigured\(\)/);
  const app = await read("app/(public)/contractor/contractor-app.tsx");
  assert.match(app, /const codes = methods \? methods\.email \|\| methods\.text : false;/);
  assert.match(app, /!codes \? null : !sent \?/);
  assert.match(app, /window\.location\.href = `\/c\/\$\{match\[1\]\.toLowerCase\(\)\}`/);
});
