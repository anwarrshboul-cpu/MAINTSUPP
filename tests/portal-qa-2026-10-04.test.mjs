/**
 * Fixes from the full-portal QA pass of 2026-10-04, each pinned to the
 * contract it restores.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("renaming a job on the board renames the job the drawer opens", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  const save = board.slice(board.indexOf("const saveCustomCell = async"));
  assert.match(save, /if \(column\.system && column\.key === "name" && renamed\) \{\s*onRequestChange\(\{ \.\.\.request, title: renamed\.slice\(0, 200\) \}\);/);
});

test("Advance request moves the board row into its stage's group", async () => {
  const lib = await read("app/lib/board-mutations.ts");
  const fn = lib.slice(lib.indexOf("export async function followStageToGroup"));
  assert.match(fn, /if \(!current\?\.stageKey \|\| current\.stageKey === stage\) return;/, "an owner's own group is left alone");
  assert.match(fn, /eq\(maintenanceGroups\.boardId, placement\.boardId\)/, "only a group of the row's own board");
  assert.match(fn, /eq\(maintenanceGroups\.stageKey, stage\)/);
  const route = await read("app/api/maintenance/route.ts");
  assert.match(route, /if \(stage && updated\) \{\s*await followStageToGroup\(db, orgId, id, stage\);/);
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const advance = portal.slice(portal.indexOf("const changeRequestStage = async"));
  assert.match(advance.slice(0, 900), /window\.dispatchEvent\(new Event\("maintsupp:refresh-board"\)\)/);
});

test("compliance expiry warnings run every day for client workspaces", async () => {
  const daily = await read("app/api/cron/daily/route.ts");
  assert.match(daily, /await runComplianceDigestsForCron\(request\)/);
  assert.match(daily, /await dispatchDueRemindersDaily\(\)/);
  const digest = await read("app/api/notifications/compliance/route.ts");
  const cron = digest.slice(digest.indexOf("export async function runComplianceDigestsForCron"));
  assert.match(cron, /authoriseCron\(request, "compliance alerts", await resolveCronSecret\(\)\)/, "the cron secret is required");
  assert.match(cron, /moduleSwitchedOff\(db, workspace\.id, "compliance"\)/);
  assert.match(digest, /new Set\(\[DEMO_ORGANISATION_ID, DEMO_WORKSPACE_ID, WEBSITE_LEADS_WORKSPACE_ID, \.\.\.listed\]\)/, "demo workspaces never email");
  assert.match(digest, /subject: workspaceName \? `\$\{workspaceName\} · \$\{template\.subject\}` : template\.subject/);
  /* A person's run is unchanged: the same function, session-guarded. */
  assert.match(digest, /return Response\.json\(await sendDigest\(db, orgId, dryRun\)\);/);
});

test("the daily reminder run never uses a reminder up while email is down", async () => {
  const route = await read("app/api/cron/reminders/route.ts");
  const fn = route.slice(route.indexOf("export async function dispatchDueRemindersDaily"));
  assert.match(fn, /if \(!emailDeliveryStatus\(\)\.deliverable\) return \{ skipped:/);
});

test("the live site shows calm text, not an error wall, where a tool is off by design", async () => {
  const reconcile = await read("app/(app)/portal/views/reconcile-panel.tsx");
  assert.match(reconcile, /Numbers reconciliation runs on test copies of the data only\./);
  const sites = await read("app/(app)/portal/ops/sites-list.tsx");
  assert.match(sites, /coverage\.total === 0 \? null :/, "no 'map unavailable' line over an empty register");
  const register = await read("app/(app)/portal/views/document-register.ts");
  assert.match(register, /if \(owner\?\.startsWith\("contractor-link:"\)\) return "Contractor \(job link\)";/);
});

test("reminders run on the daily check only — no separate hourly key (owner, 2026-10-04)", async () => {
  /* The cadence is the agreed 90/60/30/14/7/0/overdue ladder, checked once a
     day; an hourly scheduler and its key were withdrawn the same afternoon. */
  const route = await read("app/api/cron/reminders/route.ts");
  assert.doesNotMatch(route, /REMINDER_TRIGGER_SECRET/);
  assert.match(route, /const refusal = authoriseCron\(request, "reminders", await resolveCronSecret\(\)\);/);
});

test("reminder recipients: Client contact and calendar certificates resolve", async () => {
  const route = await read("app/api/cron/reminders/route.ts");
  assert.match(route, /groups\["client-contact"\] = owners\.length \? owners\.map\(asPerson\) : null;/);
  assert.match(route, /eq\(clientCompanyMembers\.status, "active"\)/);
  assert.match(route, /\.from\(calendarEvents\)\s*\.where\(and\(eq\(calendarEvents\.id, subjectId\), eq\(calendarEvents\.organisationId, organisationId\)\)\)/);
});
