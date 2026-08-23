/**
 * UI batch — the board header and the surfaces it opens.
 *
 * Pins, in source, the promises the batch made: "Integrate" is gone; the
 * two counts come from the API and nowhere else; every item on the ⋯ menu
 * is wired to a real destination or disabled with its reason; nothing is
 * pretended to be connected; a shared link's `?view=` is honoured; and the
 * login's `next` can only ever be a path on this origin. The two pure link
 * helpers are transpiled and run.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const transpile = (source) =>
  ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const asModule = (javascript) => `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

const ACTIONS = "app/(app)/portal/board-actions";

/* ── The header ──────────────────────────────────────────────────────────── */

test("Integrate is gone and the five real actions remain, each with an accessible name", async () => {
  const header = await read("app/(app)/portal/board-header.tsx");
  // The word survives in the comment that explains its removal; the button must not.
  assert.doesNotMatch(header, />Integrate<|aria-label="Integrate"/, "the Integrate button opened nowhere and must not come back");
  for (const label of ["Automations", "Discussion", "Invite", "Copy link", "Board options"]) {
    assert.match(header, new RegExp(label), `${label} must be on the header`);
  }
  // Labels hide below 768px, so every button must be named by aria-label.
  const buttons = header.match(/<button[\s\S]*?>/g) ?? [];
  for (const button of buttons) {
    assert.match(button, /aria-label=/, `an unnamed header button:\n${button}`);
  }
});

