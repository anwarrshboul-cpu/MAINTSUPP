/**
 * Phase 3 — the Platform Super Admin console at `/admin` (Master Specification §5).
 *
 * WHAT THIS FILE IS ACTUALLY GUARDING
 *
 * Three things, and only the first is the obvious one:
 *
 *   1. THE SECOND GUARD. `tests/portal-auth-guard.test.mjs` already walks every
 *      `page.tsx` under `app/` and fails unless each calls `requirePageSession`.
 *      That answers "are you signed in". Every screen here needs a second,
 *      narrower answer — "are you MAINTSUPP platform staff" — and it has to come
 *      AFTER the first, because reversing them bounces an anonymous request to
 *      `/dashboard` and loses the address it asked for. Nothing else in the suite
 *      knows this console exists, so the enumeration lives here.
 *
 *   2. THAT THE GUARD IS NOT A CAPABILITY. `can()` returns true for `super_admin`
 *      before it reads anything at all, so no capability can tell the platform's
 *      own staff from a client company's most senior role — which is the entire
 *      distinction this console rests on. A future batch reaching for
 *      `requireCapability` here would produce a console an Owner can open, and it
 *      would look correct.
 *
 *   3. THAT NOTHING WAS TAKEN FROM THE PORTAL. The portal shell is 10,000 lines
 *      whose declarations five other test files slice BY STRING INDEX; the
 *      navigation catalogue is held level across four. This console was built as a
 *      sibling of `views/account-shell.tsx` precisely so none of that had to move,
 *      and these tests make that a rule rather than a preference.
 *
 * A NOTE ON WHAT IS DELIBERATELY ABSENT
 *
 * The reference design shows ten rail entries. Five exist. Branding, Integrations,
 * Billing and platform Settings each need a server side that does not exist, and a
 * rail entry leading to an empty screen is the "configuration that does not affect
 * components" this codebase refuses everywhere else. The tests below assert their
 * ABSENCE, so adding one is a deliberate act that arrives with its API.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PLATFORM_ELSEWHERE,
  PLATFORM_SECTIONS,
  PLATFORM_SECTION_KEYS,
  platformSection,
  platformSectionPath,
} from "../app/lib/platform-sections.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const decommented = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The console entries, by the route file each lives in.
 *
 * EIGHT. `pages` was added the day `/api/site-pages` existed, `leads` the day
 * `GET /api/leads` stopped being a 501, and `applications` the day
 * `/api/contractor-applications/inbox` gave the application rows a reader — which is the rule in
 * `platform-sections.ts` being kept rather than bent: a rail entry is a promise that
 * there is something behind it. The four screens with no server side are still
 * absent, and the test below still proves it.
 *
 * THE ORDER MATTERS: the assertion below deep-equals this list against
 * `PLATFORM_SECTION_KEYS`, so these must stay in the catalogue's order. `pages`
 * precedes `leads` because that is the order the two phases merged in.
 */
const ENTRIES = [
  ["", "app/(app)/admin/page.tsx", "/admin"],
  /* TWELVE: Search across workspaces arrived with `/api/admin/search`, and is
     listed SECOND because it is a way into everything else in this rail. */
  ["search", "app/(app)/admin/search/page.tsx", "/admin/search"],
  ["clients", "app/(app)/admin/clients/page.tsx", "/admin/clients"],
  ["users", "app/(app)/admin/users/page.tsx", "/admin/users"],
  ["roles", "app/(app)/admin/roles/page.tsx", "/admin/roles"],
  ["audit", "app/(app)/admin/audit/page.tsx", "/admin/audit"],
  ["pages", "app/(app)/admin/pages/page.tsx", "/admin/pages"],
  /* TEN: Website navigation (decision J, §77 item 11) arrived with
     `/api/site-navigation`, and sits beside Website pages — the same website. */
  ["navigation", "app/(app)/admin/navigation/page.tsx", "/admin/navigation"],
  /* ELEVEN: Website media (decision K, §77 item 12) arrived with `/api/cms-media`. */
  ["media", "app/(app)/admin/media/page.tsx", "/admin/media"],
  ["leads", "app/(app)/admin/leads/page.tsx", "/admin/leads"],
  ["applications", "app/(app)/admin/applications/page.tsx", "/admin/applications"],
  /* NINE: Backups (§39) arrived with `/api/admin/backups` — visibility only. */
  ["backups", "app/(app)/admin/backups/page.tsx", "/admin/backups"],
];

