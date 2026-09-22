/**
 * SEARCH ACROSS WORKSPACES — the platform console's, and only the console's.
 *
 * §36 shipped `/api/search` single-workspace ON PURPOSE: "the organisation comes
 * from the session through `scopedDb`, never from the request, so there is no
 * parameter to point this at another tenant". The owner's note at the time was
 * that /admin search MAY span workspaces. The dangerous way to grant that is a
 * widening parameter on the route every member of every workspace can call, so
 * the first thing this file pins is that no such parameter appeared.
 *
 * The rest is the properties a cross-tenant answer has to have:
 *   1. the gate is `platformAdmin` AND a proved session — not a capability,
 *      because every capability in this product is per-workspace and this answer
 *      is about all of them at once;
 *   2. every query is confined to `scope.organisationIds`, which is the widened
 *      set platform staff already get (`crossOrganisation: platformAdmin`) and
 *      the same instrument `/api/audit` and the enquiry inbox use;
 *   3. every workspace-scoped row NAMES its workspace, because a cross-tenant
 *      list in which two clients' stores are indistinguishable is worse than no
 *      list;
 *   4. getting to a row goes through `/api/context`, so the server still decides
 *      whether this actor may open that workspace;
 *   5. what it cannot answer is stated on the screen, from the server's list.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PLATFORM_SECTIONS,
  PLATFORM_SECTION_KEYS,
  platformSection,
} from "../app/lib/platform-sections.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
/* Comments stripped before every ABSENCE assertion: this repo has had tests pass
   on their own explanatory prose more than once. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the portal's own search is untouched and still cannot be pointed at another tenant", async () => {
  const portal = code(await read("app/api/search/route.ts"));
  assert.doesNotMatch(
    portal,
    /organisationIds|allWorkspaces|crossOrganisation|platformAdmin/,
    "§36 must stay single-workspace: a widening switch there is reachable by every member of every workspace",
  );
  /* Its organisation still comes from the session, never from the request. */
  assert.match(portal, /const \{ db, orgId, siteScope \} = scope;/);
});

