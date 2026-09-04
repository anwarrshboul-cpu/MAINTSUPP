/**
 * W2C — INDEPENDENT QA (lane 5). The adversarial check on four lanes' work.
 *
 * This file is written from the outside. It does not restate what the
 * implementing tests already assert; it pins the properties an independent
 * pass could actually break, and it pins two DEFECTS this pass measured.
 *
 * ── WHAT THIS FILE FOUND, AND WHERE IT STANDS ─────────────────────────────
 *
 * Written against 055b436, where three of its tests failed on purpose because
 * they pinned real, reproduced defects. All three were fixed after this pass
 * reported them, and the tests are now the guard rather than the evidence:
 *
 *   1. SITE-SCOPE LEAK — six unscoped `from(sites)` reads. Pinned by
 *      "the canonical location select holds only canonical sites" and
 *      "the tenant and account site counts exclude instance registers".
 *   2. THE "NEW ITEM" MENU drawn under the rail — pinned inside
 *      "both board panels leave the toolbar's stacking context".
 *   3. TWO BRAND-NAMING SURFACES — pinned by
 *      "the Sites register search box does not name the brand" and
 *      "the account menu renders no tooltip naming the brand".
 *
 * The measurements are kept in each test's own note, because a pin whose reason
 * is gone is a pin somebody deletes the next time it is inconvenient.
 *
 * THE FIRST DEFECT, IN FULL. `app/lib/register-scope.ts` says the model is default-deny by
 * omission: "Every scoped function in this codebase defaults its scope to
 * `CANONICAL_REGISTER`." That is true of every function IN that module — but a
 * hand-rolled `select().from(sites).where(eq(sites.organisationId, orgId))`
 * does not go through it, and three of those were never taught the scope
 * because their files were outside the change:
 *
 *   app/api/context/route.ts   ~line 106  requestConfiguration.sites
 *   app/api/context/route.ts   ~line  73  tenantSummary[].sites
 *   app/api/account/route.ts   ~line 153  the usage tile's site count
 *
 * `git log 9bf6611..055b436 -- app/api/context/route.ts app/api/account/route.ts`
 * is empty, which is why the sweep missed them.
 *
 * Measured on the local D1 with ONE instance-scoped site present: the canonical
 * register held 38 sites and all three surfaces reported 39. In the browser at
 * 1440x900 the instance site "ZZL5 … Site One" appeared in the "Choose a
 * location" select on /dashboard/jobs and the sidebar workspace switcher read
 * "81 jobs · 40 sites".
 *
 * `requestConfiguration.sites` is the one that matters, because
 * `workspace-data-manager.tsx` already states the rule for exactly this case:
 * "a picker is an assignment surface rather than an inventory — offering
 * another register's site there would attach a job to a site the canonical
 * board does not hold."
 *
 * A fourth instance of the same defect is NOT pinned here because closing it is
 * a product decision rather than a scope fix: `resolveSite()` in
 * `app/api/report-job/route.ts` matches on `(name, organisation_id)` with no
 * register predicate, so an anonymous public submission naming an instance site
 * is accepted and attached to it. Reproduced: MN-1157 landed on
 * `store-zzl5-…-site-one`. Whether an unmatched name should fall through to
 * `unassignedSiteId()` is the owner's call.
 *
 * Everything else in this file passed at 055b436 and is here to keep passing.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
/* Comments explain a rule; they must never be what satisfies an assertion.
   Line endings are per file here and there is no `.gitattributes`, so a
   multi-line pattern matched against an LF regex silently misses in a CRLF
   file — which is a test that passes for the wrong reason. */
const codeOnly = (text) =>
  text.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const normalise = (text) => text.replace(/\r\n/g, "\n");