/* ------------------------------------------------------------------ */
/* The catalogue                                                       */
/* ------------------------------------------------------------------ */

test("the console lists twelve screens, and every one has a route", async () => {
  assert.equal(PLATFORM_SECTIONS.length, ENTRIES.length);
  assert.deepStrictEqual(
    [...PLATFORM_SECTION_KEYS],
    ENTRIES.map(([key]) => key),
    "the catalogue and the route files must name the same screens in the same order",
  );
  for (const [key, file, route] of ENTRIES) {
    await read(file); // throws if the route is missing
    assert.equal(platformSectionPath(key), route);
    assert.ok(platformSection(key), `${key || "(dashboard)"} must be in the catalogue`);
  }
  assert.equal(
    new Set(PLATFORM_SECTION_KEYS).size,
    PLATFORM_SECTIONS.length,
    "a duplicate key would give one screen two rail entries",
  );
});

test("the four screens with no server side are NOT listed", () => {
  /*
   * Branding/Theme, Integrations, Billing and platform Settings appear in the
   * reference design and have no platform API — Billing has no payment integration
   * anywhere in this product. A rail entry is a promise that there is something
   * behind it. Each arrives with its API or not at all, and this assertion is what
   * makes adding one a deliberate act.
   */
  const absent = ["branding", "theme", "integrations", "billing", "settings"];
  for (const key of absent) {
    assert.equal(
      platformSection(key),
      null,
      `${key} has no platform API, so it must not be offered in the rail`,
    );
  }
});

test("Reconcile stays a workspace tool, and says why", async () => {
  /*
   * A different reason from the four above: `/admin/reconcile` already exists and
   * already means something. It reports figures for ONE workspace, offers a purge
   * inside it, answers to `settings.edit`, and its route refuses outright outside
   * non-production. Moving it into the console would take a URL with a documented
   * meaning and quietly change it.
   */
  assert.equal(platformSection("reconcile"), null);

  const redirect = await read("app/(app)/admin/reconcile/page.tsx");
  assert.match(
    redirect,
    /redirect\("\/dashboard\/reconcile"\)/,
    "it must still be the redirect it was",
  );
  assert.match(
    redirect,
    /THIS COMMENT USED TO ARGUE THAT `\/admin` DOES NOT EXIST/,
    "and the reversal must be recorded rather than the old reasoning deleted — " +
      "per CLAUDE.md, a decision this phase overturns keeps its record",
  );
  assert.match(
    redirect,
    /the reconciler is not a platform view/,
    "with the reason it is still not a console screen",
  );
});

test("every icon is one the product has, and every capability is real", async () => {
  /*
   * `app/components.tsx` is a CLOSED union of 51 names and
   * `tests/stage-twentythree-sections.test.mjs` pins it against the renderer, so an
   * invented name is a compile error there and a blank square here. There is no
   * `billing`, `palette`, `plug` or `puzzle` — which is part of why the four
   * screens above are absent rather than stubbed.
   */
  const components = await read("app/components.tsx");
  const union = components.slice(components.indexOf("export type IconName"));
  const icons = new Set(
    [...union.slice(0, union.indexOf(";")).matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]),
  );
  assert.ok(icons.size >= 40, `the icon union should have been found; got ${icons.size}`);

  const permissions = await read("app/lib/permissions.ts");
  const capabilities = new Set(
    [
      ...decommented(
        permissions.slice(
          permissions.indexOf("export const CAPABILITY_CATALOGUE = ["),
          permissions.indexOf("export const SUPER_ADMIN_ONLY"),
        ),
      ).matchAll(/key:\s*"([^"]+)"/g),
    ].map((m) => m[1]),
  );
  assert.ok(capabilities.size >= 18, "the capability catalogue should have been found");

  for (const section of PLATFORM_SECTIONS) {
    assert.ok(icons.has(section.icon), `${section.key || "(dashboard)"} uses an unknown icon`);
    assert.ok(
      section.blurb.length > 20,
      `${section.key || "(dashboard)"} needs a blurb — the rail's title and the heading read it`,
    );
    if (section.capability === null) continue;
    assert.ok(
      capabilities.has(section.capability),
      `${section.key || "(dashboard)"} names ${section.capability}, which is not a capability`,
    );
  }
  for (const entry of PLATFORM_ELSEWHERE) {
    assert.ok(icons.has(entry.icon), `${entry.href} uses an unknown icon`);
  }
});

