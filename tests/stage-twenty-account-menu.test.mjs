import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Stage 20 — the top-right of the page.
 *
 * These tests guard three things the avatar menu is easy to get wrong:
 *
 *   1. Shape. monday's menu is a two-column panel with a fixed item order, a
 *      plan pill in the header and a working-status row along the bottom. The
 *      order is asserted, not described, so an item cannot quietly move.
 *
 *   2. No dead ends. Every item must resolve to a destination, and every
 *      destination must be a route that exists in this repository or a route
 *      another part of Stage 20 owns.
 *
 *   3. No fiction. The screens that could most easily be invented — Trash,
 *      Change theme and Shortcuts — are checked against the thing they claim to
 *      describe: the schema, the stylesheets and the key handlers themselves.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const MENU = "app/(app)/portal/account-menu.tsx";
const MENU_CSS = "app/(app)/portal/account-menu.css";
const PANELS = "app/(app)/portal/views/account-panels.ts";
const SHELL = "app/(app)/portal/views/account-shell.tsx";
const PORTAL = "app/(app)/portal/portal-app.tsx";
const ROUTE = "app/(app)/dashboard/account/[[...panel]]/page.tsx";
const ACCOUNT_API = "app/api/account/route.ts";
const TRASH_API = "app/api/account/trash/route.ts";
const ARCHIVE_API = "app/api/account/archive/route.ts";
const TRASH_VIEW = "app/(app)/portal/views/account-workspace.tsx";
const BIN_API = "app/api/trash/route.ts";
const EXPLORE_VIEW = "app/(app)/portal/views/account-explore.tsx";

/**
 * monday.com's avatar menu, in monday's own order. This is the specification
 * the rest of the file is measured against; the MAINTSUPP label beside each one
 * is the owner's chosen translation.
 */
const MONDAY_ACCOUNT_COLUMN = [
  ["My profile", "My profile"],
  ["Import data", "Import data"],
  ["Developers", "Developers"],
  ["Spaces", "Workspaces"],
  ["Trash", "Trash"],
  ["Archive", "Archive"],
  ["Administration", "Administration"],
  ["Teams", "Teams"],
  ["Log out", "Log out"],
];

const MONDAY_EXPLORE_COLUMN = [
  ["App marketplace", "Integrations"],
  ["Mobile app", "Mobile access"],
  ["monday.labs", "Beta features"],
  ["Shortcuts", "Shortcuts"],
  ["Invite members", "Invite members"],
  ["Get help", "Get help"],
  ["Change theme", "Change theme"],
  ["Upgrade account", "Plan & billing"],
];

/** Reads the menu items out of one `useMemo` block, in source order. */
async function menuItems(which) {
  const source = await read(MENU);
  const start = source.indexOf(`const ${which}Items = useMemo<MenuItem[]>(`);
  assert.ok(start > 0, `${which}Items must be declared in ${MENU}`);
  const block = source.slice(start, source.indexOf("[onImportData]", start) + 40);
  const scoped = which === "account" ? block : source.slice(start);
  return [
    ...scoped.matchAll(
      /monday:\s*"([^"]+)",\s*\n\s*label:\s*"([^"]+)",\s*\n\s*icon:\s*"([^"]+)",([\s\S]*?)\n\s{6}\}/g,
    ),
  ].map(([, monday, label, icon, tail]) => ({ monday, label, icon, tail }));
}

test("the Account column is monday's nine items, in monday's order", async () => {
  const items = (await menuItems("account")).slice(0, 9);
  assert.deepEqual(
    items.map((item) => [item.monday, item.label]),
    MONDAY_ACCOUNT_COLUMN,
  );
});

test("the Explore column is monday's eight items, in monday's order", async () => {
  const source = await read(MENU);
  const block = source.slice(source.indexOf("const exploreItems = useMemo<MenuItem[]>("));
  const items = [
    ...block.matchAll(/monday:\s*"([^"]+)",\s*\n\s*label:\s*"([^"]+)"/g),
  ].map(([, monday, label]) => [monday, label]);
  assert.deepEqual(items.slice(0, 8), MONDAY_EXPLORE_COLUMN);
});