const RECYCLE = "app/lib/recycle-bin.ts";
const SECTIONS = "app/api/workspace-sections/route.ts";
const CONTEXT = "app/api/context/route.ts";
const ACCOUNT = "app/api/account/route.ts";
const REPORT_JOB = "app/api/report-job/route.ts";
const ANCHORED = "app/(app)/portal/overlay/anchored.tsx";
const CONTROLS = "app/(app)/portal/board-controls.tsx";
const OVERLAY_CSS = "app/(app)/portal/overlay/overlay.css";
const GLOBALS = "app/globals.css";
const BRAND = "app/brand-overrides.css";
const PORTAL = "app/(app)/portal/portal-app.tsx";
const SITES_MANAGER = "app/(app)/portal/sites/sites-manager.tsx";
const ACCOUNT_MENU = "app/(app)/portal/account-menu.tsx";
const LIVE_BOARD = "app/(app)/portal/live-board.tsx";

/**
 * The body of a named `async function`, brace-matched.
 *
 * The opening brace is NOT simply the first `{` after the name: these
 * signatures carry object type literals in their parameters and in their
 * return type — `Promise<{ id: string; … }>` — and starting there matches the
 * type's own closing brace and returns a four-line "body" with no statements
 * in it. So the parameter list is skipped by paren depth first, and then the
 * return type by angle depth, and only after both is a `{` the body's.
 */
function functionBody(text, name) {
  const start = text.search(new RegExp(`(export\\s+)?async function ${name}\\s*\\(`));
  assert.notEqual(start, -1, `${name} is not in this file any more — re-point this pin`);
  let i = text.indexOf("(", start);
  let parens = 0;
  for (; i < text.length; i += 1) {
    if (text[i] === "(") parens += 1;
    else if (text[i] === ")") {
      parens -= 1;
      if (parens === 0) { i += 1; break; }
    }
  }
  let angles = 0;
  for (; i < text.length; i += 1) {
    if (text[i] === "<") angles += 1;
    else if (text[i] === ">") angles -= 1;
    else if (text[i] === "{" && angles === 0) break;
  }
  const open = i;
  let depth = 0;
  for (let j = open; j < text.length; j += 1) {
    if (text[j] === "{") depth += 1;
    else if (text[j] === "}") {
      depth -= 1;
      if (depth === 0) {
        const body = text.slice(open, j + 1);
        assert.ok(body.length > 200, `${name}'s body came out at ${body.length} chars — the brace match is wrong`);
        return body;
      }
    }
  }
  throw new Error(`${name} never closes`);
}

/**
 * Every opening JSX tag for a component, as text.
 *
 * NOT `/<Name[\s\S]*?>/`: a non-greedy match stops at the first `>` in the
 * source, and these props hold arrow functions — `onClose={() =>` — so it
 * truncates the tag two props in and reports every popover as missing whatever
 * comes later. Brace depth is tracked so the `>` that closes the tag is the
 * only one that ends it.
 */
function openingTags(text, name) {
  const out = [];
  const open = new RegExp(`<${name}\\b`, "g");
  let m;
  while ((m = open.exec(text))) {
    let depth = 0;
    for (let i = m.index; i < text.length; i += 1) {
      const c = text[i];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) {
        out.push(text.slice(m.index, i + 1));
        break;
      }
    }
  }
  return out;
}

/* ================================================================== */
/* 1. Binning a section takes NOTHING ELSE APART                      */
/* ================================================================== */

/**
 * The claim the owner cares about most, and the one a later edit is most
 * likely to break by "helpfully" tidying the children up as well.
 *
 * Verified at the database level against a running server before this pin was
 * written: a Jobs instance holding 2 live rows, 1 row already in the bin, 6
 * groups, 27 columns, 2 views and 1 form was binned in one call, and afterwards
 * `maintenance_requests.deleted_at`, `maintenance_group_items`,
 * `maintenance_groups`, `board_views`, `maintenance_board_columns`,
 * `maintenance_board_cells` and `form_configurations` were byte-identical to
 * their pre-bin snapshots. Restore returned all seven to the same values.
 *
 * So the invariant is: `sendSectionToBin` may write to exactly three tables.
 */