test("the catalogue is a plain module a server component can read", async () => {
  /*
   * Importing a value out of a `"use client"` file gives back a client reference,
   * not the array — so a route could not read the keys from there. `account-panels.ts`
   * is a separate module for exactly this reason and says so.
   */
  const source = await read("app/lib/platform-sections.ts");
  assert.ok(
    !/^\s*"use client"/m.test(source),
    'platform-sections.ts must NOT be "use client" — the routes read it on the server',
  );
});

/* ------------------------------------------------------------------ */
/* The two guards                                                      */
/* ------------------------------------------------------------------ */

test("every entry calls both guards, in the order that matters", async () => {
  for (const [key, file, route] of ENTRIES) {
    const source = await read(file);
    const code = decommented(source);

    const session = code.indexOf("requirePageSession(");
    const platform = code.indexOf("requirePlatformAdmin(");
    assert.ok(session > 0, `${file} must call requirePageSession`);
    assert.ok(platform > 0, `${file} must call requirePlatformAdmin`);
    assert.ok(
      session < platform,
      `${file} must establish the session BEFORE platform-admin. Reversed, an ` +
        "anonymous request is sent to /dashboard, which sends it to " +
        "/login?next=/dashboard — losing the address it actually asked for.",
    );
    assert.match(
      code,
      new RegExp(`requirePageSession\\("${route.replace(/\//g, "\\/")}"\\)`),
      `${file} must name its OWN address, so signing in comes back here`,
    );
    assert.match(
      code,
      new RegExp(`section="${key}"`),
      `${file} must render the ${key || "dashboard"} section`,
    );
    /* `await`, not a bare call. An un-awaited guard returns a promise, the redirect
       never throws in time, and the page renders for everybody. */
    assert.match(code, /await requirePageSession\(/, `${file} must await the session guard`);
    assert.match(code, /await requirePlatformAdmin\(\)/, `${file} must await the platform guard`);
  }
});

test("nothing under /admin flushes markup before the guards run", async () => {
  /*
   * The rule `tests/portal-auth-guard.test.mjs` already enforces for the rest of
   * `app/(app)`, restated for this subtree because a `loading.tsx` added here would
   * stream the console's frame to an anonymous request before either guard had
   * answered.
   */
  const offenders = [];
  async function walk(dir) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await walk(`${dir}/${entry.name}`);
      } else if (["loading.tsx", "template.tsx", "default.tsx"].includes(entry.name)) {
        offenders.push(`${dir}/${entry.name}`);
      }
    }
  }
  await walk("app/(app)/admin");
  assert.deepStrictEqual(
    offenders,
    [],
    "one of these flushes markup before the guard has run. If a loading state is " +
      "genuinely wanted, the guard has to move above it — into a layout — first.",
  );
});