test("the console's search answers to platform staff, before it reads anything", async () => {
  const route = code(await read("app/api/admin/search/route.ts"));
  const body = route.slice(route.indexOf("export async function GET"));
  assert.match(
    body.slice(0, 700),
    /if \(scope\.platformAdmin !== true \|\| !scope\.authenticated\) \{/,
    "platform staff AND a proved session",
  );
  assert.match(body.slice(0, 900), /status: 403/);
  assert.ok(
    body.indexOf("platformAdmin") < body.indexOf("searchNeedle"),
    "the gate is asked before the query is even parsed",
  );
  /* NOT a capability, for the reason the Clients and enquiries screens record. */
  assert.doesNotMatch(route, /scopedDbWithCapability|requireCapability/);
});

test("every query is confined to the workspaces this actor may see", async () => {
  const route = code(await read("app/api/admin/search/route.ts"));
  /* One source of workspace ids, and it is the scope's — never the request's. */
  assert.match(route, /const ids = scope\.organisationIds;/);
  assert.doesNotMatch(
    route,
    /searchParams\.get\("organisationId"\)|payload\.organisationId/,
    "a request must not be able to name the workspaces it searches",
  );
  /* Each table that carries an organisation is filtered by it. */
  for (const table of ["maintenanceRequests", "sites", "contractors", "memberships", "leads"]) {
    assert.match(
      route,
      new RegExp(String.raw`inArray\(${table}\.organisationId, (ids|matchedWorkspaces)`),
      `${table} must be confined to the actor's workspaces`,
    );
  }
  /* The workspaces themselves are keyed by `id`, and the list the screen shows —
     and every row's workspace name — is built from that one confined read. */
  assert.match(route, /\.from\(organisations\)\s*\.where\(inArray\(organisations\.id, ids\)\)/);
  /* A binned job is not a result. */
  assert.match(route, /isNull\(maintenanceRequests\.deletedAt\)/);
  /* And an empty set answers nothing rather than everything. */
  assert.match(route, /if \(!ids\.length\) \{\s*return Response\.json\(\{ query: raw\.trim\(\), groups/);
});

test("every workspace-scoped row names its workspace, and the platform's own rows do not pretend to have one", async () => {
  const route = await read("app/api/admin/search/route.ts");
  assert.match(route, /const named = \(organisationId: string\) => \(\{\s*workspaceId: organisationId,\s*workspaceName: names\.get\(organisationId\) \?\? null,/);
  for (const group of ["jobs", "sites", "contractors", "people", "workspaces"]) {
    const at = route.indexOf(`key: "${group}"`);
    assert.ok(at > 0, `${group} is a group`);
    assert.match(route.slice(at, at + 900), /\.\.\.named\(/, `${group} rows must name their workspace`);
  }
  /* An enquiry belongs to the platform whatever organisation id its row carries —
     the reason is in `app/api/leads/route.ts` — so it must NOT be labelled with
     one, and neither must a website page. */
  for (const group of ["pages", "enquiries"]) {
    const at = route.indexOf(`key: "${group}"`);
    assert.match(route.slice(at, at + 900), /workspaceId: null,\s*workspaceName: null,/, `${group} must not wear a workspace's name`);
  }
});

test("opening a result goes through the server's own workspace switch", async () => {
  const view = code(await read("app/(app)/admin/console-search-view.tsx"));
  assert.match(
    view,
    /body: JSON\.stringify\(\{ action: "select_organisation", organisationId: item\.workspaceId \}\)/,
    "the same door the Clients screen uses, which refuses a workspace the actor is not in",
  );
  /* The screen must not decide it itself, and must not carry a workspace in a
     link that would open the portal without switching. */
  assert.doesNotMatch(view, /platformAdmin|organisationIds/);
  assert.match(view, /window\.location\.assign\(item\.portalHref \?\? "\/dashboard"\)/, "a full load, because the switch sets a cookie the server reads");
});

test("what the search cannot answer is stated from the server's list, not the screen's", async () => {
  const route = await read("app/api/admin/search/route.ts");
  const view = await read("app/(app)/admin/console-search-view.tsx");
  assert.match(route, /export const CONSOLE_SEARCH_OMISSIONS: readonly string\[\]/);
  /* Documents and finance are the two deliberate absences, and each says why. */
  assert.match(route, /Documents are not searched here\./);
  assert.match(route, /Finance is not searched here\./);
  assert.match(view, /data\.omissions\.map/, "the screen prints the server's list rather than its own copy");
  assert.doesNotMatch(code(view), /Documents are not searched/, "a second copy of that sentence would drift");
});

test("the rail lists it second, with the API it answers to recorded", async () => {
  const entry = platformSection("search");
  assert.ok(entry, "the catalogue has a search section");
  assert.equal(entry.capability, null, "no per-workspace capability can describe a cross-workspace answer");
  assert.equal(PLATFORM_SECTION_KEYS[1], "search", "a way into everything belongs beside the dashboard");
  assert.equal(PLATFORM_SECTIONS.length, PLATFORM_SECTION_KEYS.length);
  /* The page exists, guards in the order that matters, and the shell draws it. */
  const page = await read("app/(app)/admin/search/page.tsx");
  assert.ok(page.indexOf("requirePageSession") < page.indexOf("requirePlatformAdmin"), "sign in first, then platform staff");
  assert.match(page, /section="search"/);
  const shell = await read("app/(app)/admin/platform-shell.tsx");
  assert.match(shell, /case "search":\s*return <ConsoleSearchView \/>;/);
});

test("the stylesheet builds on the admin kit and opens no new breakpoint", async () => {
  const css = await read("app/(app)/admin/console-search.css");
  for (const shared of ["admin-console", "admin-toolbar", "admin-field", "admin-notice", "admin-mini"]) {
    assert.doesNotMatch(
      css,
      new RegExp(`^\\.${shared}\\s*\\{`, "m"),
      `views/admin-console.css owns .${shared}; a second definition is drift`,
    );
  }
  /* Only 640/767/768/1024/1280 are permitted anywhere in this product. */
  assert.deepEqual(
    [...css.matchAll(/@media[^{]*?(\d{3,4})px/g)]
      .map((match) => match[1])
      .filter((width) => !["640", "767", "768", "1024", "1280"].includes(width)),
    [],
  );
  /* Tokens, never literals, for colour. */
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, "colour comes from tokens");
});