test("W2C-QA binning a section writes to exactly three tables and soft-deletes nothing on its register", async () => {
  const body = codeOnly(functionBody(codeOnly(await source(RECYCLE)), "sendSectionToBin"));

  const written = [...body.matchAll(/\.(?:update|insert|delete)\(([A-Za-z]+)\)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(written)].sort(),
    ["boards", "recycleBin", "workspaceSections"],
    "sendSectionToBin must touch only recycleBin, workspaceSections and boards. " +
      "Anything else means binning a section is taking its contents apart, which " +
      `is the property Restore depends on. Found: ${JSON.stringify(written)}`,
  );

  for (const forbidden of [
    "maintenanceRequests",
    "maintenanceGroupItems",
    "maintenanceGroups",
    "maintenanceBoardCells",
    "maintenanceBoardColumns",
    "boardViews",
    "formConfigurations",
    "sites",
    "contractors",
    "attachments",
  ]) {
    assert.ok(
      !new RegExp(`\\.(update|insert|delete)\\(${forbidden}\\)`).test(body),
      `sendSectionToBin writes ${forbidden}. Binning a section must move the ` +
        "section, not disassemble what is on it — see the header of this test.",
    );
  }

  assert.ok(
    !/deleteObject|\.delete\(\s*key|storage|bucket|R2/i.test(body),
    "sendSectionToBin must not touch stored files. A binned section's evidence " +
      "has to still be there thirty days later.",
  );
});

/** Restore is the exact inverse, and just as narrow. */
test("W2C-QA restoring a section writes to exactly three tables", async () => {
  const body = codeOnly(functionBody(codeOnly(await source(RECYCLE)), "restoreSection"));
  const written = [...body.matchAll(/\.(?:update|insert|delete)\(([A-Za-z]+)\)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(written)].sort(),
    ["boards", "recycleBin", "workspaceSections"],
    `restoreSection must be the inverse of sendSectionToBin. Found: ${JSON.stringify(written)}`,
  );
  assert.match(
    body,
    /archivedAt:\s*snapshot\.wasArchived === true \? undefined : null/,
    "A section that was archived BEFORE it was deleted must come back archived. " +
      "`undefined` leaves the column alone; `null` clears it — the two are not " +
      "interchangeable here and swapping them silently un-archives somebody's section.",
  );
});

/**
 * The bin's `&bin=1` verb is the REVERSIBLE half and must not quietly acquire
 * the irreversible capability, and `purge=1` must not quietly lose it.
 */
test("W2C-QA bin=1 needs settings.edit while delete-for-good needs data.delete", async () => {
  const route = codeOnly(await source(SECTIONS));
  assert.match(
    route,
    /scopedDbWithCapability\(request,\s*"settings\.edit"\)/,
    "DELETE /api/workspace-sections is guarded on settings.edit",
  );
  assert.match(
    route,
    /can\(subject,\s*"data\.delete"\)/,
    "…and the destructive branch resolves data.delete separately",
  );
  const trash = codeOnly(await source("app/api/trash/route.ts"));
  assert.match(
    trash,
    /export async function DELETE[\s\S]{0,400}scopedDbWithCapability\(request,\s*"data\.delete"\)/,
    "DELETE /api/trash — delete for good — must stay on data.delete, which is " +
      "withheld from admin. Verified live: an admin got 403 and the bin entry survived.",
  );
});

/** A canonical section is not a `workspace_sections` row and cannot reach the flow. */
test("W2C-QA only a workspace-added section can be binned", async () => {
  const route = codeOnly(await source(SECTIONS));
  assert.match(
    route,
    /if \(toBin\) \{[\s\S]{0,400}if \(!isWorkspaceSectionKey\(row\.key\)\)/,
    "The `bin=1` branch must refuse a key outside the `section:` namespace before " +
      "it writes anything. Verified live: jobs, contractors, sites, " +
      "store-documentation, maintenance and stores all refuse.",
  );
});

/** A child of a binned section is neither restorable nor purgeable on its own. */
test("W2C-QA a child of a binned section cannot be restored or purged alone", async () => {
  const recycle = codeOnly(await source(RECYCLE));
  assert.match(
    recycle,
    /if \(entry\.boardId\) \{[\s\S]{0,300}binnedSectionBoards\(db, orgId\)[\s\S]{0,300}status: 409/,
    "restoreFromBin must refuse a child whose section is in the bin — enforced in " +
      "the module, not in the screen, because the screen already hides these " +
      "entries so anything reaching here is a stale tab or a script.",
  );
  const trash = codeOnly(await source("app/api/trash/route.ts"));
  assert.match(
    trash,
    /binnedSectionBoards\(db, orgId\)/,
    "…and DELETE /api/trash must skip them for the same reason, or `?all=true` " +
      "walks a list whose section entry destroys its children mid-loop.",
  );
});

/** Thirty days, stated once. */
test("W2C-QA retention is thirty days and the sweep is deterministic on request", async () => {
  const recycle = codeOnly(await source(RECYCLE));
  assert.match(recycle, /export const RETENTION_DAYS = 30;/);
  assert.match(
    recycle,
    /export async function sweepRecycleBin/,
    "The retention must be RUNNABLE rather than waitable, or nothing can test it.",
  );
  const trash = codeOnly(await source("app/api/trash/route.ts"));
  assert.match(
    trash,
    /sweep[\s\S]{0,600}scopedDbWithCapability\(request,\s*"data\.delete"\)/,
    "?sweep=1 destroys, so it resolves data.delete again even though the route " +
      "guard is board.view. Verified live: an admin got 403.",
  );
});

/* ================================================================== */
/* 2. The overlay layer — the sort popover                            */
/* ================================================================== */

/**
 * `.live-board-toolbar` is `position: relative; z-index: 80`, which IS a
 * stacking context, so nothing inside it can out-paint the 410 rail whatever
 * z-index it carries. The panels therefore have to leave the toolbar entirely.
 *
 * Measured in Chromium at 12 widths x 2 themes: the panel resolved into
 * `#maintsupp-layers .ms-layer` at z-index 1000, never overlapped the rail,
 * never left the viewport, and `document.elementFromPoint` at its four corners
 * and centre returned the panel itself every time.
 */
test("W2C-QA both board panels leave the toolbar's stacking context and clamp to the content area", async () => {
  const controls = codeOnly(await source(CONTROLS));
  assert.match(
    controls,
    /const BOARD_CONTENT_REGION = "\.portal-main";/,
    "The clamp region is the content area, so a panel is pushed off the rail " +
      "rather than drawn over it.",
  );
  const popovers = [...controls.matchAll(/<AnchoredPopover\b[\s\S]*?>/g)].map((m) => m[0]);
  const bounded = popovers.filter((tag) => /bounds=\{BOARD_CONTENT_REGION\}/.test(tag));
  assert.ok(
    popovers.length >= 2,
    `Sort AND Filter must both render through AnchoredPopover. Found ${popovers.length}.`,
  );
  assert.equal(
    bounded.length,
    popovers.length,
    "Every toolbar panel that goes through the shared layer must also carry " +
      "`bounds`. Without it the panel clamps to the WINDOW, not to `.portal-main`, " +
      "and is free to be drawn across the rail again.\n" +
      popovers.map((tag) => tag.replace(/\s+/g, " ").slice(0, 90)).join("\n"),
  );
  for (const label of ["Sort the board", "Filter the board"]) {
    assert.ok(
      popovers.some((tag) => tag.includes(label)),
      `The "${label}" panel is not one of the bounded popovers any more.`,
    );
  }

  /*
   * EVERY board overlay, not just the two panels this started with.
   *
   * The Sort fix left the "New item" split-button menu inline in the toolbar,
   * which is the SAME defect on the control beside it. Measured at 055b436 on
   * /dashboard/jobs: at 1024x900 that menu rendered at l=10 r=1014 while
   * `.portal-main` starts at 220, and `document.elementFromPoint(15, 885)`
   * returned `aside.portal-sidebar` — the rail painted over the menu. At
   * 1280x900 it ran off the bottom (b=943, vh=900). Both readings carried
   * `portalled: false` and stacking ancestor `div.live-board-toolbar z=80`.
   *
   * It is fixed, and this is the pin that keeps every overlay on one footing:
   * a new menu added to the board without `bounds` is the defect coming back.
   */
  const board = codeOnly(await source(LIVE_BOARD));
  const boardPopovers = openingTags(board, "AnchoredPopover");
  /*
   * THE TOOLBAR's popovers must carry the clamp, because the toolbar sits hard
   * against `.portal-main`'s left edge — that is where a panel runs onto the
   * rail. The per-row actions menu is anchored inside the grid, well right of
   * the rail, and it measured clean at 1440/1280/1024/900/800/768/430/390/320
   * (on screen, inside `.portal-main`, nothing painted over it) exactly as the
   * Hide menu did before it was given `bounds`. It is listed here rather than
   * waved through: a NEW unbounded popover fails this, and if the row menu ever
   * moves it should be given `bounds` too.
   */
  const MEASURED_CLEAN_WITHOUT_BOUNDS = ['label={"Actions for "'];
  const unbounded = boardPopovers
    .filter((tag) => !/bounds=\{BOARD_CONTENT_REGION\}/.test(tag))
    .filter((tag) => !MEASURED_CLEAN_WITHOUT_BOUNDS.some((known) => tag.includes(known)));
  assert.deepEqual(
    unbounded.map((tag) => tag.replace(/\s+/g, " ").slice(0, 110)),
    [],
    "A board popover neither carries `bounds` nor is one of the surfaces measured " +
      "clean without it. Without the clamp a panel is free to be drawn across the " +
      "rail again — which is the defect this whole test exists for. " +
      "`BOARD_CONTENT_REGION` is exported from board-controls.tsx so there is one " +
      "literal; add it to the tag, or measure the surface and list it above.",
  );
  /* The two that were the reported defect, by name, so neither can lose it. */
  for (const anchored of ["actionsOpen", "hideOpen"]) {
    const tag = boardPopovers.find((entry) => entry.includes(`open={${anchored}}`));
    assert.ok(tag, `The ${anchored} popover is gone from live-board.tsx — re-point this pin.`);
    assert.match(
      tag,
      /bounds=\{BOARD_CONTENT_REGION\}/,
      `The ${anchored} popover lost its clamp. At 1024x900 the unclamped "New item" ` +
        "menu rendered at l=10 with `.portal-main` starting at 220, and the rail " +
        "hit-tested over its lower-left corner.",
    );
  }
  assert.ok(
    boardPopovers.length >= 2,
    `live-board.tsx should render its menus through the shared layer; found ${boardPopovers.length}.`,
  );
  assert.ok(
    !/\{actionsOpen && \(\s*<div className="live-board-menu action-menu">/.test(board),
    "The 'New item' menu is inline inside the toolbar again. `.live-board-menu` " +
      "is absolutely positioned inside `.live-board-toolbar`, which is a stacking " +
      "context at z-index 80, so its own z-index cannot beat the 410 rail.",
  );
  assert.match(
    codeOnly(await source(CONTROLS)),
    /export const BOARD_CONTENT_REGION = "\.portal-main";/,
    "The clamp region must stay exported — two spellings of one region drift.",
  );

  const anchored = codeOnly(await source(ANCHORED));
  assert.match(anchored, /const HOST_ID = "maintsupp-layers";/);
  assert.match(
    anchored,
    /function resolveBounds\(/,
    "The bounds option is resolved in one place; nothing may hand-roll the clamp.",
  );
  assert.match(
    anchored,
    /left = Math\.max\(minX \+ padding, Math\.min\(left, maxX - padding - width\)\);/,
    "The horizontal clamp is what keeps the panel inside `.portal-main`.",
  );

  const overlay = normalise(await source(OVERLAY_CSS));
  assert.match(
    overlay,
    /#maintsupp-layers \{\s*position: static;/,
    "The host must NOT be a stacking context of its own, or the layer's z-index " +
      "would resolve inside it instead of against the rail.",
  );
  assert.match(overlay, /\.ms-layer \{[\s\S]*?z-index: var\(--z-popover\);/);

  const globals = normalise(await source(GLOBALS));
  assert.match(globals, /--z-popover: 1000;/);
  assert.match(globals, /--z-sidebar: 410;/);
  assert.match(globals, /--z-toolbar: 80;/);
});

/* ================================================================== */
/* 3. The rail                                                        */
/* ================================================================== */

/**
 * One scroll container, and the support card is the last block inside it.
 *
 * Measured in Chromium at 12 widths x 2 themes: above 768px the scroller is
 * `.sidebar-scroll`; at 768px and below `.sidebar-scroll` goes
 * `overflow-y: visible; flex: none` and the rail itself scrolls. Exactly one
 * scroller at every width, nothing `fixed` or `sticky` inside the rail, and
 * scrolling to the bottom brought both the card and the last nav entry
 * ("Customise sidebar") fully inside the rail with nothing painted over them.
 */
test("W2C-QA the rail has one scroll container and the card is content, not furniture", async () => {
  const portal = normalise(await source(PORTAL));
  const scroll = portal.slice(portal.indexOf('<div className="sidebar-scroll">'));
  const closes = scroll.indexOf('<div className="sidebar-help">');
  assert.ok(
    closes > 0 && closes < 4000,
    "The support card must live INSIDE `.sidebar-scroll`, after the nav. Outside " +
      "it the card is chrome again and the nav's last row is clipped against it.",
  );

  for (const [file, css] of [
    [GLOBALS, normalise(await source(GLOBALS))],
    [BRAND, normalise(await source(BRAND))],
  ]) {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(
      !/\.portal-nav\s*\{[^}]*overflow-y:\s*auto/.test(stripped),
      `${file} makes .portal-nav a scroller again. Two nested scrollers is the ` +
        "double-scrollbar trap this was written to end.",
    );
    assert.ok(
      !/\.sidebar-help\s*\{[^}]*margin-top:\s*auto/.test(stripped),
      `${file} restores margin-top: auto on the support card, which is what made ` +
        "it permanent furniture between the nav and the profile block.",
    );
    assert.ok(
      !/\.sidebar-help\s*\{[^}]*position:\s*(fixed|sticky)/.test(stripped),
      `${file} pins the support card. Nothing in the rail may be fixed or sticky ` +
        "except the rail itself.",
    );
  }
});

/* ================================================================== */
/* 4. The workspace selector                                          */
/* ================================================================== */

/**
 * Recomputed from the tokens, in the browser and here, so a token edit fails
 * on this line rather than on somebody's screen.
 *
 * Chromium resolved, at all twelve widths in both themes:
 *   unselected  rgb(234,243,246) on rgb(18,33,44)  = 14.57:1
 *   checked     rgb(111,220,211) on rgb(18,60,58)  =  7.42:1
 *   focus ring  2px solid rgb(95,214,205)
 * and it is still a native <select> with two <option>s, keyboard focusable,
 * with no `role` and no `[role="listbox"]` anywhere on the page.
 */
test("W2C-QA the workspace option colours clear 4.5:1 in both states", async () => {
  const globals = normalise(await source(GLOBALS));
  const token = (name) => {
    const found = globals.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
    assert.ok(found, `--${name} is gone — re-point this pin at its new home`);
    return found[1];
  };
  const channel = (hex) => {
    const full = hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
    return [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  const luminance = (hex) =>
    channel(hex)
      .map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };

  const unselected = ratio(token("rail-fg"), token("rail-bg-raised"));
  const disabled = ratio(token("rail-fg-muted"), token("rail-bg-raised"));
  const checked = ratio(token("rail-active-fg"), token("rail-active-bg"));

  assert.ok(unselected >= 4.5, `unselected option is ${unselected.toFixed(2)}:1`);
  assert.ok(disabled >= 4.5, `disabled option is ${disabled.toFixed(2)}:1`);
  assert.ok(checked >= 4.5, `checked option is ${checked.toFixed(2)}:1`);
  /* The measured value, so a drift shows up as a number rather than a pass. */
  assert.equal(unselected.toFixed(2), "14.57");
  assert.equal(checked.toFixed(2), "7.42");

  const brand = normalise(await source(BRAND)).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(
    brand,
    /select option \{\s*background: var\(--rail-bg-raised\);\s*color: var\(--rail-fg\);/,
    "The option colours must be STATED. `color-scheme: dark` alone fixes the " +
      "popup's furniture while the UA still resolves `option`'s background " +
      "against the root scheme — which is the white-on-white the owner reported.",
  );

  const portal = normalise(await source(PORTAL));
  assert.match(
    portal,
    /<select\s+aria-label="Client workspace"/,
    "It must stay a native <select> — the platform keyboard is the point.",
  );
});

/* ================================================================== */
/* 5. Branding — the two that are still there                         */
/* ================================================================== */

/**
 * The Sites register's search box still names the brand, on a register surface,
 * in live `placeholder` text. Two branches of the same input.
 *
 * This is a PIN ON THE CURRENT STATE rather than a failing assertion, because
 * "monday name" is also the column's own meaning to a reader mid-migration and
 * removing it is the owner's call, not QA's. When it is decided, this test is
 * the one line to change.
 */
/**
 * RE-POINTED. This test was written as a standing note that two placeholder
 * branches on the Sites register search box still read "…postcode or monday
 * name", on a REGISTER surface, and it said: "If this count changes the
 * decision was made — update this test to match it rather than deleting it."
 *
 * The decision was made. Both branches now read "…or board name", so the note
 * becomes the guard: the register's search box may not name the other product
 * again. The history is kept here because it is the only place that records
 * WHY the wording is what it is — the column really does hold the name the row
 * carries on the board, and "board name" is the same fact without the brand.
 */
test("W2C-QA the Sites register search box does not name the brand", async () => {
  const manager = codeOnly(await source(SITES_MANAGER));
  const hits = [...manager.matchAll(/"[^"]*\bmonday\b[^"]*"/gi)].map((m) => m[0]);
  assert.deepEqual(
    hits,
    [],
    "A user-visible string on the Sites register names the brand again. The two " +
      "search placeholders were changed to '…or board name'; this is the surface " +
      "the owner photographed.\n" +
      `Found: ${hits.join(" | ")}`,
  );
  /* The wording that replaced it, so a later edit cannot quietly drop the
     alias hint altogether and leave the box unsearchable by former name. */
  assert.match(
    manager,
    /Search name, former name, code, town, postcode or board name/,
    "The aliases branch must still tell a reader they can search a former name.",
  );
});

/**
 * The avatar menu is rendered from the topbar, so it is reachable from every
 * board, register and view. It carried `title={`monday: ${item.monday}`}` on
 * every row plus `title="monday: credits pill"` on the plan link — eight
 * browser tooltips naming the other product, one hover away from anywhere.
 *
 * `item.monday` itself is deliberately kept: it is the mapping this menu was
 * built against. What must not come back is RENDERING it.
 */
test("W2C-QA the account menu renders no tooltip naming the brand", async () => {
  const menu = codeOnly(await source(ACCOUNT_MENU));
  const rendered = [...menu.matchAll(/title[=:]\s*[{`"'][^`"'}\n]*monday[^`"'}\n]*[`"'}]/gi)]
    .map((m) => m[0]);
  assert.deepEqual(
    rendered,
    [],
    "A tooltip in the avatar menu names the brand. This menu is drawn from the " +
      "topbar on every surface, so a `title` here is not account-page copy — it " +
      "reaches a reader who is looking at a board.\n" +
      `Found: ${rendered.join(" | ")}`,
  );
  /*
   * The mapping itself stays. `monday: "My profile"` on each MenuItem records
   * which surface of the other product each entry answers to, which is why the
   * menu is shaped the way it is. Only RENDERING it was the defect, so this
   * asserts the data is still there rather than that it is still referenced —
   * the reference was the `title` that had to go.
   */
  assert.ok(
    (menu.match(/^\s*monday:\s*"/gm) ?? []).length >= 5,
    "The MenuItem.monday mapping has been stripped as well. Removing the tooltip " +
      "was the fix; removing the mapping loses the record of what this menu was " +
      "built against.",
  );
});

/** The board's app-view glyph no longer announces the brand to a screen reader. */
test("W2C-QA no board or view surface announces the brand through aria-label", async () => {
  for (const file of [
    "app/(app)/portal/board-tab-glyph.tsx",
    "app/(app)/portal/views/parity-views.tsx",
    "app/(app)/portal/board-view-pane.tsx",
    "app/(app)/portal/live-board.tsx",
  ]) {
    const text = codeOnly(await source(file));
    const labels = [...text.matchAll(/aria-label=\{?["'`]([^"'`]*)["'`]/g)].map((m) => m[1]);
    for (const label of labels) {
      assert.ok(
        !/monday/i.test(label),
        `${file} announces "${label}" to a screen reader on a board surface.`,
      );
    }
  }
});

/* ================================================================== */
/* 6. THE DEFECT — three unscoped site reads                          */
/* ================================================================== */

/**
 * FAILS AT 055b436. See the file header for the measurement and the reason.
 *
 * The assertion is deliberately on the SHAPE of the query rather than on a
 * count, so it keeps meaning when the local corpus changes.
 */
test("W2C-QA the canonical location select holds only canonical sites", async () => {
  const context = codeOnly(await source(CONTEXT));
  const select = context.slice(
    context.indexOf(".select({ id: sites.id, name: sites.name })"),
  ).slice(0, 500);
  assert.ok(
    select.length > 0,
    "The requestConfiguration site read has moved — re-point this pin.",
  );
  assert.match(
    select,
    /registerScopeFilter\(\s*sites\.boardId/,
    "`requestConfiguration.sites` is the location <select> on Raise a ticket, on " +
      "the board's job form and on the public /request page. It reads every site " +
      "in the organisation, so a site belonging to a custom Sites SECTION is " +
      "offered there and a job can be attached to it.\n\n" +
      "Reproduced at 055b436: the canonical register held 38 sites and this " +
      "endpoint returned 39, the extra one being an instance-scoped row; the " +
      "browser showed it in the 'Choose a location' select on /dashboard/jobs.\n\n" +
      "`workspace-data-manager.tsx` already states the rule: 'a picker is an " +
      "assignment surface rather than an inventory'. Fix: add " +
      "`registerScopeFilter(sites.boardId, CANONICAL_REGISTER)` to the WHERE. " +
      "Patch script: scratchpad/w2c/lane5/PROPOSED-PATCH-context-account-leak.py",
  );
});

/** FAILS AT 055b436. The two counts that read across registers. */
test("W2C-QA the tenant and account site counts exclude instance registers", async () => {
  const context = codeOnly(await source(CONTEXT));
  const summary = context.slice(context.indexOf("async function tenantSummary")).slice(0, 1400);
  assert.match(
    summary,
    /registerScopeFilter\(\s*sites\.boardId/,
    "`tenantSummary[].sites` counts every site row in the organisation, so the " +
      "sidebar workspace switcher read '81 jobs · 40 sites' against a canonical " +
      "register of 38. A tile that says how big a TENANT is should not count " +
      "rows filed inside one of its sections.",
  );

  const account = codeOnly(await source(ACCOUNT));
  const tile = account.slice(account.indexOf("from(sites)") - 200).slice(0, 500);
  assert.match(
    tile,
    /registerScopeFilter\(\s*sites\.boardId/,
    "The account usage tile's site count has the same unscoped read, and " +
      "reported 39 against a canonical register of 38.",
  );
});

/**
 * NOT an assertion — a standing note, so the fourth instance is not lost when
 * the three above are fixed. It passes either way and says which state it found.
 */
test("W2C-QA report-job site resolution is recorded, scoped or not", async () => {
  const report = codeOnly(await source(REPORT_JOB));
  const resolve = report.slice(report.indexOf("async function resolveSite")).slice(0, 1600);
  const scoped = /registerScopeFilter\(\s*sites\.boardId/.test(resolve);
  assert.ok(
    resolve.includes("from(sites)"),
    "resolveSite has moved — re-point this pin.",
  );
  if (!scoped) {
    console.log(
      "[W2C-QA] resolveSite() in app/api/report-job/route.ts still matches a site " +
        "on (name, organisation_id) with no register predicate. An anonymous " +
        "public submission naming an instance site by name is accepted and " +
        "attached to it — reproduced at 055b436, MN-1157 landed on " +
        "store-zzl5-…-site-one. Closing it needs an owner decision about whether " +
        "an unmatched name falls through to unassignedSiteId().",
    );
  }
});