test("the platform guard is NOT a capability check, and that is the point", async () => {
  /*
   * `can()` returns true for `super_admin` before it reads anything, so a
   * capability cannot distinguish the platform's own staff from a client company's
   * most senior role — and that distinction is the whole console. A future batch
   * reaching for `requireCapability` here would produce a console an Owner can
   * open, and it would look correct.
   */
  const guard = await read("app/lib/platform-guard.ts");
  const code = decommented(guard);
  assert.match(
    code,
    /scope\.platformAdmin === true/,
    "the decision is `platformAdmin`, which resolveTenantAccess reads from the " +
      "platform_admins table and never from the request",
  );
  assert.ok(
    !/requireCapability|\bcan\(/.test(code),
    "it must not gate on a capability — can() returns true for super_admin before " +
      "it reads anything, so a capability cannot express 'platform staff'",
  );
});

test("the platform guard fails CLOSED, unlike the module guard", async () => {
  /*
   * The opposite choice from `requireModuleAccess`, deliberately. A module switch is
   * product configuration and every API behind it still enforces its capability, so
   * failing open there costs one screen. This is an authorisation boundary and the
   * screens behind it read across every client's data, so an unresolvable request is
   * refused. Those costs are not comparable and the code has to pick the right one.
   */
  const guard = await read("app/lib/platform-guard.ts");
  const code = decommented(guard);
  assert.match(
    code,
    /} catch \{\s*allowed = false;/,
    "an unresolvable request must be refused, not admitted",
  );
  assert.match(code, /if \(!allowed\) redirect\(PLATFORM_FALLBACK_PATH\);/);
  assert.match(
    guard,
    /WHY THIS FAILS CLOSED, UNLIKE THE MODULE GUARD/,
    "and the contrast must be written down, so the next person does not copy the " +
      "wrong one of the two",
  );
});

test("the refusal goes to the workspace, and the redirect is outside the try", async () => {
  const guard = await read("app/lib/platform-guard.ts");
  assert.match(guard, /PLATFORM_FALLBACK_PATH = "\/dashboard"/);

  const code = decommented(guard);
  const tryEnd = code.indexOf("allowed = false;");
  const redirectAt = code.indexOf("redirect(PLATFORM_FALLBACK_PATH)");
  assert.ok(
    redirectAt > tryEnd,
    "redirect() throws, so calling it inside the try would let the catch swallow " +
      "the control-flow signal and render the console anyway — the standard " +
      "version of this bug",
  );
  assert.ok(
    !/notFound\(/.test(code),
    "not a 404: this console's existence is not a secret, and a 404 for a URL " +
      "that plainly exists sends people to support to report a broken link",
  );
});

/* ------------------------------------------------------------------ */
/* Reuse, and what was NOT touched                                     */
/* ------------------------------------------------------------------ */

test("the shell mounts the existing screens rather than reimplementing them", async () => {
  /*
   * All four take no props, fetch their own data and refuse on their own through
   * `useAdminResource`'s four-state model. Two of them already render a grouped
   * workspace picker, which is what makes them a platform console on the first day.
   */
  const shell = await read("app/(app)/admin/platform-shell.tsx");
  for (const [view, from] of [
    ["AdminClientsView", "../portal/views/admin-clients"],
    ["AdminRolesView", "../portal/views/admin-roles"],
    ["AdminUsersView", "../portal/views/admin-users"],
    ["AuditLog", "../portal/views/audit-log"],
  ]) {
    assert.match(
      shell,
      new RegExp(`import \\{ ${view} \\} from "${from.replace(/\//g, "\\/")}";`),
      `${view} must be imported, not rebuilt`,
    );
  }
  assert.match(shell, /<AdminClientsView onSwitched=/);
  assert.match(shell, /<AdminUsersView \/>/);
  assert.match(shell, /<AdminRolesView \/>/);
  assert.match(shell, /<AuditLog \/>/);
});

test("the shell takes nothing from the portal shell", async () => {
  /*
   * The property this phase was designed around. Five test files slice
   * `portal-app.tsx` by string index between named declarations, so moving one
   * produces an empty slice rather than a loud failure — and the navigation
   * catalogue is held level across four more. Building a sibling of
   * `views/account-shell.tsx` is what keeps all of that still.
   */
  /* Comments stripped first. Both of these names appear in the file's header,
     which explains at length why they are NOT used — an assertion that could not
     tell the explanation from the thing would be unfixable. The same reason
     `tests/portal-auth-guard.test.mjs` strips comments before its own greps. */
  const shell = decommented(await read("app/(app)/admin/platform-shell.tsx"));
  assert.ok(
    !/from "\.\.\/portal\/portal-app"/.test(shell),
    "the console must not import from portal-app.tsx",
  );
  assert.ok(
    !/SidebarNav/.test(shell),
    "and must not reuse SidebarNav: its arrangement comes from /api/navigation, " +
      "which merges against BUILT_IN_ORDER and DROPS any key that list does not " +
      "contain — so reusing it would demand a platform entry in the PORTAL's " +
      "route map, tripping four source-slice pins on the way",
  );

  /*
   * And the portal's navigation layer knows nothing about this console.
   *
   * NOT "no console key appears in BUILT_IN_ORDER" — that assertion was written
   * first and it was wrong. `audit` appears in both, because the portal has had its
   * own Audit SECTION at `/dashboard/audit` all along and the console's screen at
   * `/admin/audit` happens to share the word. Two namespaces may use one noun; both
   * mount the same `AuditLog`, which is the point of reusing it.
   *
   * The real contract is that `layout.ts` gained nothing: it does not import the
   * platform catalogue, it names no `/admin` route, and it still holds exactly the
   * nineteen portal sections it held before. A platform key registered there is
   * what would demand a `sectionRoutes` entry in the PORTAL's route map.
   */
  const layout = await read("app/api/navigation/layout.ts");
  assert.ok(
    !/platform-sections|PLATFORM_/.test(layout),
    "the portal's navigation layer must not know the console exists",
  );
  assert.ok(
    !/"\/admin/.test(layout),
    "and must name no /admin route",
  );
  const builtIn = layout.slice(
    layout.indexOf("BUILT_IN_ORDER"),
    layout.indexOf("];", layout.indexOf("BUILT_IN_ORDER")),
  );
  const portalKeys = [...decommented(builtIn).matchAll(/key: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(
    portalKeys.length,
    19,
    "the portal still has its nineteen sections — this phase added none and took none",
  );
});

test("the console is themed by the layout, and keeps itself in step", async () => {
  /*
   * `AccountShell` learned this the hard way: it hard-coded `"dark"`, and because
   * it was the only write on its own routes an explicit Light choice was discarded
   * and the whole area became a permanently dark island. The layout stamps the
   * attribute before paint; this hook keeps it current afterwards, which matters
   * because the console carries no theme control of its own.
   */
  const shell = await read("app/(app)/admin/platform-shell.tsx");
  assert.match(shell, /useAppliedTheme\(\);/);
  assert.ok(
    !/data-theme="dark"|"dark"/.test(decommented(shell)),
    "no hard-coded theme — that is the bug account-shell.tsx already fixed",
  );

  const layout = await read("app/(app)/layout.tsx");
  assert.match(
    layout,
    /themeBootScript/,
    "the layout must still stamp the theme before paint for everything under (app)",
  );
});

test("the console says it is the console", async () => {
  /*
   * It looks like the client portal and answers across every client. One badge is
   * cheaper than a reader inferring that from the URL, and far cheaper than them
   * not inferring it at all.
   */
  const shell = await read("app/(app)/admin/platform-shell.tsx");
  assert.match(shell, /platform-topbar__badge/);
  assert.match(shell, />Platform</);
  assert.match(
    shell,
    /href="\/dashboard"[\s\S]{0,200}Back to workspace/,
    "and carries a way back, as account-shell.tsx does",
  );
});

test("each screen names itself in the document title", async () => {
  const titles = new Set();
  for (const [, file] of ENTRIES) {
    const source = await read(file);
    const match = /title: "([^"]+)"/.exec(source);
    assert.ok(match, `${file} must set a metadata title`);
    titles.add(match[1]);
  }
  assert.equal(titles.size, ENTRIES.length, "one distinct browser title per screen");
});

/* ------------------------------------------------------------------ */
/* The Dashboard                                                       */
/* ------------------------------------------------------------------ */

test("the Dashboard reads the platform API that already exists", async () => {
  /*
   * `GET /api/admin/clients` is already the platform-wide list, already gated on
   * `clients.view_all`, and already restricts its rows to `context.organisationIds`
   * — which for a Platform Super Admin is every active organisation. A
   * `/api/admin/platform-summary` beside it would be a second place for the same
   * numbers to be derived, and the first time one changed they would disagree.
   */
  const overview = await read("app/(app)/admin/platform-overview.tsx");
  assert.match(overview, /useAdminResource<ClientsPayload>\("\/api\/admin\/clients"\)/);

  const route = await read("app/api/admin/clients/route.ts");
  assert.match(route, /clients\.view_all/, "and that route must still hold the capability");
  assert.match(
    route,
    /organisationIds/,
    "and must still restrict its rows — two gates, neither substituting for the other",
  );
});

test("the Dashboard trusts the server's totals rather than re-summing", async () => {
  /*
   * The payload carries `totals`, computed server-side from the same rows. Summing
   * `clients` in the browser gives the same figures today and a different one the
   * day the route starts paginating — and a dashboard whose headline disagrees with
   * its own table is worse than one with no headline.
   */
  const overview = await read("app/(app)/admin/platform-overview.tsx");
  assert.match(overview, /data\.totals\?\.\[total\.key\]/);
  assert.ok(
    !/\.reduce\(/.test(decommented(overview)),
    "the totals must not be re-derived in the browser",
  );
});

test("the Dashboard tells a refusal apart from an empty installation", async () => {
  /*
   * `useAdminResource` distinguishes loading / loaded / DENIED / broken, and the
   * third is the one that matters on a console reached by URL. A 403 arriving here
   * means the capability and the platform-admin flag disagree — a real condition
   * worth naming, not something to paint as "no clients yet".
   */
  const overview = await read("app/(app)/admin/platform-overview.tsx");
  assert.match(overview, /if \(denied\) \{/);
  assert.match(overview, /tone="denied"/);
  assert.match(overview, /tone="error"/);
  assert.match(overview, /tone="empty"/);
  assert.match(overview, /No client workspaces yet/);
});

/* ------------------------------------------------------------------ */
/* Getting there                                                       */
/* ------------------------------------------------------------------ */

test("the avatar menu offers the console on platformAdmin, never on a capability", async () => {
  const menu = await read("app/(app)/portal/account-menu.tsx");
  assert.match(menu, /usePlatformAdmin\(\)/);
  assert.match(menu, /href: "\/admin",/);
  assert.match(
    menu,
    /item\.key !== "platform" \|\| isPlatformStaff === true/,
    "`=== true` keeps it hidden while the answer is in flight — showing a door to " +
      "the platform console and taking it away is worse than showing it late",
  );
  /* And the WORKSPACE administration entry is untouched: it opens
     `/dashboard/admin` on `users.view`, which is right for an Owner or an Admin. */
  assert.match(menu, /item\.key !== "admin" \|\| canAdminister === true/);
  assert.match(menu, /href: "\/dashboard\/admin",/);
});

test("the platform signal shares the one context read", async () => {
  /*
   * `tests/shared-context-and-navigation-reads.test.mjs` forbids a second direct
   * read of `/api/context`, and it was written because two readers of one endpoint
   * fetched it twice on every dashboard load — 433ms and 298ms for the same bytes.
   */
  const hook = await read("app/lib/client-capabilities.ts");
  assert.match(hook, /export function usePlatformAdmin\(\): boolean \| null/);
  assert.match(hook, /fetchRuntimeContext\(\)/);
  assert.ok(
    !/fetch\("\/api\/context"/.test(hook),
    "it must go through the shared memo, never fetch the endpoint itself",
  );
  assert.match(
    hook,
    /typeof identity\.platformAdmin !== "boolean"/,
    "a payload from before this field existed leaves it UNANSWERED rather than " +
      "answering no — the same rule capabilities follow",
  );
});

test("every console path is in the auth-guard's live list", async () => {
  const guard = await read("tests/portal-auth-guard.test.mjs");
  const list = guard.slice(guard.indexOf("PROTECTED_PATHS"), guard.indexOf("];", guard.indexOf("PROTECTED_PATHS")));
  for (const [, , route] of ENTRIES) {
    assert.match(
      list,
      new RegExp(`"${route.replace(/\//g, "\\/")}",`),
      `${route} must be checked by the signed-out live test too`,
    );
  }
});

test("the worker already treats /admin as auth-dependent", async () => {
  /*
   * Measured rather than assumed, because it is the one piece of infrastructure a
   * new namespace usually needs and this one already had: `/admin` responses get
   * `Cache-Control: private, no-store` and `Vary: Cookie`, so a redirect for one
   * reader cannot be served to another. No worker change was needed for this phase.
   */
  const worker = await read("worker/index.ts");
  assert.match(worker, /pathname === "\/admin"/);
  assert.match(worker, /pathname\.startsWith\("\/admin\/"\)/);
});

/* ------------------------------------------------------------------ */
/* The stylesheet                                                      */
/* ------------------------------------------------------------------ */

test("the console's stylesheet spends no literal and one allowed breakpoint", async () => {
  const css = await read("app/(app)/admin/platform-shell.css");
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");

  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(body), "no hex literal may appear");
  assert.ok(!/\b(?:rgba?|hsla?)\(/.test(body), "no colour function either — use the tokens");

  /* Tokens only, and every one must exist. A `var()` naming nothing renders as
     nothing, which on a page background is a white screen. */
  const globals = await read("app/globals.css");
  for (const token of new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))) {
    assert.ok(globals.includes(`${token}:`), `${token} is not defined in globals.css`);
  }

  const allowed = new Set(["640", "767", "768", "1024", "1280"]);
  const widths = [...body.matchAll(/@media[^{]*?(\d+)px/g)].map((m) => m[1]);
  assert.equal(widths.length, 1, "one breakpoint is enough for a rail and a table");
  for (const width of widths) {
    assert.ok(allowed.has(width), `${width}px is not one of 640 / 767 / 768 / 1024 / 1280`);
  }
});

test("the console does not restate the admin kit's own styling", async () => {
  /*
   * `views/admin-console.css` owns `.admin-notice`, `.admin-toolbar`, `.admin-field`,
   * `.admin-avatar` and `.admin-flash`, and the four mounted screens import it. A
   * second definition here would be the drift this phase was built to avoid.
   */
  /* Comments stripped: the header names these four to say admin-console.css owns
     them, which is the opposite of restating them. */
  const css = decommented(await read("app/(app)/admin/platform-shell.css"));
  for (const owned of [".admin-notice", ".admin-toolbar", ".admin-field", ".admin-flash"]) {
    assert.ok(
      !css.includes(owned),
      `${owned} belongs to views/admin-console.css — do not restate it here`,
    );
  }
});