test("the counts are the API's, never a literal", async () => {
  const header = await read("app/(app)/portal/board-header.tsx");
  assert.match(header, /automationCount: number \| null/, "the count is absent until the API answers");
  assert.match(header, /memberCount: number \| null/);
  assert.doesNotMatch(header, /automationCount=\{\d+\}/);

  const host = await read(`${ACTIONS}/board-actions-host.tsx`);
  assert.match(host, /fetch\(`\/api\/automations\?boardId=/, "the automation count is read from /api/automations");
  assert.match(host, /counts\.enabled/);
  assert.match(host, /fetch\("\/api\/board\/members"\)/, "the member count is read from /api/board/members");
  assert.match(host, /payload\.members\.length/);
  assert.match(host, /maintsupp:automations-changed/, "a write in the modal re-reads the count");

  const chrome = await read("app/(app)/portal/board-chrome.tsx");
  assert.doesNotMatch(chrome, /automationCount=\{/, "the chrome passes no count down — the host fetches its own");
  assert.match(chrome, /<BoardActionsHost/);
  assert.doesNotMatch(chrome, /import BoardHeader/, "the header is composed through the host");
});

/* ── The ⋯ menu ──────────────────────────────────────────────────────────── */

test("every board option is wired to a real destination or disabled with a reason", async () => {
  const menu = await read(`${ACTIONS}/board-options-menu.tsx`);
  const link = await read(`${ACTIONS}/board-link.ts`);
  const wired = {
    activity: /navigateTo\(BOARD_ROUTES\.activityLog\)/,
    discussion: /onDiscussion\(\)/,
    notifications: /openNotifications\(\)/,
    permissions: /navigateTo\(BOARD_ROUTES\.permissions\)/,
    rename: /onRename\(\)/,
    terminology: /onTerminology\(\)/,
    "archived-history": /navigateTo\(BOARD_ROUTES\.archive\)/,
    export: /exportWholeBoard\(boardId\)/,
    import: /navigateTo\(BOARD_ROUTES\.importItems\)/,
    fullscreen: /toggleFullscreen\(\)/,
    archive: /navigateTo\(BOARD_ROUTES\.archive\)/,
    trash: /navigateTo\(BOARD_ROUTES\.trash\)/,
  };
  for (const [key, pattern] of Object.entries(wired)) {
    assert.match(menu, new RegExp(`key: "${key}"`), `menu item ${key} is missing`);
    assert.match(menu, pattern, `menu item ${key} is not wired`);
  }
  // The two the product cannot do say so instead of pretending.
  for (const key of ["archive-board", "delete-board"]) {
    const start = menu.indexOf(`key: "${key}"`);
    const entry = menu.slice(start, menu.indexOf("},", start));
    assert.match(entry, /disabled: true/, `${key} must be disabled`);
    assert.match(entry, /reason: "Boards cannot be/, `${key} must say why`);
    assert.doesNotMatch(entry, /onSelect/, `${key} must not run anything`);
  }
  // Destinations are real routes.
  assert.match(link, /activityLog: "\/dashboard\/audit"/);
  assert.match(link, /permissions: "\/dashboard\/admin\/roles"/);
  assert.match(link, /archive: "\/dashboard\/account\/archive"/);
  assert.match(link, /trash: "\/dashboard\/account\/trash"/);
  assert.match(link, /importItems: "\/dashboard\?manage=import"/);
  const routes = await read("app/(app)/dashboard/[[...section]]/page.tsx");
  assert.match(routes, /audit: "audit"/);
  assert.match(routes, /"admin\/roles": "admin-roles"/);
  const panels = await read("app/(app)/portal/views/account-panels.ts");
  assert.match(panels, /key: "trash"/);
  assert.match(panels, /key: "archive"/);
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /params\.get\("manage"\) !== "import"/, "?manage=import opens the importer");
  /*
   * Notifications has two routes to one panel, and firing both in one tick
   * cancels itself: the listener sets the state true, the top-bar button
   * TOGGLES it, and React applies both against the same state — so the panel
   * opened and shut again and the menu item appeared to do nothing. The
   * button press must be deferred and conditional on the panel still being
   * shut, which `aria-expanded` reports.
   */
  assert.match(portal, /addEventListener\("maintsupp:open-notifications"/, "the portal listens for the event");
  assert.match(portal, /setNotificationsOpen\(\(open\) => !open\)/, "the top-bar button toggles, so the click cannot be unconditional");
  const opener = menu.slice(menu.indexOf("function openNotifications"), menu.indexOf("function toggleFullscreen"));
  assert.match(opener, /dispatchEvent\(new Event\("maintsupp:open-notifications"\)\)/, "the event is still the first route");
  assert.match(opener, /aria-expanded/, "the button press is guarded by the panel's own state");
  assert.doesNotMatch(
    opener,
    /\n\s*button\.click\(\);\n\s*return true;/,
    "the button must not be pressed in the same tick as the event — that cancels the open",
  );
  // Nothing invented.
  // The doc comment names what was left out; no ITEM may carry those labels.
  const labels = (menu.match(/label: "[^"]+"/g) ?? []).join("\n");
  for (const absent of ["Power-Up", "AI suggestion", "Convert to project", "template", "Duplicate board", "report"]) {
    assert.doesNotMatch(labels, new RegExp(absent, "i"), `${absent} must not be offered`);
  }
});

test("permissions gate what they should, through the capability hook", async () => {
  const menu = await read(`${ACTIONS}/board-options-menu.tsx`);
  assert.match(menu, /useCapability\("audit\.read"\)/);
  assert.match(menu, /useCapability\("roles\.edit"\)/);
  assert.match(menu, /useCapability\("data\.export"\)/);
  const dialogs = await read(`${ACTIONS}/board-settings-dialogs.tsx`);
  assert.match(dialogs, /settings\.edit/, "the rename dialog names the capability the route enforces");
  const settings = await read("app/api/board/settings/route.ts");
  assert.match(settings, /scopedDbWithCapability\(request, "settings\.edit"\)/);
});

/* ── Honesty about integrations ──────────────────────────────────────────── */

test("no fake integrations anywhere on the automations surfaces", async () => {
  const connections = await read("app/api/automations/connections/route.ts");
  assert.match(connections, /connected: emailConfigured/, "email is connected only when a key exists");
  for (const fake of ["whatsapp", "slack", "teams", "gmail", "outlook"]) {
    assert.doesNotMatch(connections, new RegExp(`key: "${fake}"`), `${fake} is not a connection this product has`);
  }
  const panels = await read(`${ACTIONS}/automations-panels.tsx`);
  assert.match(panels, /No automation runs yet/);
  assert.match(panels, /Deleted rule/, "a run whose rule is gone is labelled, not dropped");
  assert.match(panels, /automationName \?\?/);
  assert.doesNotMatch(panels, /<meter|<progress|allowance|of \{usage\.quota/i, "no meter against an invented quota");
  assert.match(panels, /\{usage\.note\}/, "the route's own note about there being no quota is shown");
  const usage = await read("app/api/automations/usage/route.ts");
  assert.match(usage, /quota: null/);
  const modal = await read(`${ACTIONS}/automations-modal.tsx`);
  assert.match(modal, /templates\.length > 0 &&/, "templates are offered only when the store has some");
  assert.doesNotMatch(modal, /Rename/, "the sentence is server-composed, so there is no Rename");
});

test("the builder only offers what the catalogue says is available, and shows the reason otherwise", async () => {
  const picker = await read(`${ACTIONS}/catalog-picker.tsx`);
  assert.match(picker, /entry\.available \? entry\.description : entry\.reason/);
  assert.match(picker, /aria-disabled=\{!entry\.available/);
  assert.match(picker, /entry\.available && onPick\(entry\)/);
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter"]) {
    assert.match(picker, new RegExp(`"${key}"`), `the picker must handle ${key}`);
  }
  assert.match(picker, /layer="popover-raised"/, "the picker stacks above the modal");
  const builder = await read(`${ACTIONS}/automation-builder.tsx`);
  assert.match(builder, /composeSentence\(/, "the preview uses the same composer as the server");
  assert.match(builder, /catalog\.timeBasedNote/, "time-based rules say how they are checked");
  assert.match(builder, /createRule\(/);
});

/* ── Copy link and ?view= ────────────────────────────────────────────────── */

const linkModule = await import(asModule(transpile(await read(`${ACTIONS}/board-link.ts`))));

test("boardLink names the board's own path and only the view", () => {
  assert.equal(linkModule.boardLink("https://app.example", "/dashboard/jobs", "chart"), "https://app.example/dashboard/jobs?view=chart");
  assert.equal(linkModule.boardLink("https://app.example", "/dashboard/store-documentation", null), "https://app.example/dashboard/store-documentation");
  assert.equal(linkModule.boardLink("https://app.example", "/dashboard/s/my-section", "main"), "https://app.example/dashboard/s/my-section?view=main");
});

test("viewFromSearch reads the view and refuses junk", () => {
  assert.equal(linkModule.viewFromSearch("?view=chart"), "chart");
  assert.equal(linkModule.viewFromSearch("?manage=import&view=form"), "form");
  assert.equal(linkModule.viewFromSearch("?view="), null);
  assert.equal(linkModule.viewFromSearch(""), null);
  assert.equal(linkModule.viewFromSearch(`?view=${"x".repeat(81)}`), null);
});

test("the chrome honours ?view= on load, only for a tab the board has", async () => {
  const chrome = await read("app/(app)/portal/board-chrome.tsx");
  assert.match(chrome, /viewFromSearch\(window\.location\.search\)/);
  assert.match(chrome, /views\.some\(\(view\) => view\.key === wanted\)/, "an unknown key is ignored");
  assert.match(chrome, /linkedView\.current = null/, "consumed once, so it cannot drag the strip back later");
  const host = await read(`${ACTIONS}/board-actions-host.tsx`);
  assert.match(host, /boardLink\(window\.location\.origin, window\.location\.pathname, activeKey/);
  assert.match(host, /copyBoardText\(link\)/);
  const header = await read("app/(app)/portal/board-header.tsx");
  assert.match(header, /"Link copied" : "Copy link"/, "the button itself says Copied");
});

/* ── Login next ──────────────────────────────────────────────────────────── */

test("the login's next is same-origin only, and the session guard preserves path and query", async () => {
  const auth = await read("app/lib/auth-session.ts");
  const start = auth.indexOf("export function safeRedirectPath");
  const fn = auth.slice(start, start + 900);
  assert.match(fn, /!value\.startsWith\("\/"\)/, "only a path");
  assert.match(fn, /value\.startsWith\("\/\/"\)/, "protocol-relative URLs are refused");
  assert.match(fn, /url\.origin !== "https:\/\/maintsupp\.invalid"/, "an absolute URL is refused");
  assert.match(fn, /\$\{url\.pathname\}\$\{url\.search\}/, "the query survives, so ?view= does");
  const login = await read("app/(app)/login/page.tsx");
  assert.match(login, /safeRedirectPath\(rawNext\)/);
  assert.match(login, /if \(session\) redirect\(next\)/);
  const form = await read("app/(app)/login/sign-in-form.tsx");
  assert.match(form, /next/);
  const guard = await read("app/(app)/portal/session-guard.ts");
  assert.match(guard, /\$\{window\.location\.pathname\}\$\{window\.location\.search\}/);
  assert.match(guard, /\/login\?next=\$\{encodeURIComponent\(returnTo\(\)\)\}/);
});

/* ── The other surfaces ──────────────────────────────────────────────────── */

test("Invite goes through the one invitation writer and says no email was sent", async () => {
  const invite = await read(`${ACTIONS}/invite-modal.tsx`);
  assert.match(invite, /fetch\("\/api\/auth\/invitations"/);
  assert.match(invite, /No email was sent\./);
  assert.match(invite, /Anyone at/);
  assert.match(invite, /grantableRoles\(/, "the role list is capped at the caller's own rank");
  assert.match(invite, /payload\.inviteNote \?\? "Only admins can invite\."/);
  const members = await read("app/api/board/members/route.ts");
  assert.match(members, /canInvite/);
  assert.match(members, /inviteAs/);
});

test("the discussion drawer reuses the item thread against the board route", async () => {
  const discussion = await read(`${ACTIONS}/board-discussion.tsx`);
  assert.match(discussion, /import \{ UpdateThread \} from "\.\.\/update-thread"/);
  assert.match(discussion, /\/api\/board\/discussion\?board=/);
  assert.match(discussion, /method: "POST"/);
  assert.match(discussion, /canPost/);
  assert.match(discussion, /No discussion yet/);
  assert.match(discussion, /Files cannot be attached to a board discussion/);
  const shell = await read(`${ACTIONS}/board-modal.tsx`);
  assert.match(shell, /useBodyScrollLock\(open\)/, "the drawer takes the body scroll lock");
});

test("the view strip's three menus ride the shared layer, not the strip", async () => {
  const chrome = await read("app/(app)/portal/board-chrome.tsx");
  assert.match(chrome, /from "\.\/board-actions\/view-menus"/);
  for (const menu of ["ViewTabMenu", "ViewOverflowMenu", "AddViewMenu"]) {
    assert.match(chrome, new RegExp(`<${menu}\\b`), `${menu} must be drawn`);
  }
  // The absolute-positioned menu the strip could clip is gone from the chrome.
  assert.doesNotMatch(chrome, /className="board-views__menu"/);
  const menus = await read(`${ACTIONS}/view-menus.tsx`);
  assert.match(menus, /import \{ AnchoredPopover \} from "\.\.\/overlay\/anchored"/);
  assert.equal((menus.match(/<AnchoredPopover/g) ?? []).length, 3);
  assert.match(menus, /role="menuitem"/);
});

test("the board route keeps its own guard on a date column's decoration", async () => {
  const route = await read("app/api/board/route.ts");
  const fn = route.slice(route.indexOf("function dateDecorationValue"), route.indexOf("function normalizeCellValue"));
  assert.match(fn, /if \(type !== "date"\) return null;/);
  assert.match(fn, /return sharedDateDecorationValue\(type, raw\);/, "and then the shared helper applies the same rules");
});

test("all board-action styling lives in board-actions.css under its own prefixes", async () => {
  const css = await read(`${ACTIONS}/board-actions.css`);
  const selectors = css.match(/^\.[a-zA-Z0-9_-]+/gm) ?? [];
  for (const selector of selectors) {
    assert.ok(
      /^\.(ba-|auto-|board-header__)/.test(selector),
      `${selector} is outside the batch's prefixes`,
    );
  }
  for (const file of ["app/globals.css", "app/brand-overrides.css"]) {
    assert.doesNotMatch(await read(file), /\.auto-(modal|picker|builder)/, `${file} must not carry automation styles`);
  }
});
