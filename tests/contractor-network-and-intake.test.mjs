/**
 * The contractor network and the website's intake (owner, 2026-10-04):
 * applications carry documents, the applicant is thanked, staff are alerted,
 * an approved applicant joins a client's Contractors register, a stranger's
 * job report never lands in a client's workspace, client Owners keep only
 * their own preferences, and invitations point at the app.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("application documents: written only with the applicant's one-hour key, read only by signed-in staff", async () => {
  const route = await read("app/api/contractor-applications/documents/route.ts");
  assert.match(route, /eq\(contractorApplications\.uploadTokenHash, await sha256Hex\(token\)\)/);
  assert.match(route, /new Date\(application\.uploadTokenExpiresAt\)\.getTime\(\) < Date\.now\(\)/);
  assert.match(route, /signatureMatches\(type, file\.name/);
  assert.match(route, /if \(!scope\.platformAdmin \|\| !scope\.authenticated\) \{/);
  assert.match(route, /"Content-Disposition": `attachment; filename=/, "always a download, never rendered");
  const apply = await read("app/api/contractor-applications/route.ts");
  assert.match(apply, /uploadTokenHash: await sha256Hex\(uploadToken\)/);
  assert.match(apply, /event: "contractor\.application_received"/, "the applicant is thanked");
  assert.match(apply, /await notifyPlatformStaff\(db, \{\s*title: `New contractor application/);
});

test("approve and add: a client workspace only, Approved, linked, and the app link on request", async () => {
  const inbox = await read("app/api/contractor-applications/inbox/route.ts");
  assert.match(inbox, /body\?\.action !== "add_to_register"/);
  assert.match(inbox, /NOT_A_REGISTER\.has\(organisationId\) \|\| !scope\.organisationIds\.includes\(organisationId\)/);
  assert.match(inbox, /\.set\(\{ status: "Approved", contractorId \}\)/);
  assert.match(inbox, /if \(body\.sendAppLink === true\) \{\s*const token = await createContractorInvite/);
});

test("a stranger's website job report goes to Website Leads, never a client's workspace", async () => {
  const route = await read("app/api/report-job/route.ts");
  assert.match(route, /const orgId = site \? primaryOrgId : WEBSITE_LEADS_WORKSPACE_ID;/);
  assert.match(route, /if \(!site\) \{\s*await seedBoardStructure\(await getD1\(\), WEBSITE_LEADS_WORKSPACE_ID/);
  const leads = await read("app/api/leads/route.ts");
  assert.match(leads, /await notifyPlatformStaff\(db, \{\s*title: `New enquiry/);
});

test("the home page has a door for contractors", async () => {
  const section = await read("app/(marketing)/_sections/contractor-choice.tsx");
  assert.match(section, /<Link className="btn btn--primary" href="\/contractors">\s*Join our contractor network/);
});

test("client Owners and Admins keep their own preferences, not the workspace's settings", async () => {
  /* The full matrix is pinned in users-access-rbac.test.mjs; this file pins the
     reason in one place: neither built-in set names the two capabilities. */
  const source = await read("app/lib/permissions.ts");
  const defaults = source.slice(source.indexOf("const BUILT_IN_DEFAULTS"), source.indexOf("  manager:", source.indexOf("const BUILT_IN_DEFAULTS")));
  assert.doesNotMatch(defaults, /"settings\.edit"/);
  assert.doesNotMatch(defaults.slice(defaults.indexOf("  admin:")), /"integrations\.manage"/);
  assert.match(defaults, /"navigation\.personalise"/);
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /runtimeContext\?\.identity\?\.platformAdmin === true &&\s*runtimeContext\?\.capabilities\?\.\["settings\.edit"\] === true/, "Reconcile is staff-only");
});

test("an invitation points at the app, and accepting on a phone goes there", async () => {
  const notifications = await read("app/lib/notifications.ts");
  const invite = notifications.slice(notifications.indexOf("export function invitationEmailTemplate"));
  /* One button does both (owner, 2026-10-04). */
  assert.match(invite, />Accept &amp; download the app<\/a>/);
  assert.equal((invite.slice(0, invite.indexOf("const text")).match(/<a href=/g) ?? []).length, 1, "exactly one button");
  const form = await read("app/(public)/invite/[token]/accept-invite-form.tsx");
  assert.match(form, /window\.location\.assign\(installed \? \(payload\.redirectTo \?\? "\/dashboard"\) : "\/app\?welcome=1"\)/);
});