test("every menu item goes somewhere — no item is decorative", async () => {
  const source = await read(MENU);
  const blocks = [
    ...source.matchAll(/\{\s*key:\s*"([^"]+)",\s*\n\s*monday:[\s\S]*?\n\s{6}\},/g),
  ];
  assert.ok(blocks.length >= 17, "both columns must be present");
  for (const [block, key] of blocks) {
    assert.match(
      block,
      /href:|onSelect:|onImportData/,
      `the "${key}" item must carry an href or an action`,
    );
  }
});

test("the header carries the workspace name and monday's credits pill as a plan tier", async () => {
  const source = await read(MENU);
  assert.match(source, /account-menu__workspace/);
  assert.match(source, /account-menu__plan/);
  assert.match(
    source,
    /planLabel\(snapshot\.workspace\.planTier\)/,
    "the pill must render the workspace's plan tier",
  );

  const api = await read(ACCOUNT_API);
  assert.match(
    api,
    /planTier:\s*context\.organisation\.planTier/,
    "the plan tier must be read from the organisations row",
  );
});

test("the working-status row reproduces monday's Do not disturb / On / Off / More", async () => {
  const source = await read(MENU);
  const footer = source.slice(
    source.indexOf('className="account-menu__status"'),
    source.indexOf("account-menu__status-list"),
  );
  assert.match(footer, /Do not disturb/);
  assert.match(footer, />\s*On\s*</);
  assert.match(footer, />\s*Off\s*</);
  assert.match(footer, /account-menu__more/, "monday's More affordance must be present");
  assert.match(source, /aria-label="More working statuses"/);
});

test("the working status is persisted to users.working_status", async () => {
  const menu = await read(MENU);
  assert.match(
    menu,
    /patchAccount\(\{\s*workingStatus:\s*status\s*\}\)/,
    "choosing a status must PATCH the account, not only set local state",
  );

  const api = await read(ACCOUNT_API);
  assert.match(api, /working_status = \$\{value\}/);
  assert.match(api, /working_status = NULL/);
  assert.match(
    api,
    /WORKING_STATUS_VALUES as readonly string\[\]\)\.includes\(value\)/,
    "an unknown status must be refused rather than written",
  );
});

