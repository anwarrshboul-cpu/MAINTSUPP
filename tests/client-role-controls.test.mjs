/**
 * QA on 2026-10-01, signed in as a Cloud Test client: the server refused every
 * write correctly, but the UI still offered a working "+ New" record form, an
 * Import tab, "Import data" and "Developers" in the avatar menu, and the topbar
 * Invite and Integrations links. Each is now offered only with its capability.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("controls a client cannot use are not offered to one", async () => {
  const manager = await read("app/(app)/portal/workspace-data-manager.tsx");
  assert.match(manager, /const readOnlyTab = tab === "activity" \|\| tab === "import" \|\| !canEdit;/);
  assert.match(manager, /tabs\.filter\(\(item\) => item\.key !== "import" \|\| canImport\)/);
  assert.match(manager, /tab === "import" && canImport \?/);

  const app = await read("app/(app)/portal/portal-app.tsx");
  assert.match(app, /canEdit=\{runtimeContext\?\.capabilities\?\.\["sites\.edit"\] !== false\}/);
  assert.match(app, /canImport=\{runtimeContext\?\.capabilities\?\.\["data\.import"\] !== false\}/);
  assert.match(app, /\["users\.invite"\] !== false \? \(\s*<Link[\s\S]{0,120}href="\/dashboard\/account\/invite"/);
  assert.match(app, /\["integrations\.manage"\] !== false \? \(\s*<Link[\s\S]{0,120}href="\/dashboard\/account\/integrations"/);

  const menu = await read("app/(app)/portal/account-menu.tsx");
  assert.match(menu, /useCapability\("data\.import"\)/);
  assert.match(menu, /item\.key !== "import" \|\| canImport !== false/);
  assert.match(menu, /item\.key !== "developers" \|\| canIntegrate !== false/);
});

/* QA 2026-10-01: on the Overview (which never loads the job list) the bell said
   "You're all caught up" over two jobs needing attention and the Jobs badge was
   blank. `/api/notifications` now returns the bell's candidates and the open
   count under the job feed's own scope. */
test("the Overview's bell and Jobs badge do not depend on the job list", async () => {
  const route = await read("app/api/notifications/route.ts");
  assert.match(route, /liveWorkOrderCondition\(orgId\),\s*memberSiteCondition\(maintenanceRequests\.siteId, siteScope\),\s*sql`not \$\{closedJobSql\}`/);
  assert.match(route, /candidates: candidates\.map\(\(row\) => exposeRequest\(row\)\)/);
  const app = await read("app/(app)/portal/portal-app.tsx");
  assert.match(app, /jobListLoaded \? notificationCandidates\(requests\) : serverNotificationCandidates/);
  assert.match(app, /: \(serverOpenJobs \?\? 0\);/);
});

/* QA 2026-10-01, second pass: Sites, Assets, Settings and Team. Verified in the
   browser: client sees none of these, manager sees Add site/asset only, owner all. */
test("register, settings and team controls follow their capability", async () => {
  const sites = await read("app/(app)/portal/sites/sites-manager.tsx");
  assert.match(sites, /const canEditSites = useCapability\("sites\.edit"\) !== false;/);
  assert.match(sites, /const canImportSites = useCapability\("data\.import"\) !== false;/);
  assert.match(sites, /onAddSite=\{canEditSites \?/);
  const list = await read("app/(app)/portal/ops/sites-list.tsx");
  assert.match(list, /onAddSite\?: \(\) => void;/);
  const assets = await read("app/(app)/portal/assets/assets-manager.tsx");
  assert.match(assets, /onAddAsset=\{!canEdit \? undefined :/);
  const app = await read("app/(app)/portal/portal-app.tsx");
  assert.match(app, /canEditSettings=\{runtimeContext\?\.capabilities\?\.\["settings\.edit"\] !== false\}/);
  assert.match(app, /canManage=\{runtimeContext\?\.capabilities\?\.\["users\.edit"\] !== false\}/);
  assert.doesNotMatch(app, /role: "Super Admin", active: true, lastActive: "Now"/, "the fallback row shows the reader's own role");
});