test("the menu is keyboard operable: escape, focus trap, arrows, focus return", async () => {
  const source = await read(MENU);

  assert.match(source, /if \(event\.key === "Escape"\)/, "Escape must be handled");
  assert.match(
    source,
    /if \(returnFocus\) triggerRef\.current\?\.focus\(\)/,
    "closing must return focus to the avatar",
  );
  assert.match(
    source,
    /if \(event\.key === "Tab"\)[\s\S]*?last\.focus\(\)[\s\S]*?first\.focus\(\)/,
    "Tab must wrap inside the panel — the focus trap",
  );
  assert.match(source, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(source, /event\.key === "ArrowRight" \|\| event\.key === "ArrowLeft"/);
  assert.match(source, /event\.key === "Home"/);
  assert.match(source, /event\.key === "End"/);
  assert.match(source, /role="menu"/);
  assert.match(source, /aria-haspopup="menu"/);
  assert.match(source, /aria-expanded=\{open\}/);
});

test("the topbar's decorative avatar is gone, replaced by the menu", async () => {
  const source = await read(PORTAL);
  const topbar = source.slice(
    source.indexOf('<div className="topbar-actions">'),
    source.indexOf("</header>"),
  );
  assert.ok(topbar.length > 0, "the topbar-actions block must exist");
  assert.doesNotMatch(
    topbar,
    /<Avatar\s/,
    "the bare Avatar must no longer sit in the topbar doing nothing",
  );
  assert.match(topbar, /<AccountMenu\b/);
  assert.match(topbar, /onImportData=\{\(\) => openWorkspaceManager\("import"\)\}/);
  // Notifications stay exactly where they were.
  assert.match(topbar, /<Icon name="bell"/);
});

test("the icon row adds only entries with a real destination", async () => {
  const source = await read(PORTAL);
  const topbar = source.slice(
    source.indexOf('<div className="topbar-actions">'),
    source.indexOf("</header>"),
  );
  for (const href of [
    "/dashboard/account/invite",
    "/dashboard/account/integrations",
    "/dashboard/account/help",
  ]) {
    assert.match(topbar, new RegExp(href.replace(/\//g, "\\/")));
  }
  // monday's inbox and product grid have nothing behind them here, so they must
  // not appear as icons that do nothing.
  assert.doesNotMatch(topbar, /aria-label="Inbox"/);
  assert.doesNotMatch(topbar, /aria-label="Apps"/);
});

test("every panel in the rail resolves to the account route", async () => {
  const panels = await read(PANELS);
  const keys = [...panels.matchAll(/\{ key: "([^"]*)",/g)].map(([, key]) => key);
  assert.ok(keys.includes(""), "the profile is the empty segment");
  assert.equal(new Set(keys).size, keys.length, "panel keys must be unique");

  const route = await read(ROUTE);
  assert.match(route, /ACCOUNT_PANEL_KEYS\.has\(requested\)/);

  const shell = await read(SHELL);
  for (const key of keys) {
    if (!key) continue;
    assert.match(
      shell,
      new RegExp(`case "${key}":`),
      `the shell must render a panel for "${key}"`,
    );
  }
});

test("every menu href points at a panel that exists or a route another agent owns", async () => {
  const menu = await read(MENU);
  const panels = await read(PANELS);
  const keys = new Set(
    [...panels.matchAll(/\{ key: "([^"]*)",/g)].map(([, key]) => key),
  );
  const elsewhere = new Set([
    "/dashboard/admin",
    "/dashboard/teams",
    "/dashboard?manage=import",
  ]);

  const hrefs = [...menu.matchAll(/href:\s*"([^"]+)"/g)].map(([, href]) => href);
  assert.ok(hrefs.length >= 15, "most items navigate");
  for (const href of hrefs) {
    if (elsewhere.has(href)) continue;
    assert.ok(
      href.startsWith("/dashboard/account"),
      `unexpected destination ${href}`,
    );
    const key = href.replace("/dashboard/account", "").replace(/^\//, "");
    assert.ok(keys.has(key), `${href} has no panel behind it`);
  }
});

/* ── The three screens most at risk of being invented ───────────────────── */

/*
 * THIS TEST WAS REVERSED IN STAGE 23. WHAT IT USED TO ASSERT IS RECORDED HERE.
 *
 * It was called "Trash offers no restore, because no table stores a deleted
 * row", and it asserted three things: that `db/schema.ts` contained no
 * `deleted_at`, that the trash route said `recoverable: false` and exposed no
 * POST, and that the word "Restore" appeared nowhere on the Trash panel. Its
 * job was to make a claim on the screen fail loudly the moment the schema
 * stopped matching it — so that "there is no bin" could not quietly become a
 * lie while the screen went on saying it.
 *
 * It did that job. Stage 23 added `deleted_at` and this test failed, exactly as
 * designed, and the failure is what forced the screen and the route to be
 * rewritten in the same change rather than left behind.
 *
 * It was reversed on the owner's explicit instruction — "when someone deleted
 * something we should have backup for 30 days and where he can find also the
 * deleted section — check monday.com" — and not because it was wrong. So it has
 * been INVERTED rather than deleted: the same three surfaces are still checked
 * against the schema, and they must now agree that the bin EXISTS. A future
 * change that rips the recycle bin out will fail here for the mirror-image
 * reason the original failed, which is the property worth keeping.
 */
test("Trash restores, and the schema backs the claim up", async () => {
  const schema = await read("db/schema.ts");

  // The reversal, asserted at its root: the columns a bin cannot exist without.
  assert.match(
    schema,
    /deletedAt: text\("deleted_at"\)/,
    "the recycle bin needs a soft-delete column; if this is gone, Trash is lying again",
  );
  assert.match(
    schema,
    /export const recycleBin = sqliteTable\(\s*\n?\s*"recycle_bin"/,
    "the bin is a table, because restoring needs the placement a flag cannot hold",
  );
  // A stored expiry, not a computed one — the sweep indexes it.
  assert.match(schema, /expiresAt: text\("expires_at"\)\.notNull\(\)/);

  // The history route still exists and still says what it can honestly say.
  const api = await read(TRASH_API);
  assert.match(api, /recoverable: true/);
  assert.match(
    api,
    /softDelete: true/,
    "the recovery matrix must report the entities the bin actually covers",
  );
  assert.match(
    api,
    /softDelete: false/,
    "and must keep reporting the ones it does not — a bin is not a licence to guess",
  );

  // The bin's own route, with a real restore behind a capability.
  const bin = await read(BIN_API);
  assert.match(bin, /export async function POST/, "the bin must expose a restore");
  assert.match(bin, /scopedDbWithCapability\(request, "board.edit"\)/);
  assert.match(
    bin,
    /scopedDbWithCapability\(request, "data.delete"\)/,
    "permanent deletion must require data.delete, which admin does not hold by default",
  );

  const view = await read(TRASH_VIEW);
  const panel = view.slice(
    view.indexOf("export function AccountTrashPanel"),
    view.indexOf("export function AccountArchivePanel"),
  );
  assert.match(panel, />\s*\{busy === entry\.id \? "Working…" : "Restore"\}\s*</);
  assert.doesNotMatch(
    panel,
    /Nothing here can be restored/,
    "the old headline must go with the old behaviour",
  );

  /*
   * The half of the old screen that had to SURVIVE the reversal.
   *
   * The bin covers 30 days. The deletion history covers everything before
   * Stage 23 and everything since purged, and replacing it with the bin would
   * have destroyed the only record of both.
   */
  assert.match(panel, /Deletion history/);
  assert.match(panel, /This is a history, not a bin/);
});

test("Archive restores exactly what the schema can restore", async () => {
  const schema = await read("db/schema.ts");
  const api = await read(ARCHIVE_API);

  // The four tables that genuinely carry the flag.
  for (const table of [
    "maintenanceRequests",
    "maintenanceGroups",
    "boards",
    "teams",
  ]) {
    /*
     * The whole table definition, not its first 1,600 characters.
     *
     * The window was a reasonable shortcut and stopped being one the moment
     * `maintenanceRequests` grew three signature columns: `archived` was still
     * there, just past the cut. A slice that fails when a table gains a field
     * is testing the file's layout, not the schema.
     */
    const start = schema.indexOf(`export const ${table} =`);
    assert.ok(start > 0, `${table} must exist in the schema`);
    const next = schema.indexOf("\nexport const ", start + 1);
    const block = schema.slice(start, next === -1 ? undefined : next);
    assert.match(
      block,
      /archived: integer\("archived"/,
      `${table} must carry an archived flag for the Archive screen to read it`,
    );
  }

  assert.match(api, /const RESTORABLE = new Set\(\["job", "group", "board"\]\)/);
  assert.match(
    api,
    /restorable: false[\s\S]*?restoreNote:/,
    "teams must be listed as not restorable here, with the reason",
  );
  // Every restore is scoped to the caller's organisation as well as the id.
  const posts = [...api.matchAll(/\.update\((\w+)\)[\s\S]*?\.where\(([\s\S]*?)\);/g)];
  assert.equal(posts.length, 3, "three restorable kinds, three updates");
  for (const [, table, where] of posts) {
    assert.match(where, /organisationId, context\.orgId/, `${table} restore must be tenant-scoped`);
  }
});

test("Change theme offers light as well as dark, and the stylesheets back it", async () => {
  /*
   * This replaces "Change theme offers only dark, and the stylesheets prove
   * why", which asserted that no `data-theme="light"` rule existed and told
   * whoever added one to come here. A light skin has now landed, so the
   * tripwire becomes the contract it was guarding: the palette, the API and
   * the picker have to agree.
   */
  const sheets = await Promise.all([
    read("app/globals.css"),
    read("app/brand-overrides.css"),
    read("app/board-metrics.css"),
  ]);
  const joined = sheets.join("\n");
  assert.ok(
    (joined.match(/data-theme="dark"/g) ?? []).length > 0,
    "the dark skin exists",
  );
  assert.ok(
    (joined.match(/data-theme="light"/g) ?? []).length > 0,
    "the light skin exists",
  );

  // The dark palette must be scoped, or it wins over the light tokens declared
  // above it and selecting light changes nothing at all.
  // Stage 26: the two dark palettes were merged, so this selector now heads a
  // list (`:root:not([data-theme="light"]), body[data-theme="dark"]`). The
  // contract is unchanged — the dark block must still be scoped — so the match
  // allows the rest of the selector list rather than demanding a lone brace.
  assert.match(
    sheets[0],
    /:root:not\(\[data-theme="light"\]\)[^{]*\{/,
    "the dark token block must be scoped so the light base can win",
  );
  /*
   * The base `body` rule KEEPS its dark literal on purpose.
   *
   * Tokenising it looked tidier and silently restyled the dark product:
   * body[data-theme="dark"] resolves --canvas to #0b1218, which is not the
   * #101820 the literal painted. The dark theme must not move, so the light
   * ground is applied by the light block instead — which therefore has to
   * exist and has to set a background.
   */
  const lightBody = sheets[1].match(
    /body\[data-theme="light"\]\s*\{[\s\S]*?\}/,
  );
  assert.ok(lightBody, "a body[data-theme='light'] rule must exist");
  assert.match(
    lightBody[0],
    /background:\s*var\(--canvas\)/,
    "the light ground must be applied on the light selector, not by editing the base body rule",
  );

  const api = await read(ACCOUNT_API);
  assert.match(
    api,
    /export const SUPPORTED_THEMES = \["dark", "light", "system"\] as const;/,
  );

  const view = await read(EXPLORE_VIEW);
  const panel = view.slice(view.indexOf("export function AccountThemePanel"));
  assert.match(panel, /choose\("light"\)/, "light must be selectable");
  assert.match(panel, /choose\("system"\)/, "system must be selectable");
  assert.doesNotMatch(
    panel,
    /Why light is not offered/,
    "the card explaining light's absence must go when light arrives",
  );
  assert.match(
    panel,
    /themePreference: theme/,
    "the choice must still be written to users.theme_preference",
  );
  /*
   * Stage 26: still applied, but no longer by assigning the raw choice.
   *
   * `document.body.dataset.theme = theme` wrote the CHOICE, so picking System
   * put `data-theme="system"` on the document — a value no stylesheet matches,
   * which produced a third, unintended skin (the rail fell back to
   * --navy-950 instead of its own ground). `setThemeChoice` resolves the
   * choice through `prefers-color-scheme` first, stamps html AND body, and
   * stores it, so this panel and the topbar toggle cannot disagree.
   */
  assert.match(
    panel,
    /setThemeChoice\(theme\)/,
    "and applied through the shared store, not merely stored",
  );
});

test("every documented shortcut is a key this application really handles", async () => {
  const view = await read(EXPLORE_VIEW);
  const block = view.slice(
    view.indexOf("const SHORTCUT_GROUPS"),
    view.indexOf("export function AccountShortcutsPanel"),
  );
  const groups = [
    ...block.matchAll(/source:\s*"([^"]+)",\s*\n\s*rows:\s*\[([\s\S]*?)\n\s{4}\]/g),
  ];
  assert.ok(groups.length >= 6, "the reference must cover the app, not one screen");

  /** Display label → the string a key handler compares against. */
  const codeName = {
    Esc: "Escape",
    Enter: "Enter",
    Tab: "Tab",
    "↑": "ArrowUp",
    "↓": "ArrowDown",
    "←": "ArrowLeft",
    "→": "ArrowRight",
    Home: "Home",
    End: "End",
    PgUp: "PageUp",
    PgDn: "PageDown",
    Shift: "shiftKey",
    Alt: "altKey",
  };

  for (const [, sources, rows] of groups) {
    const files = sources.split(",").map((name) => name.trim());
    const bodies = await Promise.all(
      files.map((file) =>
        read(
          file.startsWith("views/")
            ? `app/(app)/portal/${file}`
            : `app/(app)/portal/${file}`,
        ),
      ),
    );
    const combined = bodies.join("\n");

    const keys = new Set(
      [...rows.matchAll(/keys:\s*\[([^\]]+)\]/g)]
        .flatMap(([, list]) => list.split(","))
        .map((key) => key.trim().replace(/^"|"$/g, "")),
    );

    for (const key of keys) {
      const needle = codeName[key];
      assert.ok(needle, `no code name known for the documented key "${key}"`);
      assert.ok(
        combined.includes(needle),
        `${sources} does not handle ${key} (${needle}), but the Shortcuts screen says it does`,
      );
    }
  }
});

/* ── Boundaries ─────────────────────────────────────────────────────────── */

test("the account routes never reimplement another agent's endpoints", async () => {
  for (const file of [
    ACCOUNT_API,
    TRASH_API,
    ARCHIVE_API,
    "app/api/account/sessions/route.ts",
    "app/api/account/platform/route.ts",
  ]) {
    const source = await read(file);
    assert.doesNotMatch(
      source,
      /invitations|password_hash/,
      `${file} must leave invitations and credentials to /api/auth`,
    );
  }
});

test("pending routes are handled, not assumed", async () => {
  const menu = await read(MENU);
  assert.match(
    menu,
    /response\.status === 404[\s\S]*?authentication routes are still being built/,
    "log out must survive /api/auth/logout not existing yet",
  );

  const profile = await read("app/(app)/portal/views/account-profile.tsx");
  assert.match(profile, /\/api\/auth\/password/);
  assert.match(profile, /response\.status === 404/);

  const explore = await read(EXPLORE_VIEW);
  assert.match(explore, /\/api\/auth\/invitations/);
  assert.match(explore, /response\.status === 404/);
});

test("the menu keeps MAINTSUPP's palette and imports none of monday's blue", async () => {
  const css = await read(MENU_CSS);
  assert.match(css, /#12b4a8/i, "the teal accent is MAINTSUPP's");
  assert.match(css, /#182830/i, "the surface is the dashboard's");
  // monday's brand blues, which a copied menu would drag in.
  for (const blue of ["#0073ea", "#0060b9", "#579bfc", "#00c875"]) {
    assert.doesNotMatch(css, new RegExp(blue, "i"), `${blue} is monday's, not ours`);
  }
});

test("the two-column shape survives in the markup and the stylesheet", async () => {
  const menu = await read(MENU);
  assert.match(menu, /data-menu-column="account"/);
  assert.match(menu, /data-menu-column="explore"/);
  assert.match(menu, /<h3>Account<\/h3>/);
  assert.match(menu, /<h3>Explore<\/h3>/);

  const css = await read(MENU_CSS);
  assert.match(
    css,
    /\.account-menu__columns\s*\{[\s\S]*?grid-template-columns:\s*1fr 1fr/,
    "two equal columns, as monday's menu has",
  );
});
